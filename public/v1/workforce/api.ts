import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { forbidden, badRequest, PlatformError } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import {
  resourceGroupCreateSchema,
  resourceGroupMemberMutationSchema,
  resourceGroupPatchSchema,
  workforceConfigurationInputSchema,
  workforceUserProfilePatchSchema
} from "./schemas.js";
import {
  hydratedWorkforceUser,
  listAssignableResources,
  listWorkforceUsers,
  patchWorkforceUserProfile,
  resolveAssignableSubjects,
  workforceConfigurationBundle
} from "./service.js";
import {
  archiveResourceGroup,
  createResourceGroup,
  listResourceGroups,
  patchResourceGroup,
  putResourceGroupMember,
  readResourceGroup,
  removeResourceGroupMember,
  saveWorkforceConfiguration
} from "./storage.js";
import { registerCrewApi } from "./crew_api.js";
import { registerSalesApi } from "./sales_api.js";
import { migrateLegacyLaborCrews } from "./legacy_migration.js";
import {
  ACCESS_SCHEMA_VERSION,
  CREW_PERMISSION_KEYS,
  SALES_PERMISSION_KEYS,
  accessCatalog,
  archiveAccessRole,
  createAccessRole,
  listAccessRoles,
  patchAccessRole,
  readAccessRole,
  resolveAccessProfile
} from "./access.js";
import {
  applyPersonaTemplate,
  archivePersonaTemplate,
  createPersonaTemplate,
  listPersonaTemplates,
  patchPersonaTemplate,
  readPersonaTemplate
} from "./persona_templates.js";

const objectSchema = z.object({}).passthrough();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function queryObject(request: FastifyRequest) {
  return objectSchema.parse(request.query ?? {});
}

function expectedRevision(request: FastifyRequest) {
  const value = Number(asObject(request.query).expected_revision || 0);
  if (!Number.isInteger(value) || value <= 0) throw badRequest("expected_revision_required", "A positive expected_revision query parameter is required.");
  return value;
}

async function requireWorkforceRead(request: FastifyRequest, orgId: string, settingsOnly = false) {
  return await requirePlatformAuth(request, {
    orgId,
    permission: settingsOnly ? "manage_company_settings" : "view_projects|manage_company_settings"
  });
}

async function requireWorkforceMutation(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
}

async function requireUserProfileRead(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, permission: "manage_company_users|manage_company_user_permissions|manage_company_settings" });
}

async function requireUserProfileMutation(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_users|manage_company_user_permissions|manage_company_settings" });
}

function canMutateFullUserProfile(context: Awaited<ReturnType<typeof requirePlatformAuth>>) {
  const permissions = asObject(context.permissions);
  const role = cleanText(context.role).toLowerCase();
  return permissions["*"] === true
    || permissions.manage_company_users === true
    || permissions.manage_company_settings === true
    || ["owner", "admin", "super_admin"].includes(role);
}

function assertUserProfilePatchScope(
  context: Awaited<ReturnType<typeof requirePlatformAuth>>,
  body: Record<string, unknown>
) {
  if (canMutateFullUserProfile(context)) return;
  const forbiddenFields = ["compensation_profile", "worker_classification", "payment_terms"]
    .filter((field) => Object.prototype.hasOwnProperty.call(body, field));
  if (forbiddenFields.length) {
    throw forbidden(
      "workforce_profile_fields_forbidden",
      "This administrator may change access roles, application access, and permission overrides only.",
      { forbidden_fields: forbiddenFields }
    );
  }
}

async function requireAccessAdministration(request: FastifyRequest, orgId: string, csrf = false) {
  return await requirePlatformAuth(request, {
    orgId,
    csrf,
    application: "management",
    permission: "manage_company_users|manage_company_settings|manage_company_user_permissions"
  });
}

async function settingsPayload(orgId: string, branchId: string) {
  const bundle = (await workforceConfigurationBundle(orgId, branchId));
  return {
    ...bundle,
    settings: {
      schema_version: bundle.configuration.schema_version,
      terminology: bundle.configuration.terminology,
      revision: bundle.configuration.revision
    }
  };
}

