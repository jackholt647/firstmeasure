import { badRequest, conflict, notFound, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { contentHash } from "../platform/publication/validation.js";
import { fieldPath, fieldSchema, object } from "./contracts.js";
import { FIELD_HOMES, fieldHome, homeKindOf, type FieldEntity, type FieldHome, type FieldHomeKind } from "./owners.js";

// Field homes. A definition of a user, group, outside company or department field is made on a role, a group type, a
// company type or one department. A record has the fields of the homes it is in; a value whose home the record has
// left stays stored and is neither shown nor validated. See docs/architecture/custom-fields.md.

const text = (value: unknown) => String(value ?? "").trim();
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const pathOf = (field: JsonObject) => String(field.path || field.key || "");
const sameHome = (field: JsonObject, home: FieldHome) => object(field.home).kind === home.kind && text(object(field.home).id) === home.id;
async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try { return await run(); } catch (error) { if ((error instanceof PlatformError && error.statusCode === 404) || (error as { code?: string })?.code === "ENOENT") return null; throw error; }
}
const readModule = (orgId: string) => optional(() => readBranchModule(orgId, "default", "custom_fields"));

export type RecordHomes = { kind: FieldHomeKind; ids: string[] };
export type HomeRow = { id: string; name: string; status: string };

/**
 * The assignee module is being built beside this one. It is loaded by name at run time so that this file neither
 * type-checks against it nor fails without it; every use tolerates its absence.
 */
async function assigneeBase(): Promise<Record<string, any> | null> {
  const specifier = "../assignees/base.js";
  try { return await import(specifier) as Record<string, any>; } catch { return null; }
}

/** The types an outside company has: zero or more, kept by the assignee base. */
let companyTypeReader: ((orgId: string, id: string) => Promise<string[]>) | null = null;
/** The owner of company types may supply its reader; without one the assignee record is read by name. */
export function useCompanyTypeReader(reader: ((orgId: string, id: string) => Promise<string[]>) | null) { companyTypeReader = reader; }
async function companyTypeIds(orgId: string, id: string): Promise<string[]> {
  if (companyTypeReader) return unique((await companyTypeReader(orgId, id)).map(text));
  try {
    const base = await assigneeBase();
    const ref = { type: "organization_connection", id };
    if (typeof base?.assigneeTypeIds === "function") return unique((await base.assigneeTypeIds(orgId, ref) as unknown[]).map(text));
    if (typeof base?.readAssigneeRecord !== "function") return [];
    const row = object(await base.readAssigneeRecord(orgId, ref));
    return unique([...(Array.isArray(row.type_ids) ? row.type_ids.map(text) : []), text(row.type_id)]);
  } catch { return []; }
}

/** The homes a record is in, in the order their fields are shown. null: this kind of owner has no homes. */
export async function recordHomes(orgId: string, entity: FieldEntity, record: JsonObject): Promise<RecordHomes | null> {
  const kind = homeKindOf(entity);
  if (!kind) return null;
  const id = text(record.owner_id || record.id);
  if (kind === "role") return { kind, ids: unique([...(Array.isArray(record.access_role_ids) ? record.access_role_ids : []), ...(Array.isArray(record.roles) ? record.roles : [])].map(text)) };
  if (kind === "department") return { kind, ids: id ? [id] : [] };
  if (!id) return { kind, ids: [] };
  if (kind === "group_type") {
    const db = (await import("../workforce/storage.js")).getWorkforceDatabase();
    const row = await db.prepare("SELECT kind_id FROM resource_groups WHERE organization_id=? AND id=?").get(orgId, id);
    return { kind, ids: row ? [text(row.kind_id || "crew")] : [] };
  }
  return { kind, ids: await companyTypeIds(orgId, id) };
}

/**
 * The definitions that apply to a record in `homes`, one per path. Definitions with no home apply to every record.
 * When two of the record's homes declare the same path, the first home's definition is shown, the field is required,
 * private or read-only if any of them says so, and every one of their permissions must be held. `hidden` lists the
 * paths that belong only to homes the record is not in: their stored values are kept and not published.
 */
