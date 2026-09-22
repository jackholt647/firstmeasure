/* Day-routing API. Mounted on the /v1/platform prefix so the frontend
 * PlatformAPI client (whose base URL is /v1/platform) can call it directly.
 *
 * POST /organizations/:orgId/routing/optimize
 *   { event_type_id, date | window_start+window_end, branch_id?, apply?, keep_existing? }
 * Returns per-subject routes with travel legs; apply=true also writes the
 * assignments onto the project events.
 */

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { optimizeDayRouting } from "./service.js";

const optimizeBodySchema = z.object({
  event_type_id: z.string().min(1),
  date: z.string().optional(),
  window_start: z.string().optional(),
  window_end: z.string().optional(),
  branch_id: z.string().optional(),
  apply: z.boolean().optional(),
  keep_existing: z.boolean().optional()
}).passthrough();

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

export const registerRoutingApi: FastifyPluginAsync = async (app) => {
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

  app.post("/organizations/:orgId/routing/optimize", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const actor = await requirePlatformAuth(request, { orgId, permission: "manage_schedule|manage_projects", csrf: true });
    const body = optimizeBodySchema.parse(request.body ?? {});
    return await optimizeDayRouting(orgId, {
      event_type_id: body.event_type_id,
      date: body.date,
      window_start: body.window_start,
      window_end: body.window_end,
      branch_id: body.branch_id || actor.branchId || "default",
      apply: body.apply === true,
      keep_existing: body.keep_existing === true,
      actor: { userId: actor.userId }
    });
  });
};
