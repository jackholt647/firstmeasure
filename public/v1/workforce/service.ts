import type { JsonObject } from "../compensation/service.js";
import {
  listOrganizationConnections,
  organizationConnectionAssignableProjection
} from "../connections/storage.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { notFound } from "../platform/errors.js";
import { listDocuments, readDocument, upsertDocument } from "../platform/storage.js";
import {
  assertAssignmentTagsExist,
  assertCompensationCapabilityScopes,
  listResourceGroups,
  readCompensationProfile,
  readWorkforceConfiguration,
  resourceGroupAssignableProjection,
  saveCompensationProfile
} from "./storage.js";
import { resolveAccessProfile } from "./access.js";
import { filterAssignableSubjects, normalizeAssignmentPolicy } from "./assignability.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function uniqueIds(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : []).map(cleanId).filter(Boolean))];
}

function permissionOverrides(value: unknown) {
  return Object.fromEntries(Object.entries(asObject(value)).map(([key, enabled]) => [cleanText(key), enabled === true]).filter(([key]) => !!key));
}

function appAccessOverrides(value: unknown) {
  const result: JsonObject = {};
  for (const [appIdValue, stateValue] of Object.entries(asObject(value))) {
    const appId = cleanText(appIdValue);
    if (!appId) continue;
    if (stateValue === true) result[appId] = "show";
    else if (stateValue === false) result[appId] = "hide";
    else {
      const state = cleanText(stateValue).toLowerCase();
      result[appId] = ["show", "hide"].includes(state) ? state : "inherit";
    }
  }
  return result;
}

function normalizeApplicationAccess(value: unknown, currentValue: unknown = {}) {
  const current = asObject(currentValue);
  const input = asObject(value);
  const next = { ...current };
  for (const [applicationIdValue, entryValue] of Object.entries(input)) {
    const rawApplicationId = cleanId(applicationIdValue);
    const applicationId = ["main", "portal"].includes(rawApplicationId)
      ? "management"
      : ["crew", "workforce"].includes(rawApplicationId)
        ? "field"
        : rawApplicationId;
    if (!applicationId) continue;
    const entry = asObject(entryValue);
    next[applicationId] = {
      ...asObject(current[applicationId]),
      enabled: entry.enabled === true,
      role_id: cleanText(entry.role_id || asObject(current[applicationId]).role_id || "member") || "member",
      permissions: asObject(entry.permissions)
    };
  }
  return next;
}

export async function workforceConfigurationBundle(orgId: string, branchId = "default") {
  return {
    branch_id: branchId,
    configuration: (await readWorkforceConfiguration(orgId))
  };
}

