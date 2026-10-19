import path from "node:path";
import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden } from "../platform/errors.js";
import { ensureSqlColumn, openSqlStore, type SqlStore } from "../platform/sql_store.js";
import { env } from "../src/config/env.js";
import { assigneeAdapters } from "./adapters.js";
import { ASSIGNEE_KINDS, assigneeKey, assigneeRefSchema, parseAssigneeKey, type AssigneeKind, type AssigneeRecord, type AssigneeRef, type AssigneeStoreRecord } from "./contract.js";
import { onboardingRequirementsSchema, type OnboardingRequirement } from "../connections/onboarding-contract.js";
import { staffingRequirementListSchema, type StaffingRequirement } from "./staffing-requirements.js";

/**
 * The base record and the operations every assignee shares. See docs/architecture/assignee-base.md.
 *
 * The three kinds keep their own stores. A shared field is read from the home it already had wherever it had one
 * (adapters.ts); the base record holds only what had no home: the types of an outside company, the permission set an
 * outside company carries, and the standing staffing requirements of a group.
 *
 * An assignee's types depend on its kind. A person's types are their access roles; there is no user type. A group has
 * exactly one type, its `kind_id`. An outside company has zero or more of the organization's company types.
 */

// ---- Who is acting ----
/** Who is acting. Published actions run by the platform itself carry no user; the publication layer has already authorized them. */
export type Actor = Pick<PlatformAuthContext, "orgId" | "userId"> & Partial<PlatformAuthContext> & { system?: boolean };
/** A person needs the permission in this organization; the platform acting for an already-authorized action does not. */
export function requireActor(orgId: string, actor: Actor, permission: string, code: string, message: string) {
  if (!actor || actor.orgId !== orgId || (!actor.system && !hasPermission(actor as PlatformAuthContext, permission))) throw forbidden(code, message);
}

