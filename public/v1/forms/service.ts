import { createHash, randomUUID } from "node:crypto";

import { appointmentConfigurationSchema, bookPlannedAppointment, previewAppointment, readAppointmentCatalog, type AppointmentConfiguration } from "../appointments/planning.js";
import { VERSIONS, getRecord as getModuleRecord } from "../documents/modules/storage.js";
import { runModuleCode } from "../documents/modules/runtime.js";
import { createModuleInstance, evaluateModuleInstance, freezeModuleInstance, storeModuleVersion } from "../documents/modules/service.js";
import { organizationBranding } from "../documents/theme-defaults.js";
import { escapeEmailHtml } from "../email/outbound.js";
import { sendOrganizationTransactionalEmail } from "../email/organization_outbound.js";
import { createPlatformLead } from "../platform/api.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { PlatformError, badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import { invokeAction } from "../platform/publication/actions.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import { contentHash, validateJson } from "../platform/publication/validation.js";
import { readDocument, readOrganization, type JsonObject } from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { resolveOrganizationTimezone } from "../platform/timezone.js";
import { emitWorkEvent } from "../work/engine.js";
import { collectAnswers, summarizeAnswers } from "./answers.js";
import { calculationSource, compileFormModule, formInputSchema } from "./compile.js";
import { FORM_BLOCKS, FORM_FONTS, estimateOutputSchema, formDefinitionSchema, formDraftSchema, formItems, type FormDefinition, type FormItem } from "./contracts.js";
import { buildInsights, recordActivity, type ActivityEvent } from "./insights.js";
import { listMeasurementSources, measurementSource, signMeasurement, verifyMeasurement } from "./sources.js";
import { ACTIVITY, FORMS, SUBMISSIONS, findRecord, listRecords, newFormId, newPublicKey, parsePublicKey, readFormRecord, removeRecord, saveRecord, type StoredRecord } from "./storage.js";
import { buildTemplateDefinition, formTemplate, listFormTemplates } from "./templates.js";

const obj = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown) => String(value ?? "").trim();
const now = () => new Date().toISOString();

type Published = { module_id: string; version: string; definition: FormDefinition; definition_hash: string; name: string; published_at: string; published_by: string };
type FormRecord = StoredRecord & { name: string; branch_id: string; template: string; definition: FormDefinition; enabled: boolean; public_key: string; published: Published | null };

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

const FLAG_LABELS: Record<string, string> = { contact_form: "Contact forms", appointment_form: "Appointment booking forms", instant_estimate: "Instant estimate forms" };

/** Blocks, not form types, decide which lead_forms capabilities a form needs. */
export function requiredFormFlags(definition: Pick<FormDefinition, "steps" | "calculation">) {
  const flags = new Set<string>();
  for (const item of formItems(definition)) {
    const capability = (FORM_BLOCKS[item.kind] as { capability?: string }).capability;
    if (capability) flags.add(capability);
  }
  if (definition.calculation) flags.add("instant_estimate");
  if (!flags.size) flags.add("contact_form");
  return [...flags];
}

async function requireFormsEnabled(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "website_embed_import"))) throw forbidden("app_flag_disabled", "Website forms are not enabled for this organization.");
}

async function enabledFormFlags(orgId: string) {
  const entries = await Promise.all(Object.keys(FLAG_LABELS).map(async (flag) => [flag, await isAppFlagEnabled(orgId, "lead_forms", flag)] as const));
  return Object.fromEntries(entries) as Record<string, boolean>;
}

async function requireFormFlags(orgId: string, definition: Pick<FormDefinition, "steps" | "calculation">) {
  const enabled = await enabledFormFlags(orgId);
  for (const flag of requiredFormFlags(definition)) {
    if (!enabled[flag]) throw forbidden("app_flag_disabled", `${FLAG_LABELS[flag]} are not enabled for this organization.`);
  }
}

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

/** Public bookings act as the organization, like other unattended scheduling paths. */
function systemActor(orgId: string, branchId: string): PlatformAuthContext {
  return { orgId, userId: "", role: "system", branchId, permissions: { "*": true }, identity: { name: "Website form" } } as unknown as PlatformAuthContext;
}

async function appointmentPresets(actor: PlatformAuthContext) {
  const { catalog } = await readAppointmentCatalog(actor);
  return catalog.presets.map((preset) => ({
    id: preset.id,
    label: preset.label,
    duration_minutes: preset.configuration.duration_minutes,
    window_minutes: preset.configuration.window_minutes,
    /** Web booking reserves a single timed visit. */
    bookable_online: preset.configuration.timing_mode === "timed" && !preset.configuration.recurrence,
    configuration: preset.configuration
  }));
}

async function presetConfiguration(actor: PlatformAuthContext, presetId: string): Promise<AppointmentConfiguration> {
  const presets = await appointmentPresets(actor);
  const preset = presets.find((entry) => entry.id === presetId);
  if (!preset) throw badRequest("form_appointment_type_missing", "Choose an appointment type for the appointment picker.");
  if (!preset.bookable_online) throw badRequest("form_appointment_type_unsupported", `'${preset.label}' is a multi-day or recurring appointment type and cannot be booked from a web form.`);
  return appointmentConfigurationSchema.parse({ ...preset.configuration, preset_id: preset.id });
}

