import { badRequest, conflict, PlatformError } from "../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { normalizeAssignmentPolicy } from "../workforce/assignability.js";
import { resolveAssignableSubjects } from "../workforce/service.js";

const CUSTOM_FIELD_SCHEMA_VERSION = 3;
const ASSIGNABLE_TYPES = new Set(["organization_user", "resource_group", "organization_connection"]);

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(value: unknown) {
  return [...new Set(asArray(value).map(cleanText).filter(Boolean))];
}

export function normalizeCustomFieldPath(value: unknown, fallback = "") {
  const segments = cleanText(value || fallback)
    .toLowerCase()
    .split(".")
    .map((segment) => segment.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, ""))
    .filter(Boolean);
  if (!segments.length) throw badRequest("custom_field_path_required", "Custom fields require a stable path.");
  if (segments.length > 12 || segments.some((segment) => segment.length > 64)) {
    throw badRequest("custom_field_path_invalid", "Custom field paths may contain at most 12 segments of 64 characters.");
  }
  return segments.join(".");
}

export function customFieldValueAtPath(value: unknown, pathValue: unknown): unknown {
  const path = normalizeCustomFieldPath(pathValue);
  return path.split(".").reduce<unknown>((current, segment) => (
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as JsonObject)[segment]
      : undefined
  ), value);
}

export function setCustomFieldValueAtPath(value: unknown, pathValue: unknown, nextValue: unknown) {
  const root = asObject(value);
  const path = normalizeCustomFieldPath(pathValue);
  const segments = path.split(".");
  let cursor = root;
  for (const segment of segments.slice(0, -1)) {
    cursor[segment] = asObject(cursor[segment]);
    cursor = cursor[segment] as JsonObject;
  }
  cursor[segments[segments.length - 1] as string] = nextValue as never;
  return root;
}

function normalizedFieldType(value: unknown) {
  const type = cleanText(value || "text").toLowerCase();
  const supported = new Set([
    "text", "multiline", "email", "phone", "url", "number", "currency", "percentage", "slider",
    "date", "datetime", "boolean", "toggle", "select", "radio", "multiselect", "tags", "list",
    "key_value", "json", "formula", "organization_user", "resource_group", "organization_connection",
    "assignable_subject"
  ]);
  if (!supported.has(type)) throw badRequest("custom_field_type_invalid", `Unsupported custom field type '${type}'.`);
  return type;
}

function sourceIdentity(value: unknown) {
  const source = asObject(value);
  return [
    cleanText(source.kind || "scope"),
    cleanText(source.scope_template_id || source.id),
    cleanText(source.scope_template_version || source.version),
    cleanText(source.work_plan_id || source.instance_id)
  ].join(":");
}

function normalizeSource(value: unknown): JsonObject {
  const source = asObject(value);
  return {
    kind: cleanText(source.kind || "scope") || "scope",
    scope_template_id: cleanText(source.scope_template_id || source.id),
    scope_template_version: Number(source.scope_template_version || source.version || 0),
    work_plan_id: cleanText(source.work_plan_id || source.instance_id),
    contributed_at: cleanText(source.contributed_at || new Date().toISOString())
  };
}

function normalizeGroup(value: unknown, index = 0): JsonObject {
  const source = asObject(value);
  const path = normalizeCustomFieldPath(source.path || source.key || source.id || `group_${index + 1}`);
  return {
    path,
    key: path,
    label: cleanText(source.label || source.name || path.split(".").pop()) || path,
    description: cleanText(source.description),
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index,
    collapsed_by_default: source.collapsed_by_default !== false,
    location: cleanText(source.location || "project_left") || "project_left",
    icon: cleanText(source.icon),
    sources: asArray(source.sources).map(normalizeSource)
  };
}

