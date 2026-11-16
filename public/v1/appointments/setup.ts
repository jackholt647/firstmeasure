import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { readCompanyProfile, type CompanyProfile } from "../company-profile/profile.js";
import { appointmentConfigurationSchema, readAppointmentCatalog, saveAppointmentCatalog } from "./planning.js";

/**
 * The appointment setup (FM-515, docs/architecture/setup-steps.md, "The appointment steps"): what kinds of appointments
 * an organization schedules, and for each, whether the customer gets a text before it and when someone is on the way,
 * and who goes. The kinds are a setup step (`appointments.kinds`, asked once, saved with `appointments.kinds.save`);
 * the per-kind questions are the `appointments.setup` experience, finished with `appointments.setup.apply`. Both write
 * the organization's appointment types (the scheduling catalog's presets) through the catalog's own writer, so Settings
 * and the New appointment dialog show them at once. Who goes is decided from the company profile's answers to who sells
 * and who does the work, and those answers also give the organization the group and company types it needs.
 *
 * What was answered is kept apart from the catalog, in the default branch's `appointment_setup` module: the catalog
 * says what can be booked, this says what the organization told us.
 */
export const APPOINTMENT_SETUP_MODULE = "appointment_setup";

type Copy = { key: string; text: string };
const c = (key: string, text: string): Copy => ({ key: `gx_appt_${key}`, text });
export const APPOINTMENT_CATEGORIES = ["sales", "production", "other"] as const;
export type AppointmentCategory = typeof APPOINTMENT_CATEGORIES[number];
export const APPOINTMENT_ATTENDEES = ["me", "sales_team", "crews", "subcontractors", "anyone"] as const;
export type AppointmentAttendee = typeof APPOINTMENT_ATTENDEES[number];

type KindDefaults = Partial<z.input<typeof appointmentConfigurationSchema>>;
export type AppointmentKind = { id: string; label: Copy; category: AppointmentCategory; configuration: KindDefaults; industries?: string[]; packs?: string[] };
const kind = (id: string, text: string, category: AppointmentCategory, configuration: KindDefaults, where: { industries?: string[]; packs?: string[] } = {}): AppointmentKind => ({ id, label: c(`kind_${id}`, text), category, configuration, ...where });

/** The kinds of appointment the setup suggests. Data that only grows: never change an id or its meaning. */
export const APPOINTMENT_KINDS: readonly AppointmentKind[] = Object.freeze([
  kind("sales", "Sales appointment", "sales", { duration_minutes: 60, window_minutes: 60 }),
  kind("inspection", "Inspection", "sales", { duration_minutes: 60, window_minutes: 60 }, { industries: ["roofing", "exteriors", "solar"] }),
  kind("installation", "Installation", "production", { timing_mode: "days", duration_days: 1 }),
  kind("repair", "Repair appointment", "production", { duration_minutes: 60, window_minutes: 240 }),
  kind("service_call", "Service call", "production", { duration_minutes: 60, window_minutes: 240 }, { packs: ["home_services"] }),
  kind("maintenance", "Maintenance visit", "production", { duration_minutes: 60, window_minutes: 240 }, { industries: ["hvac", "plumbing", "landscaping"] }),
  kind("delivery", "Material delivery", "production", { duration_minutes: 60, window_minutes: 240, delivery: true }),
  kind("walkthrough", "Final walkthrough", "production", { duration_minutes: 60, window_minutes: 60 }),
  kind("meeting", "Team meeting", "other", { duration_minutes: 60, window_minutes: 60, location: { mode: "company_office", address: "" } })
]);
const kindById = new Map(APPOINTMENT_KINDS.map((entry) => [entry.id, entry]));
const CATEGORY_COPY: Record<AppointmentCategory, Copy> = { sales: c("category_sales", "Sales"), production: c("category_production", "Production"), other: c("category_other", "Other") };
const ATTENDEE_COPY: Record<AppointmentAttendee, Copy> = {
  me: c("attendee_me", "Me"), sales_team: c("attendee_sales_team", "Our sales team"), crews: c("attendee_crews", "A crew"),
  subcontractors: c("attendee_subcontractors", "A subcontractor"), anyone: c("attendee_anyone", "Whoever is free")
};
/** The group and company types the team answers need (assignee-base.md "The type lists"). */
const SALES_TEAM_TYPE = { kind: "resource_group" as const, id: "sales_team", name: "Sales team", description: "Salespeople who run sales appointments." };
const CREW_TYPE = { kind: "resource_group" as const, id: "crew", name: "Crew", description: "An internal production team that can be assigned work as a unit." };
const SUBCONTRACTOR_TYPE = { kind: "organization_connection" as const, id: "subcontractor", name: "Subcontractor", description: "An outside company that does work for us." };

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => String(value ?? "").trim();
const slug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

