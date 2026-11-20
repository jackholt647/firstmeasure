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
/** Who can go to an appointment (data that only grows). `technician` is one person who does repairs and service (GP-85). */
export const APPOINTMENT_ATTENDEES = ["me", "sales_team", "crews", "subcontractors", "anyone", "technician"] as const;
export type AppointmentAttendee = typeof APPOINTMENT_ATTENDEES[number];

/**
 * Who each kind offers first (GP-85); the rest are behind the setup's +. Sales: me or a salesperson. Work: crews,
 * subcontractors or me. Repairs and service: a technician, crews, subcontractors, me or a salesperson.
 */
const SALES_OFFER: AppointmentAttendee[] = ["me", "sales_team"];
const WORK_OFFER: AppointmentAttendee[] = ["crews", "subcontractors", "me"];
const SERVICE_OFFER: AppointmentAttendee[] = ["technician", "crews", "subcontractors", "me", "sales_team"];
const OTHER_OFFER: AppointmentAttendee[] = ["anyone", "me"];
const CATEGORY_OFFER: Record<AppointmentCategory, AppointmentAttendee[]> = { sales: SALES_OFFER, production: WORK_OFFER, other: OTHER_OFFER };

type KindDefaults = Partial<z.input<typeof appointmentConfigurationSchema>>;
/** `goes` is who goes to the kind unless the person says otherwise, when it is not its category's default (GP-139). */
export type AppointmentKind = { id: string; label: Copy; category: AppointmentCategory; configuration: KindDefaults; offer: AppointmentAttendee[]; goes?: AppointmentAttendee[]; industries?: string[]; packs?: string[]; retired?: boolean };
const kind = (id: string, text: string, category: AppointmentCategory, configuration: KindDefaults, where: { industries?: string[]; packs?: string[]; offer?: AppointmentAttendee[]; goes?: AppointmentAttendee[]; retired?: boolean } = {}): AppointmentKind => ({ id, label: c(`kind_${id}`, text), category, configuration, offer: where.offer || CATEGORY_OFFER[category], ...(where.goes ? { goes: where.goes } : {}), ...(where.industries ? { industries: where.industries } : {}), ...(where.packs ? { packs: where.packs } : {}), ...(where.retired ? { retired: true } : {}) });

/**
 * The kinds of appointment the setup suggests. Data that only grows: never change an id or its meaning. A `retired` kind
 * stays so the types and answers that name it keep working, but it is never suggested and the setup offers it only to an
 * organization that already picked it: an inspection is much the same as a sales appointment, and a service call as a
 * repair appointment (GP-85, GP-135). A material delivery is picked to start with.
 */
