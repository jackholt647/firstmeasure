import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { badRequest } from "../../platform/errors.js";
import { requirePlatformAuth, type PlatformAuthContext } from "../../platform/auth.js";
import { DOCUMENT_CAPABILITIES } from "../capability_policy.js";
import { readDocumentInstance } from "../storage.js";
import {
  appendCollabCommands,
  attachCollabStream,
  updateCollabPresence,
  type CollabActor,
  type JsonObject
} from "./service.js";

/**
 * Collab routes for the document engine (Tranche E, phase 1).
 *
 * Wired into documents/api.ts by the integrator — the routes are declared
 * relative to the plugin instance, so mounting inside registerDocumentsApi
 * (prefix /v1/documents) yields:
 *
 *   GET  /v1/documents/:documentId/collab/stream
 *   POST /v1/documents/:documentId/collab/commands
 *   POST /v1/documents/:documentId/collab/presence
 *
 * Auth mirrors the other document routes (platform session + documents app
 * capability + view_projects). There is no :orgId segment here: the org comes
 * from the session, and readDocumentInstance() 404s for any document outside
 * it, so a user can only join documents in their own organization.
 */

export type CollabRouteDeps = {
  requireAuth?: typeof requirePlatformAuth;
  readDocument?: typeof readDocumentInstance;
};

const collabCursorSchema = z
  .object({
    node_id: z.string().min(1).max(200).nullish(),
    block_id: z.string().min(1).max(200).nullish(),
    offset: z.number().int().min(0).nullish()
  })
  .nullish();

const collabSelectionSchema = z
  .object({
    anchor: collabCursorSchema,
    focus: collabCursorSchema,
    node_id: z.string().min(1).max(200).nullish(),
    block_ids: z.array(z.string().min(1).max(200)).max(200).optional()
  })
  .nullish();

const collabCommandSchema = z.object({ type: z.string().min(1).max(120) }).passthrough();

const collabCommandsBodySchema = z.object({
  base_revision: z.number().int().min(0),
  commands: z.array(collabCommandSchema).min(1).max(500),
  actor_cursor: collabCursorSchema
});

const collabPresenceBodySchema = z.object({
  cursor: collabCursorSchema,
  selection: collabSelectionSchema
});

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

/** Validation errors surface as 400s with the shared error shape even when the
 *  parent plugin's ZodError handler is not installed. */
function parseBody<Schema extends z.ZodTypeAny>(schema: Schema, value: unknown): z.infer<Schema> {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw badRequest("validation_error", "The request body is invalid.", parsed.error.issues);
  }
  return parsed.data;
}

function actorFromContext(ctx: PlatformAuthContext): CollabActor {
  const user = asObject(ctx.user);
  return {
    id: ctx.userId,
    name: cleanText(user.name) || cleanText(asObject(ctx.identity).name) || "Someone",
    email: cleanText(user.email) || cleanText(asObject(ctx.identity).email)
  };
}

export function registerCollabRoutes(app: FastifyInstance, deps: CollabRouteDeps = {}) {
  const requireAuth = deps.requireAuth ?? requirePlatformAuth;
  const readDocument = deps.readDocument ?? readDocumentInstance;

  /** Session auth + org scoping: the document must live in the session's org. */
  async function authorize(request: FastifyRequest, options: { csrf?: boolean } = {}) {
    const ctx = await requireAuth(request, {
      permission: "view_projects",
      capability: DOCUMENT_CAPABILITIES.app,
      csrf: options.csrf
    });
    const documentId = getParam(request.params, "documentId");
    // Throws document_not_found (404) when the id is missing or belongs to
    // another organization — collab never confirms foreign documents exist.
    await readDocument(ctx.orgId, documentId);
    return { ctx, documentId };
  }

  app.get("/:documentId/collab/stream", async (request, reply) => {
    const { ctx, documentId } = await authorize(request);
    (await attachCollabStream(request, reply, {
      orgId: ctx.orgId,
      docId: documentId,
      actor: actorFromContext(ctx)
    }));
  });

  app.post("/:documentId/collab/commands", async (request, reply) => {
    const { ctx, documentId } = await authorize(request, { csrf: true });
    const body = parseBody(collabCommandsBodySchema, request.body);
    const result = (await appendCollabCommands(ctx.orgId, documentId, actorFromContext(ctx), {
      base_revision: body.base_revision,
      commands: body.commands,
      ...(body.actor_cursor !== undefined ? { actor_cursor: (body.actor_cursor ?? null) as JsonObject | null } : {})
    }));
    if (!result.ok) reply.code(409);
    return result;
  });

  app.post("/:documentId/collab/presence", async (request) => {
    const { ctx, documentId } = await authorize(request, { csrf: true });
    const body = parseBody(collabPresenceBodySchema, request.body);
    const presence = (await updateCollabPresence(ctx.orgId, documentId, actorFromContext(ctx), {
      ...(body.cursor !== undefined ? { cursor: (body.cursor ?? null) as JsonObject | null } : {}),
      ...(body.selection !== undefined ? { selection: (body.selection ?? null) as JsonObject | null } : {})
    }));
    return { ok: true, presence };
  });
}
