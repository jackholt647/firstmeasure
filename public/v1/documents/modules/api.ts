import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth } from "../../platform/auth.js";
import { userPublicationContext } from "../../platform/publication/context.js";
import { PlatformError } from "../../platform/errors.js";
import { moduleBindingSchema } from "./schemas.js";
import { createModuleInstance, evaluateModuleInstance, freezeModuleInstance, generateModuleDocument, getModuleExports, listModuleInstances, listModules, moduleDefinition, publishModule, readModuleInstance, updateModuleInputs, moduleInstanceView, materializeModuleDocument, writeModuleExport } from "./service.js";
import { registerModuleDataProvider } from "./provider.js";
import { inspectModuleGraph, refreshModuleGraph } from "./dependencies.js";
import { updateModuleBindings, reconcileModuleCommand } from "./service.js";

const object = z.record(z.unknown());
const params = (request: FastifyRequest) => request.params as Record<string, string>;
export const registerDocumentModuleRoutes: FastifyPluginAsync = async app => {
  registerModuleDataProvider();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "module_input_invalid", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
    app.log.error(error); return reply.code(500).send({ error: "module_request_failed", message: "Module request failed." });
  });
  async function context(request: FastifyRequest, manage = false) {
    const auth = await requirePlatformAuth(request, { orgId: params(request).orgId!, permission: manage ? "manage_company_settings" : "view_projects", csrf: !["GET", "HEAD"].includes(request.method), capability: manage ? "documents.templates_studio" : "platform.documents" });
    return userPublicationContext(auth, { executionKind: "module" });
  }
  app.get("/organizations/:orgId/modules", async request => ({ modules: await listModules(await context(request)) }));
  app.post("/organizations/:orgId/modules", async request => {
    const body = z.object({ moduleId: z.string().optional(), definition: object }).parse(request.body);
    return { module: await publishModule(await context(request, true), body.definition, body.moduleId) };
  });
  app.get("/organizations/:orgId/modules/:moduleId", async request => ({ module: await moduleDefinition(await context(request), params(request).moduleId!, (request.query as { version?: string }).version) }));
  app.get("/organizations/:orgId/instances", async request => {
    const ctx = await context(request); const projectId = (request.query as { projectId?: string }).projectId;
    return { instances: (await listModuleInstances({ ...ctx, projectId })).map(instance => ({ id: instance.id, projectId: instance.projectId, moduleId: instance.moduleId, version: instance.version, kind: instance.kind, frozen: !!instance.frozen })) };
  });
  app.post("/organizations/:orgId/instances", async request => {
    const body = z.object({ moduleId: z.string(), version: z.string().optional(), codePolicy: z.enum(["live", "frozen"]).optional(), projectId: z.string(), inputs: object.optional(), bindings: z.record(moduleBindingSchema).optional() }).parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await createModuleInstance(ctx, body)) };
  });
  app.get("/organizations/:orgId/instances/:instanceId", async request => { const ctx = await context(request); return { instance: await moduleInstanceView(ctx, await readModuleInstance(ctx, params(request).instanceId!)) }; });
  app.get("/organizations/:orgId/instances/:instanceId/freshness", async request => inspectModuleGraph(await context(request), params(request).instanceId!));
  app.post("/organizations/:orgId/instances/:instanceId/refresh", async request => {
    const body = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(request.body);
    const ctx = await context(request);
    const result = await refreshModuleGraph(ctx, params(request).instanceId!, body.expectedRevision);
    return { instance: await moduleInstanceView(ctx, result.instance), refreshed: result.refreshed };
  });
  app.patch("/organizations/:orgId/instances/:instanceId/bindings", async request => {
    const body = z.object({ bindings: z.record(moduleBindingSchema), expectedRevision: z.number().int().positive() }).strict().parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await updateModuleBindings(ctx, params(request).instanceId!, body.bindings, body.expectedRevision)) };
  });
  app.patch("/organizations/:orgId/instances/:instanceId", async request => {
    const body = z.object({ inputs: object, expectedRevision: z.number().int().positive() }).parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await updateModuleInputs(ctx, params(request).instanceId!, body.inputs, body.expectedRevision)) };
  });
  for (const mode of ["evaluate", "command"] as const) app.post(`/organizations/:orgId/instances/:instanceId/${mode}`, async request => {
    const body = z.object({ expectedRevision: z.number().int().positive(), idempotencyKey: z.string().min(1).max(200).optional() }).parse(request.body);
    const ctx = await context(request);
    const result = await evaluateModuleInstance(ctx, params(request).instanceId!, { ...body, mode });
    return { instance: await moduleInstanceView(ctx, result.instance as Record<string, unknown>), execution: { id: result.execution.id, status: result.execution.status, mode: result.execution.mode } };
  });
  app.post("/organizations/:orgId/instances/:instanceId/freeze", async request => {
    const body = z.object({ expectedRevision: z.number().int().positive() }).parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await freezeModuleInstance(ctx, params(request).instanceId!, body.expectedRevision)) };
  });
  app.post("/organizations/:orgId/instances/:instanceId/reconcile", async request => {
    const body = z.object({ expectedRevision: z.number().int().positive(), executionId: z.string().min(1), note: z.string().trim().min(10).max(2000) }).strict().parse(request.body);
    const ctx = await context(request, true);
    return { instance: await moduleInstanceView(ctx, await reconcileModuleCommand(ctx, params(request).instanceId!, body.expectedRevision, body.executionId, body.note)) };
  });
  app.post("/organizations/:orgId/instances/:instanceId/generate", async request => {
    const body = z.object({ moduleId: z.string(), bindingName: z.string(), exportName: z.string(), policy: z.enum(["live", "frozen"]), inputs: object.optional() }).parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await generateModuleDocument(ctx, params(request).instanceId!, body)) };
  });
  app.post("/organizations/:orgId/instances/:instanceId/document", async request => {
    const body = z.object({ documentId: z.string().optional(), expectedDocumentRevision: z.number().int().positive().optional(), title: z.string().max(200).optional() }).parse(request.body || {});
    return materializeModuleDocument(await context(request), params(request).instanceId!, body);
  });
  app.get("/organizations/:orgId/instances/:instanceId/exports/:exportName", async request => getModuleExports(await context(request), params(request).instanceId!, params(request).exportName!));
  app.patch("/organizations/:orgId/instances/:instanceId/exports/:exportName", async request => {
    const body = z.object({ value: z.unknown(), expectedRevision: z.number().int().positive() }).parse(request.body);
    const ctx = await context(request);
    return { instance: await moduleInstanceView(ctx, await writeModuleExport(ctx, params(request).instanceId!, params(request).exportName!, body.value, body.expectedRevision)) };
  });
};
