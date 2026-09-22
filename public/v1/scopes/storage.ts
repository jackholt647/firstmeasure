import { createHash } from "node:crypto";

import { badRequest, conflict, notFound, PlatformError } from "../platform/errors.js";
import { getWorkDatabase, type JsonObject } from "../work/storage.js";
import { scopeTemplateDefinitionSchema, type ScopeTemplateDefinition } from "./schemas.js";
import { DEFAULT_SCOPE_TEMPLATES } from "./presets/index.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function parseJson(value: unknown) {
  try {
    return value ? JSON.parse(String(value)) as JsonObject : {};
  } catch {
    return {};
  }
}

function nowIso() {
  return new Date().toISOString();
}

function truthy(value: unknown) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "on"].includes(cleanText(value).toLowerCase());
}

function normalizeScopeFlags(value: unknown) {
  const source = asObject(value);
  const flags: Record<string, boolean> = {};
  for (const [rawId, rawEnabled] of Object.entries(source)) {
    const id = cleanText(rawId);
    if (!id || typeof rawEnabled !== "boolean") continue;
    flags[id] = rawEnabled;
  }
  return flags;
}

async function ensureOrganizationScopeSettings(orgId: string) {
  const db = getWorkDatabase();
  const existing = (await db.prepare("SELECT * FROM organization_scope_settings WHERE organization_id = ?").get(orgId));
  if (existing) return asObject(existing);
  const now = nowIso();
  (await db.prepare(`INSERT INTO organization_scope_settings
    (organization_id, schema_version, revision, flags_json, created_at, updated_at)
    VALUES (?, 1, 1, '{}', ?, ?) ON CONFLICT DO NOTHING`)
    .run(orgId, now, now));
  return asObject((await db.prepare("SELECT * FROM organization_scope_settings WHERE organization_id = ?").get(orgId)));
}

async function organizationScopeSettings(orgId: string) {
  const row = (await ensureOrganizationScopeSettings(orgId));
  return {
    schema_version: Number(row.schema_version || 1),
    revision: Number(row.revision || 1),
    flags: normalizeScopeFlags(parseJson(row.flags_json)),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at)
  };
}

function scopeEnabled(flags: Record<string, boolean>, templateId: string) {
  return Object.prototype.hasOwnProperty.call(flags, templateId) ? flags[templateId] !== false : true;
}

let updatingDefaultTemplates = false;

function checksum(definition: ScopeTemplateDefinition) {
  return createHash("sha256").update(JSON.stringify(definition)).digest("hex");
}

function versionId(orgId: string, branchId: string, templateId: string, version: number) {
  const hash = createHash("sha256").update(`${orgId}:${branchId}:${templateId}:${version}`).digest("hex").slice(0, 18);
  return `scope_version_${hash}`;
}

function templateView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    ...value,
    current_version: Number(value.current_version || 1),
    sort_order: Number(value.sort_order || 0),
    metadata: parseJson(value.metadata_json)
  };
}

function versionView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    ...value,
    version: Number(value.version || 1),
    definition: parseJson(value.definition_json)
  };
}

async function insertVersion(orgId: string, branchId: string, definitionValue: ScopeTemplateDefinition, version: number) {
  const db = getWorkDatabase();
  const definition = scopeTemplateDefinitionSchema.parse(definitionValue);
  const id = versionId(orgId, branchId, definition.id, version);
  const now = nowIso();
  (await db.prepare(`INSERT INTO scope_template_versions (id, organization_id, branch_id, template_id, version, status,
    definition_json, checksum, created_at, published_at) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`)
    .run(id, orgId, branchId, definition.id, version, JSON.stringify(definition), checksum(definition), now, now));
  return (await readScopeTemplateVersion(orgId, branchId, definition.id, version));
}

