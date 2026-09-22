import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import "./capabilities.js";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { readMediaFile, storeMediaUpload } from "../platform/storage.js";
import { transcribeAudio } from "../audio-notes/transcription.js";
import { audioMediaPublicUrl } from "../audio-notes/links.js";
import { pageSnapshotPublicUrl, validPageSnapshotToken } from "./links.js";
import {
  generateSuggestedReply,
  polishDraft,
  scheduleChatAgentTurn
} from "./agent.js";
import {
  chatLiveStatus,
  chatSettingsPayload,
  chatSuggestionsEnabled,
  captureOfflineDetails,
  claimConversation,
  closeConversation,
  conversationFeed,
  createOrResumeSession,
  inboxSnapshot,
  linkConversation,
  loadChatSettings,
  markConversationRead,
  presenceHeartbeat,
  publicWidgetConfig,
  recordVisitorMessage,
  releaseConversation,
  requireVisitor,
  resolveWidget,
  rotateChatWidgetKey,
  saveChatSettings,
  setAiHandling,
  startConversation,
  teamConversationDetail,
  teamMessageShape,
  teamSendMessage,
  teamTyping,
  visitorTyping
} from "./service.js";
import {
  chatSettingsSchema,
  polishSchema,
  publicOfflineDetailsSchema,
  publicSendMessageSchema,
  publicSessionSchema,
  publicStartConversationSchema,
  suggestSchema,
  teamLinkSchema,
  teamPresenceSchema,
  teamSendMessageSchema
} from "./schemas.js";
import { readConversationState } from "./storage.js";

function getParam(params: unknown, key: string) {
  const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
  return String(record[key] ?? "").trim();
}

function getQuery(request: FastifyRequest, key: string) {
  const record = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  return String(record[key] ?? "").trim();
}