function normalizeField(value: unknown, index = 0): JsonObject {
  const source = asObject(value);
  const path = normalizeCustomFieldPath(source.path || source.key || source.id || source.label || `field_${index + 1}`);
  const type = normalizedFieldType(source.type || source.presentation || source.widget);
  const cardinality = cleanText(source.cardinality) === "many" ? "many" : "one";
  const groupPath = cleanText(source.group_path || source.group)
    ? normalizeCustomFieldPath(source.group_path || source.group)
    : (path.includes(".") ? path.split(".").slice(0, -1).join(".") : "");
  return {
    ...source,
    id: cleanText(source.id) || path,
    path,
    key: path,
    label: cleanText(source.label || source.name || path.split(".").pop()) || path,
    entity: "project",
    type,
    cardinality,
    group_path: groupPath,
    required: source.required === true,
    enabled: source.enabled !== false,
    read_only: source.read_only === true || type === "formula",
    show_in_overview: source.show_in_overview !== false,
    show_in_scope: source.show_in_scope === true,
    background_only: source.background_only === true,
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : index,
    assignment_policy: ["organization_user", "resource_group", "organization_connection", "assignable_subject"].includes(type)
      ? normalizeAssignmentPolicy(
        Object.keys(asObject(source.assignment_policy)).length
          ? source.assignment_policy
          : { allow_unassigned: source.required !== true, rules: [{ subject_types: type === "assignable_subject" ? [...ASSIGNABLE_TYPES] : [type] }] }
      )
      : {},
    default_from: asObject(source.default_from),
    ui: asObject(source.ui),
    sources: asArray(source.sources).map(normalizeSource)
  };
}

function normalizedProjectSchema(projectValue: unknown) {
  const schema = asObject(asObject(projectValue).custom_field_schema);
  return {
    version: CUSTOM_FIELD_SCHEMA_VERSION,
    groups: asArray(schema.groups).map(normalizeGroup),
    fields: asArray(schema.fields || schema.definitions).map(normalizeField)
  };
}

function compatibleField(existing: JsonObject, incoming: JsonObject) {
  return cleanText(existing.type) === cleanText(incoming.type)
    && cleanText(existing.cardinality || "one") === cleanText(incoming.cardinality || "one");
}

function mergeSources(leftValue: unknown, rightValue: unknown) {
  const merged = [...asArray(leftValue), ...asArray(rightValue)].map(normalizeSource);
  const byId = new Map<string, JsonObject>();
  for (const source of merged) byId.set(sourceIdentity(source), source);
  return [...byId.values()];
}

export function reconcileProjectCustomFieldSchema(
  projectValue: unknown,
  contributionValue: unknown,
  sourceValue: unknown
) {
  const project = asObject(projectValue);
  const current = normalizedProjectSchema(project);
  const contribution = asObject(contributionValue);
  const source = normalizeSource(sourceValue);
  const groupMap = new Map(current.groups.map((group) => [cleanText(group.path), group]));
  const fieldMap = new Map(current.fields.map((field) => [cleanText(field.path), field]));

  for (const [index, rawGroup] of asArray(contribution.groups || contribution.field_groups).entries()) {
    const group = normalizeGroup(rawGroup, index);
    const existing = groupMap.get(cleanText(group.path));
    groupMap.set(cleanText(group.path), {
      ...existing,
      ...group,
      sources: mergeSources(existing?.sources, [...asArray(group.sources), source])
    });
  }

  for (const [index, rawField] of asArray(contribution.fields || contribution.definitions).entries()) {
    const field = normalizeField(rawField, index);
    const existing = fieldMap.get(cleanText(field.path));
    if (existing && !compatibleField(existing, field)) {
      throw conflict(
        "custom_field_definition_conflict",
        `Custom field '${cleanText(field.path)}' is already defined as ${cleanText(existing.type)} (${cleanText(existing.cardinality || "one")}).`,
        { path: field.path, existing_type: existing.type, incoming_type: field.type }
      );
    }
    fieldMap.set(cleanText(field.path), {
      ...existing,
      ...field,
      sources: mergeSources(existing?.sources, [...asArray(field.sources), source])
    });
    const groupPath = cleanText(field.group_path);
    if (groupPath && !groupMap.has(groupPath)) {
      groupMap.set(groupPath, normalizeGroup({
        path: groupPath,
        label: groupPath.split(".").pop()?.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
        collapsed_by_default: true,
        sources: [source]
      }));
    }
  }

  return {
    ...project,
    custom_field_schema: {
      version: CUSTOM_FIELD_SCHEMA_VERSION,
      groups: [...groupMap.values()].sort((left, right) => Number(left.order || 0) - Number(right.order || 0)),
      fields: [...fieldMap.values()].sort((left, right) => Number(left.order || 0) - Number(right.order || 0))
    }
  };
}

function eventTypeId(value: unknown) {
  const event = asObject(value);
  return cleanText(event.event_type_default_id || event.event_type_id || event.type_id || event.type);
}

