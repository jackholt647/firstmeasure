import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { listDocuments, readBranchModule } from "../platform/storage.js";
import { readCompanyProfile } from "../company-profile/profile.js";
import { serviceOf } from "../company-profile/catalog.js";
import { APPOINTMENT_KINDS, ensureSalesDepartment, noSales } from "./setup.js";

/**
 * The salesperson setup (GP-144, guided experience `sales.team.setup`, docs/architecture/guided-experiences.md "Who
 * sells"): who the company's salespeople are and which of the work it does each may sell. It adds no list of its own.
 * A salesperson is a member of the Sales department, the department a sales appointment type asks for
 * (`requirementsFor`), so the New appointment dialog and the planner find them at once; the setup adds and removes
 * direct members only (someone in it through a role or a group stays, and is shown as such). What each may sell is the
 * company profile services in their assignee capabilities (`labor/capabilities.ts`), where the workforce setup keeps
 * what each crew does; every one the company does until the person says otherwise.
 */
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const SALES_KINDS = new Set(APPOINTMENT_KINDS.filter((entry) => entry.category === "sales").map((entry) => entry.id));
const userKey = (id: string) => `organization_user:${id}`;

type DepartmentLike = { id: string; label: string; status?: string; branch_id?: string };
type PresetLike = { id: string; configuration?: { event_type_id?: string; requirements?: { department_id?: string }[] } };
/**
 * The departments that hold a branch's salespeople: those its sales appointment types ask for, then the one the
 * appointment setup makes (`sales`, `sales_<branch>`, or one named Sales). Pure, so the booking preview can tell a
 * requirement for a salesperson from any other (GP-144).
 */
export function salesDepartmentIds(departments: DepartmentLike[], presets: PresetLike[]) {
  const active = departments.filter((entry) => entry.status !== "archived");
  const ids: string[] = [];
  const add = (id: string) => { if (id && !ids.includes(id) && active.some((entry) => entry.id === id)) ids.push(id); };
  for (const preset of presets) {
    if (!SALES_KINDS.has(preset.id) && preset.configuration?.event_type_id !== "sales_appointment") continue;
    for (const requirement of preset.configuration?.requirements || []) add(text(requirement.department_id));
  }
  for (const entry of active) if (entry.id === "sales" || entry.id.startsWith("sales_") || entry.label.trim().toLowerCase() === "sales") add(entry.id);
  return ids;
}

async function branchPresets(orgId: string, branchId: string): Promise<PresetLike[]> {
  try { return (object(object((await readBranchModule(orgId, branchId, "scheduling"))?.data).appointment_catalog).presets as PresetLike[] | undefined) || []; }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return []; throw error; }
}
/** The branch's Sales department, or null while it has none. */
async function salesDepartment(orgId: string, branchId: string) {
  const { readOrganizationDepartments } = await import("../workforce/departments.js");
  const [catalog, presets] = await Promise.all([readOrganizationDepartments(orgId), branchPresets(orgId, branchId)]);
  const here = catalog.departments.filter((entry) => entry.branch_id === branchId);
  const id = salesDepartmentIds(here, presets)[0];
  return { catalog, department: id ? here.find((entry) => entry.id === id)! : null };
}