function bookingWindow(item: Pick<FormItem, "min_notice_hours" | "horizon_days">) {
  const from = Date.now() + item.min_notice_hours * 3600_000;
  return { from, to: Date.now() + item.horizon_days * 86_400_000 };
}

async function openSlots(actor: PlatformAuthContext, item: FormItem, date: string, address: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest("form_date_invalid", "Choose a valid date.");
  const window = bookingWindow(item);
  const day = new Date(`${date}T12:00:00Z`).getTime();
  if (day < window.from - 36 * 3600_000 || day > window.to + 36 * 3600_000) return [];
  const configuration = await presetConfiguration(actor, item.preset_id);
  // No project exists yet, so availability is planned against the address the visitor entered.
  const planned = configuration.location.mode === "project" && address ? { ...configuration, location: { mode: "custom" as const, address } } : configuration;
  const preview = await previewAppointment(actor, { date, configuration: planned });
  return preview.slots
    .filter((slot) => {
      const start = new Date(str(slot.start_at)).getTime();
      return slot.available === true && start >= window.from && start <= window.to;
    })
    .map((slot) => ({ start_at: str(slot.start_at), label: str(slot.label), available: true }));
}

async function describeAppointment(orgId: string, branchId: string, startAt: string) {
  const zone = await resolveOrganizationTimezone(orgId, branchId).catch(() => "UTC");
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(startAt));
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------

const noCapabilities = {
  read: async () => { throw badRequest("form_calculation_binding", "Form calculations cannot read organization data."); },
  invoke: async () => { throw badRequest("form_calculation_binding", "Form calculations cannot run actions."); }
};

/**
 * Runs a form's calculation in the document-module sandbox. It is evaluate-only
 * and receives nothing but the validated answers, so an anonymous submission
 * can never reach organization data or cause an effect through tenant code.
 */
async function runCalculation(source: string, answers: JsonObject) {
  const result = await runModuleCode({ source, inputs: answers, mode: "evaluate", limits: { milliseconds: 5000, calls: 0, bytes: 200_000 } }, noCapabilities);
  validateJson(estimateOutputSchema, result.outputs, "form estimate");
  return obj(result.outputs.estimate);
}

// ---------------------------------------------------------------------------
// Company brand
// ---------------------------------------------------------------------------

