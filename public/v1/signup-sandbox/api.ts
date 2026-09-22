import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";

import { authContextFromRequest, publicAuthContext, rememberPlatformAccount, setPlatformAuthCookies } from "../platform/auth.js";
import { gatedAccounts, experimentalAdmin, loginExperimentalAdmin, logoutExperimentalAdmin, requireAdminOrigin } from "./admin.js";
import { loginPlatformIdentity } from "../platform/auth.js";
import { env } from "../src/config/env.js";
import {
  applyStageEffects,
  completeStage,
  computeSettingsProjection,
  findInstanceByOrg,
  instanceRunState,
  createPage,
  createPageVariant,
  createTestInstance,
  createWorkflow,
  deletePage,
  deleteTestOrg,
  deleteWorkflow,
  duplicateWorkflow,
  ensureSeedData,
  exportLibraryBundle,
  exportWorkflowBundle,
  importBundle,
  resolveWorkflowRunContext,
  updatePage,
  updateWorkflow
} from "./service.js";
import { sandboxStore, type JsonObject } from "./storage.js";

function body(request: FastifyRequest): JsonObject {
  return (request.body ?? {}) as JsonObject;
}

function param(request: FastifyRequest, key: string): string {
  return String(((request.params ?? {}) as Record<string, unknown>)[key] ?? "");
}

// The signup sandbox is a development-only tool: it mints pre-authenticated
// test organizations with a fixed password, so it must never ship live.
export const registerSignupSandboxApi: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (request, reply) => {
    if (env.isProduction) {
      return reply.code(404).send({ ok: false, error: "Not found." });
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!gatedAccounts()) return;
    requireAdminOrigin(request);
    if (request.routeOptions.url?.endsWith("/admin/login")) return;
    await experimentalAdmin(request);
  });
  app.post("/admin/login", loginExperimentalAdmin);
  app.get("/admin/session", async (request) => ({ ok: true, ...(await experimentalAdmin(request)) }));
  app.post("/admin/logout", async (_request, reply) => logoutExperimentalAdmin(reply));
  app.post("/test-orgs/:id/login", async (request, reply) => {
    const record = await sandboxStore.readTestOrg(param(request, "id"));
    if (!record) return reply.code(404).send({ ok: false, error: "Test organization not found." });
    const ctx = await loginPlatformIdentity({ email: String(record.email), password: String(record.password), organizationId: String(record.org_id), metadata: { source: "experimental_admin" } });
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    await rememberPlatformAccount(request, reply, ctx);
    return { ok: true, redirect: "/portal/" };
  });

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; code?: string; message?: string };
    const statusCode = Number(err.statusCode) || 500;
    void reply.code(statusCode >= 400 && statusCode < 600 ? statusCode : 500).send({
      ok: false,
      code: err.code || "sandbox_error",
      error: err.message || "Signup sandbox request failed."
    });
  });

  app.get("/state", async () => {
    await ensureSeedData();
    return {
      ok: true,
      workflows: await sandboxStore.listWorkflows(),
      pages: await sandboxStore.listPages(),
      test_orgs: await sandboxStore.listTestOrgs()
    };
  });

  // Workflows
  app.post("/workflows", async (request) => ({ ok: true, workflow: await createWorkflow(body(request)) }));
  app.patch("/workflows/:id", async (request) => ({ ok: true, workflow: await updateWorkflow(param(request, "id"), body(request)) }));
  app.delete("/workflows/:id", async (request) => ({ ok: true, ...(await deleteWorkflow(param(request, "id"))) }));
  app.post("/workflows/:id/duplicate", async (request) => ({ ok: true, workflow: await duplicateWorkflow(param(request, "id"), body(request)) }));
  app.get("/workflows/:id/export", async (request) => ({ ok: true, bundle: await exportWorkflowBundle(param(request, "id")) }));
  app.get("/workflows/:id/run-context", async (request) => ({ ok: true, ...(await resolveWorkflowRunContext(param(request, "id"))) }));
  app.get("/workflows/:id/projection", async (request) => ({ ok: true, projection: await computeSettingsProjection(param(request, "id")) }));

  // Pages
  app.post("/pages", async (request) => ({ ok: true, page: await createPage(body(request)) }));
  app.post("/pages/:id/variant", async (request) => ({ ok: true, page: await createPageVariant(param(request, "id"), body(request)) }));
  app.patch("/pages/:id", async (request) => ({ ok: true, page: await updatePage(param(request, "id"), body(request)) }));
  app.delete("/pages/:id", async (request) => ({
    ok: true,
    ...(await deletePage(param(request, "id"), { force: String((request.query as JsonObject)?.force ?? "") === "true" }))
  }));

  // Library export / import
  app.get("/export", async () => ({ ok: true, bundle: await exportLibraryBundle() }));
  app.post("/import", async (request) => {
    const input = body(request);
    const bundle = (input.bundle ?? input) as JsonObject;
    return { ok: true, summary: await importBundle(bundle, { overwrite: input.overwrite === true }) };
  });

  // Test instances: creates a fresh org and logs the browser in as it.
  app.post("/workflows/:id/instances", async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await createTestInstance(param(request, "id"), body(request));
    setPlatformAuthCookies(request, reply, result.authContext.sessionId, result.authContext.csrfToken);
    await rememberPlatformAccount(request, reply, result.authContext);
    return {
      ok: true,
      test_org: result.testOrg,
      redirect: result.redirect,
      auth: publicAuthContext(result.authContext)
    };
  });

  // Powers the dev bar injected into the real portal: resolves the session's
  // org to a sandbox instance (null for non-test orgs, so the bar no-ops).
  app.get("/current-instance", async (request) => {
    const ctx = await authContextFromRequest(request).catch(() => null);
    if (!ctx) return { ok: true, instance: null };
    const record = await findInstanceByOrg(String(ctx.orgId));
    if (!record) return { ok: true, instance: null };
    return { ok: true, instance: await instanceRunState(String(record.id)) };
  });

  app.get("/test-orgs/:id/run-state", async (request) => ({ ok: true, instance: await instanceRunState(param(request, "id")) }));
  app.post("/test-orgs/:id/complete-stage/:stageId", async (request) => ({
    ok: true,
    ...(await completeStage(param(request, "id"), param(request, "stageId"), body(request)))
  }));
  app.post("/test-orgs/:id/apply-stage/:stageId", async (request) => ({
    ok: true,
    ...(await applyStageEffects(param(request, "id"), param(request, "stageId")))
  }));
  app.get("/test-orgs", async () => ({ ok: true, test_orgs: await sandboxStore.listTestOrgs() }));
  app.delete("/test-orgs/:id", async (request) => ({ ok: true, ...(await deleteTestOrg(param(request, "id"))) }));
};