export const APPOINTMENT_KINDS: readonly AppointmentKind[] = Object.freeze([
  kind("sales", "Sales appointment", "sales", { duration_minutes: 60, window_minutes: 60 }),
  kind("inspection", "Inspection", "sales", { duration_minutes: 60, window_minutes: 60 }, { retired: true }),
  kind("installation", "Installation", "production", { timing_mode: "days", duration_days: 1 }),
  kind("repair", "Repair appointment", "production", { duration_minutes: 60, window_minutes: 240 }, { offer: SERVICE_OFFER, goes: ["technician"] }),
  kind("service_call", "Service call", "production", { duration_minutes: 60, window_minutes: 240 }, { packs: ["home_services"], offer: SERVICE_OFFER, goes: ["technician"], retired: true }),
  kind("maintenance", "Maintenance visit", "production", { duration_minutes: 60, window_minutes: 240 }, { industries: ["hvac", "plumbing", "landscaping"], offer: SERVICE_OFFER, goes: ["technician"] }),
  kind("delivery", "Material delivery", "production", { duration_minutes: 60, window_minutes: 240, delivery: true }),
  kind("walkthrough", "Final walkthrough", "production", { duration_minutes: 60, window_minutes: 60 }),
  kind("meeting", "Team meeting", "other", { duration_minutes: 60, window_minutes: 60, location: { mode: "company_office", address: "" } })
]);
/** The kinds every company starts with picked; a company with no sales appointments starts without the sales one. */
const COMMON_KINDS = ["sales", "installation", "repair", "delivery"];
const kindById = new Map(APPOINTMENT_KINDS.map((entry) => [entry.id, entry]));
const CATEGORY_COPY: Record<AppointmentCategory, Copy> = { sales: c("category_sales", "Sales"), production: c("category_production", "Production"), other: c("category_other", "Other") };
// What crews and subcontractors are called comes from the terminology system: the setup shows its words for them, and
// these are only the fallback.
const ATTENDEE_COPY: Record<AppointmentAttendee, Copy> = {
  me: c("attendee_me", "Me"), sales_team: c("attendee_salesperson", "A salesperson"), crews: c("attendee_crews", "A crew"),
  subcontractors: c("attendee_subcontractors", "A subcontractor"), anyone: c("attendee_anyone", "Whoever is free"),
  technician: c("attendee_technician", "A repair technician")
};
/** The group and company types the team answers need (assignee-base.md "The type lists"). */
const SALES_TEAM_TYPE = { kind: "resource_group" as const, id: "sales_team", name: "Sales team", description: "Salespeople who run sales appointments." };
const CREW_TYPE = { kind: "resource_group" as const, id: "crew", name: "Crew", description: "An internal production team that can be assigned work as a unit." };
const SUBCONTRACTOR_TYPE = { kind: "organization_connection" as const, id: "subcontractor", name: "Subcontractor", description: "An outside company that does work for us." };

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => String(value ?? "").trim();
const slug = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);

/** Whether the company said it does no sales appointments: then there are no sales kinds and no sales department. */
export const noSales = (profile: Pick<CompanyProfile, "sales_team">) => profile.sales_team === "no_sales";
/** The kinds suggested for this company: the common ones, and those its kind of company usually has (never a retired one). */
export function suggestedKinds(profile: Pick<CompanyProfile, "industry" | "crm_pack" | "sales_team">) {
  const ids = COMMON_KINDS.filter((id) => !noSales(profile) || kindById.get(id)?.category !== "sales");
  for (const entry of APPOINTMENT_KINDS) {
    if (entry.retired || ids.includes(entry.id) || (noSales(profile) && entry.category === "sales")) continue;
    if ((profile.industry && entry.industries?.includes(profile.industry)) || (profile.crm_pack && entry.packs?.includes(profile.crm_pack))) ids.push(entry.id);
  }
  return ids;
}
/** Who a kind offers first: its own list, or its category's for a kind of the person's own. */
export const kindOffer = (id: string, category: AppointmentCategory): AppointmentAttendee[] => kindById.get(id)?.offer || CATEGORY_OFFER[category];
/** Who goes to a kind of appointment unless the person says otherwise, from who sells and who does the work. */
export function defaultAttendee(category: AppointmentCategory, profile: Pick<CompanyProfile, "sales_team" | "workforce">): AppointmentAttendee {
  if (category === "sales") return profile.sales_team === "just_me" ? "me" : profile.sales_team === "small_team" || profile.sales_team === "managed_team" ? "sales_team" : "anyone";
  if (category === "production") return profile.workforce === "just_me" ? "me" : profile.workforce === "crews" || profile.workforce === "crews_and_subs" ? "crews" : profile.workforce === "subcontractors" ? "subcontractors" : "anyone";
  return "anyone";
}
/**
 * Who goes to a kind unless the person says otherwise (GP-85: one or more): the sales answer for sales; for work, who
 * does it (both crews and subcontractors when the company has both); whoever is free for anything else. A kind with its
 * own default has it (GP-139: a repair or service visit goes to a repair technician), except in a company where the
 * person does the work themselves.
 */