function eventSubjects(value: unknown): JsonObject[] {
  const event = asObject(value);
  const byIdentity = new Map<string, JsonObject>();
  for (const assigned of asArray(event.assigned_users).map(asObject)) {
    const id = cleanText(assigned.id || assigned.user_id);
    if (id) byIdentity.set(`organization_user:${id}`, { subject_type: "organization_user", subject_id: id });
  }
  for (const idValue of asArray(event.assigned_user_ids)) {
    const id = cleanText(idValue);
    if (id) byIdentity.set(`organization_user:${id}`, { subject_type: "organization_user", subject_id: id });
  }
  const resource = asObject(event.work_resource_ref);
  const resourceId = cleanText(resource.id || event.assigned_resource_id || event.resource_id || event.assigned_crew_id || event.crew_id);
  const resourceKind = cleanText(resource.kind || event.assigned_resource_kind || "resource_group");
  if (resourceId && ASSIGNABLE_TYPES.has(resourceKind)) {
    byIdentity.set(`${resourceKind}:${resourceId}`, { subject_type: resourceKind, subject_id: resourceId });
  }
  return [...byIdentity.values()];
}

function qualifyingEvents(project: JsonObject, defaultFrom: JsonObject) {
  const wantedType = cleanText(defaultFrom.event_type_id || defaultFrom.event_type_default_id);
  return asArray(project.events).map(asObject)
    .filter((event) => !wantedType || eventTypeId(event) === wantedType)
    .filter((event) => !["cancelled", "canceled", "deleted"].includes(cleanText(event.status).toLowerCase()))
    .sort((left, right) => {
      const leftKey = cleanText(left.start_at || left.start || left.created_at || left.updated_at);
      const rightKey = cleanText(right.start_at || right.start || right.created_at || right.updated_at);
      return leftKey.localeCompare(rightKey);
    });
}

function fallbackDefaultValue(project: JsonObject, defaultFrom: JsonObject) {
  if (cleanText(defaultFrom.fallback_source) !== "proposal_creator") return { found: false };
  const reference = asObject(asObject(project.__custom_field_default_context).proposal_creator);
  const subjectId = cleanText(reference.subject_id || reference.id || reference.user_id);
  if (!subjectId) return { found: false };
  return {
    found: true,
    value: { subject_type: "organization_user", subject_id: subjectId },
    source_event_id: ""
  };
}

function defaultValueForField(project: JsonObject, field: JsonObject) {
  const defaultFrom = asObject(field.default_from);
  const sourceKind = cleanText(defaultFrom.source || defaultFrom.kind);
  if (sourceKind === "event_scheduler") {
    const event = qualifyingEvents(project, defaultFrom)[0];
    if (!event) return fallbackDefaultValue(project, defaultFrom);
    const userId = cleanText(event.scheduled_by_user_id || event.created_by_user_id);
    if (!userId) return fallbackDefaultValue(project, defaultFrom);
    return {
      found: true,
      value: { subject_type: "organization_user", subject_id: userId },
      source_event_id: cleanText(event.id)
    };
  }
  if (["event_assignment", "first_event_assignee", "appointment_assignee"].includes(sourceKind)) {
    const event = qualifyingEvents(project, defaultFrom)[0];
    if (!event) return fallbackDefaultValue(project, defaultFrom);
    const subjects = eventSubjects(event);
    const policy = normalizeAssignmentPolicy(field.assignment_policy);
    // Event payloads do not always carry the assignee's roles/tags. Type
    // compatibility is safe to decide here; the API performs a live workforce
    // policy validation whenever a populated reference is persisted.
    const allowed = subjects.filter((subject) => !policy.rules.length || policy.rules.some((rule) => (
      !rule.subject_types.length || rule.subject_types.includes(cleanText(subject.subject_type) as typeof rule.subject_types[number])
    )));
    if (!allowed.length) return fallbackDefaultValue(project, defaultFrom);
    const values = allowed.map((subject) => ({
      subject_type: cleanText(subject.subject_type),
      subject_id: cleanText(subject.subject_id || subject.id || subject.resource_id)
    }));
    return {
      found: true,
      value: cleanText(field.cardinality) === "many" ? values : values[0],
      source_event_id: cleanText(event.id)
    };
  }
  if (Object.prototype.hasOwnProperty.call(field, "default_value")) {
    return { found: true, value: field.default_value };
  }
  return { found: false };
}

function emptyValue(value: unknown) {
  return value == null || value === ""
    || (Array.isArray(value) && !value.length)
    || (value && typeof value === "object" && !Array.isArray(value) && !Object.keys(value as JsonObject).length);
}

