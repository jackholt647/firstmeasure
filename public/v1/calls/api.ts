import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { callsProviderStatus } from "./provider.js";
import * as service from "./service.js";

const createRoomSchema = z.object({
  context_type: z.string().trim().min(1).max(60),
  context_id: z.string().trim().min(1).max(180),
  thread_id: z.string().trim().max(180).optional(),
  title: z.string().trim().max(240).optional(),
  allow_video: z.boolean().default(true),
  recording_mode: z.enum(["off", "audio", "video"]).default("off"),
  settings: z.record(z.string(), z.unknown()).default({})
});

const mediaStateSchema = z.object({
  microphone_enabled: z.boolean().optional(),
  camera_enabled: z.boolean().optional(),
  screen_enabled: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0, "At least one media state is required.");

const signalSchema = z.object({
  sender_peer_id: z.string().trim().min(1).max(180),
  target_peer_id: z.string().trim().max(180).optional(),
  kind: z.enum(["hello", "offer", "answer", "ice", "bye"]),
  payload: z.record(z.string(), z.unknown()).default({})
});

const artifactSchema = z.object({
  kind: z.enum(["audio_recording", "video_recording", "transcript", "notes"]),
  media_id: z.string().trim().max(180).optional(),
  attachment_id: z.string().trim().max(180).optional(),
  provider_asset_id: z.string().trim().max(240).optional(),
  content_type: z.string().trim().max(160).optional(),
  duration_ms: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});

function param(params: unknown, key: string) {
  return String(params && typeof params === "object" ? (params as Record<string, unknown>)[key] ?? "" : "").trim();
}

function numberQuery(query: unknown, key: string, fallback = 0) {
  const value = Number(query && typeof query === "object" ? (query as Record<string, unknown>)[key] : fallback);
  return Number.isFinite(value) ? value : fallback;
}

export const registerCallsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) {
      return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  const auth = (request: Parameters<typeof requirePlatformAuth>[0], orgId: string, csrf = false) => requirePlatformAuth(request, {
    orgId,
    application: ["management", "field"],
    capability: "calls.rooms",
    csrf
  });

  app.get("/", async () => ({ ok: true, api: "calls", provider: callsProviderStatus() }));

  app.get("/provider-status", async () => ({ ok: true, provider: callsProviderStatus() }));

  app.post("/organizations/:orgId/rooms", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    const room = await service.createRoom(ctx, createRoomSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, room };
  });

  app.get("/organizations/:orgId/rooms/:roomId", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId);
    return { ok: true, room: (await service.getRoom(ctx, param(request.params, "roomId"))) };
  });

  app.post("/organizations/:orgId/rooms/:roomId/join", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    return { ok: true, room: await service.joinRoom(ctx, param(request.params, "roomId")) };
  });

  app.patch("/organizations/:orgId/rooms/:roomId/media-state", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    return {
      ok: true,
      room: (await service.updateMediaState(ctx, param(request.params, "roomId"), mediaStateSchema.parse(request.body ?? {})))
    };
  });

  app.post("/organizations/:orgId/rooms/:roomId/leave", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    return { ok: true, room: (await service.leaveRoom(ctx, param(request.params, "roomId"))) };
  });

  app.post("/organizations/:orgId/rooms/:roomId/end", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    return { ok: true, room: await service.endRoom(ctx, param(request.params, "roomId")) };
  });

  app.post("/organizations/:orgId/rooms/:roomId/signals", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    const signal = (await service.postSignal(ctx, param(request.params, "roomId"), signalSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, signal };
  });

  app.get("/organizations/:orgId/rooms/:roomId/signals", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const signals = (await service.listSignals(
      ctx,
      param(request.params, "roomId"),
      numberQuery(request.query, "after"),
      param(request.query, "peer_id")
    ));
    return { ok: true, signals, cursor: Math.max(numberQuery(request.query, "after"), ...signals.map((item) => Number(item.seq || 0))) };
  });

  app.post("/organizations/:orgId/rooms/:roomId/artifacts", async (request, reply) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId, true);
    const artifact = (await service.saveArtifact(ctx, param(request.params, "roomId"), artifactSchema.parse(request.body ?? {})));
    reply.code(201);
    return { ok: true, artifact };
  });

  app.get("/organizations/:orgId/rooms/:roomId/artifacts", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId);
    return { ok: true, artifacts: (await service.listArtifacts(ctx, param(request.params, "roomId"))) };
  });

  app.get("/organizations/:orgId/events", async (request) => {
    const orgId = param(request.params, "orgId");
    const ctx = await auth(request, orgId);
    return {
      ok: true,
      events: (await service.listEvents(ctx, {
        roomId: param(request.query, "room_id") || undefined,
        limit: numberQuery(request.query, "limit", 100)
      }))
    };
  });
};