export function defaultAttendees(category: AppointmentCategory, profile: Pick<CompanyProfile, "sales_team" | "workforce">, kindId?: string): AppointmentAttendee[] {
  const goes = kindId ? kindById.get(kindId)?.goes : undefined;
  if (goes?.length && profile.workforce !== "just_me") return [...goes];
  if (category === "production" && profile.workforce === "crews_and_subs") return ["crews", "subcontractors"];
  if (category === "sales" && !profile.sales_team) return ["sales_team"];
  return [defaultAttendee(category, profile)];
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
/** One kind's answers. Who goes is `attendees` (GP-85: one or more); `attendee`, the first, is what was saved before. */
const storedTypeSchema = z.object({ id: z.string(), reminder: z.boolean(), on_my_way: z.boolean(), attendee: z.enum(APPOINTMENT_ATTENDEES).optional(), attendees: z.array(z.enum(APPOINTMENT_ATTENDEES)).min(1).max(APPOINTMENT_ATTENDEES.length).optional() }).strict()
  .refine((value) => !!value.attendee || !!value.attendees?.length, { message: "Say who goes to it.", path: ["attendees"] });
type StoredKind = z.infer<typeof storedKindSchema>;
type StoredType = { id: string; reminder: boolean; on_my_way: boolean; attendees: AppointmentAttendee[] };
const typeAnswer = (value: z.infer<typeof storedTypeSchema>): StoredType => ({ id: value.id, reminder: value.reminder, on_my_way: value.on_my_way, attendees: [...new Set(value.attendees?.length ? value.attendees : [value.attendee!])] });

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
  const types = new Map(parsedList(storedTypeSchema, data.types).map(typeAnswer).map((entry) => [entry.id, entry]));
  return {
    answered: { kinds: kinds.length > 0, types: !!text(data.applied_at) },
    kinds: kinds.map((entry) => {
      const answered = types.get(entry.id);
      const attendees = answered?.attendees ?? defaultAttendees(entry.category, profile, entry.id);
      return { ...entry, reminder: answered?.reminder ?? entry.category !== "other", on_my_way: answered?.on_my_way ?? entry.category !== "other", attendee: attendees[0]!, attendees, offered: kindOffer(entry.id, entry.category), answered: !!answered };
    }),
    attendees: offeredAttendees(profile),
    sales_team: profile.sales_team, workforce: profile.workforce, no_sales: noSales(profile),
    applied_at: text(data.applied_at) || null,
    revision: Number(record?.revision || 0)
  };
}
export function publishedAppointmentCatalog(profile: CompanyProfile) {
  return {
    kinds: APPOINTMENT_KINDS.map((entry) => ({ id: entry.id, label: entry.label, category: entry.category, offer: entry.offer, ...(entry.retired ? { retired: true } : {}) })),
    categories: APPOINTMENT_CATEGORIES.map((id) => ({ id, label: CATEGORY_COPY[id] })),
    attendees: APPOINTMENT_ATTENDEES.map((id) => ({ id, label: ATTENDEE_COPY[id] })),
    suggested: suggestedKinds(profile)
  };
}

// ── Writing the appointment types ───────────────────────────────────────
/**
 * The staffing requirement for who goes. Several answers mean any one of them goes (GP-85), and a type's requirements
 * all have to be met, so they become one requirement wide enough for each: one person (me, a salesperson, a technician,
 * whoever is free), or one person or group when a crew is among them. An outside company is not booked by the planner,
 * so a type a subcontractor may go to requires nothing: whoever books it says who goes. The department narrows it only
 * when every answer is someone of that department.
 */
export function requirementsFor(attendees: AppointmentAttendee | AppointmentAttendee[], userId: string, departmentId: string | undefined) {
  const set = new Set(Array.isArray(attendees) ? attendees : [attendees]);
  const ofDepartment = [...set].every((entry) => entry === "sales_team" || entry === "crews" || entry === "technician");
  const department = departmentId && ofDepartment ? { department_id: departmentId } : {};
  if (set.has("subcontractors")) return [];
  if (set.size === 1 && set.has("me")) return userId ? [{ subject_type: "organization_user", mode: "specific", subject_keys: [`organization_user:${userId}`] }] : [{ subject_type: "organization_user", mode: "count", count: 1 }];
  if (set.size === 1 && set.has("crews")) return [{ ...department, subject_type: "resource_group", mode: "count", count: 1, crew_member_percent: 100 }];
  if (set.has("crews")) return [{ ...department, subject_type: "any", mode: "count", count: 1 }];
  return [{ ...department, subject_type: "organization_user", mode: "count", count: 1 }];
}
const CATEGORY_DEPARTMENT: Record<AppointmentCategory, string | null> = { sales: "sales", production: "production", other: null };
const SETUP_DEPARTMENTS = new Set(Object.values(CATEGORY_DEPARTMENT).filter(Boolean));

