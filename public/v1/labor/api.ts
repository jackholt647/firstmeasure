import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { forbidden, PlatformError } from "../platform/errors.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { archiveCrew, loadLaborSettings, saveLaborSettings, upsertCrew } from "./storage.js";

const bodySchema = z.object({}).passthrough();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

async function requireCrewManagementEnabled(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "crew_management"))) {
    throw forbidden("app_flag_disabled", "Crew management is not enabled for this organization.");
  }
}

export const registerLaborApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "labor",
    message: "labor API is mounted",
    terminology: {
      compensation_plan: "A labor rate set covering hourly, piece-rate, salary, or hybrid pay rules."
    }
  }));

  app.get("/organizations/:orgId/branch/:branchId/crews", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireCrewManagementEnabled(orgId);
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const result = await loadLaborSettings(orgId, getParam(request.params, "branchId") || "default");
    return { ok: true, ...result };
  });

  app.put("/organizations/:orgId/branch/:branchId/crews", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireCrewManagementEnabled(orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = bodySchema.parse(request.body ?? {});
    const result = await saveLaborSettings(orgId, getParam(request.params, "branchId") || "default", body.settings || body);
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/branch/:branchId/crews", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requireCrewManagementEnabled(orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = bodySchema.parse(request.body ?? {});
    const result = await upsertCrew(orgId, getParam(request.params, "branchId") || "default", body.crew || body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.patch("/organizations/:orgId/branch/:branchId/crews/:crewId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireCrewManagementEnabled(orgId);
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = bodySchema.parse(request.body ?? {});
    const result = await upsertCrew(orgId, getParam(request.params, "branchId") || "default", { ...asObject(body.crew || body), id: getParam(request.params, "crewId") });
    return { ok: true, ...result };
  });

  app.delete("/organizations/:orgId/branch/:branchId/crews/:crewId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requireCrewManagementEnabled(orgId);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const result = await archiveCrew(orgId, getParam(request.params, "branchId") || "default", getParam(request.params, "crewId"), ctx as unknown as Record<string, unknown>);
    return { ok: true, ...result };
  });
};