export function resolveHomedFields(fields: JsonObject[], homes: RecordHomes): { fields: JsonObject[]; hidden: string[] } {
  const position = new Map(homes.ids.map((id, index) => [id, index]));
  const byPath = new Map<string, JsonObject[]>(), hidden = new Set<string>();
  for (const field of fields) {
    const home = object(field.home), path = pathOf(field);
    if (home.kind && !(home.kind === homes.kind && position.has(text(home.id)))) { hidden.add(path); continue; }
    byPath.set(path, [...(byPath.get(path) || []), field]);
  }
  const rank = (field: JsonObject) => object(field.home).kind ? position.get(text(object(field.home).id))! : -1;
  const resolved: JsonObject[] = [];
  for (const [path, declared] of byPath) {
    hidden.delete(path);
    const active = declared.filter(field => field.retired !== true);
    const group = (active.length ? active : declared).map((field, index) => ({ field, index })).sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index).map(entry => entry.field);
    const first = group[0]!;
    if (group.length === 1 && !object(first.home).kind) { resolved.push(first); continue; }
    resolved.push({
      ...first,
      required: group.some(field => field.required === true),
      private: group.some(field => field.private === true),
      read_only: group.some(field => field.read_only === true),
      // Each home keeps its own position for the field, so a home's list reads in the order that home gave it.
      homes: group.filter(field => object(field.home).kind).map(field => ({ kind: object(field.home).kind, id: text(object(field.home).id), order: Number(field.order ?? 0) })),
      all_read_permissions: unique(group.map(field => text(field.read_permission || (field.private === true ? "manage_company_settings" : "")))),
      all_write_permissions: unique(group.map(field => text(field.write_permission)))
    });
  }
  return { fields: resolved, hidden: [...hidden] };
}

async function groupTypes(orgId: string): Promise<JsonObject[]> {
  const storage = await import("../workforce/storage.js");
  const row = object(await storage.getWorkforceDatabase().prepare("SELECT resource_group_kinds_json FROM workforce_configuration WHERE organization_id=?").get(orgId));
  let stored: JsonObject[] = [];
  try { stored = list(JSON.parse(text(row.resource_group_kinds_json) || "[]")); } catch { stored = []; }
  const byId = new Map<string, JsonObject>();
  for (const definition of [...storage.DEFAULT_RESOURCE_GROUP_KINDS.map(object), ...stored]) { const id = text(definition.id); if (id) byId.set(id, { ...byId.get(id), ...definition }); }
  return [...byId.values()];
}
const typeRow = (definition: JsonObject): HomeRow => ({ id: text(definition.id), name: text(definition.name || definition.label || definition.id), status: text(definition.status) === "archived" ? "archived" : "active" });

/**
 * The homes of one kind that exist: roles from the access role store, group types from the workforce configuration,
 * company types from the assignee base's list, departments from the department catalog. Reads only. null means the
 * list could not be reached, so an id cannot be checked: only company types, when the assignee module is absent.
 */
export async function listHomes(orgId: string, kind: FieldHomeKind): Promise<HomeRow[] | null> {
  if (kind === "role") {
    const db = (await import("../workforce/storage.js")).getWorkforceDatabase();
    return (await db.prepare("SELECT id, name, status FROM workforce_access_roles WHERE organization_id=? ORDER BY name, id").all(orgId)).map(row => ({ id: text(row.id), name: text(row.name || row.id), status: text(row.status || "active") }));
  }
  if (kind === "department") {
    const catalog = await (await import("../workforce/departments.js")).readOrganizationDepartments(orgId);
    return catalog.departments.map(row => ({ id: row.id, name: row.label, status: text((row as JsonObject).status || "active") }));
  }
  if (kind === "group_type") return (await groupTypes(orgId)).map(typeRow);
  const base = await assigneeBase();
  if (typeof base?.listCompanyTypes !== "function") return null;
  const found = await base.listCompanyTypes(orgId);
  return list(Array.isArray(found) ? found : object(found).types).map(typeRow);
}