/**
 * The types the setup answers for (GP-140): the built-in ones (the default Sales and Production, the instant
 * organization's), the kinds of the setup's list, and the person's own kinds it made (`custom_`). A type someone made in Settings
 * has an id of its own and is never one of these. A type a website form books is kept all the same, so the form goes on
 * working; a booking keeps its own copy of its type and needs nothing.
 */
async function setupMadeTypes(orgId: string) {
  const [{ defaultAppointmentCatalog, instantFullAppointmentCatalog }, { FORMS, listRecords }] = await Promise.all([import("./defaults.js"), import("../forms/storage.js")]);
  const ids = new Set([...defaultAppointmentCatalog().presets, ...instantFullAppointmentCatalog().presets, ...APPOINTMENT_KINDS].map((entry) => entry.id));
  const booked = new Set<string>();
  for (const form of await listRecords(orgId, FORMS)) {
    for (const definition of [object(form.definition), object(object(form.published).definition)]) {
      for (const item of list(definition.steps).flatMap((step) => list(step.items))) if (item.kind === "appointment" && text(item.preset_id)) booked.add(text(item.preset_id));
    }
  }
  return (id: string) => (ids.has(id) || id.startsWith("custom_")) && !booked.has(id);
}

/**
 * Puts the setup's kinds into the person's branch's appointment types, through the catalog's own writer. The kinds
 * picked become the organization's types (GP-140): the built-in types and the setup's own that were not picked are
 * dropped, and a type someone made in Settings is kept. `answers` (by kind id) also sets each type's texts and who goes.
 * A new sales or production type needs a project (FM-557); an other one (a team meeting) does not.
 */
async function writeTypes(auth: PlatformAuthContext, kinds: StoredKind[], answers: Map<string, StoredType> | null, profile: Pick<CompanyProfile, "sales_team">, departments: Partial<Record<AppointmentCategory, string>> = {}) {
  const [bundle, setupMade] = await Promise.all([readAppointmentCatalog(auth), setupMadeTypes(auth.orgId)]);
  const picked = new Set(kinds.map((entry) => entry.id));
  // A company with no sales appointments makes no distinction between sales and production (GP-85): its types name no
  // department.
  const activeDepartments = new Set(noSales(profile) ? [] : bundle.catalog.departments.filter((entry) => entry.status === "active").map((entry) => entry.id));
  const departmentOf = (category: AppointmentCategory) => [departments[category], CATEGORY_DEPARTMENT[category]].find((id) => !!id && activeDepartments.has(id)) || undefined;
  const presets = bundle.revision > 0 ? bundle.catalog.presets.filter((preset) => picked.has(preset.id) || !setupMade(preset.id)) : [];
  for (const entry of kinds) {
    const known = kindById.get(entry.id);
    const departmentId = departmentOf(entry.category);
    const at = presets.findIndex((preset) => preset.id === entry.id);
    const answer = answers?.get(entry.id);
    if (at >= 0 && !answer) continue;
    const base = at >= 0 ? presets[at]!.configuration : appointmentConfigurationSchema.parse({ title: entry.label, ...(known?.configuration || { duration_minutes: 60, window_minutes: 60 }), department_ids: departmentId ? [departmentId] : [], requires_project: entry.category !== "other" });
    // A type saved before its department existed gains it, since who goes is narrowed to it (GP-122); with no sales
    // appointments it names neither sales nor production.
    const departmentIds = !answer ? base.department_ids
      : noSales(profile) ? base.department_ids.filter((id) => !SETUP_DEPARTMENTS.has(id))
      : departmentId && !base.department_ids.includes(departmentId) ? [...base.department_ids, departmentId] : base.department_ids;
    const configuration = answer
      ? appointmentConfigurationSchema.parse({ ...base, department_ids: departmentIds, requirements: requirementsFor(answer.attendees, auth.userId, departmentId), customer_texts: { reminder: answer.reminder, on_my_way: answer.on_my_way } })
      : appointmentConfigurationSchema.parse({ ...base, requirements: requirementsFor("anyone", auth.userId, departmentId) });
    const preset = { id: entry.id, label: at >= 0 ? presets[at]!.label : entry.label, configuration };
    if (at >= 0) presets[at] = preset; else presets.push(preset);
  }
  await saveAppointmentCatalog(auth, { catalog: { ...bundle.catalog, presets }, revision: bundle.revision });
}