/** The kinds suggested for this company: the common ones, and those its kind of company usually has. */
export function suggestedKinds(profile: Pick<CompanyProfile, "industry" | "crm_pack" | "sales_team">) {
  const ids = ["sales", "installation", "repair"].filter((id) => id !== "sales" || profile.sales_team !== "no_sales");
  for (const entry of APPOINTMENT_KINDS) {
    if (ids.includes(entry.id)) continue;
    if ((profile.industry && entry.industries?.includes(profile.industry)) || (profile.crm_pack && entry.packs?.includes(profile.crm_pack))) ids.push(entry.id);
  }
  return ids;
}
/** Who goes to a kind of appointment unless the person says otherwise, from who sells and who does the work. */
export function defaultAttendee(category: AppointmentCategory, profile: Pick<CompanyProfile, "sales_team" | "workforce">): AppointmentAttendee {
  if (category === "sales") return profile.sales_team === "just_me" ? "me" : profile.sales_team === "small_team" || profile.sales_team === "managed_team" ? "sales_team" : "anyone";
  if (category === "production") return profile.workforce === "just_me" ? "me" : profile.workforce === "crews" || profile.workforce === "crews_and_subs" ? "crews" : profile.workforce === "subcontractors" ? "subcontractors" : "anyone";
  return "anyone";
}
/** The answers offered for who goes: always me and whoever is free, and the teams this company said it has. */
export function offeredAttendees(profile: Pick<CompanyProfile, "sales_team" | "workforce">): AppointmentAttendee[] {
  const offered: AppointmentAttendee[] = ["me"];
  if (profile.sales_team === "small_team" || profile.sales_team === "managed_team") offered.push("sales_team");
  if (profile.workforce === "crews" || profile.workforce === "crews_and_subs") offered.push("crews");
  if (profile.workforce === "subcontractors" || profile.workforce === "crews_and_subs") offered.push("subcontractors");
  offered.push("anyone");
  return offered;
}

// ── What was answered ───────────────────────────────────────────────────
const storedKindSchema = z.object({ id: z.string(), label: z.string(), category: z.enum(APPOINTMENT_CATEGORIES), custom: z.boolean().default(false) }).strict();
const storedTypeSchema = z.object({ id: z.string(), reminder: z.boolean(), on_my_way: z.boolean(), attendee: z.enum(APPOINTMENT_ATTENDEES) }).strict();
type StoredKind = z.infer<typeof storedKindSchema>;
type StoredType = z.infer<typeof storedTypeSchema>;

