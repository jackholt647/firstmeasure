import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePlatformAuth } from "../auth.js";
import { PlatformError } from "../errors.js";
import { authorizePublication, userPublicationContext } from "./context.js";
import { listDataProviders, readPublishedData, listPublishedData } from "./providers.js";
import { listActions, invokeAction } from "./actions.js";
import { listDatasetTypes } from "./datasets.js";
import { initializePublication } from "./bootstrap.js";
import type { AccessPolicy, PublicationContext, TargetRef } from "./contracts.js";

const identity = z.string().min(1).max(200);
export const publicationTargetSchema = z.object({
  scope: z.enum(["global", "organization", "project"]), organizationId: identity.optional(),
  branchId: identity.optional(), projectId: identity.optional(), id: identity.optional()
}).strict();
export const publicationSourceSchema = z.object({
  provider: identity, version: identity.optional(), export: identity, target: publicationTargetSchema,
  args: z.record(z.unknown()).optional(), path: z.string().max(2000).optional(), revision: identity.optional()
}).strict();

export const registerPublicationApi: FastifyPluginAsync = async app => {
  initializePublication();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "publication_input_invalid", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    app.log.error(error);
    return reply.code(500).send({ error: "publication_failed", message: "The publication request failed." });
  });
  async function context(request: FastifyRequest, target?: TargetRef, command = false) {
    const { orgId } = request.params as { orgId: string };
    // Each published contract enforces its application and permission requirements.
    const auth = await requirePlatformAuth(request, { orgId, application: false, csrf: !["GET", "HEAD"].includes(request.method) });
    return userPublicationContext(auth, { ...(target?.projectId ? { projectId: target.projectId } : {}), mode: command ? "command" : "evaluate" });
  }
  async function discoverable(ctx: PublicationContext, target: TargetRef, policy: AccessPolicy, operation: string) {
    try { await authorizePublication(ctx, target, policy, operation); return true; }
    catch (error) { if (error instanceof PlatformError && [400, 403, 404].includes(error.statusCode)) return false; throw error; }
  }
  app.get("/organizations/:orgId/catalog", async request => {
    const query = z.object({ scope: z.enum(["global", "organization", "project"]).default("organization"), projectId: identity.optional(), branchId: identity.optional() }).parse(request.query);
    const ctx = await context(request);
    const target: TargetRef = { ...query, organizationId: ctx.organizationId };
    const providers = [];
    for (const provider of listDataProviders()) {
      const exports: Record<string, unknown> = {};
      for (const [name, entry] of Object.entries(provider.exports)) {
        if (await discoverable(ctx, target, entry.access, `${provider.id}.${name}`)) exports[name] = entry;
      }
      if (Object.keys(exports).length) providers.push({ ...provider, exports });
    }
    const actions = [];
    for (const action of listActions()) {
      if (action.executionKinds.includes("api") && await discoverable(ctx, target, action.policy, action.id)) actions.push(action);
    }
    // Discovery is a description, never permission to read or execute a particular resource.
    return { providers, actions, datasetTypes: listDatasetTypes() };
  });
  app.post("/organizations/:orgId/data/read", async request => {
    const source = publicationSourceSchema.parse(request.body);
    return readPublishedData(await context(request, source.target), source);
  });
  app.get("/organizations/:orgId/projects/:projectId/measurements", async request => {
    const { orgId, projectId } = request.params as { orgId: string; projectId: string };
    const target: TargetRef = { scope: "project", organizationId: orgId, projectId };
    const { effectiveProjectMeasurements } = await import("./firstmeasure-datasets.js");
    return effectiveProjectMeasurements(await context(request, target), projectId);
  });
  app.post("/organizations/:orgId/data/list", async request => {
    const body = z.object({ source: publicationSourceSchema, limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(8000).optional() }).strict().parse(request.body);
    return listPublishedData(await context(request, body.source.target), body.source, { limit: body.limit, cursor: body.cursor });
  });
  app.post("/organizations/:orgId/actions/invoke", async request => {
    const body = z.object({ action: identity, version: identity.optional(), target: publicationTargetSchema, input: z.record(z.unknown()), idempotencyKey: z.string().min(1).max(512).optional(), expectedImplementation: z.string().max(300).optional() }).strict().parse(request.body);
    const ctx = await context(request, body.target, true);
    return invokeAction(ctx, { action: body.action, ...(body.version ? { version: body.version } : {}), target: body.target }, body.input, { idempotencyKey: body.idempotencyKey, expectedImplementation: body.expectedImplementation });
  });
};