/** The company's current brand, so forms that follow it never go stale after a rebrand. */
async function companyBrand(orgId: string, branchId: string) {
  const branding = obj(await organizationBranding(orgId, branchId).catch(() => ({})));
  const colors = obj(branding.colors);
  const primary = [colors.primary, colors.accent].map(str).find((value) => /^#[0-9a-fA-F]{6}$/.test(value)) || "";
  const font = str(obj(branding.typography).document_font_family);
  const logo = [branding.logo, branding.logo_url, branding.logoUrl].map(str).find((value) => /^https:\/\//i.test(value) || value.startsWith("/v1/")) || "";
  return { primary, font: /^[A-Za-z0-9 ]{1,80}$/.test(font) ? font : "", logo: logo.startsWith("/") ? `${env.publicBaseUrl}${logo}` : logo };
}

function withBrand(presentation: FormDefinition["presentation"], brand: Awaited<ReturnType<typeof companyBrand>>): FormDefinition["presentation"] {
  const style = presentation.style;
  return {
    ...presentation,
    style: {
      ...style,
      ...(style.use_company_colors && brand.primary ? { primary_color: brand.primary } : {}),
      ...(style.use_company_font && brand.font ? { font_family: brand.font } : {}),
      ...(style.logo_enabled && !style.logo_url && brand.logo ? { logo_url: brand.logo } : {})
    }
  };
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

function formView(record: FormRecord, stats?: { count: number; last_at: string }) {
  const published = record.published;
  return {
    id: record.id,
    revision: record.revision,
    name: record.name,
    branch_id: record.branch_id,
    template: record.template,
    definition: record.definition,
    enabled: record.enabled !== false,
    status: !published ? "draft" : record.enabled === false ? "paused" : "live",
    has_unpublished_changes: !!published && (published.definition_hash !== contentHash(record.definition) || published.name !== record.name),
    published: published ? { version: published.version, module_id: published.module_id, published_at: published.published_at } : null,
    public_key: published ? record.public_key : "",
    features: formFeatures(record.definition),
    submissions: stats || { count: 0, last_at: "" },
    created_at: str(record.created_at),
    updated_at: str(record.updated_at)
  };
}

function formFeatures(definition: FormDefinition) {
  const kinds = new Set(formItems(definition).map((item) => item.kind));
  return { appointment: kinds.has("appointment"), measurement: kinds.has("property_measurement"), estimate: !!definition.calculation };
}

async function submissionStats(orgId: string) {
  const stats = new Map<string, { count: number; last_at: string }>();
  for (const submission of await listRecords(orgId, SUBMISSIONS)) {
    if (submission.status !== "complete") continue;
    const entry = stats.get(str(submission.form_id)) || { count: 0, last_at: "" };
    entry.count += 1;
    if (str(submission.created_at) > entry.last_at) entry.last_at = str(submission.created_at);
    stats.set(str(submission.form_id), entry);
  }
  return stats;
}

const branchOf = (auth: PlatformAuthContext) => auth.branchId || "default";

async function ownedForm(auth: PlatformAuthContext, formId: string) {
  const record = await readFormRecord(auth.orgId, formId) as FormRecord;
  if (str(record.branch_id || "default") !== branchOf(auth)) throw notFound("form_not_found", "This form was not found.");
  return record;
}

export async function formsContext(auth: PlatformAuthContext) {
  await requireFormsEnabled(auth.orgId);
  const flags = await enabledFormFlags(auth.orgId);
  const presets = flags.appointment_form ? await appointmentPresets(auth).catch(() => []) : [];
  return {
    capabilities: flags,
    templates: listFormTemplates().map((template) => ({ ...template, available: template.requires.every((flag) => flags[flag]) })),
    blocks: Object.entries(FORM_BLOCKS).map(([kind, block]) => ({ kind, ...block, available: !("capability" in block) || flags[block.capability] === true })),
    measurement_sources: listMeasurementSources(),
    appointment_types: presets.map(({ configuration: _configuration, ...preset }) => preset),
    fonts: FORM_FONTS,
    brand: await companyBrand(auth.orgId, branchOf(auth))
  };
}

export async function listForms(auth: PlatformAuthContext) {
  await requireFormsEnabled(auth.orgId);
  await seedSandboxForms(auth);
  const [records, stats] = await Promise.all([listRecords(auth.orgId, FORMS), submissionStats(auth.orgId)]);
  return records
    .filter((record) => str(record.branch_id || "default") === branchOf(auth))
    .sort((a, b) => str(b.updated_at).localeCompare(str(a.updated_at)))
    .map((record) => formView(record as FormRecord, stats.get(record.id)));
}

export async function getForm(auth: PlatformAuthContext, formId: string) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  return formView(record, (await submissionStats(auth.orgId)).get(record.id));
}

export async function createForm(auth: PlatformAuthContext, input: { template?: string; name?: string; definition?: unknown }) {
  await requireFormsEnabled(auth.orgId);
  const template = formTemplate(str(input.template)) || formTemplate("blank")!;
  const definition = input.definition ? formDraftSchema.parse(input.definition) : buildTemplateDefinition(template.id);
  await requireFormFlags(auth.orgId, definition);
  const id = newFormId();
  const record = await saveRecord(auth.orgId, FORMS, id, {
    name: str(input.name).slice(0, 120) || template.name,
    branch_id: branchOf(auth),
    template: definition.template,
    definition,
    enabled: true,
    public_key: newPublicKey(auth.orgId, id),
    published: null,
    created_by: auth.userId,
    created_at: now(),
    updated_at: now()
  }, { createOnly: true });
  return formView(record as FormRecord);
}

export async function updateForm(auth: PlatformAuthContext, formId: string, input: { name?: string; definition?: unknown; enabled?: boolean; expected_revision?: number }) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  if (input.expected_revision && input.expected_revision !== record.revision) throw conflict("form_revision", "This form changed in another tab. Reload it before saving.");
  const definition = input.definition === undefined ? record.definition : formDraftSchema.parse(input.definition);
  if (input.definition !== undefined) await requireFormFlags(auth.orgId, definition);
  const { id: _id, revision: _revision, ...data } = record;
  const saved = await saveRecord(auth.orgId, FORMS, record.id, {
    ...data,
    name: input.name === undefined ? record.name : str(input.name).slice(0, 120) || record.name,
    definition,
    enabled: input.enabled === undefined ? record.enabled !== false : input.enabled,
    updated_at: now()
  }, { expectedRevision: record.revision });
  // Saved on every edit: submission counts come from the list and detail reads instead.
  return formView(saved as FormRecord);
}

function describeIssues(error: import("zod").ZodError, definition: unknown) {
  const steps = Array.isArray(obj(definition).steps) ? obj(definition).steps as unknown[] : [];
  return error.issues.slice(0, 12).map((issue) => {
    const [root, stepIndex, , itemIndex] = issue.path;
    const step = root === "steps" && typeof stepIndex === "number" ? obj(steps[stepIndex]) : {};
    const item = typeof itemIndex === "number" && Array.isArray(step.items) ? obj(step.items[itemIndex]) : {};
    const where = str(item.label) || str(item.heading) || str(step.title) || (root === "calculation" ? "Pricing" : "");
    return { step_id: str(step.id), item_id: str(item.id), message: where ? `${where}: ${issue.message}` : issue.message };
  });
}

export async function publishForm(auth: PlatformAuthContext, formId: string, input: { expected_revision?: number } = {}) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  if (input.expected_revision && input.expected_revision !== record.revision) throw conflict("form_revision", "This form changed in another tab. Reload it before publishing.");
  const parsed = formDefinitionSchema.safeParse(record.definition);
  if (!parsed.success) throw badRequest("form_incomplete", "Finish these items before publishing.", { issues: describeIssues(parsed.error, record.definition) });
  const definition = parsed.data;
  await requireFormFlags(auth.orgId, definition);
  for (const item of formItems(definition)) {
    if (item.kind === "appointment") await presetConfiguration(auth, item.preset_id);
    if (item.kind === "property_measurement" && !measurementSource(item.source)) throw badRequest("form_measurement_source", "This form uses a measurement that is no longer available.");
  }
  if (definition.calculation?.mode === "code") {
    // Catch code that cannot run at all; missing answers are a normal runtime outcome, not a publish error.
    const failure = await runCalculation(calculationSource(definition), {}).then(() => "", (error) => error instanceof Error ? error.message : "Calculation failed.");
    if (/SyntaxError|is not defined|form estimate/i.test(failure)) throw badRequest("form_calculation_invalid", `The calculation could not run: ${failure}`);
  }
  const module = await storeModuleVersion(auth.orgId, compileFormModule(record.name, definition), `form_module_${record.id}`);
  const { id: _id, revision: _revision, ...data } = record;
  const saved = await saveRecord(auth.orgId, FORMS, record.id, {
    ...data,
    definition,
    published: { module_id: str(module.id), version: str(module.version), definition, definition_hash: contentHash(definition), name: record.name, published_at: now(), published_by: auth.userId },
    public_key: record.public_key || newPublicKey(auth.orgId, record.id),
    updated_at: now()
  }, { expectedRevision: record.revision });
  return formView(saved as FormRecord, (await submissionStats(auth.orgId)).get(record.id));
}

