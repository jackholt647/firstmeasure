import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync } from 'node:fs';
import { isFirstMeasurePostgresEnabled, queryPostgres } from '../src/database/postgres.js';
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import {
  assertCompensationAllowed,
  compensationPlanProjection,
  effectiveCompensation,
  normalizeCompensationProfileInput,
  type JsonObject
} from "../compensation/service.js";
import type { CompensationSubjectType } from "../compensation/schemas.js";
import { env } from "../src/config/env.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import { listScopeTemplates } from "../scopes/storage.js";

const DATABASE_SCHEMA_VERSION = 3;
const DEFAULT_BRANCH_ID = "default";

let database: SqlStore | null = null;
let databasePath = "";

export const DEFAULT_WORKFORCE_TERMINOLOGY = {
  resource_group: { singular: "Crew", plural: "Crews" },
  resource_group_member: { singular: "Crew Member", plural: "Crew Members" },
  organization_connection: { singular: "Subcontractor", plural: "Subcontractors" },
  applications: { management: "Main App", field: "Crew App" }
};

export const DEFAULT_RESOURCE_GROUP_KINDS = [
  {
    id: "crew",
    name: "Crew",
    description: "An internal production team that can be assigned work as a unit."
  }
];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function cleanId(value: unknown, label = "id") {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return id;
}

function generatedId(prefix: string) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function uniqueIds(value: unknown) {
  return [...new Set(asArray(value).map((item) => cleanId(item)).filter(Boolean))];
}

export async function assertCapabilityScopesExist(orgIdValue: string, branchIdsValue: unknown, scopeIdsValue: unknown) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const scopeIds = uniqueIds(scopeIdsValue);
  if (!scopeIds.length) return scopeIds;
  const branchIds = uniqueIds(branchIdsValue);
  if (!branchIds.length) branchIds.push(DEFAULT_BRANCH_ID);
  const knownIds = new Set((await Promise.all(branchIds.map(async (branchId) => (await listScopeTemplates(orgId, branchId, {
    include_disabled: true,
    include_archived: true
  })).map((template) => cleanText(template.id))))).flat());
  const unknownIds = scopeIds.filter((scopeId) => !knownIds.has(scopeId));
  if (unknownIds.length) {
    throw badRequest("capability_scope_not_found", "Capability scopes must reference templates available to the resource's branch.", {
      scope_ids: unknownIds,
      branch_ids: branchIds
    });
  }
  return scopeIds;
}

export async function assertCompensationCapabilityScopes(orgId: string, branchIds: unknown, input: unknown) {
  const profile = normalizeCompensationProfileInput(input);
  const scopeIds = profile.components.flatMap((component) => asArray(component.capability_scope_ids));
  (await assertCapabilityScopesExist(orgId, branchIds, scopeIds));
  return profile;
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "workforce.sqlite");
}