async function stored(orgId: string) {
  try { return await readBranchModule(orgId, "default", APPOINTMENT_SETUP_MODULE); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
}
async function writeRecord(orgId: string, patch: JsonObject, userId: string) {
  const current = await stored(orgId);
  await saveBranchModule(orgId, "default", APPOINTMENT_SETUP_MODULE, { data: { ...object(current?.data), ...patch, updated_by: userId } as JsonObject, expected_revision: Number(current?.revision || 0) }, { replace: true });
}
const parsedList = <T>(schema: z.ZodType<T>, value: unknown): T[] => list(value).map((row) => schema.safeParse(row)).filter((row) => row.success).map((row) => (row as { data: T }).data);

/** What the setup knows: the kinds answered, and each one's texts and who goes (answered, or the defaults). */
export async function readAppointmentSetup(orgId: string) {
  const [record, profile] = await Promise.all([stored(orgId), readCompanyProfile(orgId)]);
  const data = object(record?.data);
  const kinds = parsedList(storedKindSchema, data.kinds);
  const types = new Map(parsedList(storedTypeSchema, data.types).map((entry) => [entry.id, entry]));
  return {
    answered: { kinds: kinds.length > 0, types: !!text(data.applied_at) },
    kinds: kinds.map((entry) => {
      const answered = types.get(entry.id);
      return { ...entry, reminder: answered?.reminder ?? entry.category !== "other", on_my_way: answered?.on_my_way ?? entry.category !== "other", attendee: answered?.attendee ?? defaultAttendee(entry.category, profile), answered: !!answered };
    }),
    attendees: offeredAttendees(profile),
    sales_team: profile.sales_team, workforce: profile.workforce,
    applied_at: text(data.applied_at) || null,
    revision: Number(record?.revision || 0)
  };
}
export function publishedAppointmentCatalog(profile: CompanyProfile) {
  return {
    kinds: APPOINTMENT_KINDS.map((entry) => ({ id: entry.id, label: entry.label, category: entry.category })),
    categories: APPOINTMENT_CATEGORIES.map((id) => ({ id, label: CATEGORY_COPY[id] })),
    attendees: APPOINTMENT_ATTENDEES.map((id) => ({ id, label: ATTENDEE_COPY[id] })),
    suggested: suggestedKinds(profile)
  };
}

// ── Writing the appointment types ───────────────────────────────────────
function requirementsFor(attendee: AppointmentAttendee, userId: string, departmentId: string | undefined) {
  const department = departmentId ? { department_id: departmentId } : {};
  if (attendee === "me") return userId ? [{ subject_type: "organization_user", mode: "specific", subject_keys: [`organization_user:${userId}`] }] : [{ subject_type: "organization_user", mode: "count", count: 1 }];
  if (attendee === "sales_team") return [{ ...department, subject_type: "organization_user", mode: "count", count: 1 }];
  if (attendee === "crews") return [{ ...department, subject_type: "resource_group", mode: "count", count: 1, crew_member_percent: 100 }];
  // An outside company is not booked by the planner: whoever books it says who goes.
  if (attendee === "subcontractors") return [];
  return [{ subject_type: "organization_user", mode: "count", count: 1 }];
}
const CATEGORY_DEPARTMENT: Record<AppointmentCategory, string | null> = { sales: "sales", production: "production", other: null };

/**
 * Puts the setup's kinds into the person's branch's appointment types, through the catalog's own writer. A catalog
 * nobody has saved (the built-in Sales and Production types) becomes exactly the kinds picked; a saved one keeps every
 * type it has and gains the kinds it lacks. `answers` (by kind id) also sets each type's texts and who goes.
 */
async function writeTypes(auth: PlatformAuthContext, kinds: StoredKind[], answers: Map<string, StoredType> | null) {
  const bundle = await readAppointmentCatalog(auth);
  const saved = bundle.revision > 0;
  const activeDepartments = new Set(bundle.catalog.departments.filter((entry) => entry.status === "active").map((entry) => entry.id));
  const presets = saved ? [...bundle.catalog.presets] : [];
  for (const entry of kinds) {
    const known = kindById.get(entry.id);
    const departmentId = CATEGORY_DEPARTMENT[entry.category] && activeDepartments.has(CATEGORY_DEPARTMENT[entry.category]!) ? CATEGORY_DEPARTMENT[entry.category]! : undefined;
    const at = presets.findIndex((preset) => preset.id === entry.id);
    const answer = answers?.get(entry.id);
    if (at >= 0 && !answer) continue;
    const base = at >= 0 ? presets[at]!.configuration : appointmentConfigurationSchema.parse({ title: entry.label, ...(known?.configuration || { duration_minutes: 60, window_minutes: 60 }), department_ids: departmentId ? [departmentId] : [] });
    const configuration = answer
      ? appointmentConfigurationSchema.parse({ ...base, requirements: requirementsFor(answer.attendee, auth.userId, departmentId), customer_texts: { reminder: answer.reminder, on_my_way: answer.on_my_way } })
      : appointmentConfigurationSchema.parse({ ...base, requirements: requirementsFor("anyone", auth.userId, departmentId) });
    const preset = { id: entry.id, label: at >= 0 ? presets[at]!.label : entry.label, configuration };
    if (at >= 0) presets[at] = preset; else presets.push(preset);
  }
  await saveAppointmentCatalog(auth, { catalog: { ...bundle.catalog, presets }, revision: bundle.revision });
}

/** Gives the organization the group and company types its answers name: a sales team, crews, subcontractors. */
async function ensureTeamTypes(auth: PlatformAuthContext, profile: CompanyProfile) {
  const { listAssigneeTypes, saveAssigneeType } = await import("../assignees/base.js");
  const wanted = [
    ...(profile.sales_is_team ? [SALES_TEAM_TYPE] : []),
    ...(profile.workforce === "crews" || profile.workforce === "crews_and_subs" ? [CREW_TYPE] : []),
    ...(profile.workforce === "subcontractors" || profile.workforce === "crews_and_subs" ? [SUBCONTRACTOR_TYPE] : [])
  ];
  const added: string[] = [];
  for (const type of wanted) {
    const existing = (await listAssigneeTypes(auth.orgId)).types.find((entry) => entry.kind === type.kind && entry.id === type.id);
    if (existing && existing.status === "active") continue;
    await saveAssigneeType(auth.orgId, { kind: type.kind, id: type.id, name: existing?.name || type.name, description: existing?.description || type.description, status: "active" }, auth);
    added.push(type.id);
  }
  return added;
}

export const kindsInputSchema = z.object({
  kinds: z.array(z.object({
    id: z.string().trim().max(60).optional(),
    /** The person's own name for a kind the list does not have. */
    label: z.string().trim().max(80).transform((value) => value.replace(/[<>]/g, "")).optional(),
    category: z.enum(APPOINTMENT_CATEGORIES).optional()
  }).strict()).min(1).max(20)
}).strict();
export const applyInputSchema = z.object({
  appointment_types: z.array(storedTypeSchema).max(20).default([])
}).strict();

/** Saves the kinds of appointment the organization schedules and makes each an appointment type. */
export async function saveAppointmentKinds(auth: PlatformAuthContext, input: unknown) {
  const parsed = kindsInputSchema.parse(input);
  const kinds: StoredKind[] = [];
  for (const row of parsed.kinds) {
    const known = row.id ? kindById.get(row.id) : null;
    if (row.id && !known && !row.id.startsWith("custom_")) throw badRequest("appointment_kind_unknown", `${row.id} is not a kind of appointment in the list.`);
    const label = known ? (row.label || known.label.text) : text(row.label);
    if (!label) throw badRequest("appointment_kind_label", "Give your own kind of appointment a name.");
    const id = known ? known.id : `custom_${slug(row.id ? row.id.slice("custom_".length) : label)}`;
    if (id === "custom_") throw badRequest("appointment_kind_label", "Give your own kind of appointment a name with a letter or number.");
    if (kinds.some((entry) => entry.id === id)) continue;
    kinds.push({ id, label, category: row.category || known?.category || "other", custom: !known });
  }
  await writeTypes(auth, kinds, null);
  await writeRecord(auth.orgId, { kinds }, auth.userId);
  return readAppointmentSetup(auth.orgId);
}

/** Finishes the setup: each kind's texts and who goes, written to its appointment type, and the team types made. */
export async function applyAppointmentSetup(auth: PlatformAuthContext, input: unknown) {
  const parsed = applyInputSchema.parse(input);
  const [current, profile] = await Promise.all([readAppointmentSetup(auth.orgId), readCompanyProfile(auth.orgId)]);
  if (!current.kinds.length) throw badRequest("appointment_kinds_missing", "Choose the kinds of appointments you schedule first.");
  const given = new Map(parsed.appointment_types.map((entry) => [entry.id, entry]));
  const unknown = [...given.keys()].filter((id) => !current.kinds.some((entry) => entry.id === id));
  if (unknown.length) throw badRequest("appointment_kind_unknown", `${unknown.join(", ")} is not one of the kinds of appointments you chose.`);
  // A kind not given keeps what was answered before, or the defaults.
  const answers = new Map(current.kinds.map((entry) => [entry.id, given.get(entry.id) || { id: entry.id, reminder: entry.reminder, on_my_way: entry.on_my_way, attendee: entry.attendee }]));
  await writeTypes(auth, current.kinds.map(({ id, label, category, custom }) => ({ id, label, category, custom: !!custom })), answers);
  const added = await ensureTeamTypes(auth, profile);
  await writeRecord(auth.orgId, { types: [...answers.values()], applied_at: new Date().toISOString() }, auth.userId);
  const { listResourceGroups } = await import("../workforce/storage.js");
  const crews = (await listResourceGroups(auth.orgId)).filter((group: JsonObject) => text(group.kind_id) === "crew" && text(group.status || "active") === "active").length;
  return { ...(await readAppointmentSetup(auth.orgId)), types_added: added, crews };
}

// ── Publication ─────────────────────────────────────────────────────────
const copy = z.object({ key: z.string(), text: z.string() }).strict();
const setupSchema = z.object({
  answered: z.object({ kinds: z.boolean(), types: z.boolean() }).strict(),
  kinds: z.array(storedKindSchema.extend({ reminder: z.boolean(), on_my_way: z.boolean(), attendee: z.enum(APPOINTMENT_ATTENDEES), answered: z.boolean() })),
  attendees: z.array(z.enum(APPOINTMENT_ATTENDEES)),
  sales_team: z.string().nullable(), workforce: z.string().nullable(),
  applied_at: z.string().nullable(), revision: z.number().int()
});
const catalogSchema = z.object({
  kinds: z.array(z.object({ id: z.string(), label: copy, category: z.enum(APPOINTMENT_CATEGORIES) }).strict()),
  categories: z.array(z.object({ id: z.enum(APPOINTMENT_CATEGORIES), label: copy }).strict()),
  attendees: z.array(z.object({ id: z.enum(APPOINTMENT_ATTENDEES), label: copy }).strict()),
  suggested: z.array(z.string())
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"] };
const person = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("appointment_setup_person", "The appointment setup is answered by a person."); return ctx.auth; };

let registered = false;
export function registerAppointmentSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "appointment-setup", version: "1", apps: ["scheduling"], exports: {
    status: { description: "What the organization said about its appointments: the kinds it schedules (sales, production or other), and for each whether the customer is texted before it and when someone is on the way, and who goes. `answered` says which parts have been answered.",
      schema: json(setupSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readAppointmentSetup(ctx.organizationId); return { value, revision: String(value.revision) }; } },
    catalog: { description: "The kinds of appointment the setup suggests, with their category and copy, the suggestions for this company, and who can go. Data that only grows.",
      schema: json(catalogSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => ({ value: publishedAppointmentCatalog(await readCompanyProfile(ctx.organizationId)) }) }
  } });
  const policy = { scopes: ["organization" as const], permissions: ["manage_company_settings"], capabilities: ["platform.scheduling"] };
  registerAction({ id: "appointments.kinds.save", version: "1", domain: "scheduling", implementation: backendImplementationDigest(),
    description: "Save the kinds of appointments the organization schedules (ids from the appointment-setup catalog, or custom ones with a name and a category: sales, production or other). Each becomes an appointment type; existing types are kept.",
    inputSchema: json(kindsInputSchema) as Record<string, unknown>, outputSchema: json(setupSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"], policy,
    validateInput: (value) => { kindsInputSchema.parse(value); },
    execute: (ctx, _target, value) => saveAppointmentKinds(person(ctx), value) });
  registerAction({ id: "appointments.setup.apply", version: "1", domain: "scheduling", implementation: backendImplementationDigest(),
    description: "Finish the appointment setup: for each kind of appointment chosen, whether the customer gets a text before it starts (reminder) and when someone is on the way (on_my_way), and who goes (me, sales_team, crews, subcontractors, anyone). Writes the appointment types and adds the group and company types the team answers need.",
    inputSchema: json(applyInputSchema) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"], policy,
    validateInput: (value) => { applyInputSchema.parse(value); },
    execute: (ctx, _target, value) => applyAppointmentSetup(person(ctx), value) });
}