export async function duplicateForm(auth: PlatformAuthContext, formId: string) {
  const record = await ownedForm(auth, formId);
  return createForm(auth, { template: record.template, name: `${record.name} copy`.slice(0, 120), definition: record.definition });
}

export async function deleteForm(auth: PlatformAuthContext, formId: string) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  await removeRecord(auth.orgId, FORMS, record.id);
  return { id: record.id };
}

export async function rotateFormKey(auth: PlatformAuthContext, formId: string) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  const { id: _id, revision: _revision, ...data } = record;
  const saved = await saveRecord(auth.orgId, FORMS, record.id, { ...data, public_key: newPublicKey(auth.orgId, record.id), updated_at: now() }, { expectedRevision: record.revision });
  return formView(saved as FormRecord);
}

/** Views, starts, completion, step funnel, answer breakdowns and recent submissions for one form. */
export async function formInsights(auth: PlatformAuthContext, formId: string) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  const insights = await buildInsights(auth.orgId, record.id, formDraftSchema.parse(record.published?.definition || record.definition));
  return { form: { id: record.id, name: record.name, status: !record.published ? "draft" : record.enabled === false ? "paused" : "live" }, ...insights };
}

/**
 * Instant development organizations start with the three forms a typical company
 * wants, already published. Seeded once; deleting them does not bring them back.
 */