function deepMergeObjects(leftValue: unknown, rightValue: unknown): JsonObject {
  const left = asObject(leftValue);
  const right = asObject(rightValue);
  const merged: JsonObject = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (
      value && typeof value === "object" && !Array.isArray(value)
      && left[key] && typeof left[key] === "object" && !Array.isArray(left[key])
    ) ? deepMergeObjects(left[key], value) : value;
  }
  return merged;
}

export function mergeProjectCustomFieldsForSave(currentValue: unknown, incomingValue: unknown) {
  const current = asObject(currentValue);
  const incoming = asObject(incomingValue);
  const currentValues = asObject(current.custom_field_values || current.custom_fields);
  const incomingHasValues = Object.prototype.hasOwnProperty.call(incoming, "custom_field_values")
    || Object.prototype.hasOwnProperty.call(incoming, "custom_fields");
  const incomingValues = asObject(incoming.custom_field_values || incoming.custom_fields);
  const values = incomingHasValues ? deepMergeObjects(currentValues, incomingValues) : currentValues;
  const schema = Object.keys(asObject(current.custom_field_schema)).length
    ? current.custom_field_schema
    : incoming.custom_field_schema;
  return applyProjectCustomFieldDefaults({
    ...incoming,
    ...(schema ? { custom_field_schema: schema } : {}),
    ...(Object.keys(values).length || incomingHasValues ? {
      custom_field_values: values,
      custom_fields: values
    } : {}),
    custom_field_value_meta: deepMergeObjects(current.custom_field_value_meta, incoming.custom_field_value_meta)
  });
}

export function applyProjectCustomFieldDefaults(projectValue: unknown, now = new Date().toISOString()) {
  const project = asObject(projectValue);
  const schema = normalizedProjectSchema(project);
  let values = asObject(project.custom_field_values || project.custom_fields);
  const metadata = asObject(project.custom_field_value_meta);
  let changed = false;
  for (const field of schema.fields) {
    const path = cleanText(field.path);
    if (!path || !emptyValue(customFieldValueAtPath(values, path))) continue;
    const resolved = defaultValueForField(project, field);
    if (!resolved.found) continue;
    values = setCustomFieldValueAtPath(values, path, resolved.value);
    metadata[path] = {
      source: cleanText(asObject(field.default_from).source || "default"),
      source_event_id: cleanText(resolved.source_event_id),
      write_mode: "default",
      set_at: now,
      set_by: "system"
    };
    changed = true;
  }
  return changed ? {
    ...project,
    custom_field_values: values,
    custom_fields: values,
    custom_field_value_meta: metadata
  } : project;
}

export async function validateProjectCustomFieldValues(
  orgId: string,
  branchId: string,
  projectValue: unknown,
  previousProjectValue: unknown = {}
) {
  const project = asObject(projectValue);
  const schema = normalizedProjectSchema(project);
  const values = asObject(project.custom_field_values || project.custom_fields);
  const previousProject = asObject(previousProjectValue);
  const previousSchema = normalizedProjectSchema(previousProject);
  const previousPaths = new Set(previousSchema.fields.map((field) => cleanText(field.path)));
  const previousValues = asObject(previousProject.custom_field_values || previousProject.custom_fields);
  for (const field of schema.fields) {
    const path = cleanText(field.path);
    const value = customFieldValueAtPath(values, path);
    if (!["organization_user", "resource_group", "organization_connection", "assignable_subject"].includes(cleanText(field.type)) || emptyValue(value)) continue;
    if (
      previousPaths.has(path) &&
      JSON.stringify(value) === JSON.stringify(customFieldValueAtPath(previousValues, path))
    ) continue;
    const references = (Array.isArray(value) ? value : [value]).map(asObject);
    if (cleanText(field.cardinality) !== "many" && references.length > 1) {
      throw badRequest("custom_field_cardinality_invalid", `${cleanText(field.label || path)} accepts one assignment.`, { path });
    }
    if (references.some((reference) => !ASSIGNABLE_TYPES.has(cleanText(reference.subject_type)) || !cleanText(reference.subject_id || reference.id))) {
      throw badRequest("custom_field_reference_invalid", `${cleanText(field.label || path)} contains an invalid assignment reference.`, { path });
    }
    const source = asObject(asArray(field.sources)[0]);
    const resolved = await resolveAssignableSubjects(orgId, branchId || "default", field.assignment_policy, {
      scope_template_id: cleanText(source.scope_template_id)
    });
    const allowed = new Set(resolved.subjects.map((subject) => `${cleanText(subject.subject_type)}:${cleanText(subject.id || subject.resource_id)}`));
    const rejected = references
      .map((reference) => `${cleanText(reference.subject_type)}:${cleanText(reference.subject_id || reference.id)}`)
      .filter((identity) => !allowed.has(identity));
    if (rejected.length) {
      throw badRequest("custom_field_assignment_not_allowed", `${cleanText(field.label || path)} contains an ineligible assignment.`, { path, rejected });
    }
  }
  return project;
}