/** The organization's people who can sell, with whether they have joined yet (`invited`). */
async function organizationPeople(orgId: string) {
  return (await listDocuments(orgId, "users")).map((document) => {
    const data = object(document.data);
    return { id: text(document.id), name: text(data.name) || text(data.email) || text(document.id), email: text(data.email).toLowerCase(), status: text(data.status) || "active", deleted: data.deleted === true };
  }).filter((user) => user.id && !user.deleted && user.status !== "disabled" && user.status !== "archived")
    .map(({ id, name, email, status }) => ({ id, name, email, status: status === "invited" || status === "pending" ? "invited" : "active" })).sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSalesTeamSetup(orgId: string, branchId: string, auth: PlatformAuthContext | null) {
  const [{ department }, profile, people, { resolveOrganizationStructure }, { listDeclaredCapabilities }] = await Promise.all([
    salesDepartment(orgId, branchId), readCompanyProfile(orgId), organizationPeople(orgId), import("../workforce/organization-structure.js"), import("../labor/capabilities.js")]);
  const declared = new Map((await listDeclaredCapabilities(orgId)).filter((row) => row.assignee.type === "organization_user").map((row) => [row.assignee.id, row.service_ids]));
  const structure = department ? await resolveOrganizationStructure(orgId) : null;
  const known = new Map(people.map((person) => [person.id, person]));
  const salespeople = !department || !structure ? [] : structure.users.filter((user) => user.department_ids.includes(department.id) && known.has(user.id)).map((user) => {
    const sources = user.sources.filter((source) => source.department_id === department.id);
    // Only a direct member is the setup's to take off; one in through a role or a group stays.
    const via = sources.some((source) => source.kind === "direct") ? "direct" : sources.some((source) => source.kind === "role") ? "role" : "group";
    return { user_id: user.id, name: known.get(user.id)!.name, via, service_ids: declared.get(user.id) ?? null };
  });
  const may = (permission: string) => !!auth && hasPermission(auth, permission);
  return {
    services: profile.services.map((entry) => ({ id: entry.id, label: serviceOf(entry.id)!.label })),
    services_answered: profile.answered.services,
    department: department ? { id: department.id, label: department.label } : null,
    people, salespeople,
    sales_team: profile.sales_team, no_sales: noSales(profile),
    can: { add_people: may("manage_company_users|manage_users"), invite: may("manage_company_users|manage_users") }
  };
}

export const salesTeamInputSchema = z.object({
  /** Everyone who sells, each with the company profile services they may sell. Direct members left out are taken off. */
  salespeople: z.array(z.object({ user_id: z.string().trim().min(1).max(200), service_ids: z.array(z.string().trim().min(1).max(80)).max(80) }).strict()).max(100)
}).strict();

/** Saves who sells (the Sales department's direct members) and what each may sell (their capabilities' services). */
export async function applySalesTeamSetup(auth: PlatformAuthContext, input: unknown) {
  const parsed = salesTeamInputSchema.parse(input);
  const branchId = text(auth.branchId) || "default";
  const profile = await readCompanyProfile(auth.orgId);
  for (const row of parsed.salespeople) for (const id of row.service_ids) if (!serviceOf(id)) throw badRequest("sales_service_unknown", `${id} is not a kind of work in the company profile catalog.`);
  const people = new Set((await organizationPeople(auth.orgId)).map((person) => person.id));
  const unknown = parsed.salespeople.filter((row) => !people.has(row.user_id)).map((row) => row.user_id);
  if (unknown.length) throw badRequest("sales_person_unknown", `${unknown.join(", ")} is not someone in this organization.`);
  if (!(await salesDepartment(auth.orgId, branchId)).department && !(await ensureSalesDepartment(auth))) throw badRequest("sales_department_missing", "Your company said it does no sales appointments. Change that in the company profile first.");
  const { catalog, department } = await salesDepartment(auth.orgId, branchId);
  if (!department) throw badRequest("sales_department_missing", "There is no Sales department in this branch.");

  // Who is in the department: direct members added and taken off; members through a role or a group are kept.
  const wanted = new Set(parsed.salespeople.map((row) => userKey(row.user_id)));
  const kept = department.subject_keys.filter((key) => !key.startsWith("organization_user:") || wanted.has(key));
  const { resolveOrganizationStructure } = await import("../workforce/organization-structure.js");
  const already = new Set((await resolveOrganizationStructure(auth.orgId)).users.filter((user) => user.department_ids.includes(department.id) && user.sources.some((source) => source.department_id === department.id && source.kind !== "direct")).map((user) => userKey(user.id)));
  const subjectKeys = [...new Set([...kept, ...[...wanted].filter((key) => !already.has(key))])];
  if (subjectKeys.length !== department.subject_keys.length || subjectKeys.some((key) => !department.subject_keys.includes(key))) {
    const { saveDepartmentSettings } = await import("../workforce/departments.js");
    const departments = catalog.departments.map((entry) => entry.id === department.id ? { ...entry, subject_keys: subjectKeys } : entry);
    await saveDepartmentSettings(auth, { departments, terminology: catalog.terminology, revision: catalog.revision, ...(catalog.revision ? {} : { legacy_token: catalog.legacy_token }) });
  }

  // What each may sell: the services given replace the ones saved before; the rest of their capabilities stay.
  const { listDeclaredCapabilities, saveCapabilities, serviceTags } = await import("../labor/capabilities.js");
  const declared = new Map((await listDeclaredCapabilities(auth.orgId)).filter((row) => row.assignee.type === "organization_user").map((row) => [row.assignee.id, row]));
  for (const row of parsed.salespeople) {
    const service_ids = [...new Set(row.service_ids)];
    const current = declared.get(row.user_id);
    if (current && [...current.service_ids].sort().join(",") === [...service_ids].sort().join(",")) continue;
    await saveCapabilities(auth.orgId, { assignee: { type: "organization_user", id: row.user_id }, schema_ids: current?.schema_ids || [], service_ids, service_tags: serviceTags(current?.service_tags || {}, service_ids), item_ids: current?.item_ids || [], excluded_item_ids: current?.excluded_item_ids || [], ...(current ? { expected_revision: current.revision } : {}) }, auth);
  }
  return readSalesTeamSetup(auth.orgId, branchId, auth);
}

// ── Publication ─────────────────────────────────────────────────────────
const copy = z.object({ key: z.string(), text: z.string() }).strict();
const statusSchema = z.object({
  services: z.array(z.object({ id: z.string(), label: copy }).strict()),
  services_answered: z.boolean(),
  department: z.object({ id: z.string(), label: z.string() }).strict().nullable(),
  people: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), status: z.enum(["active", "invited"]) }).strict()),
  salespeople: z.array(z.object({ user_id: z.string(), name: z.string(), via: z.enum(["direct", "role", "group"]), service_ids: z.array(z.string()).nullable() }).strict()),
  sales_team: z.string().nullable(), no_sales: z.boolean(),
  can: z.object({ add_people: z.boolean(), invite: z.boolean() }).strict()
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const readAccess: AccessPolicy = { scopes: ["organization"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"] };
const person = (ctx: PublicationContext) => { if (!ctx.auth) throw forbidden("sales_team_setup_person", "The salesperson setup is answered by a person."); return ctx.auth; };

let registered = false;
export function registerSalesTeamSetupPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "sales-team-setup", version: "1", apps: ["scheduling"], exports: {
    status: { description: "Who sells at the organization (GP-144): the people in the branch's Sales department (`salespeople`; `via` says whether they are in it directly, through a role or through a group) and, for each, the company profile services they may sell (`service_ids`, null while nothing was said: then every one), with the services the company does, the Sales department (null while there is none), the organization's people who could be added and whether the person may add and invite people (`can`).",
      schema: json(statusSchema), schemaVersion: "1", access: readAccess,
      read: async (ctx) => ({ value: await readSalesTeamSetup(ctx.organizationId, text(ctx.branchId || ctx.auth?.branchId) || "default", ctx.auth) }) }
  } });
  registerAction({ id: "sales.team.setup.apply", version: "1", domain: "scheduling", implementation: backendImplementationDigest(),
    description: "Save who sells (GP-144): the people given become the Sales department's direct members, so sales appointments can go to them (direct members left out are taken off; anyone in it through a role or a group stays), and each one's `service_ids`, the company profile services they may sell, replace the services in their assignee capabilities. Makes the Sales department when the branch has none. Add someone new first with workforce.users.add.",
    inputSchema: json(salesTeamInputSchema) as Record<string, unknown>, outputSchema: json(statusSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.scheduling"] },
    validateInput: (value) => { salesTeamInputSchema.parse(value); },
    execute: (ctx, _target, value) => applySalesTeamSetup(person(ctx), value) });
}
