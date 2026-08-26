import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z, ZodError } from "zod";

import { PlatformError } from "../platform/errors.js";
import { asObject, type JsonObject } from "../internal/storage.js";
import {
  beginGmailConnect,
  debugSnapshot,
  disconnectGmail,
  finishGmailConnect,
  gmailConnectionStatus,
  legacyGmailAction,
  sendGmailMessage,
  syncMailboxForActor
} from "./gmail.js";

const objectSchema = z.object({}).passthrough();

export const registerCommunicationsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, success: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, success: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, success: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    success: true,
    api: "communications",
    providers: ["gmail"],
    routes: {
      gmail_status: "/gmail/status",
      gmail_connect: "/gmail/oauth/begin",
      gmail_callback: "/gmail/oauth/callback",
      gmail_disconnect: "/gmail/disconnect",
      gmail_sync: "/gmail/sync",
      gmail_debug: "/gmail/debug",
      gmail_send: "/gmail/send"
    }
  }));

  app.get("/gmail/status", async (request) => {
    const actor = actorFromRequest(request);
    return { ok: true, success: true, gmail: await gmailConnectionStatus(actor.email) };
  });

  app.post("/gmail/status", async (request) => {
    const actor = actorFromRequest(request, objectSchema.parse(request.body ?? {}));
    return { ok: true, success: true, gmail: await gmailConnectionStatus(actor.email) };
  });

  app.get("/gmail/oauth/begin", async (request, reply) => {
    const actor = actorFromRequest(request, asObject(request.query));
    const url = await beginGmailConnect(actor.email, publicBaseUrl(request));
    return reply.redirect(url);
  });

  app.post("/gmail/oauth/begin", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    const actor = actorFromRequest(request, body);
    return { ok: true, success: true, url: await beginGmailConnect(actor.email, publicBaseUrl(request)) };
  });

  app.get("/gmail/oauth/callback", async (request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    return await finishGmailConnect(asObject(request.query));
  });

  app.post("/gmail/disconnect", async (request) => {
    const actor = actorFromRequest(request, objectSchema.parse(request.body ?? {}));
    return await disconnectGmail(actor.email);
  });

  app.post("/gmail/sync", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    const actor = actorFromRequest(request, body);
    const sync = await syncMailboxForActor(actor.email, body);
    return { ok: true, success: true, sync, gmail: await gmailConnectionStatus(actor.email) };
  });

  app.post("/gmail/debug", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    const actor = actorFromRequest(request, body);
    return {
      ok: true,
      success: true,
      debug: await debugSnapshot(actor.email, String(body.mailbox_key ?? ""), Math.max(25, Math.min(300, Number(body.limit ?? 150) || 150)))
    };
  });

  app.post("/gmail/send", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    const actor = actorFromRequest(request, body);
    return await sendGmailMessage(actor.email, body);
  });
};

export async function handleCommunicationsLegacyAction(action: string, body: JsonObject, request: FastifyRequest) {
  const actor = actorFromRequest(request, body);
  return await legacyGmailAction(action, body, actor.email);
}

function actorFromRequest(request: FastifyRequest, body: JsonObject = {}) {
  const headers = request.headers;
  const email = String(
    body.actor_email
      ?? headers["x-internal-user-email"]
      ?? headers["x-platform-user-email"]
      ?? headers["x-user-email"]
      ?? ""
  ).trim().toLowerCase();
  return {
    email,
    name: String(body.actor_name ?? headers["x-internal-user-name"] ?? email),
    role: String(body.actor_role ?? headers["x-internal-user-role"] ?? "user")
  };
}

function publicBaseUrl(request: FastifyRequest) {
  const proto = String(request.headers["x-forwarded-proto"] ?? (request.protocol || "http")).split(",")[0]?.trim() || "http";
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? `127.0.0.1:${process.env.V1_PORT ?? 3111}`).split(",")[0]?.trim();
  return `${proto}://${host}/v1`;
}