async function seedSandboxForms(auth: PlatformAuthContext) {
  if (env.dataEnvironment !== "development") return;
  const organization = obj(await readOrganization(auth.orgId).catch(() => ({})));
  if (obj(organization.metadata).sandbox_workflow_id !== "swf_instant_full_org") return;
  if (await findRecord(auth.orgId, ACTIVITY, "sandbox_seed")) return;
  await saveRecord(auth.orgId, ACTIVITY, "sandbox_seed", { form_id: "", seeded_at: now() });
  if ((await listRecords(auth.orgId, FORMS)).length) return;
  const flags = await enabledFormFlags(auth.orgId);
  const preset = flags.appointment_form ? (await appointmentPresets(auth).catch(() => [])).find((entry) => entry.bookable_online) : null;
  const seeds: Array<[string, string, boolean]> = [
    ["contact", "Contact us", flags.contact_form === true],
    ["roofing_instant_estimate", "Instant roof estimate", flags.instant_estimate === true],
    ["appointment", "Book an appointment", !!preset]
  ];
  for (const [template, name, enabled] of seeds) {
    if (!enabled) continue;
    try {
      const form = await createForm(auth, { template, name });
      if (template === "appointment") {
        const picker = formItems(form.definition).find((item) => item.kind === "appointment");
        if (picker && preset) picker.preset_id = preset.id;
        await updateForm(auth, form.id, { definition: form.definition });
      }
      await publishForm(auth, form.id);
    } catch (error) {
      console.warn(`[forms] sandbox seed ${template} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

export async function listFormSubmissions(auth: PlatformAuthContext, formId: string) {
  await requireFormsEnabled(auth.orgId);
  const record = await ownedForm(auth, formId);
  return (await listRecords(auth.orgId, SUBMISSIONS))
    .filter((submission) => submission.form_id === record.id && submission.status === "complete")
    .sort((a, b) => str(b.created_at).localeCompare(str(a.created_at)))
    .slice(0, 200)
    .map((submission) => ({
      id: submission.id,
      created_at: str(submission.created_at),
      contact: obj(submission.contact),
      address: str(submission.address),
      summary: Array.isArray(submission.summary) ? submission.summary : [],
      estimate: submission.estimate || null,
      appointment: submission.appointment || null,
      project_id: str(submission.project_id),
      page_url: str(submission.page_url)
    }));
}

/** Prices example answers against a draft. Used by the form builder agent to check its own pricing. */
export function priceDraft(definition: FormDefinition, answers: JsonObject) {
  return runCalculation(calculationSource(definition), answers);
}

// --- Editor preview: the same blocks as the live form, against the draft ----

export async function previewMeasurement(auth: PlatformAuthContext, input: { source: string; address: string; tint?: string }) {
  await requireFormsEnabled(auth.orgId);
  const source = measurementSource(str(input.source));
  if (!source) throw badRequest("form_measurement_source", "Unknown measurement.");
  if (!str(input.address)) throw badRequest("form_address_required", "Enter an address to measure.");
  const result = await source.measure({ address: str(input.address), tint: str(input.tint), preview: true });
  return { measured: result.ok, values: result.values, facts: result.facts, formatted_address: result.formatted_address || str(input.address), preview: result.preview || null, message: result.message || "", token: signMeasurement("preview", source.id, str(input.address), result.values) };
}

export async function previewAvailability(auth: PlatformAuthContext, input: { item?: unknown; date: string; address?: string }) {
  await requireFormsEnabled(auth.orgId);
  const item = obj(input.item);
  const slots = await openSlots(auth, { preset_id: str(item.preset_id), min_notice_hours: Number(item.min_notice_hours ?? 2), horizon_days: Number(item.horizon_days ?? 45) } as FormItem, str(input.date), str(input.address));
  return { date: str(input.date), slots };
}

/** Dry run of a submission against an unsaved draft: validates and prices, creates nothing. */
export async function testForm(auth: PlatformAuthContext, input: { definition?: unknown; answers?: unknown; measurements?: unknown }) {
  await requireFormsEnabled(auth.orgId);
  const parsed = formDefinitionSchema.safeParse(input.definition);
  if (!parsed.success) throw badRequest("form_incomplete", "Finish these items before testing.", { issues: describeIssues(parsed.error, input.definition) });
  const definition = parsed.data;
  const raw = obj(input.answers);
  const measured: JsonObject = {};
  for (const item of formItems(definition)) {
    if (item.kind !== "property_measurement" || !item.param) continue;
    const address = str(raw[item.address_param || ""]);
    measured[item.param] = verifyMeasurement(obj(input.measurements)[item.id], "preview", item.source, address) || { status: "unavailable" };
  }
  const { answers, issues } = collectAnswers(definition, raw, measured);
  if (issues.length) throw new PlatformError("form_invalid", 422, "Some answers need attention.", { issues });
  validateJson(formInputSchema(definition), answers, "form answers");
  const estimate = definition.calculation ? await runCalculation(calculationSource(definition), answers) : null;
  const appointmentItem = formItems(definition).find((item) => item.kind === "appointment" && item.param && answers[item.param]);
  const start = appointmentItem ? str(obj(answers[appointmentItem.param!]).start_at) : "";
  return {
    ok: true,
    preview: true,
    success: definition.presentation.success,
    ...(estimate ? { estimate } : {}),
    ...(start ? { appointment: { status: "booked", start_at: start, label: await describeAppointment(auth.orgId, branchOf(auth), start) } } : {})
  };
}

// ---------------------------------------------------------------------------
// Public runtime
// ---------------------------------------------------------------------------

type LiveForm = { orgId: string; branchId: string; record: FormRecord; published: Published; definition: FormDefinition };

async function liveForm(publicKey: string): Promise<LiveForm> {
  const parsed = parsePublicKey(publicKey);
  const record = parsed ? await findRecord(parsed.orgId, FORMS, parsed.formId).catch(() => null) as FormRecord | null : null;
  if (!parsed || !record || record.public_key !== publicKey || !record.published) throw notFound("form_not_found", "This form is not available.");
  if (record.enabled === false) throw forbidden("form_paused", "This form is not accepting responses right now.");
  await requireFormsEnabled(parsed.orgId);
  await requireFormFlags(parsed.orgId, record.published.definition);
  return { orgId: parsed.orgId, branchId: str(record.branch_id) || "default", record, published: record.published, definition: record.published.definition };
}

function publicItem(item: FormItem) {
  const { maps_to: _maps, preset_id: _preset, min_notice_hours: _notice, ...rest } = item;
  return rest;
}

/** Anonymous counts of how far visitors get. Never fails a visitor's request. */
export async function recordPublicActivity(publicKey: string, event: ActivityEvent) {
  const form = await liveForm(publicKey);
  if (event.type === "step" && !form.definition.steps.some((step) => step.id === event.step_id)) return;
  await recordActivity(form.orgId, form.record.id, event).catch(() => undefined);
}

export async function publicForm(publicKey: string) {
  const { record, published, definition, orgId, branchId } = await liveForm(publicKey);
  return {
    ok: true,
    form: {
      key: publicKey,
      name: published.name || record.name,
      version: published.version,
      presentation: withBrand(definition.presentation, await companyBrand(orgId, branchId)),
      steps: definition.steps.map((step) => ({ ...step, items: step.items.map(publicItem) })),
      features: formFeatures(definition)
    }
  };
}

function itemOfKind(definition: FormDefinition, itemId: string, kind: FormItem["kind"]) {
  const item = formItems(definition).find((entry) => entry.id === itemId && entry.kind === kind);
  if (!item) throw badRequest("form_block_unknown", "This form does not have that block.");
  return item;
}

export async function publicAvailability(publicKey: string, query: { item_id?: unknown; date?: unknown; address?: unknown }) {
  const form = await liveForm(publicKey);
  const item = itemOfKind(form.definition, str(query.item_id), "appointment");
  const date = str(query.date);
  return { ok: true, date, slots: await openSlots(systemActor(form.orgId, form.branchId), item, date, str(query.address).slice(0, 400)) };
}

export async function publicMeasurement(publicKey: string, body: { item_id?: unknown; address?: unknown }) {
  const form = await liveForm(publicKey);
  const item = itemOfKind(form.definition, str(body.item_id), "property_measurement");
  const address = str(body.address).slice(0, 400);
  if (!address) throw badRequest("form_address_required", "Enter an address first.");
  const source = measurementSource(item.source);
  if (!source) throw badRequest("form_measurement_source", "This measurement is not available.");
  const result = await source.measure({ address, tint: form.definition.presentation.style.primary_color, preview: true });
  return { ok: true, measured: result.ok, values: result.values, facts: result.facts, formatted_address: result.formatted_address || address, preview: result.preview || null, message: result.message || "", token: signMeasurement(form.record.id, item.id, address, result.values) };
}

function estimateLines(estimate: JsonObject) {
  const currency = str(estimate.currency) || "USD";
  const money = (value: unknown) => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(value) || 0);
  const range = (low: unknown, high: unknown) => Number(low) === Number(high) ? money(low) : `${money(low)} – ${money(high)}`;
  const options = Array.isArray(estimate.options) ? estimate.options.map(obj) : [];
  return { range: range(estimate.low, estimate.high), options: options.map((option) => ({ label: str(option.label), range: range(option.low, option.high) })) };
}

async function sendCustomerEmail(form: LiveForm, input: { email: string; name: string; projectId: string; submissionId: string; estimate: JsonObject | null; appointment: JsonObject | null }) {
  const settings = form.definition.settings.customer_email;
  if (!settings.enabled || !input.email) return;
  const success = form.definition.presentation.success;
  const subject = settings.subject || success.title || form.published.name;
  // The recipient and name are whatever the visitor typed. Only greet with something that is plainly a name,
  // so the company's sending identity cannot be used to deliver someone else's message.
  const greeting = /^[\p{L}\p{M}][\p{L}\p{M}' .-]{0,59}$/u.test(input.name) ? `, ${input.name}` : "";
  const intro = settings.intro || `Thanks${greeting}. ${success.body}`.trim();
  const lines: string[] = [];
  if (input.appointment) lines.push(`${input.appointment.status === "booked" ? "Your appointment" : "Requested time"}: ${str(input.appointment.label)}`);
  if (input.estimate) {
    const { range, options } = estimateLines(input.estimate);
    if (options.length > 1) for (const option of options) lines.push(`${option.label}: ${option.range}`);
    else lines.push(`Estimated range: ${range}`);
    const quantity = obj(input.estimate.quantity);
    if (Number(quantity.value)) lines.push(`${str(quantity.label) || "Quantity"}: ${Number(quantity.value).toLocaleString("en-US")} ${str(quantity.unit)}`.trim());
  }
  const disclaimer = str(input.estimate?.disclaimer) || form.definition.presentation.fine_print;
  const cta = settings.cta_label && /^https:\/\//i.test(settings.cta_url) ? { label: settings.cta_label, url: settings.cta_url } : null;
  await sendOrganizationTransactionalEmail({
    organizationId: form.orgId,
    branchId: form.branchId,
    to: input.email,
    subject,
    textBody: [intro, lines.join("\n"), cta ? `${cta.label}: ${cta.url}` : "", disclaimer].filter(Boolean).join("\n\n"),
    htmlBody: [
      `<div style="font-family:Arial,sans-serif;color:#111827;">`,
      `<p style="font-size:16px;line-height:1.5;">${escapeEmailHtml(intro)}</p>`,
      lines.length ? `<ul style="font-size:15px;line-height:1.6;">${lines.map((line) => `<li>${escapeEmailHtml(line)}</li>`).join("")}</ul>` : "",
      cta ? `<p><a href="${escapeEmailHtml(cta.url)}" style="display:inline-block;padding:11px 16px;border-radius:8px;background:#111827;color:#ffffff;text-decoration:none;font-weight:700;">${escapeEmailHtml(cta.label)}</a></p>` : "",
      disclaimer ? `<p style="font-size:12px;line-height:1.45;color:#6b7280;">${escapeEmailHtml(disclaimer)}</p>` : "",
      `</div>`
    ].join(""),
    purpose: "transactional",
    projectId: input.projectId,
    tags: ["web-form"],
    source: { type: "automation", automation_id: "forms.submission" },
    metadata: { form_id: form.record.id, project_id: input.projectId },
    idempotencyKey: `form_submission:${input.submissionId}:${input.email}`
  });
}

/** Typed sink for answers: blocks with `maps_to` write the project's declared custom fields. */
async function writeMappedFields(form: LiveForm, projectId: string, submissionId: string, answers: JsonObject) {
  const values: JsonObject = {};
  for (const item of formItems(form.definition)) if (item.maps_to && item.param && Object.hasOwn(answers, item.param)) values[item.maps_to] = answers[item.param];
  if (!Object.keys(values).length) return;
  const project = await readDocument(form.orgId, "projects", projectId);
  const ctx = systemPublicationContext({ kind: "module", organizationId: form.orgId, projectId, branchId: form.branchId, operations: ["custom-fields.project.write"], mode: "command" });
  await invokeAction(ctx, { action: "custom-fields.project.write", target: { scope: "project", organizationId: form.orgId, projectId } }, { values, expectedRevision: Number(project.revision) }, { idempotencyKey: `form_submission:${submissionId}` });
}

/** Records the submission on the project as a frozen instance of the form's published module. */
async function attachModuleInstance(form: LiveForm, projectId: string, submissionId: string, answers: JsonObject) {
  if (!(await isCapabilityEnabled(form.orgId, "platform.documents"))) return;
  const ctx = systemPublicationContext({ kind: "module", organizationId: form.orgId, projectId, branchId: form.branchId, operations: ["document-modules.manage", "document-modules.read"] });
  const instance = await createModuleInstance(ctx, { moduleId: form.published.module_id, version: form.published.version, projectId, inputs: answers }, `module_instance_${submissionId}`);
  const evaluated = await evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision });
  await freezeModuleInstance(ctx, instance.id, Number(obj(evaluated.instance).revision));
}

export type SubmissionMeta = { ip?: string; userAgent?: string };

export async function submitPublicForm(publicKey: string, body: JsonObject, meta: SubmissionMeta = {}) {
  const form = await liveForm(publicKey);
  const { definition, orgId, branchId, record, published } = form;
  // Bots fill every field; a real visitor never sees this one. Answer as if it worked.
  if (str(body.website_url)) return { response: { ok: true, accepted: true, success: definition.presentation.success }, background: Promise.resolve() };

  const raw = obj(body.answers);
  const items = formItems(definition);
  const measured: JsonObject = {};
  for (const item of items) {
    if (item.kind !== "property_measurement" || !item.param) continue;
    const address = str(raw[item.address_param || ""]);
    const signed = verifyMeasurement(obj(body.measurements)[item.id], record.id, item.id, address);
    measured[item.param] = signed || (address ? (await measurementSource(item.source)?.measure({ address }).catch(() => null))?.values : null) || { status: "unavailable" };
  }
  const { answers, issues } = collectAnswers(definition, raw, measured);
  if (issues.length) throw new PlatformError("form_invalid", 422, "Some answers need attention.", { issues });
  validateJson(formInputSchema(definition), answers, "form answers");

  const contactItem = items.find((item) => item.kind === "contact");
  const contact = obj(contactItem?.param ? answers[contactItem.param] : null);
  const addressItem = items.find((item) => item.kind === "address" && item.param && answers[item.param]);
  const address = str(addressItem?.param ? answers[addressItem.param] : "");
  const summary = summarizeAnswers(definition, answers);
  if (!Object.keys(contact).length && !address && !summary.length) throw badRequest("form_empty", "Add your details before submitting.");

  const clientId = str(body.submission_id).slice(0, 80) || randomUUID();
  const submissionId = `sub_${createHash("sha256").update(`${record.id}:${clientId}`).digest("hex").slice(0, 32)}`;
  const prior = await findRecord(orgId, SUBMISSIONS, submissionId);
  if (prior?.status === "complete") return { response: obj(prior.response), background: Promise.resolve() };
  // A claim left behind by a crashed request stops blocking retries after two minutes.
  if (prior && Date.now() - new Date(str(prior.created_at)).getTime() < 120_000) throw conflict("form_submission_pending", "This submission is still being processed.");
  await saveRecord(orgId, SUBMISSIONS, submissionId, { form_id: record.id, status: "processing", created_at: now() }, { createOnly: !prior });
  const projectId = `project_f${submissionId.slice(4, 24)}`;
  let leadCreated = false;

  try {
    const actor = systemActor(orgId, branchId);
    const appointmentItem = items.find((item) => item.kind === "appointment" && item.param && answers[item.param]);
    const requestedStart = appointmentItem ? str(obj(answers[appointmentItem.param!]).start_at) : "";
    if (appointmentItem && requestedStart) {
      const date = new Intl.DateTimeFormat("en-CA", { timeZone: await resolveOrganizationTimezone(orgId, branchId).catch(() => "UTC"), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(requestedStart));
      const open = await openSlots(actor, appointmentItem, date, address);
      if (!open.some((slot) => slot.start_at === requestedStart)) {
        throw new PlatformError("form_slot_unavailable", 409, "That time was just taken. Please choose another time.", { issues: [{ item_id: appointmentItem.id, param: appointmentItem.param, message: "That time was just taken. Please choose another time." }] });
      }
    }

    // A pricing failure (nothing to measure, no matching option, a slow sandbox) must never cost the lead.
    let estimate: JsonObject | null = null;
    let estimateError = "";
    if (definition.calculation) {
      try {
        const module = await getModuleRecord(orgId, VERSIONS, `${published.module_id}_${published.version}`);
        estimate = await runCalculation(str(obj(module.definition).source), answers);
      } catch (error) {
        estimateError = error instanceof Error ? error.message.slice(0, 300) : "The estimate could not be calculated.";
      }
    }

    const name = str(contact.name);
    const email = str(contact.email);
    const phone = str(contact.phone);
    const message = items.filter((item) => item.kind === "paragraph" && item.param && answers[item.param]).map((item) => str(answers[item.param!])).join("\n\n");
    const source = {
      form_id: record.id,
      form_name: published.name,
      template: definition.template,
      tracking_key: definition.settings.tracking_key || record.id,
      page_url: str(body.page_url).slice(0, 2000),
      referrer: str(body.referrer).slice(0, 2000)
    };
    const created = await createPlatformLead(orgId, {
      project_id: projectId,
      branch_id: branchId,
      stage_id: definition.settings.stage_id || "new_lead",
      source_kind: "web_form",
      address,
      title: address || name || published.name,
      summary: message,
      contacts: name || email || phone ? [{ name, email, phone, phones: phone ? [phone] : [] }] : [],
      provider: "Web form",
      confidence: 1,
      provider_fields: { ...source, answers: summary },
      lead_source: { kind: "web_form", provider: "Web form", ...source },
      project_data: {
        form_submission: { id: submissionId, ...source, version: published.version, answers, summary, ...(estimate ? { estimate } : {}), ...(estimateError ? { estimate_error: estimateError } : {}), ...(requestedStart ? { requested_start_at: requestedStart } : {}) }
      },
      notification: {
        source: "web_form_lead_import",
        title: estimate || estimateError ? `New estimate request: ${published.name}` : requestedStart ? `New booking: ${published.name}` : `New form lead: ${published.name}`,
        body: [address, name, phone, email].filter(Boolean).join(" · ") || message || "A website form was submitted.",
        target_role_ids: definition.settings.notify_role_ids,
        context: { form_id: record.id, submission_id: submissionId }
      }
    });
    leadCreated = true;

    let appointment: JsonObject | null = null;
    if (appointmentItem && requestedStart) {
      const label = await describeAppointment(orgId, branchId, requestedStart);
      try {
        const booked = await bookPlannedAppointment(actor, { project_id: projectId, event_id: `appointment_${submissionId.slice(4)}`, start_at: requestedStart, configuration: await presetConfiguration(actor, appointmentItem.preset_id) });
        appointment = { status: "booked", start_at: requestedStart, label, event_id: str(obj(obj(booked).event).id) };
      } catch (error) {
        // The lead is already captured; staff confirm the time rather than losing the visitor.
        appointment = { status: "requested", start_at: requestedStart, label, reason: error instanceof PlatformError ? error.code : "booking_failed" };
      }
    }

    const response = {
      ok: true,
      accepted: true,
      submission_id: submissionId,
      success: definition.presentation.success,
      ...(estimate ? { estimate } : {}),
      ...(estimateError ? { estimate_unavailable: true } : {}),
      ...(appointment ? { appointment: { status: appointment.status, start_at: appointment.start_at, label: appointment.label } } : {})
    };
    await saveRecord(orgId, SUBMISSIONS, submissionId, {
      form_id: record.id,
      form_name: published.name,
      version: published.version,
      branch_id: branchId,
      status: "complete",
      answers,
      summary,
      contact,
      address,
      estimate,
      ...(estimateError ? { estimate_error: estimateError } : {}),
      appointment,
      project_id: projectId,
      page_url: source.page_url,
      referrer: source.referrer,
      user_agent: str(meta.userAgent).slice(0, 300),
      response,
      created_at: now()
    });

    // The submission is complete from here on: nothing below may fail the visitor's confirmation.
    const quiet = (label: string, work: Promise<unknown>) => work.then(() => undefined).catch((error) => { console.warn(`[forms] ${label} failed for ${submissionId}:`, error instanceof Error ? error.message : error); });
    const event = { organization_id: orgId, branch_id: branchId, ...(projectId ? { project_id: projectId } : {}), context: { source: "forms_public_submission" } };
    await quiet("submitted event", emitWorkEvent({
      ...event,
      type: "lead.form.submitted",
      idempotency_key: `lead.form.submitted:${submissionId}`,
      payload: { form_id: record.id, form_name: published.name, template: definition.template, submission_id: submissionId, ...(projectId ? { project_id: projectId } : {}), ...(appointment ? { appointment_status: appointment.status } : {}) }
    }));
    if (estimate) {
      const quantity = obj(estimate.quantity);
      await quiet("estimate event", emitWorkEvent({
        ...event,
        type: "lead.instant_estimate.generated",
        idempotency_key: `lead.instant_estimate.generated:${submissionId}`,
        payload: {
          form_id: record.id,
          submission_id: submissionId,
          low_cents: Math.round(Number(estimate.low || 0) * 100),
          high_cents: Math.round(Number(estimate.high || 0) * 100),
          currency: str(estimate.currency) || "USD",
          ...(Number(quantity.value) ? { quantity: Number(quantity.value), quantity_unit: str(quantity.unit) } : {}),
          ...(projectId ? { project_id: projectId } : {})
        }
      }));
    }

    // Follow-ups never delay the visitor's confirmation.
    // Sequential: two of these revise the same project document.
    const background = (async () => {
      if (projectId) await quiet("custom field mapping", writeMappedFields(form, projectId, submissionId, answers));
      if (projectId && estimate) await quiet("module instance", attachModuleInstance(form, projectId, submissionId, answers));
      await quiet("customer email", sendCustomerEmail(form, { email, name, projectId, submissionId, estimate, appointment }));
    })();
    return { response, background };
  } catch (error) {
    // Before the lead exists the claim is released so the visitor can correct and resend. Once it
    // exists the claim stays: a retry with the same id waits, then resumes onto the same lead and booking.
    if (!leadCreated) await removeRecord(orgId, SUBMISSIONS, submissionId).catch(() => undefined);
    throw error;
  }
}

/** For the web builder: forms that can be placed on a page. */
export async function embeddableForms(orgId: string) {
  return (await listRecords(orgId, FORMS).catch(() => [])).map((record) => {
    const form = record as FormRecord;
    const features = formFeatures(form.published?.definition || form.definition);
    return {
      id: form.id,
      name: form.published?.name || form.name,
      kind: features.appointment ? "appointment" : features.estimate ? "estimate" : "contact",
      enabled: !!form.published && form.enabled !== false,
      public_key: form.published ? form.public_key : ""
    };
  });
}
