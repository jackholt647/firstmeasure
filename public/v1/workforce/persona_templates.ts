import { randomBytes } from "node:crypto";

import { badRequest, conflict, notFound } from "../platform/errors.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { getWorkforceDatabase } from "./storage.js";
import {
  createAccessRole,
  factoryPersonaDefinitions,
  initializeAccessSchema,
  normalizeAppDefaults,
  normalizeApplicationIds,
  normalizePermissionMap,
  patchAccessRole,
  readAccessRole,
  type AccessRole,
  type AccessRoleAppDefault,
  type JsonObject,
  type PermissionMap
} from "./access.js";

// Persona templates are per-organization, data-driven bundles of apps, params,
// and permissions. Applying a template creates or updates an access role; the
// runtime access-resolution path is untouched and only ever sees roles.
// Factory templates are copied into each organization on first use and stay
// fully org-editable; factory upgrades never overwrite a modified copy.

export const PERSONA_TEMPLATE_SCHEMA_VERSION = 1;
export const PERSONA_TEMPLATE_FACTORY_REVISION = 3;

export type PersonaTemplate = {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  is_factory: boolean;
  factory_key: string;
  factory_revision: number;
  modified: boolean;
  application_ids: string[];
  level: number;
  permissions: PermissionMap;
  app_defaults: Record<string, AccessRoleAppDefault>;
  capability_requirements: string[];
  metadata: JsonObject;
  revision: number;
  created_at: string;
  updated_at: string;
  archived_at: string;
};

export type PersonaTemplateApplyResult = {
  template: PersonaTemplate;
  role: AccessRole;
  created: boolean;
  capability_warnings: string[];
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return cleanText(value) ? [value] : [];
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

function cleanOrganizationId(value: unknown) {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest("invalid_organization_id", "organization_id must contain at least one letter or number.");
  return id;
}

function cleanTemplateId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/_+/g, "_").replace(/^[_-]+|[_-]+$/g, "");
}