export async function materializeScopeCustomFields(
  orgId: string,
  projectId: string,
  definitionValue: unknown,
  sourceValue: unknown
) {
  const definition = asObject(definitionValue);
  const contribution = asObject(definition.custom_fields || definition.project_custom_fields);
  const legacyGroups = asArray(definition.custom_field_groups);
  const forwarding = asObject(asObject(definition.communications).email_forwarding);
  if (!asArray(contribution.fields || contribution.definitions).length && !legacyGroups.length && !Object.keys(forwarding).length) {
    return { skipped: true, reason: "no_custom_fields" };
  }
  const normalizedContribution = {
    ...contribution,
    groups: [...asArray(contribution.groups), ...legacyGroups]
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const document = await readDocument(orgId, "projects", projectId);
    const project = { id: projectId, ...asObject(document.data) };
    const proposalId = cleanText(asObject(sourceValue).proposal_id);
    const proposalDocument = proposalId
      ? await readDocument(orgId, "proposals", proposalId).catch(() => null)
      : null;
    const proposal = asObject(proposalDocument?.data);
    const proposalCreatorId = cleanText(proposal.created_by_user_id || proposal.updated_by_user_id);
    const projectWithDefaultContext = proposalCreatorId ? {
      ...project,
      __custom_field_default_context: {
        proposal_creator: { subject_type: "organization_user", subject_id: proposalCreatorId }
      }
    } : project;
    let reconciled = applyProjectCustomFieldDefaults(
      reconcileProjectCustomFieldSchema(projectWithDefaultContext, normalizedContribution, sourceValue)
    );
    delete reconciled.__custom_field_default_context;
    if (Object.keys(forwarding).length) {
      const currentComms = asObject(reconciled.comms);
      const currentForwarding = asObject(currentComms.email_forwarding);
      const incomingPriority = Number(forwarding.priority || 0);
      const currentPriority = Number(currentForwarding.priority || 0);
      if (!Object.keys(currentForwarding).length || incomingPriority >= currentPriority) {
        reconciled = {
          ...reconciled,
          comms: {
            ...currentComms,
            email_forwarding: {
              ...forwarding,
              enabled: forwarding.enabled !== false,
              source: normalizeSource(sourceValue),
              activated_at: new Date().toISOString()
            }
          }
        };
      }
    }
    await validateProjectCustomFieldValues(
      orgId,
      cleanText(reconciled.branch_id || "default") || "default",
      reconciled,
      project
    );
    try {
      const saved = await upsertDocument(orgId, "projects", {
        id: projectId,
        expected_revision: Number(document.revision || 0),
        data: { ...reconciled, id: undefined, updated_at: new Date().toISOString() },
        metadata: document.metadata
      }, { replace: true });
      return {
        skipped: false,
        schema: asObject(asObject(saved.data).custom_field_schema),
        values: asObject(asObject(saved.data).custom_field_values)
      };
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "revision_conflict" || attempt === 2) throw error;
    }
  }
  throw conflict("revision_conflict", "Project custom fields changed while the scope was being activated.");
}

export function assignmentPayeesFromCustomField(projectValue: unknown, pathValue: unknown) {
  const project = asObject(projectValue);
  const value = customFieldValueAtPath(project.custom_field_values || project.custom_fields, pathValue);
  return (Array.isArray(value) ? value : [value]).map(asObject)
    .map((subject) => ({
      type: cleanText(subject.subject_type),
      id: cleanText(subject.subject_id || subject.id),
      name: cleanText(subject.name || subject.label || subject.subject_id || subject.id),
      worker_type: cleanText(subject.worker_type || (subject.subject_type === "organization_connection" ? "subcontractor" : "employee"))
    }))
    .filter((payee) => ASSIGNABLE_TYPES.has(payee.type) && !!payee.id);
}