export async function ensureDefaultScopeTemplates(orgId: string, branchId = "default") {
  return (await getWorkDatabase().transaction(async () => {
  if (updatingDefaultTemplates) return;
  const db = getWorkDatabase();
  const count = Number(asObject((await db.prepare("SELECT COUNT(*) AS count FROM scope_templates WHERE organization_id = ? AND branch_id = ?").get(orgId, branchId))).count || 0);
  updatingDefaultTemplates = true;
  try {
    if (count === 0) {
      const now = nowIso();
      let seeded = false;
      await db.transaction(async () => {
        const lockedCount = Number(asObject((await db.prepare("SELECT COUNT(*) AS count FROM scope_templates WHERE organization_id = ? AND branch_id = ?").get(orgId, branchId))).count || 0);
        if (lockedCount === 0) {
          for (const [index, definition] of DEFAULT_SCOPE_TEMPLATES.entries()) {
            (await db.prepare(`INSERT INTO scope_templates (id, organization_id, branch_id, name, description, details, color,
              icon, status, current_version, sort_order, metadata_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`)
              .run(definition.id, orgId, branchId, definition.name, cleanText(definition.description), cleanText(definition.details),
                cleanText(definition.color), cleanText(definition.icon), index, JSON.stringify(definition.metadata || {}), now, now));
            (await insertVersion(orgId, branchId, definition, 1));
          }
          seeded = true;
        }
      
  });
      if (seeded) return;
    }
    for (const [index, definition] of DEFAULT_SCOPE_TEMPLATES.entries()) {
      const row = (await db.prepare("SELECT * FROM scope_templates WHERE organization_id = ? AND branch_id = ? AND id = ?")
        .get(orgId, branchId, definition.id));
      if (!row) {
        (await saveScopeTemplate(orgId, branchId, { ...definition, sort_order: index }, { systemPreset: true }));
        continue;
      }
      const template = templateView(row);
      const current = (await readScopeTemplateVersion(orgId, branchId, definition.id, Number(template.current_version)));
      const currentDefinition = asObject(current?.definition);
      const currentMetadata = asObject(currentDefinition.metadata);
      const nextRevision = Number(asObject(definition.metadata).preset_revision || 0);
      if (currentMetadata.preset === true && Number(currentMetadata.preset_revision || 0) < nextRevision) {
        try {
          (await saveScopeTemplate(orgId, branchId, { ...definition, sort_order: index, expected_version: Number(template.current_version) }, { systemPreset: true }));
        } catch (error) {
          if (!(error instanceof PlatformError) || error.code !== "scope_template_version_conflict") throw error;
        }
      }
    }
  } finally {
    updatingDefaultTemplates = false;
  }

  }));
}

export async function listScopeTemplates(orgId: string, branchId = "default", options: JsonObject = {}): Promise<JsonObject[]> {
  (await ensureDefaultScopeTemplates(orgId, branchId));
  const settings = (await organizationScopeSettings(orgId));
  const rows = (await getWorkDatabase().prepare(`SELECT * FROM scope_templates WHERE organization_id = ? AND branch_id = ?
    AND (? = 1 OR status <> 'archived') ORDER BY sort_order ASC, name ASC`)
    .all(orgId, branchId, truthy(options.include_archived || options.includeArchived) ? 1 : 0));
  const templates: JsonObject[] = (await Promise.all(rows.map(async (row) => {
    const template = templateView(row);
    const version = (await readScopeTemplateVersion(orgId, branchId, cleanText(template.id), Number(template.current_version)));
    return {
      ...template,
      enabled: scopeEnabled(settings.flags, cleanText(template.id)),
      version: version?.version,
      version_id: version?.id,
      definition: version?.definition || {}
    } as JsonObject;
  })));
  return truthy(options.include_disabled) ? templates : templates.filter((template) => template.enabled !== false);
}

