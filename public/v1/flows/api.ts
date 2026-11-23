import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { abandonRun, advanceRun, archiveFlow, backRun, canEditFlows, flowTemplates, listFlows, newMenuFlows, previewStep, readFlow, readRunView, runsFor, saveFlow, startRun } from "./service.js";

/**
 * Flow routes (docs/architecture/flows.md). Every route needs a signed-in person of the organization; what they may do
 * is checked in the service (editing: company settings or communications; playing: project access). A run is only
 * readable and playable by whoever started it, or someone who may edit flows.
 */
const param = (request: FastifyRequest, key: string) => String((request.params as Record<string, unknown>)[key] ?? "").trim();
const query = (request: FastifyRequest, key: string) => String((request.query as Record<string, unknown> | undefined)?.[key] ?? "").trim();

export const registerFlowsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) { reply.code(400); return reply.send({ ok: false, error: "validation_error", message: error.issues[0]?.message || "Invalid request.", issues: error.issues }); }
    if (error instanceof PlatformError) { reply.code(error.statusCode); return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null }); }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });
  const auth = (request: FastifyRequest) => requirePlatformAuth(request, { orgId: param(request, "orgId"), csrf: !["GET", "HEAD"].includes(request.method) });

  app.get("/", async () => ({ ok: true, api: "flows" }));

  app.get("/organizations/:orgId/flows", async (request) => {
    const ctx = await auth(request);
    return { ok: true, flows: await listFlows(ctx, { includeArchived: query(request, "archived") === "1" }), can_edit: canEditFlows(ctx), templates: canEditFlows(ctx) ? flowTemplates() : [] };
  });
  app.get("/organizations/:orgId/flows/new-menu", async (request) => ({ ok: true, flows: await newMenuFlows(await auth(request)) }));
  app.post("/organizations/:orgId/flows/preview", async (request) => {
    const ctx = await auth(request);
    const input = z.object({ definition: z.unknown(), step_id: z.string().optional(), answers: z.record(z.unknown()).optional() }).strict().parse(request.body ?? {});
    return { ok: true, ...previewStep(input.definition, input, ctx) };
  });
  app.get("/organizations/:orgId/flows/:flowId", async (request) => {
    const ctx = await auth(request);
    const version = Number(query(request, "version")) || undefined;
    return { ok: true, flow: await readFlow(ctx.orgId, param(request, "flowId"), { ...(version ? { version } : {}), latest: query(request, "latest") === "1" && canEditFlows(ctx) }) };
  });
  const saveBody = z.object({ definition: z.unknown(), publish: z.boolean().optional(), expected_version: z.number().int().min(0).optional() }).strict();
  app.post("/organizations/:orgId/flows", async (request, reply) => {
    const input = saveBody.extend({ id: z.string().max(80).optional() }).parse(request.body ?? {});
    reply.code(201);
    return { ok: true, flow: await saveFlow(await auth(request), input) };
  });
  app.put("/organizations/:orgId/flows/:flowId", async (request) => {
    const input = saveBody.parse(request.body ?? {});
    return { ok: true, flow: await saveFlow(await auth(request), { ...input, id: param(request, "flowId") }) };
  });
  app.post("/organizations/:orgId/flows/:flowId/archive", async (request) => {
    const input = z.object({ archived: z.boolean().default(true) }).strict().parse(request.body ?? {});
    return { ok: true, ...(await archiveFlow(await auth(request), param(request, "flowId"), input.archived)) };
  });

  app.get("/organizations/:orgId/runs", async (request) => ({ ok: true, runs: await runsFor(await auth(request), { flow_id: query(request, "flow_id"), project_id: query(request, "project_id") }) }));
  app.post("/organizations/:orgId/runs", async (request, reply) => {
    const input = z.object({ flow_id: z.string().min(1).max(80), source: z.unknown().optional() }).strict().parse(request.body ?? {});
    reply.code(201);
    return { ok: true, ...(await startRun(await auth(request), input)) };
  });
  app.get("/organizations/:orgId/runs/:runId", async (request) => ({ ok: true, ...(await readRunView(await auth(request), param(request, "runId"))) }));
  app.post("/organizations/:orgId/runs/:runId/steps/:stepId", async (request) => {
    const input = z.object({ answers: z.record(z.unknown()).default({}), revision: z.number().int().positive().optional() }).strict().parse(request.body ?? {});
    return { ok: true, ...(await advanceRun(await auth(request), param(request, "runId"), { step_id: param(request, "stepId"), ...input })) };
  });
  app.post("/organizations/:orgId/runs/:runId/back", async (request) => ({ ok: true, ...(await backRun(await auth(request), param(request, "runId"))) }));
  app.post("/organizations/:orgId/runs/:runId/abandon", async (request) => ({ ok: true, ...(await abandonRun(await auth(request), param(request, "runId"))) }));
};