export async function closeWorkforceDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}
export function getWorkforceDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeWorkforceDatabase();
  database = openSqlStore({ id: "workforce", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS workforce_configuration (
      organization_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 3,
      terminology_json TEXT NOT NULL DEFAULT '{}',
      resource_group_kinds_json TEXT NOT NULL DEFAULT '[]',
      assignment_tags_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_groups (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      kind_id TEXT NOT NULL DEFAULT 'crew',
      assignment_tags_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      primary_member_user_id TEXT,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS resource_groups_branch_idx
      ON resource_groups (organization_id, branch_id, status, name);

    CREATE TABLE IF NOT EXISTS resource_group_memberships (
      organization_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      is_lead INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      joined_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id, user_id),
      FOREIGN KEY (organization_id, group_id)
        REFERENCES resource_groups (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS resource_group_memberships_user_idx
      ON resource_group_memberships (organization_id, user_id, status);

    CREATE TABLE IF NOT EXISTS resource_group_capabilities (
      organization_id TEXT NOT NULL,
      group_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, group_id, scope_id),
      FOREIGN KEY (organization_id, group_id)
        REFERENCES resource_groups (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS resource_group_capabilities_scope_idx
      ON resource_group_capabilities (organization_id, scope_id, group_id);

    CREATE TABLE IF NOT EXISTS compensation_profiles (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      currency TEXT NOT NULL DEFAULT 'USD',
      effective_from TEXT,
      effective_to TEXT,
      components_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      UNIQUE (organization_id, subject_type, subject_id)
    );
    CREATE INDEX IF NOT EXISTS compensation_profiles_subject_idx
      ON compensation_profiles (organization_id, subject_type, subject_id, status);

    CREATE TABLE IF NOT EXISTS organization_connections (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      legal_name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      relationship_type_ids_json TEXT NOT NULL DEFAULT '[]',
      contacts_json TEXT NOT NULL DEFAULT '[]',
      address_json TEXT NOT NULL DEFAULT '{}',
      payment_metadata_json TEXT NOT NULL DEFAULT '{}',
      linked_organization_id TEXT,
      link_status TEXT NOT NULL DEFAULT 'unlinked',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS organization_connections_status_idx
      ON organization_connections (organization_id, status, name);

    CREATE TABLE IF NOT EXISTS organization_connection_branches (
      organization_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, connection_id, branch_id),
      FOREIGN KEY (organization_id, connection_id)
        REFERENCES organization_connections (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS organization_connection_branches_branch_idx
      ON organization_connection_branches (organization_id, branch_id, connection_id);

    CREATE TABLE IF NOT EXISTS organization_connection_capabilities (
      organization_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (organization_id, connection_id, scope_id),
      FOREIGN KEY (organization_id, connection_id)
        REFERENCES organization_connections (organization_id, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS organization_connection_capabilities_scope_idx
      ON organization_connection_capabilities (organization_id, scope_id, connection_id);
  `));
  // Older local databases predate resource-group archiving. CREATE TABLE IF
  // NOT EXISTS does not add newly introduced columns to those databases, which
  // caused archive requests to fail at runtime when setting archived_at.
  await ensureSqlColumn(db, "resource_groups", "archived_at", "TEXT");
  await ensureSqlColumn(db, "resource_groups", "kind_id", "TEXT NOT NULL DEFAULT 'crew'");
  await ensureSqlColumn(db, "resource_groups", "assignment_tags_json", "TEXT NOT NULL DEFAULT '[]'");
  await ensureSqlColumn(db, "workforce_configuration", "resource_group_kinds_json", "TEXT NOT NULL DEFAULT '[]'");
  await ensureSqlColumn(db, "workforce_configuration", "assignment_tags_json", "TEXT NOT NULL DEFAULT '[]'");
  await db.prepare("UPDATE workforce_configuration SET schema_version=? WHERE schema_version<?").run(DATABASE_SCHEMA_VERSION, DATABASE_SCHEMA_VERSION);
  // Extension schemas are part of the same atomic initialization, so no replica
  // can see a partially initialized staff/access database.
  await initializeWorkforceExtensions(db);
}

export async function withWorkforceTransaction<T>(operation: (db: SqlStore) => T | Promise<T>) {
  return (await getWorkforceDatabase().transaction(operation));
}

function mergedTerminology(value: unknown) {
  const input = asObject(value);
  const group = asObject(input.resource_group);
  const member = asObject(input.resource_group_member);
  const connection = asObject(input.organization_connection);
  const applications = asObject(input.applications);
  return {
    resource_group: { ...DEFAULT_WORKFORCE_TERMINOLOGY.resource_group, ...group },
    resource_group_member: { ...DEFAULT_WORKFORCE_TERMINOLOGY.resource_group_member, ...member },
    organization_connection: { ...DEFAULT_WORKFORCE_TERMINOLOGY.organization_connection, ...connection },
    applications: { ...DEFAULT_WORKFORCE_TERMINOLOGY.applications, ...applications }
  };
}

function normalizedDefinitions(value: unknown, defaults: JsonObject[] = []) {
  const byId = new Map<string, JsonObject>();
  for (const definitionValue of [...defaults, ...asArray(value).map(asObject)]) {
    const definition = asObject(definitionValue);
    const id = cleanId(definition.id || definition.key || definition.name, "definition_id");
    byId.set(id, {
      ...byId.get(id),
      ...definition,
      id,
      name: cleanText(definition.name || definition.label || id) || id,
      description: cleanText(definition.description),
      status: cleanText(definition.status || "active") === "archived" ? "archived" : "active"
    });
  }
  return [...byId.values()];
}

function resourceGroupKinds(value: unknown) {
  return normalizedDefinitions(value, DEFAULT_RESOURCE_GROUP_KINDS);
}

function assignmentTagDefinitions(value: unknown) {
  return normalizedDefinitions(value);
}

async function ensureWorkforceDefaults(orgIdValue: string) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const db = getWorkforceDatabase();
  const now = nowIso();
  (await db.prepare(`INSERT INTO workforce_configuration
    (organization_id, schema_version, terminology_json, resource_group_kinds_json, assignment_tags_json, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', 1, ?, ?) ON CONFLICT DO NOTHING`)
    .run(orgId, DATABASE_SCHEMA_VERSION, json(DEFAULT_WORKFORCE_TERMINOLOGY), json(DEFAULT_RESOURCE_GROUP_KINDS), now, now));
}

function configurationView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    schema_version: Number(row.schema_version || DATABASE_SCHEMA_VERSION),
    organization_id: cleanText(row.organization_id),
    terminology: mergedTerminology(parseJson(row.terminology_json)),
    resource_group_kinds: resourceGroupKinds(parseJson(row.resource_group_kinds_json, [])),
    assignment_tags: assignmentTagDefinitions(parseJson(row.assignment_tags_json, [])),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

export async function readWorkforceConfiguration(orgId: string) {
  (await ensureWorkforceDefaults(orgId));
  return configurationView((await getWorkforceDatabase().prepare("SELECT * FROM workforce_configuration WHERE organization_id = ?").get(cleanId(orgId, "organization_id"))));
}

/** Display-only compatibility read. Unlike configuration setup, never seeds a row. */
export async function readWorkforceTerminology(orgId:string) {
  const organizationId=cleanId(orgId,'organization_id');
  if(isFirstMeasurePostgresEnabled()){
    try{
      const result=await queryPostgres('SELECT terminology_json FROM workforce_configuration WHERE organization_id = $1',[organizationId]);
      return asObject(parseJson(asObject(result.rows[0]).terminology_json));
    }catch(error:any){if(error.code==='42P01')return {};throw error;}
  }
  const filename=resolvedDatabasePath();
  if(!existsSync(filename))return {};
  // Do not initialize a store or leave another application's database open.
  const reader=new DatabaseSync(filename,{readOnly:true});
  try{
    if(!reader.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workforce_configuration'").get())return {};
    const row=reader.prepare('SELECT terminology_json FROM workforce_configuration WHERE organization_id = ?').get(organizationId);
    return asObject(parseJson(asObject(row).terminology_json));
  }finally{reader.close();}
}

export async function assertResourceGroupKindExists(orgIdValue: string, kindIdValue: unknown) {
  const kindId = cleanId(kindIdValue || "crew", "resource_group_kind_id");
  const configuration = (await readWorkforceConfiguration(cleanId(orgIdValue, "organization_id")));
  const known = asArray(configuration.resource_group_kinds).map(asObject)
    .some((definition) => cleanText(definition.id) === kindId && cleanText(definition.status || "active") !== "archived");
  if (!known) throw badRequest("resource_group_kind_not_found", `Resource group kind '${kindId}' is not active for this organization.`);
  return kindId;
}

export async function assertAssignmentTagsExist(orgIdValue: string, tagIdsValue: unknown) {
  const tagIds = uniqueIds(tagIdsValue);
  if (!tagIds.length) return tagIds;
  const configuration = (await readWorkforceConfiguration(cleanId(orgIdValue, "organization_id")));
  const known = new Set(asArray(configuration.assignment_tags).map(asObject)
    .filter((definition) => cleanText(definition.status || "active") !== "archived")
    .map((definition) => cleanText(definition.id)));
  const missing = tagIds.filter((tagId) => !known.has(tagId));
  if (missing.length) {
    throw badRequest("assignment_tag_not_found", "Assignment tags must reference active workforce tag definitions.", {
      tag_ids: missing
    });
  }
  return tagIds;
}

export async function saveWorkforceConfiguration(orgIdValue: string, inputValue: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  (await ensureWorkforceDefaults(orgId));
  return (await withWorkforceTransaction(async (db) => {
    const current = configurationView((await db.prepare("SELECT * FROM workforce_configuration WHERE organization_id = ?").get(orgId)));
    const expectedRevision = Number(inputValue.expected_revision || 0);
    if (!expectedRevision || expectedRevision !== current.revision) {
      throw conflict("workforce_configuration_revision_conflict", "Workforce configuration revision does not match.", { current_revision: current.revision });
    }
    const currentTerminology = asObject(current.terminology);
    const terminologyPatch = asObject(inputValue.terminology);
    const terminology = mergedTerminology({
      ...currentTerminology,
      ...terminologyPatch,
      resource_group: { ...asObject(currentTerminology.resource_group), ...asObject(terminologyPatch.resource_group) },
      resource_group_member: { ...asObject(currentTerminology.resource_group_member), ...asObject(terminologyPatch.resource_group_member) },
      organization_connection: { ...asObject(currentTerminology.organization_connection), ...asObject(terminologyPatch.organization_connection) },
      applications: { ...asObject(currentTerminology.applications), ...asObject(terminologyPatch.applications) }
    });
    const kinds = Object.prototype.hasOwnProperty.call(inputValue, "resource_group_kinds")
      ? resourceGroupKinds([...asArray(current.resource_group_kinds), ...asArray(inputValue.resource_group_kinds)])
      : current.resource_group_kinds;
    const tags = Object.prototype.hasOwnProperty.call(inputValue, "assignment_tags")
      ? assignmentTagDefinitions([...asArray(current.assignment_tags), ...asArray(inputValue.assignment_tags)])
      : current.assignment_tags;
    (await db.prepare(`UPDATE workforce_configuration SET terminology_json=?, resource_group_kinds_json=?, assignment_tags_json=?,
      revision=revision+1, updated_at=? WHERE organization_id=?`)
      .run(json(terminology), json(kinds), json(tags), nowIso(), orgId));
    return configurationView((await db.prepare("SELECT * FROM workforce_configuration WHERE organization_id = ?").get(orgId)));
  }));
}

function compensationProfileView(rowValue: unknown): JsonObject | null {
  if (!rowValue) return null;
  const row = asObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    subject_type: cleanText(row.subject_type),
    subject_id: cleanText(row.subject_id),
    name: cleanText(row.name),
    status: cleanText(row.status || "active"),
    currency: cleanText(row.currency || "USD"),
    effective_from: cleanText(row.effective_from),
    effective_to: cleanText(row.effective_to),
    components: asArray(parseJson(row.components_json, [])),
    notes: cleanText(row.notes),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

export async function readCompensationProfile(orgIdValue: string, subjectType: CompensationSubjectType, subjectIdValue: string) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const subjectId = cleanId(subjectIdValue, "subject_id");
  return compensationProfileView((await getWorkforceDatabase().prepare(`SELECT * FROM compensation_profiles
    WHERE organization_id=? AND subject_type=? AND subject_id=?`).get(orgId, subjectType, subjectId)));
}

export async function listCompensationProfiles(orgIdValue: string, options: JsonObject = {}) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  if (cleanText(options.subject_type)) {
    conditions.push("subject_type = ?");
    params.push(cleanText(options.subject_type));
  }
  if (cleanText(options.subject_id)) {
    conditions.push("subject_id = ?");
    params.push(cleanId(options.subject_id, "subject_id"));
  }
  if (options.include_archived !== true && cleanText(options.include_archived) !== "1") conditions.push("status <> 'archived'");
  return (await getWorkforceDatabase().prepare(`SELECT * FROM compensation_profiles WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC`)
    .all(...params)).map((row) => compensationProfileView(row) as JsonObject);
}

export async function upsertCompensationProfileRecord(
  db: SqlStore,
  orgIdValue: string,
  subjectType: CompensationSubjectType,
  subjectIdValue: string,
  inputValue: unknown
) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const subjectId = cleanId(subjectIdValue, "subject_id");
  const input = normalizeCompensationProfileInput(inputValue);
  assertCompensationAllowed(subjectType, input);
  const existingRow = (await db.prepare(`SELECT * FROM compensation_profiles WHERE organization_id=? AND subject_type=? AND subject_id=?`)
    .get(orgId, subjectType, subjectId));
  const existing = compensationProfileView(existingRow);
  if (existing && input.expected_revision && input.expected_revision !== Number(existing.revision || 0)) {
    throw conflict("compensation_revision_conflict", "Compensation profile revision does not match.", { current_revision: existing.revision });
  }
  const now = nowIso();
  if (existing) {
    (await db.prepare(`UPDATE compensation_profiles SET name=?, status=?, currency=?, effective_from=?, effective_to=?, components_json=?, notes=?,
      metadata_json=?, revision=revision+1, updated_at=?, archived_at=? WHERE organization_id=? AND subject_type=? AND subject_id=?`)
      .run(
        input.name,
        input.status,
        input.currency,
        input.effective_from || null,
        input.effective_to || null,
        json(input.components),
        input.notes,
        json({ ...asObject(existing.metadata), ...input.metadata }),
        now,
        input.status === "archived" ? now : null,
        orgId,
        subjectType,
        subjectId
      ));
  } else {
    (await db.prepare(`INSERT INTO compensation_profiles
      (id, organization_id, subject_type, subject_id, name, status, currency, effective_from, effective_to, components_json,
       notes, metadata_json, revision, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
      .run(
        generatedId("compensation"),
        orgId,
        subjectType,
        subjectId,
        input.name,
        input.status,
        input.currency,
        input.effective_from || null,
        input.effective_to || null,
        json(input.components),
        input.notes,
        json(input.metadata),
        now,
        now,
        input.status === "archived" ? now : null
      ));
  }
  return compensationProfileView((await db.prepare(`SELECT * FROM compensation_profiles
    WHERE organization_id=? AND subject_type=? AND subject_id=?`).get(orgId, subjectType, subjectId))) as JsonObject;
}

export async function saveCompensationProfile(orgId: string, subjectType: CompensationSubjectType, subjectId: string, input: unknown) {
  return (await withWorkforceTransaction(async (db) => (await upsertCompensationProfileRecord(db, orgId, subjectType, subjectId, input))));
}

export async function archiveCompensationProfile(orgIdValue: string, subjectType: CompensationSubjectType, subjectIdValue: string, expectedRevision: number) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const subjectId = cleanId(subjectIdValue, "subject_id");
  return (await withWorkforceTransaction(async (db) => {
    const current = compensationProfileView((await db.prepare(`SELECT * FROM compensation_profiles
      WHERE organization_id=? AND subject_type=? AND subject_id=?`).get(orgId, subjectType, subjectId)));
    if (!current) throw notFound("compensation_profile_not_found", "Compensation profile was not found.");
    if (expectedRevision !== Number(current.revision || 0)) {
      throw conflict("compensation_revision_conflict", "Compensation profile revision does not match.", { current_revision: current.revision });
    }
    const now = nowIso();
    (await db.prepare(`UPDATE compensation_profiles SET status='archived', archived_at=?, updated_at=?, revision=revision+1
      WHERE organization_id=? AND subject_type=? AND subject_id=?`).run(now, now, orgId, subjectType, subjectId));
    return compensationProfileView((await db.prepare(`SELECT * FROM compensation_profiles
      WHERE organization_id=? AND subject_type=? AND subject_id=?`).get(orgId, subjectType, subjectId))) as JsonObject;
  }));
}

function platformUserSummary(documentValue: unknown) {
  const document = asObject(documentValue);
  const data = asObject(document.data);
  return {
    id: cleanText(document.id),
    name: cleanText(data.name || data.email || document.id),
    email: cleanText(data.email).toLowerCase(),
    phone: cleanText(data.phone),
    status: cleanText(data.status || "active"),
    branch_id: cleanText(data.branch_id || DEFAULT_BRANCH_ID),
    assignment_role_ids: uniqueIds(data.assignment_role_ids || data.roles),
    revision: Number(document.revision || 0)
  };
}

export async function requireActiveOrganizationUser(orgIdValue: string, userIdValue: string) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const userId = cleanId(userIdValue, "user_id");
  const document = await readDocument(orgId, "users", userId).catch(() => null);
  if (!document) throw badRequest("resource_group_user_not_found", `Organization user '${userId}' does not exist.`);
  const user = platformUserSummary(document);
  if (user.status === "disabled") throw badRequest("resource_group_user_disabled", `Organization user '${userId}' is disabled.`);
  return user;
}

function normalizedGroupMembers(input: JsonObject) {
  const rows: JsonObject[] = Array.isArray(input.members)
    ? input.members.map(asObject)
    : Array.isArray(input.member_user_ids)
      ? input.member_user_ids.map((userId) => ({ user_id: userId } as JsonObject))
      : [];
  const byUserId = new Map<string, JsonObject>();
  for (const row of rows) {
    const userId = cleanId(row.user_id || row.id, "user_id");
    byUserId.set(userId, {
      user_id: userId,
      role: cleanText(row.role || row.role_id || "member") || "member",
      is_lead: row.is_lead === true,
      status: cleanText(row.status || "active") === "inactive" ? "inactive" : "active"
    });
  }
  const primary = cleanText(input.primary_member_user_id);
  if (primary) {
    const primaryId = cleanId(primary, "user_id");
    if (!byUserId.has(primaryId)) {
      throw badRequest("resource_group_primary_not_member", "The primary member must be included in the resource group membership list.");
    }
    for (const [userId, row] of byUserId) row.is_lead = userId === primaryId;
  } else {
    const leads = [...byUserId.values()].filter((row) => row.is_lead === true);
    if (leads.length > 1) throw badRequest("resource_group_multiple_leads", "A resource group can have only one lead member.");
  }
  return [...byUserId.values()];
}

function groupRowView(rowValue: unknown) {
  const row = asObject(rowValue);
  return {
    id: cleanText(row.id),
    organization_id: cleanText(row.organization_id),
    branch_id: cleanText(row.branch_id || DEFAULT_BRANCH_ID),
    name: cleanText(row.name),
    kind_id: cleanText(row.kind_id || "crew"),
    assignment_tag_ids: uniqueIds(parseJson(row.assignment_tags_json, [])),
    status: cleanText(row.status || "active"),
    primary_member_user_id: cleanText(row.primary_member_user_id),
    attributes: asObject(parseJson(row.attributes_json)),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

async function groupMembershipRows(orgId: string, groupId: string) {
  return (await getWorkforceDatabase().prepare(`SELECT user_id, role, is_lead, status, joined_at, updated_at
    FROM resource_group_memberships WHERE organization_id=? AND group_id=? ORDER BY is_lead DESC, joined_at ASC`)
    .all(orgId, groupId)).map((rowValue) => {
      const row = asObject(rowValue);
      return {
        user_id: cleanText(row.user_id),
        role: cleanText(row.role || "member"),
        is_lead: Number(row.is_lead || 0) === 1,
        status: cleanText(row.status || "active"),
        joined_at: cleanText(row.joined_at),
        updated_at: cleanText(row.updated_at)
      };
    });
}

async function groupCapabilityIds(orgId: string, groupId: string) {
  return (await getWorkforceDatabase().prepare(`SELECT scope_id FROM resource_group_capabilities
    WHERE organization_id=? AND group_id=? ORDER BY scope_id ASC`).all(orgId, groupId))
    .map((row) => cleanText(asObject(row).scope_id));
}

export async function resourceGroupRecordExists(orgIdValue: string, groupIdValue: string) {
  const row = (await getWorkforceDatabase().prepare("SELECT 1 AS found FROM resource_groups WHERE organization_id=? AND id=?")
    .get(cleanId(orgIdValue, "organization_id"), cleanId(groupIdValue, "resource_group_id")));
  return !!row;
}

export async function organizationConnectionRecordExists(orgIdValue: string, connectionIdValue: string) {
  const row = (await getWorkforceDatabase().prepare("SELECT 1 AS found FROM organization_connections WHERE organization_id=? AND id=?")
    .get(cleanId(orgIdValue, "organization_id"), cleanId(connectionIdValue, "connection_id")));
  return !!row;
}

export async function readResourceGroup(orgIdValue: string, groupIdValue: string) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const groupId = cleanId(groupIdValue, "resource_group_id");
  (await ensureWorkforceDefaults(orgId));
  const row = (await getWorkforceDatabase().prepare("SELECT * FROM resource_groups WHERE organization_id=? AND id=?").get(orgId, groupId));
  if (!row) throw notFound("resource_group_not_found", "Resource group was not found.");
  const group = groupRowView(row);
  const groupCompensation = (await readCompensationProfile(orgId, "resource_group", groupId));
  const memberships = (await groupMembershipRows(orgId, groupId));
  const members = await Promise.all(memberships.map(async (membership) => {
    const document = await readDocument(orgId, "users", membership.user_id).catch(() => null);
    const user = document ? platformUserSummary(document) : { id: membership.user_id, name: membership.user_id, email: "", phone: "", status: "missing", branch_id: "", assignment_role_ids: [], revision: 0 };
    const directCompensation = (await readCompensationProfile(orgId, "organization_user", membership.user_id));
    const effective = effectiveCompensation(directCompensation, groupCompensation);
    return {
      ...membership,
      user,
      direct_compensation_profile: directCompensation,
      effective_compensation_profile: effective.profile,
      compensation_source: effective.source,
      compensation_plan: effective.profile ? compensationPlanProjection(effective.profile) : null
    };
  }));
  const capabilityScopeIds = (await groupCapabilityIds(orgId, groupId));
  return {
    ...group,
    members,
    capability_scope_ids: capabilityScopeIds,
    compensation_profile: groupCompensation,
    compensation_plan: groupCompensation ? compensationPlanProjection(groupCompensation) : null,
    project_types: capabilityScopeIds
  };
}

export async function listResourceGroups(orgIdValue: string, options: JsonObject = {}) {
  const orgId = cleanId(orgIdValue, "organization_id");
  (await ensureWorkforceDefaults(orgId));
  const conditions = ["organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  const branchId = cleanText(options.branch_id || options.branchId);
  const scopeId = cleanText(options.scope_template_id || options.capability_scope_id);
  if (branchId) {
    conditions.push("branch_id = ?");
    params.push(cleanId(branchId, "branch_id"));
  }
  if (options.include_archived !== true && cleanText(options.include_archived) !== "1") conditions.push("status <> 'archived'");
  if (scopeId) {
    conditions.push(`EXISTS (SELECT 1 FROM resource_group_capabilities c
      WHERE c.organization_id=resource_groups.organization_id AND c.group_id=resource_groups.id AND c.scope_id=?)`);
    params.push(cleanId(scopeId, "scope_id"));
  }
  const rows = (await getWorkforceDatabase().prepare(`SELECT * FROM resource_groups WHERE ${conditions.join(" AND ")} ORDER BY name ASC`).all(...params));
  const groups = await Promise.all(rows.map((row) => readResourceGroup(orgId, cleanText(asObject(row).id))));
  const kindIds = uniqueIds(options.group_kind_ids || options.kind_ids || [options.group_kind_id || options.kind_id].filter(Boolean));
  const tagIds = uniqueIds(options.assignment_tag_ids || options.tag_ids);
  return groups
    .filter((group) => !kindIds.length || kindIds.includes(cleanText(group.kind_id)))
    .filter((group) => !tagIds.length || tagIds.every((tagId) => uniqueIds(group.assignment_tag_ids).includes(tagId)));
}

async function validateGroupMembers(orgId: string, members: JsonObject[]) {
  await Promise.all(members.filter((member) => cleanText(member.status || "active") === "active")
    .map((member) => requireActiveOrganizationUser(orgId, cleanText(member.user_id))));
}

async function replaceGroupMembers(db: SqlStore, orgId: string, groupId: string, members: JsonObject[]) {
  const existingJoined = new Map((await db.prepare(`SELECT user_id, joined_at FROM resource_group_memberships
    WHERE organization_id=? AND group_id=?`).all(orgId, groupId)).map((row) => [cleanText(asObject(row).user_id), cleanText(asObject(row).joined_at)]));
  (await db.prepare("DELETE FROM resource_group_memberships WHERE organization_id=? AND group_id=?").run(orgId, groupId));
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO resource_group_memberships
    (organization_id, group_id, user_id, role, is_lead, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const member of members) {
    const userId = cleanId(member.user_id, "user_id");
    (await insert.run(orgId, groupId, userId, cleanText(member.role || "member"), member.is_lead === true ? 1 : 0,
      cleanText(member.status || "active"), existingJoined.get(userId) || now, now));
  }
}

async function replaceGroupCapabilities(db: SqlStore, orgId: string, groupId: string, scopeIds: string[]) {
  (await db.prepare("DELETE FROM resource_group_capabilities WHERE organization_id=? AND group_id=?").run(orgId, groupId));
  const insert = db.prepare(`INSERT INTO resource_group_capabilities (organization_id, group_id, scope_id, created_at)
    VALUES (?, ?, ?, ?)`);
  const now = nowIso();
  for (const scopeId of scopeIds) (await insert.run(orgId, groupId, scopeId, now));
}

export async function createResourceGroup(orgIdValue: string, input: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  (await ensureWorkforceDefaults(orgId));
  const groupId = input.id ? cleanId(input.id, "resource_group_id") : generatedId("resource_group");
  const branchId = cleanId(input.branch_id || DEFAULT_BRANCH_ID, "branch_id");
  const kindId = (await assertResourceGroupKindExists(orgId, input.kind_id || input.group_kind_id || "crew"));
  const assignmentTagIds = (await assertAssignmentTagsExist(orgId, input.assignment_tag_ids || input.tag_ids || input.tags));
  const members = normalizedGroupMembers(input);
  const primaryMemberUserId = cleanText(members.find((member) => member.is_lead === true)?.user_id);
  await validateGroupMembers(orgId, members);
  const capabilities = (await assertCapabilityScopesExist(orgId, [branchId], input.capability_scope_ids || input.project_types));
  const compensationInput = input.compensation_profile || input.compensation_plan;
  const compensation = compensationInput && typeof compensationInput === "object"
    ? (await assertCompensationCapabilityScopes(orgId, [branchId], compensationInput))
    : null;
  const now = nowIso();
  try {
    (await withWorkforceTransaction(async (db) => {
      (await db.prepare(`INSERT INTO resource_groups
        (organization_id, id, branch_id, name, kind_id, assignment_tags_json, status, primary_member_user_id,
         attributes_json, metadata_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(orgId, groupId, branchId, cleanText(input.name), kindId, json(assignmentTagIds), cleanText(input.status || "active"),
          primaryMemberUserId || null, json(asObject(input.attributes)), json(asObject(input.metadata)), now, now));
      (await replaceGroupMembers(db, orgId, groupId, members));
      (await replaceGroupCapabilities(db, orgId, groupId, capabilities));
      if (compensation) (await upsertCompensationProfileRecord(db, orgId, "resource_group", groupId, compensation));
    }));
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) throw conflict("resource_group_exists", `Resource group '${groupId}' already exists.`);
    throw error;
  }
  return await readResourceGroup(orgId, groupId);
}

export async function patchResourceGroup(orgIdValue: string, groupIdValue: string, input: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const groupId = cleanId(groupIdValue, "resource_group_id");
  const current = await readResourceGroup(orgId, groupId);
  if (Number(input.expected_revision || 0) !== Number(current.revision || 0)) {
    throw conflict("resource_group_revision_conflict", "Resource group revision does not match.", { current_revision: current.revision });
  }
  const hasMembers = Object.prototype.hasOwnProperty.call(input, "members") || Object.prototype.hasOwnProperty.call(input, "member_user_ids");
  const members = hasMembers ? normalizedGroupMembers(input) : [];
  if (hasMembers) await validateGroupMembers(orgId, members);
  const hasCapabilities = Object.prototype.hasOwnProperty.call(input, "capability_scope_ids") || Object.prototype.hasOwnProperty.call(input, "project_types");
  const nextKindId = Object.prototype.hasOwnProperty.call(input, "kind_id") || Object.prototype.hasOwnProperty.call(input, "group_kind_id")
    ? (await assertResourceGroupKindExists(orgId, input.kind_id || input.group_kind_id))
    : cleanText(current.kind_id || "crew");
  const nextAssignmentTagIds = Object.prototype.hasOwnProperty.call(input, "assignment_tag_ids")
    || Object.prototype.hasOwnProperty.call(input, "tag_ids")
    || Object.prototype.hasOwnProperty.call(input, "tags")
    ? (await assertAssignmentTagsExist(orgId, input.assignment_tag_ids || input.tag_ids || input.tags))
    : uniqueIds(current.assignment_tag_ids);
  const nextBranchId = Object.prototype.hasOwnProperty.call(input, "branch_id") ? cleanId(input.branch_id, "branch_id") : cleanText(current.branch_id);
  const capabilities = hasCapabilities
    ? (await assertCapabilityScopesExist(orgId, [nextBranchId], input.capability_scope_ids || input.project_types))
    : (await assertCapabilityScopesExist(orgId, [nextBranchId], current.capability_scope_ids));
  const compensationInput = input.compensation_profile || input.compensation_plan;
  const compensation = compensationInput && typeof compensationInput === "object"
    ? (await assertCompensationCapabilityScopes(orgId, [nextBranchId], compensationInput))
    : null;
  const hasPrimaryMember = Object.prototype.hasOwnProperty.call(input, "primary_member_user_id");
  const nextPrimaryMemberUserId = hasMembers
    ? cleanText(members.find((member) => member.is_lead === true)?.user_id)
    : hasPrimaryMember
      ? cleanText(input.primary_member_user_id)
      : cleanText(current.primary_member_user_id);
  (await withWorkforceTransaction(async (db) => {
    const locked = await db.prepare("SELECT revision FROM resource_groups WHERE organization_id=? AND id=?").get(orgId, groupId);
    if (!locked || Number(locked.revision) !== Number(current.revision)) throw conflict("resource_group_revision_conflict", "This record changed elsewhere. Reload and try again.");

    const metadata = Object.prototype.hasOwnProperty.call(input, "metadata")
      ? { ...asObject(current.metadata), ...asObject(input.metadata) }
      : asObject(current.metadata);
    (await db.prepare(`UPDATE resource_groups SET branch_id=?, name=?, kind_id=?, assignment_tags_json=?, status=?, primary_member_user_id=?, attributes_json=?, metadata_json=?,
      revision=revision+1, updated_at=?, archived_at=? WHERE organization_id=? AND id=?`)
      .run(
        nextBranchId,
        Object.prototype.hasOwnProperty.call(input, "name") ? cleanText(input.name) : current.name,
        nextKindId,
        json(nextAssignmentTagIds),
        Object.prototype.hasOwnProperty.call(input, "status") ? cleanText(input.status) : current.status,
        nextPrimaryMemberUserId || null,
        json(Object.prototype.hasOwnProperty.call(input, "attributes") ? asObject(input.attributes) : asObject(current.attributes)),
        json(metadata),
        nowIso(),
        cleanText(input.status || current.status) === "archived" ? nowIso() : null,
        orgId,
        groupId
      ));
    if (hasMembers) (await replaceGroupMembers(db, orgId, groupId, members));
    if (hasCapabilities) (await replaceGroupCapabilities(db, orgId, groupId, capabilities));
    if (compensation) (await upsertCompensationProfileRecord(db, orgId, "resource_group", groupId, compensation));
  }));
  return await readResourceGroup(orgId, groupId);
}

export async function archiveResourceGroup(orgIdValue: string, groupIdValue: string, expectedRevision: number) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const groupId = cleanId(groupIdValue, "resource_group_id");
  const now = nowIso();
  const result = await getWorkforceDatabase().prepare(`UPDATE resource_groups SET status='archived', archived_at=?, updated_at=?, revision=revision+1
    WHERE organization_id=? AND id=? AND revision=?`).run(now, now, orgId, groupId, expectedRevision);
  if (!result.changes) throw conflict("resource_group_revision_conflict", "This group changed elsewhere. Reload and try again.");
  return readResourceGroup(orgId, groupId);
}

export async function putResourceGroupMember(orgIdValue: string, groupIdValue: string, userIdValue: string, input: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const groupId = cleanId(groupIdValue, "resource_group_id");
  const userId = cleanId(userIdValue, "user_id");
  const current = await readResourceGroup(orgId, groupId);
  if (Number(input.expected_revision || 0) !== Number(current.revision || 0)) {
    throw conflict("resource_group_revision_conflict", "Resource group revision does not match.", { current_revision: current.revision });
  }
  await requireActiveOrganizationUser(orgId, userId);
  (await withWorkforceTransaction(async (db) => {
    const locked = await db.prepare("SELECT revision FROM resource_groups WHERE organization_id=? AND id=?").get(orgId, groupId);
    if (!locked || Number(locked.revision) !== Number(current.revision)) throw conflict("resource_group_revision_conflict", "This group changed elsewhere. Reload and try again.");

    const now = nowIso();
    (await db.prepare(`INSERT INTO resource_group_memberships
      (organization_id, group_id, user_id, role, is_lead, status, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, group_id, user_id) DO UPDATE SET role=excluded.role, is_lead=excluded.is_lead,
      status=excluded.status, updated_at=excluded.updated_at`)
      .run(orgId, groupId, userId, cleanText(input.role || "member"), input.is_lead === true ? 1 : 0,
        cleanText(input.status || "active"), now, now));
    if (input.is_lead === true) {
      (await db.prepare(`UPDATE resource_group_memberships SET is_lead=CASE WHEN user_id=? THEN 1 ELSE 0 END, updated_at=?
        WHERE organization_id=? AND group_id=?`).run(userId, now, orgId, groupId));
      (await db.prepare(`UPDATE resource_groups SET primary_member_user_id=?, revision=revision+1, updated_at=?
        WHERE organization_id=? AND id=?`).run(userId, now, orgId, groupId));
    } else {
      (await db.prepare(`UPDATE resource_groups SET revision=revision+1, updated_at=? WHERE organization_id=? AND id=?`).run(now, orgId, groupId));
    }
  }));
  return await readResourceGroup(orgId, groupId);
}

export async function removeResourceGroupMember(orgIdValue: string, groupIdValue: string, userIdValue: string, expectedRevision: number) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const groupId = cleanId(groupIdValue, "resource_group_id");
  const userId = cleanId(userIdValue, "user_id");
  const current = await readResourceGroup(orgId, groupId);
  if (expectedRevision !== Number(current.revision || 0)) {
    throw conflict("resource_group_revision_conflict", "Resource group revision does not match.", { current_revision: current.revision });
  }
  (await withWorkforceTransaction(async (db) => {
    const locked = await db.prepare("SELECT revision FROM resource_groups WHERE organization_id=? AND id=?").get(orgId, groupId);
    if (!locked || Number(locked.revision) !== Number(current.revision)) throw conflict("resource_group_revision_conflict", "This group changed elsewhere. Reload and try again.");

    const result = (await db.prepare("DELETE FROM resource_group_memberships WHERE organization_id=? AND group_id=? AND user_id=?").run(orgId, groupId, userId));
    if (!Number(result.changes || 0)) throw notFound("resource_group_member_not_found", "Resource group member was not found.");
    (await db.prepare(`UPDATE resource_groups SET primary_member_user_id=CASE WHEN primary_member_user_id=? THEN NULL ELSE primary_member_user_id END,
      revision=revision+1, updated_at=? WHERE organization_id=? AND id=?`).run(userId, nowIso(), orgId, groupId));
  }));
  return await readResourceGroup(orgId, groupId);
}

export function resourceGroupAssignableProjection(groupValue: JsonObject) {
  const capabilities = uniqueIds(groupValue.capability_scope_ids || groupValue.project_types);
  const compensation = asObject(groupValue.compensation_profile);
  const resourceId = cleanText(groupValue.id);
  const resourceName = cleanText(groupValue.name);
  return {
    resource_kind: "resource_group",
    subject_type: "resource_group",
    resource_id: resourceId,
    work_resource_ref: { kind: "resource_group", id: resourceId, name: resourceName },
    branch_id: cleanText(groupValue.branch_id || DEFAULT_BRANCH_ID),
    capability_scope_ids: capabilities,
    group_kind_id: cleanText(groupValue.kind_id || "crew"),
    kind_ids: [cleanText(groupValue.kind_id || "crew")],
    assignment_tag_ids: uniqueIds(groupValue.assignment_tag_ids || groupValue.tag_ids || groupValue.tags),
    members: Array.isArray(groupValue.members) ? groupValue.members : [],
    attributes: asObject(groupValue.attributes),
    metadata: asObject(groupValue.metadata),
    scheduling: asObject(asObject(groupValue.attributes).scheduling || asObject(groupValue.metadata).scheduling),

    // Compatibility projection while scheduling consumers move to typed refs.
    id: resourceId,
    name: resourceName,
    status: cleanText(groupValue.status || "active"),
    compensation_plan: cleanText(compensation.id) ? compensationPlanProjection(compensation) : null,
    project_types: capabilities
  };
}

async function initializeWorkforceExtensions(db: SqlStore) {
  await db.exec(`
      CREATE TABLE IF NOT EXISTS workforce_access_roles (
        organization_id TEXT NOT NULL,
        id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        application_ids_json TEXT NOT NULL DEFAULT '[]',
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        is_system INTEGER NOT NULL DEFAULT 0,
        system_key TEXT NOT NULL DEFAULT '',
        permissions_json TEXT NOT NULL DEFAULT '{}',
        app_defaults_json TEXT NOT NULL DEFAULT '{}',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        PRIMARY KEY (organization_id, id)
      );
      CREATE INDEX IF NOT EXISTS workforce_access_roles_application_idx
        ON workforce_access_roles (organization_id, application_id, status, name);
      CREATE UNIQUE INDEX IF NOT EXISTS workforce_access_roles_system_key_idx
        ON workforce_access_roles (organization_id, system_key) WHERE system_key <> '';
    `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS workforce_persona_templates (
      organization_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      is_factory INTEGER NOT NULL DEFAULT 0,
      factory_key TEXT NOT NULL DEFAULT '',
      factory_revision INTEGER NOT NULL DEFAULT 0,
      modified INTEGER NOT NULL DEFAULT 0,
      application_ids_json TEXT NOT NULL DEFAULT '[]',
      level INTEGER NOT NULL DEFAULT 0,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      app_defaults_json TEXT NOT NULL DEFAULT '{}',
      capability_requirements_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      PRIMARY KEY (organization_id, id)
    );
    CREATE INDEX IF NOT EXISTS workforce_persona_templates_status_idx
      ON workforce_persona_templates (organization_id, status, name);
  `);
  await db.exec(`
    CREATE TABLE IF NOT EXISTS crew_time_shifts (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      clocked_in_at TEXT NOT NULL,
      clocked_out_at TEXT,
      active_break_started_at TEXT,
      break_seconds INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS crew_time_shifts_one_active_idx
      ON crew_time_shifts (organization_id, user_id) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS crew_time_shifts_history_idx
      ON crew_time_shifts (organization_id, user_id, clocked_in_at DESC);

    CREATE TABLE IF NOT EXISTS crew_time_events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      shift_id TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (shift_id) REFERENCES crew_time_shifts (id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS crew_time_events_shift_idx
      ON crew_time_events (organization_id, shift_id, occurred_at ASC);

    CREATE TABLE IF NOT EXISTS crew_checklist_items (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL,
      completed_by_user_id TEXT,
      completed_at TEXT,
      deleted_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS crew_checklist_project_idx
      ON crew_checklist_items (organization_id, project_id, deleted_at, sort_order, created_at);

    CREATE TABLE IF NOT EXISTS crew_checklists (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'todo',
      audience TEXT NOT NULL DEFAULT 'crew',
      crew_editable INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'manual',
      source_key TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_by_user_id TEXT NOT NULL DEFAULT '',
      deleted_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS crew_checklists_project_idx
      ON crew_checklists (organization_id, project_id, deleted_at, sort_order, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS crew_checklists_source_key_idx
      ON crew_checklists (organization_id, project_id, source_key) WHERE source_key <> '';
  `);
  await ensureSqlColumn(db, "workforce_access_roles", "application_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  await ensureSqlColumn(db, "crew_checklist_items", "checklist_id", "TEXT NOT NULL DEFAULT ''");
  await ensureSqlColumn(db, "crew_checklist_items", "item_type", "TEXT NOT NULL DEFAULT 'todo'");
  await ensureSqlColumn(db, "crew_checklist_items", "rating", "TEXT NOT NULL DEFAULT ''");
  await ensureSqlColumn(db, "crew_checklist_items", "note", "TEXT NOT NULL DEFAULT ''");
}
