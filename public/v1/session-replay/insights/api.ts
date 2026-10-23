import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { readInternalUser } from "../../internal/storage.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../platform/errors.js";
import { bearerKey, createAccessKey, listAccessKeys, revokeAccessKey, verifyAccessKey } from "./keys.js";
import { handleMcp } from "./mcp.js";
import { callTool, toolManifest } from "./tools.js";

/**
 * Session replay search routes, under /v1/platform (docs/architecture/session-replay-search.md). The index holds
 * what every member saw and did, so callers are platform administrators, signed in, or a coding agent holding an
 * access key one of them created. A key reaches the tools and the MCP endpoint only; keys are managed by a
 * signed-in administrator.
 */
const text = (value: unknown) => String(value ?? "").trim();
type Caller = { kind: "admin"; email: string } | { kind: "key"; id: string; name: string };

async function requireReplayAdmin(request: FastifyRequest, csrf = false) {
  const ctx = await requirePlatformAuth(request, { csrf });
  const email = text(ctx.identity.email).toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) : null;
  const permissions = (user?.permissions && typeof user.permissions === "object" ? user.permissions : {}) as Record<string, unknown>;
  const admin = user && !user.disabled && user.status === "active" && (["admin", "system_admin"].includes(text(user.role).toLowerCase())
    || user.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true);
  if (!admin) throw forbidden("platform_admin_required", "Only platform administrators can search session replays.");
  return { ctx, email };
}

/** A bearer key when one is sent (no CSRF: it is not a cookie), otherwise a signed-in administrator. */
async function authorize(request: FastifyRequest, csrf: boolean): Promise<Caller> {
  const header = request.headers.authorization;
  if (header) {
    const key = bearerKey(header);
    const found = key ? await verifyAccessKey(key) : null;
    if (!found) throw unauthorized("invalid_replay_key", "This session replay access key is not valid, has expired or was revoked.");
    return { kind: "key", id: found.id, name: found.name };
  }
  const { email } = await requireReplayAdmin(request, csrf);
  return { kind: "admin", email };
}

const origin = (request: FastifyRequest) => `${request.protocol}://${request.headers.host || "dev.1m8.ai"}`;
const who = (caller: Caller) => caller.kind === "key" ? { replay_key: caller.id, replay_key_name: caller.name } : { replay_admin: caller.email };

export async function registerSessionReplayInsightsRoutes(app: FastifyInstance) {
  app.get("/session-replay/insights/tools", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await authorize(request, false);
    return { ok: true, ...toolManifest() };
  });

  app.post("/session-replay/insights/call", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const caller = await authorize(request, true);
    const body = z.object({ tool: z.string().min(1).max(60), input: z.unknown().optional() }).strict().parse(request.body ?? {});
    const started = Date.now();
    const result = await callTool(body.tool, body.input ?? {}, { origin: origin(request) });
    const ok = !(result && typeof result === "object" && "error" in (result as object));
    request.log.info({ ...who(caller), tool: body.tool, ms: Date.now() - started, ok }, "Session replay tool call");
    return { ok, tool: body.tool, result };
  });

  // MCP over Streamable HTTP, JSON responses only. Clients: Claude Code (`claude mcp add --transport http ...
  // --header "Authorization: Bearer <key>"`), Codex (`url` plus `bearer_token_env_var`), or any MCP client.
  app.post("/session-replay/mcp", { bodyLimit: 64 * 1024 }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const key = bearerKey(request.headers.authorization);
    const found = key ? await verifyAccessKey(key) : null;
    if (!found) {
      reply.header("WWW-Authenticate", 'Bearer realm="firstmate-session-replay"');
      throw unauthorized("invalid_replay_key", "Send a session replay access key as Authorization: Bearer <key>.");
    }
    const response = await handleMcp(request.body, {
      origin: origin(request),
      log: (tool, ms, ok) => request.log.info({ replay_key: found.id, replay_key_name: found.name, tool, ms, ok }, "Session replay MCP tool call")
    });
    if (response === null) return reply.code(202).send();
    return reply.type("application/json").send(response);
  });
  const noStream = async (_request: FastifyRequest, reply: FastifyReply) => reply.code(405).header("Allow", "POST")
    .send({ ok: false, error: "method_not_allowed", message: "This MCP endpoint answers POST requests with JSON; it offers no event stream or sessions." });
  app.get("/session-replay/mcp", noStream);
  app.delete("/session-replay/mcp", noStream);

  // Keys: a signed-in platform administrator only.
  app.get("/session-replay/insights/keys", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    await requireReplayAdmin(request);
    return { ok: true, keys: await listAccessKeys() };
  });

  app.post("/session-replay/insights/keys", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const { email } = await requireReplayAdmin(request, true);
    const body = z.object({ name: z.string().trim().min(1).max(120), days: z.number().int().min(1).max(365).optional() }).strict().parse(request.body ?? {});
    const created = await createAccessKey({ name: body.name, createdBy: email, days: body.days });
    request.log.info({ replay_admin: email, replay_key: created.id, replay_key_name: created.name }, "Session replay access key created");
    return { ok: true, key: created.key, access_key: { ...created, key: undefined } };
  });

  app.delete("/session-replay/insights/keys/:keyId", async (request) => {
    const { email } = await requireReplayAdmin(request, true);
    const keyId = text((request.params as Record<string, unknown>).keyId);
    if (!keyId) throw badRequest("missing_key", "A key id is required.");
    if (!(await revokeAccessKey(keyId, email))) throw notFound("replay_key_not_found", "No active key with that id.");
    request.log.info({ replay_admin: email, replay_key: keyId }, "Session replay access key revoked");
    return { ok: true, revoked: keyId };
  });
}
