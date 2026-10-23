import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { PlatformError } from "../../platform/errors.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { DOCUMENT_CAPABILITIES } from "../capability_policy.js";
import { readDocumentInstance } from "../storage.js";
import {
  diffAssetRevisions,
  diffDocumentRevisions,
  listAssetRevisions,
  listDocumentRevisions,
  markDocumentRevision,
  readDocumentRevision,
  restoreDocumentRevision,
  viewDocumentRevision
} from "./service.js";

/**
 * Document history routes (docs/architecture/document-history.md). Each is
 * served in the compact shape (organization from the session) and with the
 * explicit organization segment:
 *
 *   GET  /v1/documents/:documentId/revisions                      list, newest first
 *   POST /v1/documents/:documentId/revisions                      name this version
 *   GET  /v1/documents/:documentId/revisions/:seq                 state + editable definition
 *   GET  /v1/documents/:documentId/revisions/:seq/view            what it looked like
 *   GET  /v1/documents/:documentId/revisions/:seq/diff/:otherSeq  readable changes (either may be "current")
 *   POST /v1/documents/:documentId/revisions/:seq/restore         put its content back as a new revision
 *   GET  /v1/documents/history/:kind/:assetId/revisions[/:seq/diff/:otherSeq]   templates, themes, workflows
 */

const markSchema = z.object({ label: z.string().max(200).optional(), name: z.string().max(200).optional() }).passthrough();

function param(params: unknown, key: string) {
  return String((params as Record<string, unknown> | undefined)?.[key] ?? "").trim();
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
    return reply.send({ ok: false, error: String((error as { code?: unknown }).code ?? "request_error"), message: String((error as { message?: unknown }).message ?? "The request could not be processed.") });
  }
  app.log.error(error);
  reply.code(500);
  return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
}

/** Registered inside the documents plugin, which is mounted at /v1/documents; `prefix` is relative to that. */
export function registerVersionRoutes(app: FastifyInstance, options: { prefix?: string } = {}) {
  const base = (options.prefix ?? "").replace(/\/+$/, "");

  async function auth(request: FastifyRequest, write = false) {
    const orgParam = param(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      ...(orgParam ? { orgId: orgParam } : {}),
      permission: "view_projects",
      capability: DOCUMENT_CAPABILITIES.app,
      ...(write ? { csrf: true, allowScopedPermission: true } : {})
    });
    const orgId = orgParam || ctx.orgId;
    const documentId = param(request.params, "documentId");
    if (documentId) {
      const { requireDocumentDepartmentAccess } = await import("../service.js");
      requireDocumentDepartmentAccess(ctx, await readDocumentInstance(orgId, documentId));
    }
    return { ctx, orgId, documentId };
  }

  type Handler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  const wrap = (handler: Handler): Handler => async (request, reply) => {
    try { return await handler(request, reply); } catch (error) { return sendError(app, reply, error); }
  };

  const list = wrap(async (request) => {
    const { orgId, documentId } = await auth(request);
    const { revisions } = await listDocumentRevisions(orgId, documentId);
    return { ok: true, revisions, count: revisions.length };
  });
  const mark = wrap(async (request, reply) => {
    const { ctx, orgId, documentId } = await auth(request, true);
    const body = markSchema.parse(request.body ?? {});
    const revision = await markDocumentRevision(orgId, documentId, { cut: "named", label: body.label || body.name || "", userId: ctx.userId });
    reply.code(201);
    return { ok: true, revision };
  });
  const read = wrap(async (request) => {
    const { orgId, documentId } = await auth(request);
    return { ok: true, ...(await readDocumentRevision(orgId, documentId, param(request.params, "seq"))) };
  });
  const view = wrap(async (request) => {
    const { orgId, documentId } = await auth(request);
    return { ok: true, ...(await viewDocumentRevision(orgId, documentId, param(request.params, "seq"))) };
  });
  const diff = wrap(async (request) => {
    const { orgId, documentId } = await auth(request);
    return { ok: true, diff: await diffDocumentRevisions(orgId, documentId, param(request.params, "seq"), param(request.params, "otherSeq")) };
  });
  const restore = wrap(async (request) => {
    const { ctx, orgId, documentId } = await auth(request, true);
    return { ok: true, ...(await restoreDocumentRevision(orgId, documentId, param(request.params, "seq"), ctx)) };
  });
  const assetList = wrap(async (request) => {
    const { orgId } = await auth(request);
    const revisions = await listAssetRevisions(orgId, param(request.params, "kind"), param(request.params, "assetId"));
    return { ok: true, revisions, count: revisions.length };
  });
  const assetDiff = wrap(async (request) => {
    const { orgId } = await auth(request);
    return { ok: true, diff: await diffAssetRevisions(orgId, param(request.params, "kind"), param(request.params, "assetId"), param(request.params, "seq"), param(request.params, "otherSeq")) };
  });

  for (const root of [base, `${base}/organizations/:orgId/documents`]) {
    app.get(`${root}/history/:kind/:assetId/revisions`, assetList);
    app.get(`${root}/history/:kind/:assetId/revisions/:seq/diff/:otherSeq`, assetDiff);
  }
  for (const root of [`${base}/:documentId`, `${base}/organizations/:orgId/documents/:documentId`]) {
    app.get(`${root}/revisions`, list);
    app.post(`${root}/revisions`, mark);
    app.get(`${root}/revisions/:seq`, read);
    app.get(`${root}/revisions/:seq/view`, view);
    app.get(`${root}/revisions/:seq/diff/:otherSeq`, diff);
    app.post(`${root}/revisions/:seq/restore`, restore);
  }
}