function normalizeCapabilityRequirements(value: unknown): string[] {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

function normalizeLevel(value: unknown, fallback = 0) {
  const level = Number(value);
  return Number.isFinite(level) ? Math.trunc(level) : fallback;
}

const initializedTemplateDatabases = new WeakSet<object>();
const seededTemplateOrganizations = new WeakMap<object, Set<string>>();

function initializeTemplateSchema() {
  const db = getWorkforceDatabase();
  if (initializedTemplateDatabases.has(db)) return db;

  initializedTemplateDatabases.add(db);
  return db;
}

async function seedFactoryTemplates(orgId: string) {
  return (await getWorkforceDatabase().transaction(async () => {
  const db = initializeTemplateSchema();
  let seeded = seededTemplateOrganizations.get(db);
  if (!seeded) {
    seeded = new Set<string>();
    seededTemplateOrganizations.set(db, seeded);
  }
  if (seeded.has(orgId)) return;
  const now = nowIso();
  const insert = db.prepare(`INSERT INTO workforce_persona_templates
    (organization_id, id, name, description, status, is_factory, factory_key, factory_revision, modified,
     application_ids_json, level, permissions_json, app_defaults_json, capability_requirements_json, metadata_json,
     revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT DO NOTHING`);
  const readExisting = db.prepare(`SELECT factory_revision, modified FROM workforce_persona_templates
    WHERE organization_id=? AND id=? AND is_factory=1`);
  const upgrade = db.prepare(`UPDATE workforce_persona_templates
    SET name=?, description=?, application_ids_json=?, level=?, permissions_json=?, app_defaults_json=?,
        capability_requirements_json=?, factory_revision=?, revision=revision+1, updated_at=?
    WHERE organization_id=? AND id=? AND is_factory=1 AND modified=0`);
  for (const definition of factoryPersonaDefinitions()) {
    (await insert.run(
      orgId,
      definition.id,
      definition.name,
      definition.description,
      definition.id,
      PERSONA_TEMPLATE_FACTORY_REVISION,
      json(definition.application_ids),
      definition.level,
      json(definition.permissions),
      json(definition.app_defaults),
      json(definition.capability_requirements),
      json(definition.metadata),
      now,
      now
    ));
    // Factory upgrades apply only to unmodified copies whose stored revision
    // trails the shipped one; an organization's edits are never overwritten.
    const existing = asObject((await readExisting.get(orgId, definition.id)));
    const factoryRevision = Number(existing.factory_revision || 0);
    const modified = Number(existing.modified || 0) === 1;
    if (!modified && factoryRevision > 0 && factoryRevision < PERSONA_TEMPLATE_FACTORY_REVISION) {
      (await upgrade.run(
        definition.name,
        definition.description,
        json(definition.application_ids),
        definition.level,
        json(definition.permissions),
        json(definition.app_defaults),
        json(definition.capability_requirements),
        PERSONA_TEMPLATE_FACTORY_REVISION,
        now,
        orgId,
        definition.id
      ));
    }
  }
  seeded.add(orgId);

  }));
}

async function ensureTemplateDefaults(orgIdValue: string) {
  const orgId = cleanOrganizationId(orgIdValue);
  (await initializeAccessSchema());
  (await seedFactoryTemplates(orgId));
  return orgId;
}

function templateView(rowValue: unknown): PersonaTemplate {
  const row = asObject(rowValue);
  return {
    id: cleanTemplateId(row.id),
    organization_id: cleanText(row.organization_id),
    name: cleanText(row.name),
    description: cleanText(row.description),
    status: cleanText(row.status) === "archived" ? "archived" : "active",
    is_factory: Number(row.is_factory || 0) === 1,
    factory_key: cleanText(row.factory_key),
    factory_revision: Number(row.factory_revision || 0),
    modified: Number(row.modified || 0) === 1,
    application_ids: normalizeApplicationIds(parseJson(row.application_ids_json, [])),
    level: normalizeLevel(row.level),
    permissions: normalizePermissionMap(parseJson(row.permissions_json)),
    app_defaults: normalizeAppDefaults(parseJson(row.app_defaults_json)),
    capability_requirements: normalizeCapabilityRequirements(parseJson(row.capability_requirements_json, [])),
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

export async function listPersonaTemplates(orgIdValue: string, options: { include_archived?: boolean } = {}) {
  const orgId = (await ensureTemplateDefaults(orgIdValue));
  const clauses = ["organization_id=?"];
  const params: string[] = [orgId];
  if (!options.include_archived) clauses.push("status='active'");
  return (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_persona_templates
    WHERE ${clauses.join(" AND ")} ORDER BY level ASC, name ASC, id ASC`)
    .all(...params)).map(templateView);
}

export async function readPersonaTemplate(orgIdValue: string, templateIdValue: string) {
  const orgId = (await ensureTemplateDefaults(orgIdValue));
  const templateId = cleanTemplateId(templateIdValue);
  const row = (await getWorkforceDatabase().prepare(`SELECT * FROM workforce_persona_templates
    WHERE organization_id=? AND id=?`).get(orgId, templateId));
  if (!row) throw notFound("persona_template_not_found", "Persona template was not found.");
  return templateView(row);
}

async function generatedTemplateId(orgId: string, name: string) {
  const base = cleanTemplateId(name) || "persona_template";
  const db = getWorkforceDatabase();
  if (!(await db.prepare("SELECT 1 AS found FROM workforce_persona_templates WHERE organization_id=? AND id=?").get(orgId, base))) return base;
  return `${base}_${randomBytes(4).toString("hex")}`;
}

export async function createPersonaTemplate(orgIdValue: string, inputValue: JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureTemplateDefaults(orgIdValue));
  const input = asObject(inputValue);
  const name = cleanText(input.name);
  if (!name) throw badRequest("persona_template_name_required", "Persona template name is required.");
  const applicationIds = normalizeApplicationIds(input.application_ids, input.application_id || input.application);
  if (!applicationIds.length) throw badRequest("persona_template_application_required", "At least one application_id is required.");
  const explicitId = cleanTemplateId(input.id);
  const templateId = explicitId || (await generatedTemplateId(orgId, name));
  if (!templateId) throw badRequest("invalid_persona_template_id", "Persona template id must contain at least one letter or number.");
  const db = getWorkforceDatabase();
  if ((await db.prepare("SELECT 1 AS found FROM workforce_persona_templates WHERE organization_id=? AND id=?").get(orgId, templateId))) {
    throw conflict("persona_template_exists", `Persona template '${templateId}' already exists.`);
  }
  const now = nowIso();
  (await db.prepare(`INSERT INTO workforce_persona_templates
    (organization_id, id, name, description, status, is_factory, factory_key, factory_revision, modified,
     application_ids_json, level, permissions_json, app_defaults_json, capability_requirements_json, metadata_json,
     revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', 0, '', 0, 0, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(
      orgId,
      templateId,
      name,
      cleanText(input.description),
      json(applicationIds),
      normalizeLevel(input.level),
      json(normalizePermissionMap(input.permissions ?? input.permission_defaults)),
      json(normalizeAppDefaults(input.app_defaults ?? input.apps)),
      json(normalizeCapabilityRequirements(input.capability_requirements)),
      json(asObject(input.metadata)),
      now,
      now
    ));
  return (await readPersonaTemplate(orgId, templateId));

  }));
}

function requiredRevision(value: unknown) {
  const revision = Number(value || 0);
  if (!Number.isInteger(revision) || revision <= 0) {
    throw badRequest("expected_revision_required", "A positive expected_revision is required.");
  }
  return revision;
}