export const registerWorkforceApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) {
      return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "workforce",
    resources: {
      configuration: "/organizations/:orgId/branches/:branchId/configuration",
      users: "/organizations/:orgId/users",
      resource_groups: "/organizations/:orgId/branches/:branchId/resource-groups",
      assignable_resources: "/organizations/:orgId/branches/:branchId/assignable-resources",
      assignable_subjects_resolve: "/organizations/:orgId/branches/:branchId/assignable-subjects/resolve",
      user_profile: "/organizations/:orgId/users/:userId/profile",
      access_catalog: "/organizations/:orgId/access/catalog",
      access_roles: "/organizations/:orgId/access/roles",
      persona_templates: "/organizations/:orgId/access/templates",
      effective_access: "/organizations/:orgId/access/me",
      crew: "/organizations/:orgId/crew",
      sales: "/organizations/:orgId/sales"
    }
  }));

  await app.register(registerCrewApi);
  await app.register(registerSalesApi);

  app.get("/organizations/:orgId/access/catalog", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requireAccessAdministration(request, orgId);
    const query = queryObject(request);
    const surface = cleanText(query.surface) as "portal_tab" | "project_modal";
    const device = cleanText(query.device) as "desktop" | "mobile";
    const apps = accessCatalog({
      ...(surface ? { surface } : {}),
      ...(device ? { device } : {})
    });
    return {
      ok: true,
      schema_version: ACCESS_SCHEMA_VERSION,
      applications: [
        { id: "management", label: "Management", enabled: ctx.applicationAccess.management?.enabled === true },
        { id: "field", label: "Crew", enabled: ctx.applicationAccess.field?.enabled === true }
      ],
      permission_keys: [...Object.values(CREW_PERMISSION_KEYS), ...Object.values(SALES_PERMISSION_KEYS)],
      apps,
      app_catalog: apps,
      roles: (await listAccessRoles(orgId))
    };
  });

  app.get("/organizations/:orgId/access/me", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, application: ["management", "field"] });
    return {
      ok: true,
      access_profile: ctx.accessProfile,
      application_access: ctx.applicationAccess,
      app_entitlements: ctx.appEntitlements
    };
  });

  app.get("/organizations/:orgId/access/users/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId);
    const user = await readDocument(orgId, "users", getParam(request.params, "userId"));
    const accessProfile = (await resolveAccessProfile(orgId, user));
    return {
      ok: true,
      user_id: getParam(request.params, "userId"),
      access_profile: accessProfile,
      application_access: accessProfile.application_access,
      app_entitlements: accessProfile.app_entitlements
    };
  });

  app.get("/organizations/:orgId/access/roles", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId);
    const query = queryObject(request);
    const roles = (await listAccessRoles(orgId, {
      include_archived: query.include_archived === true || cleanText(query.include_archived) === "1",
      application_id: cleanText(query.application_id || query.application)
    }));
    return { ok: true, roles, access_roles: roles, count: roles.length };
  });

  app.post("/organizations/:orgId/access/roles", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const role = (await createAccessRole(orgId, objectSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, role, access_role: role };
  });

  app.get("/organizations/:orgId/access/roles/:roleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId);
    const role = (await readAccessRole(orgId, getParam(request.params, "roleId")));
    return { ok: true, role, access_role: role };
  });

  app.patch("/organizations/:orgId/access/roles/:roleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const role = (await patchAccessRole(orgId, getParam(request.params, "roleId"), objectSchema.parse(request.body ?? {})));
    return { ok: true, role, access_role: role };
  });

  app.delete("/organizations/:orgId/access/roles/:roleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const role = (await archiveAccessRole(orgId, getParam(request.params, "roleId"), expectedRevision(request)));
    return { ok: true, archived: true, role, access_role: role };
  });

  app.get("/organizations/:orgId/access/templates", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId);
    const query = queryObject(request);
    const templates = (await listPersonaTemplates(orgId, {
      include_archived: query.include_archived === true || cleanText(query.include_archived) === "1"
    }));
    return { ok: true, templates, persona_templates: templates, count: templates.length };
  });

  app.post("/organizations/:orgId/access/templates", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const template = (await createPersonaTemplate(orgId, objectSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, template, persona_template: template };
  });

  app.get("/organizations/:orgId/access/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId);
    const template = (await readPersonaTemplate(orgId, getParam(request.params, "templateId")));
    return { ok: true, template, persona_template: template };
  });

  app.patch("/organizations/:orgId/access/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const template = (await patchPersonaTemplate(orgId, getParam(request.params, "templateId"), objectSchema.parse(request.body ?? {})));
    return { ok: true, template, persona_template: template };
  });

  app.delete("/organizations/:orgId/access/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const template = (await archivePersonaTemplate(orgId, getParam(request.params, "templateId"), expectedRevision(request)));
    return { ok: true, archived: true, template, persona_template: template };
  });

  app.post("/organizations/:orgId/access/templates/:templateId/apply", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireAccessAdministration(request, orgId, true);
    const result = await applyPersonaTemplate(orgId, getParam(request.params, "templateId"));
    return {
      ok: true,
      template: result.template,
      role: result.role,
      access_role: result.role,
      created: result.created,
      capability_warnings: result.capability_warnings
    };
  });

  app.get("/organizations/:orgId/branches/:branchId/configuration", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceRead(request, orgId);
    return { ok: true, ...(await settingsPayload(orgId, branchId)) };
  });

  app.put("/organizations/:orgId/branches/:branchId/configuration", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const body = workforceConfigurationInputSchema.parse(request.body ?? {});
    const configuration = (await saveWorkforceConfiguration(orgId, body));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), configuration };
  });

  app.get("/organizations/:orgId/users", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireUserProfileRead(request, orgId);
    const query = queryObject(request);
    const users = await listWorkforceUsers(orgId, query);
    return { ok: true, users, profiles: users, count: users.length };
  });

  app.get("/organizations/:orgId/users/:userId/profile", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireUserProfileRead(request, orgId);
    const user = await hydratedWorkforceUser(orgId, getParam(request.params, "userId"));
    return { ok: true, user, profile: user };
  });

  app.patch("/organizations/:orgId/users/:userId/profile", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const context = await requireUserProfileMutation(request, orgId);
    const body = workforceUserProfilePatchSchema.parse(request.body ?? {});
    assertUserProfilePatchScope(context, body);
    const user = await patchWorkforceUserProfile(orgId, getParam(request.params, "userId"), body);
    return { ok: true, user, profile: user };
  });

  app.get("/organizations/:orgId/branches/:branchId/resource-groups", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceRead(request, orgId);
    await migrateLegacyLaborCrews(orgId, branchId);
    const groups = await listResourceGroups(orgId, { ...queryObject(request), branch_id: branchId });
    return { ok: true, ...(await settingsPayload(orgId, branchId)), resource_groups: groups, groups, count: groups.length };
  });

  app.post("/organizations/:orgId/branches/:branchId/resource-groups", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const body = resourceGroupCreateSchema.parse(request.body ?? {});
    const group = await createResourceGroup(orgId, { ...body, branch_id: branchId });
    reply.code(201);
    return { ok: true, ...(await settingsPayload(orgId, branchId)), resource_group: group, group };
  });

  app.get("/organizations/:orgId/branches/:branchId/resource-groups/:groupId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceRead(request, orgId);
    await migrateLegacyLaborCrews(orgId, branchId);
    const group = await readResourceGroup(orgId, getParam(request.params, "groupId"));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), resource_group: group, group };
  });

  app.patch("/organizations/:orgId/branches/:branchId/resource-groups/:groupId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const group = await patchResourceGroup(orgId, getParam(request.params, "groupId"), resourceGroupPatchSchema.parse(request.body ?? {}));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), resource_group: group, group };
  });

  app.delete("/organizations/:orgId/branches/:branchId/resource-groups/:groupId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const group = await archiveResourceGroup(orgId, getParam(request.params, "groupId"), expectedRevision(request));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), archived: true, resource_group: group, group };
  });

  app.put("/organizations/:orgId/branches/:branchId/resource-groups/:groupId/members/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const body = resourceGroupMemberMutationSchema.parse(request.body ?? {});
    const group = await putResourceGroupMember(orgId, getParam(request.params, "groupId"), getParam(request.params, "userId"), body);
    return { ok: true, branch_id: branchId, resource_group: group, group };
  });

  app.delete("/organizations/:orgId/branches/:branchId/resource-groups/:groupId/members/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceMutation(request, orgId);
    const group = await removeResourceGroupMember(orgId, getParam(request.params, "groupId"), getParam(request.params, "userId"), expectedRevision(request));
    return { ok: true, branch_id: branchId, resource_group: group, group };
  });

  app.get("/organizations/:orgId/branches/:branchId/assignable-resources", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceRead(request, orgId);
    await migrateLegacyLaborCrews(orgId, branchId);
    const result = await listAssignableResources(orgId, branchId, queryObject(request));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), ...result, count: result.resources.length };
  });

  app.post("/organizations/:orgId/branches/:branchId/assignable-subjects/resolve", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requireWorkforceRead(request, orgId);
    await migrateLegacyLaborCrews(orgId, branchId);
    const body = objectSchema.parse(request.body ?? {});
    const result = await resolveAssignableSubjects(orgId, branchId, body.policy || body.assignment_policy, asObject(body.options));
    return { ok: true, ...(await settingsPayload(orgId, branchId)), ...result, count: result.subjects.length };
  });
};