// ---- Store ----
let database: SqlStore | null = null;
let databasePath = "";
/** One small database for what belongs to assignees in general: base records and time off. SQLite locally, PostgreSQL in cluster mode. */
export function getAssigneeDatabase() {
  const filename = path.resolve(process.cwd(), env.platformStorageRoot, "assignees.sqlite");
  if (database && databasePath === filename) return database;
  void database?.close();
  databasePath = filename;
  database = openSqlStore({ id: "assignees", filename, schemaVersion: 2, initialize: async (db) => {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS assignee_base (
        organization_id TEXT NOT NULL,
        assignee_kind TEXT NOT NULL,
        assignee_id TEXT NOT NULL,
        type_ids_json TEXT NOT NULL DEFAULT '[]',
        permission_defaults_json TEXT NOT NULL DEFAULT '{}',
        staffing_requirements_json TEXT NOT NULL DEFAULT '[]',
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (organization_id, assignee_kind, assignee_id)
      );
      CREATE TABLE IF NOT EXISTS assignee_time_off (
        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
        assignee_kind TEXT NOT NULL,
        assignee_id TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_user_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS assignee_time_off_range_idx ON assignee_time_off (organization_id, ends_at, starts_at);
      CREATE INDEX IF NOT EXISTS assignee_time_off_assignee_idx ON assignee_time_off (organization_id, assignee_kind, assignee_id, ends_at);
    `);
    // A database made before these columns existed gets them here.
    await ensureSqlColumn(db, "assignee_base", "type_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    await ensureSqlColumn(db, "assignee_base", "staffing_requirements_json", "TEXT NOT NULL DEFAULT '[]'");
  } });
  return database;
}

const text = (value: unknown) => String(value ?? "").trim();
const parse = <T>(value: unknown, fallback: T): T => { try { return value ? JSON.parse(String(value)) as T : fallback; } catch { return fallback; } };
const idList = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];

// ---- The contract, over all three kinds ----
const adapters = assigneeAdapters(async (orgId, onlyId) => {
  const rows = onlyId
    ? await getAssigneeDatabase().prepare("SELECT assignee_id, type_ids_json FROM assignee_base WHERE organization_id=? AND assignee_kind='organization_connection' AND assignee_id=?").all(orgId, onlyId)
    : await getAssigneeDatabase().prepare("SELECT assignee_id, type_ids_json FROM assignee_base WHERE organization_id=? AND assignee_kind='organization_connection'").all(orgId);
  return new Map(rows.map((row) => [text(row.assignee_id), idList(parse<unknown[]>(row.type_ids_json, []))]));
});
/**
 * Department assignment for all three kinds comes from the one department catalog, resolved the way access and
 * scheduling already resolve it: direct assignment, a role, the type of a group, and for a person the groups they are
 * in. Reads only.
 */
async function departmentsOf(orgId: string) {
  const structure = await (await import("../workforce/organization-structure.js")).resolveOrganizationStructure(orgId);
  return (record: AssigneeStoreRecord): AssigneeRecord => ({ ...record, department_ids: [...new Set((record.kind === "organization_user" ? structure.users : record.kind === "resource_group" ? structure.groups : structure.connections).find((entry) => entry.id === record.ref.id)?.department_ids || [])].sort() });
}
/**
 * The store's own part of an assignee: everything but its departments. For callers that only need to know it exists,
 * its name or a field of its own record, without resolving the organization's structure. Reads only.
 */
export async function readAssigneeStoreRecord(orgId: string, ref: AssigneeRef): Promise<AssigneeStoreRecord | null> {
  return adapters[ref.type].read(orgId, ref.id);
}
/** The assignee behind a reference whatever its status, or null when its store has no such record. Reads only. */
export async function readAssigneeRecord(orgId: string, ref: AssigneeRef): Promise<AssigneeRecord | null> {
  const found = await adapters[ref.type].read(orgId, ref.id);
  return found ? (await departmentsOf(orgId))(found) : null;
}
/** Every assignee that is not archived, of the kinds asked for. Reads only. */
export async function listAssigneeRecords(orgId: string, kinds: readonly AssigneeKind[] = ASSIGNEE_KINDS): Promise<AssigneeRecord[]> {
  const [records, withDepartments] = await Promise.all([Promise.all(kinds.map((kind) => adapters[kind].list(orgId))), departmentsOf(orgId)]);
  return records.flat().map(withDepartments);
}
/** Refuses anything saved against an assignee that does not exist or has been archived, so nothing is orphaned from the start. */
export async function requireAssigneeRecord(orgId: string, ref: AssigneeRef): Promise<AssigneeStoreRecord> {
  const found = await readAssigneeStoreRecord(orgId, ref);
  if (!found || found.status === "archived") throw badRequest("assignee_unknown", "That person, group or company is not available in this organization.");
  return found;
}

/**
 * An assignee's types, whatever its kind: the access roles a person resolves to today (their saved roles, or the role
 * inferred for them when none are saved), a group's one type, an outside company's zero or more company types. Empty
 * when there is no such assignee. Pay defaults and field homes attach to these. Reads only.
 */
export async function assigneeTypeIds(orgId: string, ref: AssigneeRef): Promise<string[]> {
  return [...((await readAssigneeStoreRecord(orgId, ref))?.type_ids || [])];
}

// ---- The organization's type lists ----
/**
 * There are two lists, both in the workforce configuration and of the same shape. **Group types** are the existing
 * `resource_group_kinds` (a group's `kind_id` is its type; departments and assignment rules already point at that
 * list). **Company types** are `organization_connection_types`. There is no user type list: a person's types are their
 * access roles, which live in the role store.
 *
 * A group type also carries `member_role_ids`: the access roles a user is given when they join a group of that type.
 */
export const ASSIGNEE_TYPE_KINDS = ["resource_group", "organization_connection"] as const;
export type AssigneeTypeKind = typeof ASSIGNEE_TYPE_KINDS[number];
export type AssigneeType = { id: string; name: string; description: string; status: "active" | "archived"; kind: AssigneeTypeKind; member_role_ids: string[]; onboarding_requirements?: OnboardingRequirement[] };
const typeId = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{0,119}$/);
export const assigneeTypeInputSchema = z.object({
  /** Which list: a type of group, or a type of outside company. */
  kind: z.enum(ASSIGNEE_TYPE_KINDS),
  id: typeId.optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  status: z.enum(["active", "archived"]).optional(),
  /** A company type only: what onboarding a company of this type needs (connections/onboarding.ts). Omitted keeps what is saved. */
  onboarding_requirements: onboardingRequirementsSchema.optional()
}).strict().refine((value) => value.kind === "organization_connection" || value.onboarding_requirements === undefined, "Only a company type has onboarding requirements.");
const TYPE_LIST = { resource_group: "resource_group_kinds", organization_connection: "organization_connection_types" } as const;
const asType = (kind: AssigneeTypeKind, definition: Record<string, unknown>): AssigneeType => ({
  id: text(definition.id), name: text(definition.name), description: text(definition.description),
  status: text(definition.status) === "archived" ? "archived" : "active", kind,
  member_role_ids: kind === "resource_group" ? idList(definition.member_role_ids) : [],
  // A company type lists its onboarding requirements only when it has some.
  ...(kind === "organization_connection" && Array.isArray(definition.onboarding_requirements) && definition.onboarding_requirements.length ? { onboarding_requirements: onboardingRequirementsSchema.safeParse(definition.onboarding_requirements).data ?? [] } : {})
});
/** Both type lists, group types first. Reads only: an organization that has never saved one gets the defaults without a row being written. */
export async function listAssigneeTypes(orgId: string): Promise<{ types: AssigneeType[]; revision: number }> {
  const definitions = await (await import("../workforce/storage.js")).readWorkforceDefinitions(orgId);
  return { types: ASSIGNEE_TYPE_KINDS.flatMap((kind) => definitions[TYPE_LIST[kind]].map((definition) => asType(kind, definition as Record<string, unknown>))), revision: definitions.revision };
}
/** The types a group can be. Reads only. */
export async function listGroupTypes(orgId: string): Promise<AssigneeType[]> { return (await listAssigneeTypes(orgId)).types.filter((type) => type.kind === "resource_group"); }
/** The types an outside company can have. Reads only. */
export async function listCompanyTypes(orgId: string): Promise<AssigneeType[]> { return (await listAssigneeTypes(orgId)).types.filter((type) => type.kind === "organization_connection"); }
/** Adds a group type or a company type, or changes one. A type cannot be archived while a group or a company still has it. */
export async function saveAssigneeType(orgId: string, input: unknown, actor: Actor): Promise<AssigneeType> {
  requireActor(orgId, actor, "manage_company_settings", "assignee_type_write_denied", "Changing group types and company types requires company settings access.");
  const parsed = assigneeTypeInputSchema.parse(input);
  const id = parsed.id || parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest("assignee_type_id", "Give the type a name with at least one letter or number.");
  if (parsed.status === "archived") {
    const inUse = (await listAssigneeRecords(orgId, [parsed.kind])).filter((record) => record.type_ids.includes(id));
    if (inUse.length) throw badRequest("assignee_type_in_use", `${inUse.length === 1 ? `${inUse[0]!.name} still has` : `${inUse.length} assignees still have`} this type. Give them another type first.`);
  }
  const workforce = await import("../workforce/storage.js");
  const current = await workforce.readWorkforceConfiguration(orgId);
  const list = TYPE_LIST[parsed.kind];
  const existing = (current[list] as Record<string, unknown>[]).find((definition) => text(definition.id) === id);
  // A group type's `member_role_ids` are kept by this save: only `setGroupTypeMemberRoles` changes them.
  const saved = await workforce.saveWorkforceConfiguration(orgId, {
    [list]: [{ id, name: parsed.name, description: parsed.description ?? text(existing?.description), status: parsed.status || "active", ...(parsed.onboarding_requirements ? { onboarding_requirements: parsed.onboarding_requirements } : {}) }],
    expected_revision: current.revision
  });
  return asType(parsed.kind, (saved[list] as Record<string, unknown>[]).find((definition) => text(definition.id) === id)!);
}

// ---- The roles a group type gives its members ----
export const groupTypeMemberRolesInputSchema = z.object({
  /** The group type. */
  id: typeId,
  /** The access roles a user is given when they join a group of this type. */
  member_role_ids: z.array(z.string().trim().toLowerCase().min(1).max(120)).max(50)
}).strict();
/**
 * Permission defaults live on the group type, not on each group. This sets the access roles a user is given when they
 * join a group of that type. The roles are added to the user when they join (`workforce/storage.ts`,
 * `grantGroupTypeRolesOnJoin`); nothing here changes anyone who is already a member, and leaving a group removes
 * nothing. Choosing roles is permission administration, so it needs that permission rather than company settings.
 */
export async function setGroupTypeMemberRoles(orgId: string, input: unknown, actor: Actor): Promise<AssigneeType> {
  requireActor(orgId, actor, "manage_company_user_permissions", "assignee_type_member_roles_denied", "Changing the roles a group type gives its members requires permission administration access.");
  const parsed = groupTypeMemberRolesInputSchema.parse(input);
  const type = (await listGroupTypes(orgId)).find((entry) => entry.id === parsed.id);
  if (!type || type.status === "archived") throw badRequest("assignee_type_unknown", "There is no group type with that id.");
  const roles = new Set((await (await import("../workforce/access.js")).listAccessRoles(orgId)).map((role) => text(role.id)));
  const unknown = parsed.member_role_ids.filter((roleId) => !roles.has(roleId));
  if (unknown.length) throw badRequest("assignee_permission_role_unknown", `There is no role called ${unknown.join(", ")}.`);
  const saved = await (await import("../workforce/storage.js")).setResourceGroupKindMemberRoles(orgId, parsed.id, parsed.member_role_ids);
  return asType("resource_group", (saved.resource_group_kinds as Record<string, unknown>[]).find((definition) => text(definition.id) === parsed.id)!);
}

// ---- The base record ----
/**
 * The permission set an outside company carries: the roles and overrides its own people get while they work on this
 * organization's projects. It is stored and documented only; nothing resolves it yet, and nothing here is read when a
 * permission is checked.
 *
 * The other kinds keep nothing here. A person carries their own roles, on the user document. A group carries none of
 * its own: the roles its members get on joining belong to its type (`member_role_ids`).
 */
export const permissionDefaultsSchema = z.object({
  access_role_ids: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
  permission_overrides: z.record(z.string().trim().min(1).max(160), z.boolean()).default({})
}).strict();
export type PermissionDefaults = z.infer<typeof permissionDefaultsSchema>;
export type CarriedPermissions = PermissionDefaults & { applies_to: "self" | "members_on_join" | "external_people" };

export type AssigneeBase = {
  assignee: AssigneeRef;
  /** An outside company's types. Empty for the other kinds: a person's types are their roles and a group's is its `kind_id`. */
  type_ids: string[];
  /** An outside company's own permission set. Empty for the other kinds. */
  permission_defaults: PermissionDefaults;
  /** A group's standing staffing requirements. Empty for the other kinds. */
  staffing_requirements: StaffingRequirement[];
  /** 0 when nothing has been saved for this assignee. */
  revision: number;
};
const emptyBase = (assignee: AssigneeRef): AssigneeBase => ({ assignee, type_ids: [], permission_defaults: { access_role_ids: [], permission_overrides: {} }, staffing_requirements: [], revision: 0 });
const baseRow = (row: Record<string, unknown>): AssigneeBase => ({
  assignee: { type: text(row.assignee_kind) as AssigneeKind, id: text(row.assignee_id) },
  type_ids: idList(parse<unknown[]>(row.type_ids_json, [])),
  permission_defaults: { access_role_ids: [], permission_overrides: {}, ...parse<Partial<PermissionDefaults>>(row.permission_defaults_json, {}) },
  staffing_requirements: parse<StaffingRequirement[]>(row.staffing_requirements_json, []),
  revision: Number(row.revision || 0)
});
export async function readAssigneeBase(orgId: string, ref: AssigneeRef): Promise<AssigneeBase> {
  const row = await getAssigneeDatabase().prepare("SELECT * FROM assignee_base WHERE organization_id=? AND assignee_kind=? AND assignee_id=?").get(orgId, ref.type, ref.id);
  return row ? baseRow(row) : emptyBase(ref);
}
export async function listAssigneeBases(orgId: string): Promise<AssigneeBase[]> {
  return (await getAssigneeDatabase().prepare("SELECT * FROM assignee_base WHERE organization_id=? ORDER BY assignee_kind, assignee_id").all(orgId)).map(baseRow);
}
/** The one writer of a base record. Callers authorize and validate first. */
export async function writeAssigneeBase(orgId: string, ref: AssigneeRef, change: Partial<Pick<AssigneeBase, "type_ids" | "permission_defaults" | "staffing_requirements">>, actor: Actor, expectedRevision?: number): Promise<AssigneeBase> {
  return getAssigneeDatabase().transaction(async (db) => {
    const row = await db.prepare("SELECT * FROM assignee_base WHERE organization_id=? AND assignee_kind=? AND assignee_id=?").get(orgId, ref.type, ref.id);
    const current = row ? baseRow(row) : emptyBase(ref);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw conflict("assignee_base_revision_conflict", "This assignee changed elsewhere. Reload and try again.");
    const next = { ...current, ...change };
    const now = new Date().toISOString();
    if (row) await db.prepare("UPDATE assignee_base SET type_ids_json=?, permission_defaults_json=?, staffing_requirements_json=?, revision=revision+1, updated_at=?, updated_by_user_id=? WHERE organization_id=? AND assignee_kind=? AND assignee_id=?")
      .run(JSON.stringify(next.type_ids), JSON.stringify(next.permission_defaults), JSON.stringify(next.staffing_requirements), now, text(actor.userId), orgId, ref.type, ref.id);
    else await db.prepare("INSERT INTO assignee_base (organization_id, assignee_kind, assignee_id, type_ids_json, permission_defaults_json, staffing_requirements_json, revision, updated_at, updated_by_user_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)")
      .run(orgId, ref.type, ref.id, JSON.stringify(next.type_ids), JSON.stringify(next.permission_defaults), JSON.stringify(next.staffing_requirements), now, text(actor.userId));
    return { ...next, revision: current.revision + 1 };
  }, `${orgId}:${assigneeKey(ref)}`);
}

// ---- Types and tags of one assignee ----
export const assigneeProfileInputSchema = z.object({
  assignee: assigneeRefSchema,
  /**
   * The assignee's types. For an outside company, the whole list of its company types (empty clears it). For a group,
   * exactly one group type. Not for a person: a person's types are their access roles, changed by assigning roles.
   */
  type_ids: z.array(typeId).max(50).optional(),
  tag_ids: z.array(z.string().trim().min(1).max(120)).max(100).optional()
}).strict().refine((value) => value.type_ids !== undefined || value.tag_ids !== undefined, "Give types, tags, or both.");
export type AssigneeProfile = { assignee: AssigneeRef; id: string; name: string; type_ids: string[]; tag_ids: string[] };
/** Sets an assignee's types, its tags, or both, writing each to where that kind keeps it. */
export async function setAssigneeProfile(orgId: string, input: unknown, actor: Actor): Promise<AssigneeProfile> {
  requireActor(orgId, actor, "manage_company_settings", "assignee_profile_write_denied", "Changing an assignee's types or tags requires company settings access.");
  const parsed = assigneeProfileInputSchema.parse(input);
  let record = await requireAssigneeRecord(orgId, parsed.assignee);
  if (parsed.type_ids !== undefined) {
    const typeIds = [...new Set(parsed.type_ids)];
    if (record.kind === "organization_user") throw badRequest("assignee_type_person", "A person's types are their roles. Assign or remove roles instead.");
    if (record.kind === "resource_group" && typeIds.length !== 1) throw badRequest("assignee_type_required", "A group has exactly one type. Choose one.");
    const known = (await listAssigneeTypes(orgId)).types.filter((type) => type.kind === record.kind);
    for (const id of typeIds.filter((entry) => !record.type_ids.includes(entry))) {
      const type = known.find((entry) => entry.id === id);
      if (!type || type.status === "archived") throw badRequest("assignee_type_unknown", record.kind === "resource_group" ? `There is no group type called ${id}.` : `There is no company type called ${id}.`);
    }
    // A group's type is its kind: one field, kept where it always was. A company's list had no home and is in the base record.
    if (record.kind === "resource_group") { if (typeIds[0] !== record.type_ids[0]) await (await import("../workforce/storage.js")).patchResourceGroup(orgId, record.ref.id, { kind_id: typeIds[0], expected_revision: record.store_revision }); }
    else await writeAssigneeBase(orgId, record.ref, { type_ids: typeIds }, actor);
    record = await requireAssigneeRecord(orgId, parsed.assignee);
  }
  if (parsed.tag_ids !== undefined) {
    const tagIds = await (await import("../workforce/storage.js")).assertAssignmentTagsExist(orgId, parsed.tag_ids);
    await adapters[record.kind].setTags(orgId, record, tagIds);
    record = await requireAssigneeRecord(orgId, parsed.assignee);
  }
  return { assignee: record.ref, id: record.key, name: record.name, type_ids: record.type_ids, tag_ids: record.tag_ids };
}

// ---- An outside company's permission set ----
export const permissionDefaultsInputSchema = permissionDefaultsSchema.extend({ assignee: assigneeRefSchema, expected_revision: z.number().int().nonnegative().optional() }).strict();
/**
 * What an assignee carries, and for whom. A person's are read from their own user record, where permissions live. A
 * group's are the roles its type gives a user on joining. An outside company's are its own permission set. Reads only.
 */
export async function carriedPermissions(orgId: string, record: AssigneeStoreRecord): Promise<CarriedPermissions> {
  if (record.kind === "organization_user") {
    const overrides = Object.fromEntries(Object.entries((record.record.permission_overrides && typeof record.record.permission_overrides === "object" ? record.record.permission_overrides : {}) as Record<string, unknown>).map(([key, value]) => [key, value === true]));
    return { applies_to: "self", access_role_ids: [...record.role_ids], permission_overrides: overrides };
  }
  if (record.kind === "resource_group") return { applies_to: "members_on_join", access_role_ids: (await listGroupTypes(orgId)).find((type) => type.id === record.type_ids[0])?.member_role_ids || [], permission_overrides: {} };
  return { applies_to: "external_people", ...(await readAssigneeBase(orgId, record.ref)).permission_defaults };
}
/**
 * The permission set one outside company carries, for whoever administers permissions. It is read by the company's
 * assignee key and is not part of the directory row, which anyone who can view the schedule reads. Reads only.
 */
export async function readCompanyPermissionDefaults(orgId: string, key: unknown): Promise<{ assignee: AssigneeRef; permission_defaults: PermissionDefaults; revision: number }> {
  const ref = parseAssigneeKey(key);
  if (!ref || ref.type !== "organization_connection") throw badRequest("assignee_permission_defaults_company", "Name an outside company by its assignee key, organization_connection:<id>.");
  const record = await requireAssigneeRecord(orgId, ref);
  const saved = await readAssigneeBase(orgId, record.ref);
  return { assignee: record.ref, permission_defaults: saved.permission_defaults, revision: saved.revision };
}
/** Sets the permission set an outside company carries. It changes no user's permissions and no permission check; nothing resolves it yet. */
export async function setPermissionDefaults(orgId: string, input: unknown, actor: Actor): Promise<CarriedPermissions & { assignee: AssigneeRef; revision: number }> {
  requireActor(orgId, actor, "manage_company_user_permissions", "assignee_permission_defaults_denied", "Changing the permissions an outside company carries requires permission administration access.");
  const { assignee, expected_revision, ...defaults } = permissionDefaultsInputSchema.parse(input);
  const record = await requireAssigneeRecord(orgId, assignee);
  if (record.kind === "organization_user") throw badRequest("assignee_permission_defaults_person", "A person's permissions are their own roles. Change those instead.");
  if (record.kind === "resource_group") throw badRequest("assignee_permission_defaults_group", "A group has no permissions of its own. Set the roles its type gives members on joining instead.");
  const roles = new Set((await (await import("../workforce/access.js")).listAccessRoles(orgId)).map((role) => text(role.id)));
  const unknown = defaults.access_role_ids.filter((roleId) => !roles.has(roleId));
  if (unknown.length) throw badRequest("assignee_permission_role_unknown", `There is no role called ${unknown.join(", ")}.`);
  const saved = await writeAssigneeBase(orgId, record.ref, { permission_defaults: defaults }, actor, expected_revision);
  return { assignee: record.ref, applies_to: "external_people", ...saved.permission_defaults, revision: saved.revision };
}

// ---- A group's standing staffing requirements ----
export const groupStaffingRequirementsInputSchema = z.object({ assignee: assigneeRefSchema, staffing_requirements: staffingRequirementListSchema, expected_revision: z.number().int().nonnegative().optional() }).strict();
/** Replaces the staffing requirements a group should always meet. Only an assignee made of people can have them. */
export async function setGroupStaffingRequirements(orgId: string, input: unknown, actor: Actor) {
  requireActor(orgId, actor, "manage_company_settings", "assignee_staffing_requirements_write_denied", "Changing who a group should always have requires company settings access.");
  const parsed = groupStaffingRequirementsInputSchema.parse(input);
  const record = await requireAssigneeRecord(orgId, parsed.assignee);
  if (!record.traits.has_members) throw badRequest("assignee_staffing_requirements_no_members", "Only a group of people can have staffing requirements of its own. Put the requirement on the work instead.");
  const saved = await writeAssigneeBase(orgId, record.ref, { staffing_requirements: parsed.staffing_requirements }, actor, parsed.expected_revision);
  return { assignee: record.ref, staffing_requirements: saved.staffing_requirements, revision: saved.revision };
}

// ---- Cleaning up after an assignee is removed ----
export type CleanupResult = { name: string; removed: number; kept: number; detail: string; error: string };
type Cleanup = (orgId: string, ref: AssigneeRef, actor: Actor) => Promise<{ removed: number; kept?: number; detail?: string }>;
const cleanups = new Map<string, Cleanup>();
/**
 * Registers what a module does with the records it keeps against an assignee once that assignee is gone. The module
 * that owns the records registers the step; this module never reaches into another module's store.
 */
export function registerAssigneeCleanup(name: string, run: Cleanup) { cleanups.set(name, run); }
/**
 * The modules that register a cleanup step when they load. They are loaded before a cleanup runs, so a step is never
 * skipped because nothing had imported its module yet. Add a module here when it starts keeping records by assignee.
 */
const cleanupOwners: Array<() => Promise<unknown>> = [() => import("../labor/assignees.js"), () => import("../payroll/assignee-cleanup.js")];
export async function assigneeCleanupNames() { await Promise.all(cleanupOwners.map((load) => load())); return ["assignee-base", "assignee-time-off", ...cleanups.keys()]; }
/**
 * Removes what hangs off a reference to an assignee that has been archived or no longer exists. Each step reports
 * what it removed and what it had to keep; one step failing does not stop the others. An assignee that is still
 * active is refused, so this can never strip a working assignee.
 */
export async function cleanupAssignee(orgId: string, refValue: unknown, actor: Actor): Promise<{ assignee: AssigneeRef; steps: CleanupResult[] }> {
  requireActor(orgId, actor, "manage_company_settings", "assignee_cleanup_denied", "Cleaning up after an assignee requires company settings access.");
  const ref = assigneeRefSchema.parse(refValue);
  const record = await readAssigneeStoreRecord(orgId, ref);
  if (record && record.status !== "archived") throw badRequest("assignee_still_active", `${record.name} has not been removed. Archive it first.`);
  const own: [string, Cleanup][] = [
    ["assignee-base", async () => ({ removed: (await getAssigneeDatabase().prepare("DELETE FROM assignee_base WHERE organization_id=? AND assignee_kind=? AND assignee_id=?").run(orgId, ref.type, ref.id)).changes })],
    ["assignee-time-off", async () => ({ removed: (await getAssigneeDatabase().prepare("DELETE FROM assignee_time_off WHERE organization_id=? AND assignee_kind=? AND assignee_id=?").run(orgId, ref.type, ref.id)).changes })]
  ];
  await Promise.all(cleanupOwners.map((load) => load()));
  const steps: CleanupResult[] = [];
  for (const [name, run] of [...own, ...cleanups]) {
    try { const result = await run(orgId, ref, actor); steps.push({ name, removed: result.removed, kept: result.kept || 0, detail: result.detail || "", error: "" }); }
    catch (error) { steps.push({ name, removed: 0, kept: 0, detail: "", error: error instanceof Error ? error.message : "This step failed." }); }
  }
  return { assignee: ref, steps };
}