export async function listScopeLibrary(orgId: string, branchId = "default"): Promise<JsonObject[]> {
  const installed = (await listScopeTemplates(orgId, branchId, { include_disabled: true, include_archived: true }));
  return DEFAULT_SCOPE_TEMPLATES.map((definition, index) => {
    const definitionMetadata = asObject(definition.metadata);
    const launch = asObject(definitionMetadata.field_launch);
    const instances = installed.filter((template) => {
      const templateDefinition = asObject(template.definition);
      const metadata = asObject(templateDefinition.metadata);
      return cleanText(template.id) === definition.id
        || cleanText(metadata.library_template_id || metadata.based_on_preset) === definition.id;
    });
    const enabledInstances = instances.filter((template) => template.status !== "archived" && template.enabled !== false);
    return {
      id: definition.id,
      name: definition.name,
      description: cleanText(definition.description),
      details: cleanText(definition.details),
      color: cleanText(definition.color),
      icon: cleanText(definition.icon),
      kind: cleanText(definition.kind || "production"),
      category: cleanText(launch.category) || (definition.kind === "pipeline" ? "Sales" : "Production"),
      keywords: Array.isArray(launch.keywords) ? launch.keywords : [],
      suggested: launch.frequent === true,
      sort_order: index,
      installed_count: instances.length,
      enabled_count: enabledInstances.length,
      installed_scope_ids: instances.map((template) => cleanText(template.id)).filter(Boolean),
      definition: structuredClone(definition)
    };
  });
}

export async function readScopeTemplate(orgId: string, branchId: string, templateId: string) {
  (await ensureDefaultScopeTemplates(orgId, branchId));
  const row = (await getWorkDatabase().prepare("SELECT * FROM scope_templates WHERE organization_id = ? AND branch_id = ? AND id = ?")
    .get(orgId, branchId, templateId));
  if (!row) throw notFound("scope_template_not_found", "Scope template was not found.");
  const template = templateView(row);
  const version = (await readScopeTemplateVersion(orgId, branchId, templateId, Number(template.current_version)));
  const settings = (await organizationScopeSettings(orgId));
  return {
    ...template,
    enabled: scopeEnabled(settings.flags, templateId),
    version: version?.version,
    version_id: version?.id,
    definition: version?.definition || {}
  };
}

export async function readScopeFlagState(orgId: string, branchId = "default") {
  const settings = (await organizationScopeSettings(orgId));
  const templates = (await listScopeTemplates(orgId, branchId, { include_disabled: true }));
  const flags: Record<string, boolean> = { ...settings.flags };
  const catalog = templates.map((template) => {
    const id = cleanText(template.id);
    const enabled = scopeEnabled(settings.flags, id);
    flags[id] = enabled;
    return {
      id,
      name: cleanText(template.name),
      description: cleanText(template.description),
      details: cleanText(template.details),
      color: cleanText(template.color),
      icon: cleanText(template.icon),
      status: cleanText(template.status || "active") || "active",
      sort_order: Number(template.sort_order || 0),
      version: Number(template.version || template.current_version || 1),
      enabled
    };
  });
  return {
    schema_version: settings.schema_version,
    revision: settings.revision,
    branch_id: branchId,
    flags,
    enabled_scope_ids: catalog.filter((template) => template.enabled).map((template) => template.id),
    catalog,
    created_at: settings.created_at,
    updated_at: settings.updated_at
  };
}

