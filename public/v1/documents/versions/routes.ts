import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { PlatformError } from "../../platform/errors.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { DOCUMENT_CAPABILITIES } from "../capability_policy.js";
import {
  CHECKPOINT_REASONS,
  createCheckpoint,
  diffCheckpoints,
  getCheckpoint,
  listCheckpoints
} from "./service.js";

/**
 * Version-history routes for document instances (roadmap Tranche D).
 *
 * Registered as a standalone plugin (registerVersionRoutes(app)) so the
 * integrator can mount it without touching the main documents plugin. Two
 * route shapes are served for each endpoint:
 *
 *   - the compact shape from the roadmap task, org resolved from the session:
 *       POST /v1/documents/:documentId/checkpoints
 *       GET  /v1/documents/:documentId/checkpoints
 *       GET  /v1/documents/:documentId/checkpoints/:checkpointId
 *       GET  /v1/documents/:documentId/checkpoints/:a/diff/:b
 *   - the sibling documents-API shape with the explicit org segment:
 *       .../organizations/:orgId/documents/:documentId/checkpoints[...]
 *
 * Auth mirrors the sibling document-instance routes: platform session with
 * the view_projects permission and the Documents app capability; writes also
 * require the CSRF header. Cross-org requests 404 (compact shape — the doc
 * simply is not in the caller's org) or 403 (explicit org segment mismatch),
 * matching platform conventions.
 */

const createCheckpointSchema = z.object({
  name: z.string().max(200).optional(),
  reason: z.enum(CHECKPOINT_REASONS as [string, ...string[]]).optional()
}).passthrough();

export type VersionRouteDeps = {
  /** Base path the routes hang off (default "/v1/documents"). */
  prefix?: string;
  /** Service overrides for tests/DI; defaults to the real service. */
  service?: Partial<{
    createCheckpoint: typeof createCheckpoint;
    listCheckpoints: typeof listCheckpoints;
    getCheckpoint: typeof getCheckpoint;
    diffCheckpoints: typeof diffCheckpoints;
  }>;
};

function param(params: unknown, key: string) {
  const value = (params as Record<string, unknown> | undefined)?.[key];
  return String(value ?? "").trim();
}

function sendError(app: FastifyInstance, reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    reply.code(400);
    return reply.send({ ok: false, error: "validation_error", issues: error.issues });
  }
  if (error instanceof PlatformError) {
    reply.code(error.statusCode);
    return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
  }
  if (typeof (error as { statusCode?: unknown })?.statusCode === "number") {
    reply.code(Number((error as { statusCode: number }).statusCode));
    return reply.send({
      ok: false,
      error: String((error as { code?: unknown }).code ?? "request_error"),
      message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
    });
  }
  app.log.error(error);
  reply.code(500);
  return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
}

export function registerVersionRoutes(app: FastifyInstance, deps: VersionRouteDeps = {}) {
  const base = (deps.prefix ?? "/v1/documents").replace(/\/+$/, "");
  const service = {
    createCheckpoint,
    listCheckpoints,
    getCheckpoint,
    diffCheckpoints,
    ...(deps.service ?? {})
  };

  /** Session auth per sibling document routes; org from the path when present. */
  async function auth(request: FastifyRequest, options: { write?: boolean } = {}) {
    const orgParam = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      ...(orgParam ? { orgId: orgParam } : {}),
      permission: "view_projects",
      capability: DOCUMENT_CAPABILITIES.app,
      ...(options.write ? { csrf: true } : {})
    });
    return { ctx, orgId: orgParam || ctx.orgId };
  }

  type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const wrap = (handler: Handler): Handler => async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      return sendError(app, reply, error);
    }
  };

  const createHandler = wrap(async (request, reply) => {
    const { ctx, orgId } = await auth(request, { write: true });
    const body = createCheckpointSchema.parse(request.body ?? {});
    const checkpoint = await service.createCheckpoint(orgId, param(request.params, "documentId"), {
      name: body.name,
      reason: body.reason
    }, ctx);
    reply.code(201);
    return { ok: true, checkpoint };
  });

  const listHandler = wrap(async (request) => {
    const { orgId } = await auth(request);
    const checkpoints = await service.listCheckpoints(orgId, param(request.params, "documentId"));
    return { ok: true, checkpoints, count: checkpoints.length };
  });

  const readHandler = wrap(async (request) => {
    const { orgId } = await auth(request);
    const checkpoint = await service.getCheckpoint(
      orgId,
      param(request.params, "documentId"),
      param(request.params, "checkpointId")
    );
    return { ok: true, checkpoint };
  });

  const diffHandler = wrap(async (request) => {
    const { orgId } = await auth(request);
    const documentId = param(request.params, "documentId");
    // Route params share the :checkpointId name with the single-checkpoint
    // read (find-my-way requires one param name per position); a/b naming in
    // the docs maps to checkpointId/otherId here.
    const a = param(request.params, "checkpointId");
    const b = param(request.params, "otherId");
    const diff = await service.diffCheckpoints(orgId, documentId, a, b);
    return { ok: true, a, b, diff };
  });

  for (const root of [`${base}/:documentId`, `${base}/organizations/:orgId/documents/:documentId`]) {
    app.post(`${root}/checkpoints`, createHandler);
    app.get(`${root}/checkpoints`, listHandler);
    app.get(`${root}/checkpoints/:checkpointId`, readHandler);
    app.get(`${root}/checkpoints/:checkpointId/diff/:otherId`, diffHandler);
  }
}