async function hydratedWorkforceUserDocument(orgId: string, documentValue: unknown) {
  const document = asObject(documentValue);
  const data = asObject(document.data);
  const accessProfile = (await resolveAccessProfile(orgId, document));
  return {
    id: cleanText(document.id),
    organization_id: cleanText(document.organization_id || orgId),
    name: cleanText(data.name || data.email || document.id),
    email: cleanText(data.email).toLowerCase(),
    phone: cleanText(data.phone),
    status: cleanText(data.status || "active"),
    worker_classification: cleanText(data.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee",
    worker_type: cleanText(data.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee",
    payment_terms: asObject(data.payment_terms),
    branch_id: cleanText(data.branch_id || "default"),
    application_access: asObject(data.application_access),
    access_role_ids: uniqueIds(data.access_role_ids),
    role_ids: uniqueIds([...(Array.isArray(data.roles) ? data.roles : []), ...(Array.isArray(data.access_role_ids) ? data.access_role_ids : [])]),
    assignment_tag_ids: uniqueIds(data.assignment_tag_ids || data.tag_ids),
    permission_overrides: permissionOverrides(data.permission_overrides),
    app_access_overrides: appAccessOverrides(data.app_access_overrides),
    access_profile: accessProfile,
    app_entitlements: accessProfile.app_entitlements,
    compensation_profile: (await readCompensationProfile(orgId, "organization_user", cleanText(document.id))),
    revision: Number(document.revision || 0),
    updated_at: cleanText(document.updated_at)
  };
}

export async function hydratedWorkforceUser(orgId: string, userId: string) {
  const document = await readDocument(orgId, "users", userId).catch(() => null);
  if (!document) throw notFound("workforce_user_not_found", "Organization user was not found.");
  return (await hydratedWorkforceUserDocument(orgId, document));
}

export async function listWorkforceUsers(orgId: string, options: JsonObject = {}) {
  const branchId = cleanText(options.branch_id || options.branchId);
  const includeDisabled = options.include_disabled === true || cleanText(options.include_disabled) === "1";
  const documents = await listDocuments(orgId, "users");
  return (await Promise.all(documents
    .map(async (document) => (await hydratedWorkforceUserDocument(orgId, document)))))
    .filter((user) => includeDisabled || !["disabled", "deleted"].includes(cleanText(user.status).toLowerCase()))
    .filter((user) => !branchId || cleanText(user.branch_id) === branchId)
    .sort((left, right) => cleanText(left.name || left.email).localeCompare(cleanText(right.name || right.email)));
}

export async function patchWorkforceUserProfile(orgId: string, userId: string, input: JsonObject) {
  const document = await readDocument(orgId, "users", userId).catch(() => null);
  if (!document) throw notFound("workforce_user_not_found", "Organization user was not found.");
  const current = asObject(document.data);
  const compensation = Object.prototype.hasOwnProperty.call(input, "compensation_profile")
    ? (await assertCompensationCapabilityScopes(orgId, [cleanText(current.branch_id || "default")], input.compensation_profile))
    : null;

  const patch: JsonObject = {};
  if (Object.prototype.hasOwnProperty.call(input, "application_access")) {
    patch.application_access = normalizeApplicationAccess(input.application_access, current.application_access);
  }
  if (Object.prototype.hasOwnProperty.call(input, "access_role_ids")) patch.access_role_ids = uniqueIds(input.access_role_ids);
  if (Object.prototype.hasOwnProperty.call(input, "permission_overrides")) patch.permission_overrides = permissionOverrides(input.permission_overrides);
  if (Object.prototype.hasOwnProperty.call(input, "app_access_overrides")) patch.app_access_overrides = appAccessOverrides(input.app_access_overrides);
  if (Object.prototype.hasOwnProperty.call(input, "assignment_tag_ids")) {
    patch.assignment_tag_ids = (await assertAssignmentTagsExist(orgId, input.assignment_tag_ids));
  }
  if (Object.prototype.hasOwnProperty.call(input, "worker_classification")) {
    patch.worker_classification = cleanText(input.worker_classification) === "independent_contractor" ? "independent_contractor" : "employee";
  }
  if (Object.prototype.hasOwnProperty.call(input, "payment_terms")) {
    const terms = asObject(input.payment_terms);
    patch.payment_terms = {
      basis: cleanText(terms.basis) === "net_days" ? "net_days" : "payroll_schedule",
      net_days: Math.max(0, Math.min(365, Math.floor(Number(terms.net_days || 0))))
    };
  }
  if (Object.keys(patch).length) {
    await upsertDocument(orgId, "users", {
      id: userId,
      expected_revision: Number(input.expected_revision || 0) || undefined,
      data: patch,
      metadata: { workforce_profile_updated_at: new Date().toISOString() }
    }, { replace: false });
  }
  if (compensation) {
    (await saveCompensationProfile(orgId, "organization_user", userId, compensation));
  }
  return await hydratedWorkforceUser(orgId, userId);
}

export async function listAssignableResources(orgId: string, branchId: string, options: JsonObject = {}) {
  const scopeTemplateId = cleanText(options.scope_template_id || options.capability_scope_id);
  const query = {
    branch_id: branchId,
    ...(scopeTemplateId ? { scope_template_id: scopeTemplateId } : {})
  };
  const [groups, connections] = await Promise.all([
    listResourceGroups(orgId, query),
    Promise.resolve((await listOrganizationConnections(orgId, query)))
  ]);
  const resourceGroups = groups.map((group) => resourceGroupAssignableProjection(group));
  const organizationConnections = connections.map((connection) => organizationConnectionAssignableProjection(connection));
  const users = (await listWorkforceUsers(orgId, { branch_id: branchId })).map((user) => ({
    subject_type: "organization_user",
    resource_kind: "organization_user",
    resource_id: user.id,
    id: user.id,
    name: user.name,
    status: user.status,
    branch_id: user.branch_id,
    role_ids: uniqueIds(user.role_ids),
    kind_ids: uniqueIds(user.role_ids),
    assignment_tag_ids: uniqueIds(user.assignment_tag_ids),
    user
  }));
  // Equipment units join the assignable-subject catalog when equipment
  // scheduling is on. kind_ids carries the type and category ids so the
  // existing rule engine (kind_ids / assignment_tag_ids) covers
  // crew↔equipment eligibility without a bespoke tag system.
  let equipmentUnits: JsonObject[] = [];
  try {
    if (await isCapabilityEnabled(orgId, "equipment.scheduling")) {
      const { fleetUnits } = await import("../equipment/service.js");
      equipmentUnits = (await fleetUnits(orgId, { ownership: "internal" }))
        .filter((unit) => cleanText(unit.status) !== "retired")
        .filter((unit) => !branchId || branchId === "default" || cleanText(unit.branch_id) === branchId || cleanText(unit.branch_id) === "default")
        .map((unit) => ({
          subject_type: "equipment_unit",
          resource_kind: "equipment_unit",
          id: cleanText(unit.id),
          resource_id: cleanText(unit.id),
          name: cleanText(unit.name),
          status: cleanText(unit.status),
          branch_id: cleanText(unit.branch_id),
          icon: cleanText(unit.type_icon) || "fa-truck-pickup",
          kind_ids: uniqueIds([unit.type_id, unit.category_id]),
          type_id: cleanText(unit.type_id),
          type_name: cleanText(unit.type_name),
          assignment_tag_ids: uniqueIds(unit.tags),
          capability_scope_ids: [],
          equipment_unit: unit
        }));
    }
  } catch {
    /* Equipment module unavailable: the catalog simply has no equipment. */
  }
  return {
    resources: [...resourceGroups, ...organizationConnections],
    subjects: [...users, ...resourceGroups, ...organizationConnections, ...equipmentUnits],
    users,
    resource_groups: resourceGroups,
    organization_connections: organizationConnections,
    equipment_units: equipmentUnits
  };
}

export async function resolveAssignableSubjects(orgId: string, branchId: string, policyValue: unknown, options: JsonObject = {}) {
  const catalog = await listAssignableResources(orgId, branchId, options);
  const policy = normalizeAssignmentPolicy(policyValue);
  const subjects = filterAssignableSubjects(catalog.subjects, policy);
  return {
    policy,
    subjects,
    users: subjects.filter((subject) => subject.subject_type === "organization_user"),
    resource_groups: subjects.filter((subject) => subject.subject_type === "resource_group"),
    organization_connections: subjects.filter((subject) => subject.subject_type === "organization_connection"),
    equipment_units: subjects.filter((subject) => subject.subject_type === "equipment_unit")
  };
}