function visitorTokenFromRequest(request: FastifyRequest) {
  const header = String(request.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function requestMeta(request: FastifyRequest) {
  return { ip: request.ip || "", user_agent: String(request.headers["user-agent"] || "") };
}

// --- Rate limiting (in-process fixed windows; single-host architecture) ----

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  if (buckets.size > 20_000) {
    for (const [id, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(id);
    }
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count += 1;
  if (bucket.count > max) {
    throw new PlatformError("rate_limited", 429, "Too many requests. Please slow down.", {
      retry_after_seconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    });
  }
}

export const registerChatApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      if (error.statusCode === 429) {
        const details = error.details as Record<string, unknown> | undefined;
        reply.header("Retry-After", String(details?.retry_after_seconds ?? 5));
      }
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, service: "chat" }));

  app.get("/public/page-snapshots/:orgId/:mediaId/:token", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const mediaId = getParam(request.params, "mediaId");
    if (!validPageSnapshotToken(orgId, mediaId, getParam(request.params, "token"))) {
      throw forbidden("invalid_page_snapshot_link", "This page snapshot link is invalid.");
    }
    const file = await readMediaFile(orgId, mediaId);
    if (!String(file.contentType).startsWith("image/")) throw badRequest("invalid_page_snapshot", "This attachment is not an image.");
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Length", String(file.bytes.length));
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("Content-Disposition", `inline; filename="${file.fileName.replace(/["\r\n]/g, "")}"`);
    return reply.send(file.bytes);
  });

  // ==== Public (widget) endpoints ==========================================

  app.get("/public/widgets/:widgetKey", async (request) => {
    rateLimit(`cfg:${request.ip}`, 60, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    return { ok: true, widget: await publicWidgetConfig(context) };
  });

  app.post("/public/widgets/:widgetKey/sessions", async (request, reply) => {
    rateLimit(`session:${request.ip}`, 12, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const body = publicSessionSchema.parse(request.body ?? {});
    const session = await createOrResumeSession(context, body, requestMeta(request));
    reply.code(201);
    return { ok: true, ...session };
  });

  app.post("/public/widgets/:widgetKey/conversations", async (request, reply) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`start:${token || request.ip}`, 6, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    rateLimit(`org:${context.orgId}`, 600, 60_000);
    const visitor = (await requireVisitor(context, token));
    const body = publicStartConversationSchema.parse(request.body ?? {});
    const result = await startConversation(context, visitor, body, { ...requestMeta(request), source: "website" });
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/public/widgets/:widgetKey/conversations/:conversationId/messages", async (request, reply) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`msg:${token || request.ip}`, 20, 60_000);
    rateLimit(`msgday:${token || request.ip}`, 400, 24 * 3600_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    rateLimit(`org:${context.orgId}`, 600, 60_000);
    const visitor = (await requireVisitor(context, token));
    const conversationId = getParam(request.params, "conversationId");
    const state = (await readConversationState(context.orgId, conversationId));
    if (String(state.visitor_id) !== String(visitor.id)) {
      throw new PlatformError("chat_visitor_unauthorized", 403, "This conversation belongs to a different visitor.");
    }
    if (state.closed_at) throw new PlatformError("chat_conversation_closed", 400, "This conversation is closed.");
    const body = publicSendMessageSchema.parse(request.body ?? {});
    const message = await recordVisitorMessage(context, visitor, state, body);
    reply.code(201);
    return { ok: true, message };
  });

  app.post("/public/widgets/:widgetKey/audio", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`audio:${token || request.ip}`, 10, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    const mode = String((context.settings.voice as Record<string, unknown> | undefined)?.mode || "attachment");
    if (mode === "off") throw new PlatformError("chat_voice_disabled", 403, "Voice messages are disabled.");
    const typed = request as unknown as {
      parts?: () => AsyncIterable<{ type: "file" | "field"; filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Voice recording must be multipart/form-data.");
    let bytes: Buffer | null = null;
    let fileName = "voice-message.webm";
    let contentType = "audio/webm";
    for await (const part of parts) {
      if (part.type !== "file" || bytes) continue;
      bytes = await part.toBuffer?.() ?? null;
      fileName = String(part.filename || fileName);
      contentType = String(part.mimetype || contentType).toLowerCase();
    }
    if (!bytes) throw badRequest("missing_audio", "An audio file is required.");
    if (!contentType.startsWith("audio/") || bytes.length > 20 * 1024 * 1024) {
      throw badRequest("invalid_audio", "Upload an audio recording no larger than 20 MB.");
    }
    const transcription = await transcribeAudio({ bytes, fileName, contentType });
    if (mode === "dictation") return { ok: true, transcription };
    const media = await storeMediaUpload(context.orgId, {
      bytes, fileName, contentType,
      ownerType: "chat_audio",
      ownerId: String(visitor.id),
      slot: "recording",
      scope: "live_chat",
      metadata: { widget_key: context.widgetKey }
    });
    return {
      ok: true,
      transcription,
      attachment: {
        media_id: media.id,
        file_name: media.file_name,
        content_type: media.content_type,
        size_bytes: media.size_bytes,
        public_url: audioMediaPublicUrl(context.orgId, String(media.id))
      }
    };
  });

  app.post("/public/widgets/:widgetKey/page-snapshots", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`snapshot:${token || request.ip}`, 30, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    if (!String(visitor.portal_customer_id || "").trim()) {
      throw forbidden("page_snapshot_portal_only", "Page snapshots are only available in the verified customer portal.");
    }
    const typed = request as unknown as {
      parts?: () => AsyncIterable<{ type: "file" | "field"; fieldname?: string; value?: unknown; filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer> }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Page snapshots must be multipart/form-data.");
    let bytes: Buffer | null = null;
    let contentType = "image/jpeg";
    let width = 0;
    let height = 0;
    for await (const part of parts) {
      if (part.type === "file" && !bytes) {
        bytes = await part.toBuffer?.() ?? null;
        contentType = String(part.mimetype || contentType).toLowerCase();
      } else if (part.type === "field" && part.fieldname === "width") width = Math.round(Number(part.value) || 0);
      else if (part.type === "field" && part.fieldname === "height") height = Math.round(Number(part.value) || 0);
    }
    if (!bytes) throw badRequest("missing_page_snapshot", "A page snapshot image is required.");
    if (!["image/jpeg", "image/png"].includes(contentType) || bytes.length > 1_500_000) {
      throw badRequest("invalid_page_snapshot", "Upload a JPEG or PNG page snapshot no larger than 1.5 MB.");
    }
    const media = await storeMediaUpload(context.orgId, {
      bytes,
      fileName: `customer-page-${Date.now()}.${contentType === "image/png" ? "png" : "jpg"}`,
      contentType,
      ownerType: "chat_page_snapshot",
      ownerId: String(visitor.id),
      slot: "page",
      scope: "live_chat",
      metadata: { widget_key: context.widgetKey, visitor_id: visitor.id }
    });
    return {
      ok: true,
      snapshot: {
        media_id: media.id,
        public_url: pageSnapshotPublicUrl(context.orgId, String(media.id)),
        content_type: contentType,
        ...(width > 0 && width <= 5000 ? { width } : {}),
        ...(height > 0 && height <= 5000 ? { height } : {})
      }
    };
  });

  app.get("/public/widgets/:widgetKey/conversations/:conversationId/feed", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`feed:${token || request.ip}`, 60, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    return { ok: true, ...(await conversationFeed(context, visitor, getParam(request.params, "conversationId"), getQuery(request, "after"))) };
  });

  app.post("/public/widgets/:widgetKey/conversations/:conversationId/typing", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`typing:${token || request.ip}`, 30, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    (await visitorTyping(context, visitor, getParam(request.params, "conversationId")));
    return { ok: true };
  });

  app.post("/public/widgets/:widgetKey/conversations/:conversationId/close", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`close:${token || request.ip}`, 10, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    const conversationId = getParam(request.params, "conversationId");
    const state = (await readConversationState(context.orgId, conversationId));
    if (String(state.visitor_id) !== String(visitor.id)) {
      throw new PlatformError("chat_visitor_unauthorized", 403, "This conversation belongs to a different visitor.");
    }
    await closeConversation(context.orgId, context.branchId, conversationId, "visitor");
    return { ok: true };
  });

  app.post("/public/widgets/:widgetKey/conversations/:conversationId/details", async (request) => {
    const token = visitorTokenFromRequest(request);
    rateLimit(`details:${token || request.ip}`, 10, 60_000);
    const context = await resolveWidget(getParam(request.params, "widgetKey"));
    const visitor = (await requireVisitor(context, token));
    const body = publicOfflineDetailsSchema.parse(request.body ?? {});
    return { ok: true, ...(await captureOfflineDetails(context, visitor, getParam(request.params, "conversationId"), body)) };
  });

  // ==== Authenticated (team) endpoints =====================================

  app.get("/organizations/:orgId/chat/inbox", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_live_chat", capability: "apps.live_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId);
    (await presenceHeartbeat(orgId, ctx, getQuery(request, "active")));
    const snapshot = await inboxSnapshot(orgId, ctx, settings, {
      status: getQuery(request, "status"),
      active: getQuery(request, "active"),
      after: getQuery(request, "after")
    });
    const suggestions = await chatSuggestionsEnabled(orgId, settings);
    return {
      ok: true,
      ...snapshot,
      features: {
        suggestions,
        claiming_mode: String((settings.claiming as Record<string, unknown> | undefined)?.mode || "presence"),
        voice: settings.voice
      }
    };
  });

  app.get("/organizations/:orgId/chat/conversations/:conversationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: "view_live_chat", capability: "apps.live_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId);
    const conversationId = getParam(request.params, "conversationId");
    (await presenceHeartbeat(orgId, ctx, conversationId));
    (await markConversationRead(orgId, ctx, conversationId));
    return { ok: true, ...(await teamConversationDetail(orgId, ctx, settings, conversationId)) };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/messages", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId);
    const body = teamSendMessageSchema.parse(request.body ?? {});
    const result = await teamSendMessage(orgId, ctx, settings, getParam(request.params, "conversationId"), body);
    reply.code(201);
    return { ok: true, message: teamMessageShape(result.message), state: result.state };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/claim", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId);
    const state = await claimConversation(orgId, ctx, settings, getParam(request.params, "conversationId"));
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/release", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const state = await releaseConversation(orgId, ctx, getParam(request.params, "conversationId"));
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/read", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_live_chat", capability: "apps.live_chat" });
    (await markConversationRead(orgId, ctx, getParam(request.params, "conversationId")));
    return { ok: true };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/typing", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    (await teamTyping(orgId, ctx, getParam(request.params, "conversationId")));
    return { ok: true };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/close", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const state = await closeConversation(orgId, ctx.branchId, getParam(request.params, "conversationId"), ctx.userId);
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/link", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const body = teamLinkSchema.parse(request.body ?? {});
    const conversation = await linkConversation(orgId, ctx, getParam(request.params, "conversationId"), body);
    return { ok: true, conversation };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/ai", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "apps.live_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId);
    const body = (request.body ?? {}) as Record<string, unknown>;
    const active = body.active === true;
    const state = await setAiHandling(orgId, ctx, settings, getParam(request.params, "conversationId"), active);
    if (active) scheduleChatAgentTurn(orgId, ctx.branchId, getParam(request.params, "conversationId"));
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/chat/conversations/:conversationId/suggest", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "live_chat.suggested_responses" });
    const body = suggestSchema.parse(request.body ?? {});
    const suggestion = await generateSuggestedReply(orgId, ctx.branchId, getParam(request.params, "conversationId"), body.hint || "");
    return { ok: true, suggestion };
  });

  app.post("/organizations/:orgId/chat/compose/polish", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "send_live_chat", capability: "live_chat.suggested_responses" });
    const body = polishSchema.parse(request.body ?? {});
    return { ok: true, ...(await polishDraft(orgId, ctx.branchId, body.text)) };
  });

  app.post("/organizations/:orgId/chat/presence", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_live_chat", capability: "apps.live_chat" });
    const body = teamPresenceSchema.parse(request.body ?? {});
    (await presenceHeartbeat(orgId, ctx, body.conversation_id || ""));
    const settings = await loadChatSettings(orgId, ctx.branchId);
    return { ok: true, live_status: (await chatLiveStatus(orgId, settings)) };
  });

  // ==== Settings ===========================================================

  app.get("/organizations/:orgId/branch/:branchId/chat/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    const ctx = await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const settings = await loadChatSettings(orgId, branchId);
    return { ok: true, ...(await chatSettingsPayload(orgId, branchId, settings, ctx)) };
  });

  app.put("/organizations/:orgId/branch/:branchId/chat/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = chatSettingsSchema.parse((request.body as Record<string, unknown>)?.data ?? request.body ?? {});
    return { ok: true, ...(await saveChatSettings(orgId, branchId, body, ctx)) };
  });

  app.post("/organizations/:orgId/branch/:branchId/chat/settings/rotate-key", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, ...(await rotateChatWidgetKey(orgId, branchId)) };
  });
};