async function assertHome(orgId: string, home: FieldHome) {
  const homes = await listHomes(orgId, home.kind);
  if (homes === null || homes.some(row => row.id === home.id && row.status !== "archived")) return;
  // Default roles are created the first time the role store is read through its own reader.
  if (home.kind === "role" && await optional(async () => (await import("../workforce/access.js")).readAccessRole(orgId, home.id))) return;
  throw notFound("custom_field_home_not_found", `That ${home.kind.replace("_", " ")} was not found, or is archived.`);
}

const homeRevision = (home: FieldHome, fields: JsonObject[]) => contentHash({ home, fields });
// `schema` stays what the author declared (subfields of a dictionary or list); `value_schema` is the whole contract a value must meet.
const withSchema = (field: JsonObject): JsonObject => { try { return { ...field, value_schema: fieldSchema(field) }; } catch { return { ...field }; } };
const ordered = (fields: JsonObject[]) => fields.map((field, index) => ({ field, index })).sort((a, b) => Number(a.field.order ?? a.index) - Number(b.field.order ?? b.index) || a.index - b.index).map(entry => entry.field);

/** The definitions made on one role, group type, company type or department, in their order. */
export async function homeDefinitions(orgId: string, kindValue: unknown, idValue: unknown) {
  const home = fieldHome({ kind: kindValue, id: idValue })!;
  const data = object((await readModule(orgId))?.data);
  const fields = ordered(list(data.fields).filter(field => sameHome(field, home)));
  const homes = await listHomes(orgId, home.kind), row = homes?.find(entry => entry.id === home.id);
  return {
    home: { ...home, name: row?.name || home.id, exists: homes === null ? null : !!row },
    entity: FIELD_HOMES[home.kind].entity,
    revision: homeRevision(home, fields),
    fields: fields.map(withSchema),
    retired: list(data.retired_fields).filter(field => sameHome(field, home))
  };
}

/** Definitions of a people owner that name no home. They still apply to every record until someone places them. */
export async function unassignedDefinitions(orgId: string, entityValue?: unknown) {
  const entity = text(entityValue);
  if (entity && !homeKindOf(entity)) throw badRequest("custom_field_home_invalid", "Only user, team, company and department fields have a home.");
  const data = object((await readModule(orgId))?.data);
  const fields = list(data.fields).filter(field => homeKindOf(text(field.entity)) && !object(field.home).kind && (!entity || field.entity === entity));
  return { fields: fields.map(field => ({ ...withSchema(field), home_kind: homeKindOf(text(field.entity)) })), revision: contentHash(fields) };
}

/** Every home that exists or holds definitions, with how many fields it holds. */
export async function homeIndex(orgId: string) {
  const data = object((await readModule(orgId))?.data);
  const homes: JsonObject[] = [];
  for (const kind of Object.keys(FIELD_HOMES) as FieldHomeKind[]) {
    const count = new Map<string, number>();
    for (const field of list(data.fields)) if (object(field.home).kind === kind) count.set(text(object(field.home).id), (count.get(text(object(field.home).id)) || 0) + 1);
    const known = await listHomes(orgId, kind);
    for (const row of known || []) homes.push({ kind, id: row.id, name: row.name, status: row.status, exists: true, fields: count.get(row.id) || 0 });
    for (const [id, fields] of count) if (!(known || []).some(row => row.id === id)) homes.push({ kind, id, name: id, status: "active", exists: known === null ? null : false, fields });
  }
  return { homes, entities: Object.fromEntries((Object.keys(FIELD_HOMES) as FieldHomeKind[]).map(kind => [kind, FIELD_HOMES[kind].entity])) };
}