export async function patchScopeFlags(orgId: string, inputValue: JsonObject, branchId = "default") {
  const expectedRevision = Number(inputValue.expected_revision || 0);
  const patch = normalizeScopeFlags(inputValue.flags);
  const knownTemplateIds = new Set((await listScopeTemplates(orgId, branchId, { include_disabled: true, include_archived: true }))
    .map((template) => cleanText(template.id))
    .filter(Boolean));
  const unknownTemplateIds = Object.keys(patch).filter((templateId) => !knownTemplateIds.has(templateId));
  if (unknownTemplateIds.length) {
    throw badRequest("scope_flag_template_not_found", "Scope flags can only reference templates in the requested branch.", {
      template_ids: unknownTemplateIds,
      branch_id: branchId
    });
  }
  const db = getWorkDatabase();
  (await ensureOrganizationScopeSettings(orgId));
  await db.transaction(async () => {
    const current = asObject((await db.prepare("SELECT * FROM organization_scope_settings WHERE organization_id = ?").get(orgId)));
    const currentRevision = Number(current.revision || 1);
    if (!expectedRevision || expectedRevision !== currentRevision) {
      throw conflict("scope_flags_revision_conflict", "Scope flags revision does not match.");
    }
    const flags = { ...normalizeScopeFlags(parseJson(current.flags_json)), ...patch };
    const now = nowIso();
    (await db.prepare(`UPDATE organization_scope_settings SET revision = ?, flags_json = ?, updated_at = ?
      WHERE organization_id = ?`)
      .run(currentRevision + 1, JSON.stringify(flags), now, orgId));
  
  });
  return (await readScopeFlagState(orgId, branchId));
}

export async function readScopeTemplateVersion(orgId: string, branchId: string, templateId: string, version?: number) {
  const row = version
    ? (await getWorkDatabase().prepare(`SELECT * FROM scope_template_versions WHERE organization_id = ? AND branch_id = ?
        AND template_id = ? AND version = ?`).get(orgId, branchId, templateId, version))
    : (await getWorkDatabase().prepare(`SELECT * FROM scope_template_versions WHERE organization_id = ? AND branch_id = ?
        AND template_id = ? ORDER BY version DESC LIMIT 1`).get(orgId, branchId, templateId));
  return row ? versionView(row) : null;
}

export async function listScopeTemplateVersions(orgId: string, branchId: string, templateId: string) {
  (await ensureDefaultScopeTemplates(orgId, branchId));
  return (await getWorkDatabase().prepare(`SELECT * FROM scope_template_versions WHERE organization_id = ? AND branch_id = ?
    AND template_id = ? ORDER BY version DESC`).all(orgId, branchId, templateId)).map(versionView);
}

