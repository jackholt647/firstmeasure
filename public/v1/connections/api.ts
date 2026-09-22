import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { workforceConfigurationBundle } from "../workforce/service.js";
import { migrateLegacyLaborCrews } from "../workforce/legacy_migration.js";
import { organizationConnectionCreateSchema, organizationConnectionPatchSchema } from "./schemas.js";
import {
  archiveOrganizationConnection,
  createOrganizationConnection,
  listOrganizationConnections,
  patchOrganizationConnection,
  readOrganizationConnection
} from "./storage.js";

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

async function requireRead(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_company_settings" });
}

async function requireMutation(request: FastifyRequest, orgId: string) {
  return await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
}

async function settingsBundle(orgId: string, branchId: string) {
  const bundle = (await workforceConfigurationBundle(orgId, branchId));
  return {
    configuration: bundle.configuration,
    terminology: bundle.configuration.terminology
  };
}

export const registerConnectionsApi: FastifyPluginAsync = async (app) => {
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
    api: "connections",
    organization_connections: "/organizations/:orgId/organization-connections"
  }));

  app.get("/organizations/:orgId/organization-connections", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireRead(request, orgId);
    const query = queryObject(request);
    const branchId = cleanText(query.branch_id || query.branchId || "default");
    await migrateLegacyLaborCrews(orgId, branchId);
    const connections = (await listOrganizationConnections(orgId, query));
    return {
      ok: true,
      branch_id: branchId,
      organization_connections: connections,
      connections,
      count: connections.length,
      ...(await settingsBundle(orgId, branchId))
    };
  });

  app.post("/organizations/:orgId/organization-connections", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requireMutation(request, orgId);
    const body = organizationConnectionCreateSchema.parse(request.body ?? {});
    const connection = (await createOrganizationConnection(orgId, body));
    const branchId = Array.isArray(connection.branch_ids) && connection.branch_ids[0] ? String(connection.branch_ids[0]) : "default";
    reply.code(201);
    return { ok: true, organization_connection: connection, connection, ...(await settingsBundle(orgId, branchId)) };
  });

  app.get("/organizations/:orgId/organization-connections/:connectionId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireRead(request, orgId);
    await migrateLegacyLaborCrews(orgId, cleanText(queryObject(request).branch_id || "default"));
    const connection = (await readOrganizationConnection(orgId, getParam(request.params, "connectionId")));
    const branchId = Array.isArray(connection.branch_ids) && connection.branch_ids[0] ? String(connection.branch_ids[0]) : "default";
    return { ok: true, organization_connection: connection, connection, ...(await settingsBundle(orgId, branchId)) };
  });

  app.patch("/organizations/:orgId/organization-connections/:connectionId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireMutation(request, orgId);
    const body = organizationConnectionPatchSchema.parse(request.body ?? {});
    const connection = (await patchOrganizationConnection(orgId, getParam(request.params, "connectionId"), body));
    const branchId = Array.isArray(connection.branch_ids) && connection.branch_ids[0] ? String(connection.branch_ids[0]) : "default";
    return { ok: true, organization_connection: connection, connection, ...(await settingsBundle(orgId, branchId)) };
  });

  app.delete("/organizations/:orgId/organization-connections/:connectionId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireMutation(request, orgId);
    const connection = (await archiveOrganizationConnection(orgId, getParam(request.params, "connectionId"), expectedRevision(request)));
    const branchId = Array.isArray(connection.branch_ids) && connection.branch_ids[0] ? String(connection.branch_ids[0]) : "default";
    return { ok: true, archived: true, organization_connection: connection, connection, ...(await settingsBundle(orgId, branchId)) };
  });
};