export async function patchPersonaTemplate(orgIdValue: string, templateIdValue: string, inputValue: JsonObject) {
  return (await getWorkforceDatabase().transaction(async () => {
  const orgId = (await ensureTemplateDefaults(orgIdValue));
  const templateId = cleanTemplateId(templateIdValue);
  const input = asObject(inputValue);
  const current = (await readPersonaTemplate(orgId, templateId));
  const expectedRevision = requiredRevision(input.expected_revision);
  if (current.revision !== expectedRevision) {
    throw conflict("persona_template_revision_conflict", "Persona template revision does not match.", { current_revision: current.revision });
  }
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input, key);
  const hasApplicationPatch = has("application_ids") || has("application_id") || has("application");
  const applicationIds = hasApplicationPatch
    ? normalizeApplicationIds(input.application_ids, input.application_id || input.application)
    : current.application_ids;
  if (!applicationIds.length) throw badRequest("persona_template_application_required", "At least one application_id is required.");
  const name = has("name") ? cleanText(input.name) : current.name;
  if (!name) throw badRequest("persona_template_name_required", "Persona template name is required.");
  const statusValue = has("status") ? cleanText(input.status).toLowerCase() : current.status;
  if (!["active", "archived"].includes(statusValue)) {
    throw badRequest("persona_template_status_invalid", "Persona template status must be active or archived.");
  }
  const status = statusValue as "active" | "archived";
  const permissions = has("permissions") || has("permission_defaults")
    ? normalizePermissionMap(input.permissions ?? input.permission_defaults)
    : current.permissions;
  const appDefaults = has("app_defaults") || has("apps")
    ? normalizeAppDefaults(input.app_defaults ?? input.apps)
    : current.app_defaults;
  const capabilityRequirements = has("capability_requirements")
    ? normalizeCapabilityRequirements(input.capability_requirements)
    : current.capability_requirements;
  const metadata = has("metadata") ? asObject(input.metadata) : current.metadata;
  const level = has("level") ? normalizeLevel(input.level, current.level) : current.level;
  const now = nowIso();
  const result = (await getWorkforceDatabase().prepare(`UPDATE workforce_persona_templates SET
    name=?, description=?, status=?, application_ids_json=?, level=?, permissions_json=?, app_defaults_json=?,
    capability_requirements_json=?, metadata_json=?, modified=?, revision=revision+1, updated_at=?, archived_at=?
    WHERE organization_id=? AND id=? AND revision=?`)
    .run(
      name,
      has("description") ? cleanText(input.description) : current.description,
      status,
      json(applicationIds),
      level,
      json(permissions),
      json(appDefaults),
      json(capabilityRequirements),
      json(metadata),
      current.is_factory ? 1 : 0,
      now,
      status === "archived" ? (current.archived_at || now) : null,
      orgId,
      templateId,
      expectedRevision
    ));
  if (Number(result.changes || 0) !== 1) {
    const latest = (await readPersonaTemplate(orgId, templateId));
    throw conflict("persona_template_revision_conflict", "Persona template revision does not match.", { current_revision: latest.revision });
  }
  return (await readPersonaTemplate(orgId, templateId));

  }));
}

export async function archivePersonaTemplate(
  orgIdValue: string,
  templateIdValue: string,
  expectedRevisionValue: number | JsonObject
) {
  return (await getWorkforceDatabase().transaction(async () => {
  const expectedRevision = typeof expectedRevisionValue === "number"
    ? expectedRevisionValue
    : Number(asObject(expectedRevisionValue).expected_revision || 0);
  return (await patchPersonaTemplate(orgIdValue, templateIdValue, {
    expected_revision: requiredRevision(expectedRevision),
    status: "archived"
  }));

  }));
}

async function existingRole(orgId: string, roleId: string): Promise<AccessRole | null> {
  try {
    return (await readAccessRole(orgId, roleId));
  } catch (error) {
    if (asObject(error).code === "access_role_not_found") return null;
    throw error;
  }
}

export async function applyPersonaTemplate(
  orgIdValue: string,
  templateIdValue: string
): Promise<PersonaTemplateApplyResult> {
  const orgId = (await ensureTemplateDefaults(orgIdValue));
  const template = (await readPersonaTemplate(orgId, templateIdValue));
  if (template.status === "archived") {
    throw badRequest("persona_template_archived", "An archived persona template cannot be applied.");
  }
  const capabilityWarnings: string[] = [];
  for (const key of template.capability_requirements) {
    if (!(await isCapabilityEnabled(orgId, key))) capabilityWarnings.push(key);
  }
  const current = (await existingRole(orgId, template.id));
  const roleMetadata = {
    // Preserve role bookkeeping (system_default, preset_revision, …) so seeded
    // system roles keep upgrading; template metadata and identity win on top.
    ...(current ? current.metadata : {}),
    ...template.metadata,
    level: template.level,
    persona_template_id: template.id
  };
  let role: AccessRole;
  if (current) {
    role = (await patchAccessRole(orgId, template.id, {
      expected_revision: current.revision,
      name: template.name,
      description: template.description,
      application_ids: template.application_ids,
      permissions: template.permissions,
      app_defaults: template.app_defaults,
      metadata: roleMetadata
    }));
  } else {
    role = (await createAccessRole(orgId, {
      id: template.id,
      name: template.name,
      description: template.description,
      application_ids: template.application_ids,
      permissions: template.permissions,
      app_defaults: template.app_defaults,
      metadata: roleMetadata
    }));
  }
  return { template, role, created: !current, capability_warnings: capabilityWarnings };
}