export async function saveScopeTemplate(orgId: string, branchId: string, inputValue: JsonObject, options: { systemPreset?: boolean } = {}) {
  const parsedDefinition = scopeTemplateDefinitionSchema.parse(inputValue);
  const db = getWorkDatabase();
  const now = nowIso();
  const expectedVersion = Number(inputValue.expected_version || 0);
  const definitionFields = { ...parsedDefinition } as JsonObject;
  delete definitionFields.expected_version;
  await db.transaction(async () => {
    const existing = (await db.prepare("SELECT * FROM scope_templates WHERE organization_id = ? AND branch_id = ? AND id = ?")
      .get(orgId, branchId, parsedDefinition.id));
    const currentVersion = existing ? Number(asObject(existing).current_version || 0) : 0;
    if (existing && expectedVersion && expectedVersion !== currentVersion) {
      throw conflict("scope_template_version_conflict", "Scope template version does not match.");
    }
    const existingMetadata = existing ? parseJson(asObject(existing).metadata_json) : {};
    const definition: ScopeTemplateDefinition = {
      ...definitionFields,
      id: parsedDefinition.id,
      name: parsedDefinition.name,
      work_plan: parsedDefinition.work_plan,
      metadata: options.systemPreset
        ? asObject(parsedDefinition.metadata)
        : {
            ...asObject(parsedDefinition.metadata),
            ...(existingMetadata.preset === true ? { preset: false, based_on_preset: parsedDefinition.id } : {})
          }
    };
    const nextVersion = currentVersion + 1;
    if (existing) {
      (await db.prepare(`UPDATE scope_templates SET name=?, description=?, details=?, color=?, icon=?, status=?,
        current_version=?, sort_order=?, metadata_json=?, updated_at=? WHERE organization_id=? AND branch_id=? AND id=?`)
        .run(definition.name, cleanText(definition.description), cleanText(definition.details), cleanText(definition.color),
          cleanText(definition.icon), cleanText(definition.status || "active"), nextVersion, Number(definition.sort_order || 0),
          JSON.stringify(definition.metadata || {}), now, orgId, branchId, definition.id));
    } else {
      (await db.prepare(`INSERT INTO scope_templates (id, organization_id, branch_id, name, description, details, color,
        icon, status, current_version, sort_order, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(definition.id, orgId, branchId, definition.name, cleanText(definition.description), cleanText(definition.details),
          cleanText(definition.color), cleanText(definition.icon), cleanText(definition.status || "active"), nextVersion,
          Number(definition.sort_order || 0), JSON.stringify(definition.metadata || {}), now, now));
    }
    (await insertVersion(orgId, branchId, definition, nextVersion));
  
  });
  return (await readScopeTemplate(orgId, branchId, parsedDefinition.id));
}

export async function archiveScopeTemplate(orgId: string, branchId: string, templateId: string) {
  const result = (await getWorkDatabase().prepare(`UPDATE scope_templates SET status='archived', updated_at=?
    WHERE organization_id=? AND branch_id=? AND id=?`).run(nowIso(), orgId, branchId, templateId));
  if (!Number(result.changes || 0)) throw notFound("scope_template_not_found", "Scope template was not found.");
  return (await readScopeTemplate(orgId, branchId, templateId));
}

export async function setScopeTemplateState(
  orgId: string,
  branchId: string,
  templateId: string,
  inputValue: JsonObject
) {
  const current = (await readScopeTemplate(orgId, branchId, templateId));
  const db = getWorkDatabase();
  const hasTrashed = typeof inputValue.trashed === "boolean";
  const hasEnabled = typeof inputValue.enabled === "boolean";
  if (!hasTrashed && !hasEnabled) {
    throw badRequest("scope_template_state_empty", "Choose whether this board is enabled or in the trash.");
  }

  if (hasTrashed) {
    const nextStatus = inputValue.trashed === true
      ? "archived"
      : cleanText(asObject(current.definition).status || "active") === "draft" ? "draft" : "active";
    (await db.prepare(`UPDATE scope_templates SET status=?, updated_at=?
      WHERE organization_id=? AND branch_id=? AND id=?`)
      .run(nextStatus, nowIso(), orgId, branchId, templateId));
  }

  if (hasEnabled && current.enabled !== inputValue.enabled) {
    const settings = (await organizationScopeSettings(orgId));
    (await patchScopeFlags(orgId, {
      expected_revision: settings.revision,
      flags: { [templateId]: inputValue.enabled }
    }, branchId));
  }

  const template = (await readScopeTemplate(orgId, branchId, templateId));
  return {
    template,
    state: {
      enabled: template.enabled !== false,
      trashed: cleanText(asObject(template).status) === "archived"
    }
  };
}

export async function restoreDefaultScopeTemplates(orgId: string, branchId: string, options: { force?: boolean } = {}) {
  return (await getWorkDatabase().transaction(async () => {
  const db = getWorkDatabase();
  const existingCustom = Number(asObject((await db.prepare(`SELECT COUNT(*) AS count FROM scope_templates WHERE organization_id=?
    AND branch_id=? AND json_extract(metadata_json, '$.preset') IS NOT 1`, `SELECT COUNT(*) AS count FROM scope_templates WHERE organization_id=? AND branch_id=? AND (metadata_json::jsonb->>'preset') IS DISTINCT FROM 'true'`).get(orgId, branchId))).count || 0);
  if (existingCustom && options.force !== true) throw conflict("custom_scope_templates_exist", "Default templates cannot be reset while custom templates exist.");
  (await db.prepare("DELETE FROM scope_template_versions WHERE organization_id=? AND branch_id=?").run(orgId, branchId));
  (await db.prepare("DELETE FROM scope_templates WHERE organization_id=? AND branch_id=?").run(orgId, branchId));
  (await ensureDefaultScopeTemplates(orgId, branchId));
  return (await listScopeTemplates(orgId, branchId));

  }));
}