const SERVER_OWNED = ["value_schema", "writable", "homes", "all_read_permissions", "all_write_permissions", "inferred", "retired", "home_kind", "value", "source"];
async function writeModule(orgId: string, change: (fields: JsonObject[], data: JsonObject) => JsonObject[]) {
  for (let attempt = 0; ; attempt += 1) {
    const module = await readModule(orgId), data = object(module?.data);
    const fields = change(list(data.fields), data);
    try {
      return await saveBranchModule(orgId, "default", "custom_fields", { data: { ...data, fields }, metadata: object(module?.metadata), expected_revision: Number(module?.revision || 0) }, { replace: true });
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "revision_conflict" || attempt >= 2) throw error;
    }
  }
}

/**
 * Replace the definitions of one home. `fields` is the whole list in order: a definition left out is retired, which
 * keeps its access rules over values already stored. `expectedRevision` is the revision the definitions export gave.
 */
export async function saveHomeDefinitions(orgId: string, input: Record<string, unknown>) {
  const home = fieldHome({ kind: input.kind, id: input.id })!, entity = FIELD_HOMES[home.kind].entity;
  if (!Array.isArray(input.fields) || input.fields.length > 256) throw badRequest("custom_field_definitions", "Supply at most 256 field definitions.");
  await assertHome(orgId, home);
  const submitted = input.fields.map((raw, index) => {
    const field: JsonObject = { ...object(raw) };
    if (field.entity !== undefined && field.entity !== entity) throw badRequest("custom_field_home_invalid", `A ${home.kind.replace("_", " ")} holds ${entity} fields.`);
    if (field.home !== undefined && !sameHome(field, home)) throw badRequest("custom_field_home_invalid", "Every definition in this list belongs to the home being saved.");
    for (const key of SERVER_OWNED) delete field[key];
    return { ...field, path: fieldPath(field.path || field.key), entity, home, order: index };
  });
  const saved = await writeModule(orgId, fields => {
    if (text(input.expectedRevision) !== homeRevision(home, ordered(fields.filter(field => sameHome(field, home))))) throw conflict("revision_conflict", "These field definitions changed. Reload them and try again.");
    const taken = fields.find(field => field.entity === entity && !object(field.home).kind && submitted.some(next => next.path === pathOf(field)));
    if (taken) throw badRequest("custom_field_unassigned_conflict", `${pathOf(taken)} is an unassigned ${entity} field. Place it on this ${home.kind.replace("_", " ")} instead of defining it again.`, { path: pathOf(taken) });
    return [...fields.filter(field => !sameHome(field, home)), ...submitted];
  });
  const mine = ordered(list(object(saved.data).fields).filter(field => sameHome(field, home)));
  return { kind: home.kind, id: home.id, revision: homeRevision(home, mine), count: mine.length };
}

/** Give an unassigned definition its home. From then on it applies only to the records in that home. */
export async function placeDefinition(orgId: string, input: Record<string, unknown>) {
  const home = fieldHome({ kind: input.kind, id: input.id })!, entity = FIELD_HOMES[home.kind].entity, path = fieldPath(input.path);
  if (input.entity !== undefined && input.entity !== entity) throw badRequest("custom_field_home_invalid", `A ${home.kind.replace("_", " ")} holds ${entity} fields.`);
  await assertHome(orgId, home);
  const saved = await writeModule(orgId, fields => {
    const found = fields.find(field => field.entity === entity && pathOf(field) === path && !object(field.home).kind);
    if (!found) throw notFound("custom_field_unassigned_not_found", `There is no unassigned ${entity} field ${path}.`);
    const last = fields.filter(field => sameHome(field, home)).reduce((max, field) => Math.max(max, Number(field.order ?? -1)), -1);
    return fields.map(field => field === found ? { ...field, home, order: last + 1 } : field);
  });
  const mine = ordered(list(object(saved.data).fields).filter(field => sameHome(field, home)));
  return { kind: home.kind, id: home.id, revision: homeRevision(home, mine), count: mine.length };
}

/** The names of the homes of one kind, for showing where a field comes from. Unknown ids keep their id as the name. */
export async function homeNames(orgId: string, kind: FieldHomeKind): Promise<Map<string, string>> {
  return new Map(((await listHomes(orgId, kind).catch(() => null)) || []).map(row => [row.id, row.name]));
}
