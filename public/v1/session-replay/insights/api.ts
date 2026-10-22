import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { readInternalUser } from "../../internal/storage.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { forbidden } from "../../platform/errors.js";
import { callTool, toolManifest } from "./tools.js";

/**
 * Session replay search routes, under /v1/platform (docs/architecture/session-replay-search.md). Platform
 * administrators only, like replays themselves: the index holds what every member saw and did.
 */
const text = (value: unknown) => String(value ?? "").trim();

async function requireReplayAdmin(request: FastifyRequest, csrf = false) {
  const ctx = await requirePlatformAuth(request, { csrf });
  const email = text(ctx.identity.email).toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) : null;
  const permissions = (user?.permissions && typeof user.permissions === "object" ? user.permissions : {}) as Record<string, unknown>;
  const admin = user && !user.disabled && user.status === "active" && (["admin", "system_admin"].includes(text(user.role).toLowerCase())
    || user.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true);
  if (!admin) throw forbidden("platform_admin_required", "Only platform administrators can search session replays.");
  return ctx;
}

export async function registerSessionReplayInsightsRoutes(app: FastifyInstance) {
  app.get("/session-replay/insights/tools", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    return { ok: true, ...toolManifest() };
  });

  app.post("/session-replay/insights/call", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request, true);
    const body = z.object({ tool: z.string().min(1).max(60), input: z.unknown().optional() }).strict().parse(request.body ?? {});
    const origin = `${request.protocol}://${request.headers.host || "dev.1m8.ai"}`;
    const result = await callTool(body.tool, body.input ?? {}, { origin });
    return { ok: !(result && typeof result === "object" && "error" in (result as object)), tool: body.tool, result };
  });
}