/** Gives the organization the group and company types its answers name: a sales team, crews, subcontractors. */
async function ensureTeamTypes(auth: PlatformAuthContext, profile: CompanyProfile, answers: StoredType[] = []) {
  const { listAssigneeTypes, saveAssigneeType } = await import("../assignees/base.js");
  const named = (attendee: AppointmentAttendee) => answers.some((entry) => entry.attendees.includes(attendee));
  const wanted = [
    ...(profile.sales_is_team ? [SALES_TEAM_TYPE] : []),
    ...(profile.workforce === "crews" || profile.workforce === "crews_and_subs" || named("crews") ? [CREW_TYPE] : []),
    ...(profile.workforce === "subcontractors" || profile.workforce === "crews_and_subs" || named("subcontractors") ? [SUBCONTRACTOR_TYPE] : [])
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

/**
 * Gives the organization the departments its kinds say it has (GP-122): sales appointments mean a Sales department and
 * work appointments a Production department, in the person's branch, so People › Departments shows them. An existing
 * one is used (the same id, or the same name in this branch) and made active again; a new one is made with the
 * scheduling defaults' colour and roles. The team types the answers send there (a sales team, crews) are put in it, so
 * a type that narrows who goes to its department still finds them. Written through the People departments writer, as
 * the person. A company with no sales appointments has no departments (GP-85). Returns each category's department.
 */
async function ensureDepartments(auth: PlatformAuthContext, kinds: StoredKind[], answers: StoredType[], profile: Pick<CompanyProfile, "sales_team">) {
  const result: Partial<Record<AppointmentCategory, string>> = {};
  if (noSales(profile)) return result;
  const wanted = APPOINTMENT_CATEGORIES.filter((category) => CATEGORY_DEPARTMENT[category] && kinds.some((entry) => entry.category === category));
  if (!wanted.length) return result;
  const [{ readOrganizationDepartments, saveDepartmentSettings }, { defaultAppointmentCatalog }, { listAccessRoles }, { readWorkforceConfiguration }] = await Promise.all([import("../workforce/departments.js"), import("./defaults.js"), import("../workforce/access.js"), import("../workforce/storage.js")]);
  const [current, roles, configuration] = await Promise.all([readOrganizationDepartments(auth.orgId), listAccessRoles(auth.orgId), readWorkforceConfiguration(auth.orgId)]);
  const roleIds = new Set(roles.map((role: JsonObject) => text(role.id)));
  const groupKinds = new Set((configuration.resource_group_kinds as JsonObject[]).filter((entry) => text(entry.status || "active") === "active").map((entry) => text(entry.id)));
  const branchId = text(auth.branchId) || "default";
  const departments = current.departments.map((entry) => ({ ...entry }));
  let changed = false;
  for (const category of wanted) {
    const template = defaultAppointmentCatalog().departments.find((entry) => entry.id === CATEGORY_DEPARTMENT[category])!;
    const sameName = (entry: { label: string }) => entry.label.trim().toLowerCase() === template.label.toLowerCase();
    const here = departments.filter((entry) => entry.branch_id === branchId);
    let department = here.find((entry) => entry.id === template.id && entry.status === "active") || here.find((entry) => sameName(entry) && entry.status === "active")
      || here.find((entry) => entry.id === template.id) || here.find(sameName);
    if (!department) {
      // An id another branch's department has is not reused: this branch gets its own.
      const id = [template.id, `${template.id}_${slug(branchId)}`].find((candidate) => !departments.some((entry) => entry.id === candidate));
      if (!id) continue;
      department = { ...template, id, branch_id: branchId, status: "active", role_ids: template.role_ids.filter((role) => roleIds.has(role)), group_kind_ids: template.group_kind_ids.filter((kind) => groupKinds.has(kind)), subject_keys: [] };
      departments.push(department);
      changed = true;
    } else if (department.status !== "active") { department.status = "active"; changed = true; }
    const team = category === "sales" ? (answers.some((entry) => kindCategory(kinds, entry.id) === "sales" && entry.attendees.includes("sales_team")) ? SALES_TEAM_TYPE.id : "")
      : (answers.some((entry) => kindCategory(kinds, entry.id) === "production" && entry.attendees.includes("crews")) ? CREW_TYPE.id : "");
    if (team && groupKinds.has(team) && !department.group_kind_ids.includes(team)) { department.group_kind_ids = [...department.group_kind_ids, team]; changed = true; }
    result[category] = department.id;
  }
  if (changed) await saveDepartmentSettings(auth, { departments, terminology: current.terminology, revision: current.revision, ...(current.revision ? {} : { legacy_token: current.legacy_token }) });
  return result;
}
const kindCategory = (kinds: StoredKind[], id: string) => kinds.find((entry) => entry.id === id)?.category;

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
  const profile = await readCompanyProfile(auth.orgId);
  const kinds: StoredKind[] = [];
  for (const row of parsed.kinds) {
    const known = row.id ? kindById.get(row.id) : null;
    if (row.id && !known && !row.id.startsWith("custom_")) throw badRequest("appointment_kind_unknown", `${row.id} is not a kind of appointment in the list.`);
    const label = known ? (row.label || known.label.text) : text(row.label);
    if (!label) throw badRequest("appointment_kind_label", "Give your own kind of appointment a name.");
    const id = known ? known.id : `custom_${slug(row.id ? row.id.slice("custom_".length) : label)}`;
    if (id === "custom_") throw badRequest("appointment_kind_label", "Give your own kind of appointment a name with a letter or number.");
    if (kinds.some((entry) => entry.id === id)) continue;
    // With no sales appointments there is no sales or production, only the work and other appointments.
    const category = row.category || known?.category || "other";
    kinds.push({ id, label, category: noSales(profile) && category === "sales" ? "production" : category, custom: !known });
  }
  await writeTypes(auth, kinds, null, profile);
  await writeRecord(auth.orgId, { kinds }, auth.userId);
  return readAppointmentSetup(auth.orgId);
}

/** Finishes the setup: each kind's texts and who goes, written to its appointment type, and the team types made. */
export async function applyAppointmentSetup(auth: PlatformAuthContext, input: unknown) {
  const parsed = applyInputSchema.parse(input);
  const [current, profile] = await Promise.all([readAppointmentSetup(auth.orgId), readCompanyProfile(auth.orgId)]);
  if (!current.kinds.length) throw badRequest("appointment_kinds_missing", "Choose the kinds of appointments you schedule first.");
  const given = new Map(parsed.appointment_types.map(typeAnswer).map((entry) => [entry.id, entry]));
  const unknown = [...given.keys()].filter((id) => !current.kinds.some((entry) => entry.id === id));
  if (unknown.length) throw badRequest("appointment_kind_unknown", `${unknown.join(", ")} is not one of the kinds of appointments you chose.`);
  // A kind not given keeps what was answered before, or the defaults.
  const answers = new Map<string, StoredType>(current.kinds.map((entry) => [entry.id, given.get(entry.id) || { id: entry.id, reminder: entry.reminder, on_my_way: entry.on_my_way, attendees: entry.attendees }]));
  const kinds = current.kinds.map(({ id, label, category, custom }) => ({ id, label, category, custom: !!custom }));
  // The team types first, so the departments can name them; the departments before the types that are narrowed to them.
  const added = await ensureTeamTypes(auth, profile, [...answers.values()]);
  const departments = await ensureDepartments(auth, kinds, [...answers.values()], profile);
  await writeTypes(auth, kinds, answers, profile, departments);
  await writeRecord(auth.orgId, { types: [...answers.values()].map((entry) => ({ ...entry, attendee: entry.attendees[0]! })) as unknown as JsonObject[], applied_at: new Date().toISOString() }, auth.userId);
  const { listResourceGroups } = await import("../workforce/storage.js");
  const crews = (await listResourceGroups(auth.orgId)).filter((group: JsonObject) => text(group.kind_id) === "crew" && text(group.status || "active") === "active").length;
  return { ...(await readAppointmentSetup(auth.orgId)), types_added: added, departments, crews };
}

// ── Publication ─────────────────────────────────────────────────────────
const copy = z.object({ key: z.string(), text: z.string() }).strict();
const setupSchema = z.object({
  answered: z.object({ kinds: z.boolean(), types: z.boolean() }).strict(),
  kinds: z.array(storedKindSchema.extend({ reminder: z.boolean(), on_my_way: z.boolean(), attendee: z.enum(APPOINTMENT_ATTENDEES), attendees: z.array(z.enum(APPOINTMENT_ATTENDEES)), offered: z.array(z.enum(APPOINTMENT_ATTENDEES)), answered: z.boolean() })),
  attendees: z.array(z.enum(APPOINTMENT_ATTENDEES)),
  sales_team: z.string().nullable(), workforce: z.string().nullable(), no_sales: z.boolean(),
  applied_at: z.string().nullable(), revision: z.number().int()
});
const catalogSchema = z.object({
  kinds: z.array(z.object({ id: z.string(), label: copy, category: z.enum(APPOINTMENT_CATEGORIES), offer: z.array(z.enum(APPOINTMENT_ATTENDEES)), retired: z.boolean().optional() }).strict()),
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
    status: { description: "What the organization said about its appointments: the kinds it schedules (sales, production or other), and for each whether the customer is texted before it and when someone is on the way, and who goes (`attendees`, one or more; `attendee` is the first; `offered` is who that kind offers first). `no_sales` is a company that does no sales appointments: it has no sales kinds and no departments on its types. `answered` says which parts have been answered.",
      schema: json(setupSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => { const value = await readAppointmentSetup(ctx.organizationId); return { value, revision: String(value.revision) }; } },
    catalog: { description: "The kinds of appointment the setup suggests, with their category and copy, the suggestions for this company, and who can go. Data that only grows: a `retired` kind is kept for those who picked it and is not offered to anyone else.",
      schema: json(catalogSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => ({ value: publishedAppointmentCatalog(await readCompanyProfile(ctx.organizationId)) }) }
  } });
  const policy = { scopes: ["organization" as const], permissions: ["manage_company_settings"], capabilities: ["platform.scheduling"] };
  registerAction({ id: "appointments.kinds.save", version: "1", domain: "scheduling", implementation: backendImplementationDigest(),
    description: "Save the kinds of appointments the organization schedules (ids from the appointment-setup catalog, or custom ones with a name and a category: sales, production or other). Each becomes an appointment type, and they are the organization's types: built-in types and kinds that were not picked are dropped, while types made in Settings (and any a website form books) are kept.",
    inputSchema: json(kindsInputSchema) as Record<string, unknown>, outputSchema: json(setupSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"], policy,
    validateInput: (value) => { kindsInputSchema.parse(value); },
    execute: (ctx, _target, value) => saveAppointmentKinds(person(ctx), value) });
  registerAction({ id: "appointments.setup.apply", version: "1", domain: "scheduling", implementation: backendImplementationDigest(),
    description: "Finish the appointment setup: for each kind of appointment chosen, whether the customer gets a text before it starts (reminder) and when someone is on the way (on_my_way), and who goes (`attendees`, one or more of me, sales_team (a salesperson), crews, subcontractors, technician, anyone; any one of them goes). Writes the appointment types and adds the group and company types the team answers need.",
    inputSchema: json(applyInputSchema) as Record<string, unknown>, outputSchema: { type: "object" },
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"], policy,
    validateInput: (value) => { applyInputSchema.parse(value); },
    execute: (ctx, _target, value) => applyAppointmentSetup(person(ctx), value) });
}
