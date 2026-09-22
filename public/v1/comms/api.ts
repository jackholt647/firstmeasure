// HTTP surface for Project Comms — the unified per-project communications
// hub. Mounted at /v1/comms.

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import "./capabilities.js";
import "./instructions.js";
import "./definition.js";
import { registerCustomerCallsApi } from "./calls/api.js";
import { projectContext as customerCallProjectContext, manageCalls } from "./calls/service.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, forbidden } from "../platform/errors.js";
import {
  dispatchAutoReplyDraft,
  dismissAutoReplyDraft,
  orgCommsFeed,
  orgCommsInbox,
  orgConversationDetail,
  projectChatConversations,
  projectCommsFeed,
  projectCommsOverview,
  projectEmailThreadDetail,
  projectEmailThreads,
  projectSmsConversation,
  searchComms,
  sendProjectEmail,
  sendProjectSms,
  simulateProjectInbound
} from "./service.js";
import {
  createCommsTemplate,
  deleteCommsTemplate,
  listAutoReplyRecords,
  listCommsAgentThreads,
  listCommsAgentMessages,
  listCommsTemplates,
  updateCommsTemplate
} from "./storage.js";
import { COMMS_AGENT_ID } from "./definition.js";
import {
  createThreadForAgent,
  listThreadsForAgent,
  readThreadForAgent,
  runAgentTurn
} from "../agents/runtime.js";
import { importLegacyThreads } from "../agents/storage.js";
import { loadCommsSettings, saveCommsSettings, loadProjectCommsOverrides, saveProjectCommsOverrides } from "./settings.js";
import { loadChatSettings, teamSendMessage } from "../chat/service.js";

const objectSchema = z.object({}).passthrough();
const emailAddressListSchema = z.array(z.string().trim().min(1).max(500)).max(100);

const sendEmailSchema = z.object({
  to: z.union([z.string().trim().max(500), emailAddressListSchema]).optional(),
  cc: emailAddressListSchema.optional(),
  bcc: emailAddressListSchema.optional(),
  subject: z.string().trim().min(1).max(998),
  text: z.string().min(1).max(100_000),
  html: z.string().max(500_000).optional(),
  conversation_id: z.string().trim().max(180).optional(),
  idempotency_key: z.string().trim().max(500).optional()
});

const sendSmsSchema = z.object({
  to: z.union([z.string().trim().max(40), z.array(z.string().trim().min(1).max(40)).min(1).max(20)]).optional(),
  text: z.string().trim().min(1).max(1600),
  conversation_id: z.string().trim().max(180).optional(),
  idempotency_key: z.string().trim().max(500).optional(),
  audio_note: objectSchema.optional()
});

const simulateSchema = z.object({
  channel: z.enum(["email", "sms"]),
  text: z.string().trim().min(1).max(10_000),
  subject: z.string().trim().max(998).optional()
});

const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  channel: z.enum(["sms", "email"]),
  category: z.string().trim().max(80).optional().default(""),
  subject: z.string().trim().max(998).optional().default(""),
  body: z.string().min(1).max(100_000),
  variables: z.array(z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80)).max(50).optional().default([]),
  active: z.boolean().optional().default(true)
});

const templatePatchSchema = templateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "Provide at least one template field to update."
);

const VIEW_PERMISSION = "view_comms|view_projects|manage_projects|manage_company_settings";
const SEND_PERMISSION = "send_comms|send_communications|manage_projects|manage_company_settings";
const SETTINGS_PERMISSION = "manage_company_settings";
const PROJECT_SETTINGS_PERMISSION = "manage_projects|manage_company_settings";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function getParam(params: unknown, key: string) {
  const source = params && typeof params === "object" ? params as Record<string, unknown> : {};
  return cleanText(source[key]);
}

function getQuery(query: unknown, key: string) {
  const source = query && typeof query === "object" ? query as Record<string, unknown> : {};
  return cleanText(source[key]);
}

export const registerCommsApi: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler',async request=>{
    const projectId=getParam(request.params,'projectId');if(!projectId)return;
    const ctx=await requirePlatformAuth(request,{orgId:getParam(request.params,'orgId')});await customerCallProjectContext(ctx,projectId);
  });
  await app.register(registerCustomerCallsApi);
  // Create the FTS index + triggers at boot so every message written after
  // this point is indexed; pre-existing rows are backfilled once.
  const { getCommsDatabase } = await import("./storage.js");
  try { getCommsDatabase(); } catch (error) { app.log.error(error, "comms schema init failed"); }

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
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected comms error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "comms",
    endpoints: {
      overview: "/organizations/:orgId/projects/:projectId/overview",
      feed: "/organizations/:orgId/projects/:projectId/feed",
      search: "/organizations/:orgId/search",
      settings: "/organizations/:orgId/settings"
    }
  }));

  // ── Overview + feed ──────────────────────────────────────────────────────

  app.get("/organizations/:orgId/projects/:projectId/overview", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    await customerCallProjectContext(ctx,getParam(request.params,"projectId"));
    return { ok: true, overview: await projectCommsOverview(orgId, ctx.branchId || "default", getParam(request.params, "projectId")) };
  });

  app.get("/organizations/:orgId/projects/:projectId/feed", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    await customerCallProjectContext(ctx,getParam(request.params,"projectId"));
    return {
      ok: true,
      messages: (await projectCommsFeed(orgId, getParam(request.params, "projectId"), {
        channel: getQuery(request.query, "channel") || undefined,
        limit: Number(getQuery(request.query, "limit")) || undefined
      }))
    };
  });

  // ── Email ────────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/projects/:projectId/email/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.email" });
    return { ok: true, threads: (await projectEmailThreads(orgId, getParam(request.params, "projectId"))) };
  });

  app.get("/organizations/:orgId/projects/:projectId/email/threads/:conversationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.email" });
    return { ok: true, thread: (await projectEmailThreadDetail(orgId, getParam(request.params, "projectId"), getParam(request.params, "conversationId"))) };
  });

  app.post("/organizations/:orgId/projects/:projectId/email/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.email" });
    const body = sendEmailSchema.parse(request.body ?? {});
    const result = await sendProjectEmail(orgId, ctx.branchId || "default", getParam(request.params, "projectId"), {
      ...body,
      source: { type: "user", user_id: ctx.userId }
    }, ctx);
    return { ok: true, ...result };
  });

  // ── SMS ──────────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/projects/:projectId/sms", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.sms" });
    return {
      ok: true,
      ...(await projectSmsConversation(
        orgId,
        ctx.branchId || "default",
        getParam(request.params, "projectId"),
        getQuery(request.query, "conversation_id")
      ))
    };
  });

  app.post("/organizations/:orgId/projects/:projectId/sms/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.sms" });
    const body = sendSmsSchema.parse(request.body ?? {});
    const result = await sendProjectSms(orgId, ctx.branchId || "default", getParam(request.params, "projectId"), {
      ...body,
      source: { type: "user", user_id: ctx.userId }
    }, ctx);
    return { ok: true, ...result };
  });

  // ── Portal chat ──────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/projects/:projectId/chat", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.portal_chat" });
    const settings = await loadChatSettings(orgId, ctx.branchId || "default");
    return { ok: true, conversations: (await projectChatConversations(orgId, getParam(request.params, "projectId"))), voice: settings.voice };
  });

  app.post("/organizations/:orgId/projects/:projectId/chat/:conversationId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.portal_chat" });
    const body = objectSchema.parse(request.body ?? {});
    const settings = await loadChatSettings(orgId, ctx.branchId || "default");
    const result = await teamSendMessage(orgId, ctx, settings as never, getParam(request.params, "conversationId"), {
      message: String(body.message ?? body.text ?? ""),
      metadata: asObject(body.audio_note).media_id ? { audio_note: asObject(body.audio_note) } : undefined,
      idempotency_key: cleanText(body.idempotency_key) || undefined
    });
    return { ok: true, ...result };
  });

  // ── Search ───────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/search", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.search" });
    await customerCallProjectContext(ctx,getQuery(request.query,'project_id'));
    return {
      ok: true,
      results: (await searchComms(orgId, getQuery(request.query, "q"), {
        branch_id:manageCalls(ctx)?undefined:ctx.branchId||'default',
        project_id: getQuery(request.query, "project_id") || undefined,
        channel: getQuery(request.query, "channel") || undefined,
        limit: Number(getQuery(request.query, "limit")) || undefined
      }))
    };
  });

  // ── Settings ─────────────────────────────────────────────────────────────

  app.get("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    return { ok: true, settings: await loadCommsSettings(orgId, ctx.branchId || "default") };
  });

  app.put("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const settings = await saveCommsSettings(orgId, ctx.branchId || "default", body.settings ?? body);
    return { ok: true, settings };
  });

  // Reusable SMS/email copy. Templates are branch-scoped so local teams can
  // tune wording without changing another branch's customer communication.
  app.get("/organizations/:orgId/templates", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION });
    const channel = getQuery(request.query, "channel").toLowerCase();
    if (channel && !["sms", "email"].includes(channel)) {
      throw new PlatformError("invalid_template_channel", 400, "Template channel must be SMS or email.");
    }
    const activeQuery = getQuery(request.query, "active").toLowerCase();
    const active = activeQuery === "true" ? true : activeQuery === "false" ? false : undefined;
    return {
      ok: true,
      templates: (await listCommsTemplates(orgId, ctx.branchId || "default", {
        ...(channel ? { channel } : {}),
        ...(typeof active === "boolean" ? { active } : {})
      }))
    };
  });

  app.post("/organizations/:orgId/templates", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const input = templateSchema.parse(request.body ?? {});
    const template = (await createCommsTemplate(orgId, ctx.branchId || "default", input));
    reply.code(201);
    return { ok: true, template };
  });

  app.put("/organizations/:orgId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const input = templatePatchSchema.parse(request.body ?? {});
    const template = (await updateCommsTemplate(
      orgId,
      ctx.branchId || "default",
      getParam(request.params, "templateId"),
      input
    ));
    return { ok: true, template };
  });

  app.delete("/organizations/:orgId/templates/:templateId", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    (await deleteCommsTemplate(orgId, ctx.branchId || "default", getParam(request.params, "templateId")));
    reply.code(204);
    return reply.send();
  });

  app.get("/organizations/:orgId/projects/:projectId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    return { ok: true, overrides: await loadProjectCommsOverrides(orgId, getParam(request.params, "projectId")) };
  });

  app.put("/organizations/:orgId/projects/:projectId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: PROJECT_SETTINGS_PERMISSION, capability: "apps.comms" });
    const body = objectSchema.parse(request.body ?? {});
    const overrides = await saveProjectCommsOverrides(orgId, getParam(request.params, "projectId"), body.overrides ?? body);
    return { ok: true, overrides };
  });

  // ── AI agent ─────────────────────────────────────────────────────────────

  // Interactive comms-agent threads run on the centralized agent framework;
  // the focus project rides the framework thread's subject_id. Pre-framework
  // threads are imported lazily (marker-guarded, per org/project/user).
  async function importLegacyCommsThreads(orgId: string, projectId: string, userId: string) {
    (await importLegacyThreads({
      agentId: COMMS_AGENT_ID,
      marker: `comms_legacy_import:${orgId}:${projectId}:${userId}`,
      listThreads: async () => (await listCommsAgentThreads(orgId, projectId, userId, 100)),
      listMessages: async (threadId) => (await listCommsAgentMessages(orgId, threadId, 500)),
      subjectField: "project_id"
    }));
  }

  app.get("/organizations/:orgId/projects/:projectId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.agent" });
    const projectId = getParam(request.params, "projectId");
    (await importLegacyCommsThreads(orgId, projectId, ctx.userId));
    return { ok: true, threads: (await listThreadsForAgent(COMMS_AGENT_ID, orgId, { actorUserId: ctx.userId, subjectId: projectId })) };
  });

  app.post("/organizations/:orgId/projects/:projectId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: VIEW_PERMISSION, capability: "comms.agent" });
    const thread = (await createThreadForAgent(COMMS_AGENT_ID, {
      orgId,
      branchId: ctx.branchId || "default",
      subjectId: getParam(request.params, "projectId"),
      actorUserId: ctx.userId
    }));
    return { ok: true, thread };
  });

  app.get("/organizations/:orgId/projects/:projectId/agent/threads/:threadId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.agent" });
    (await importLegacyCommsThreads(orgId, getParam(request.params, "projectId"), ctx.userId));
    return { ok: true, ...(await readThreadForAgent(COMMS_AGENT_ID, orgId, getParam(request.params, "threadId"), ctx.userId)) };
  });

  app.post("/organizations/:orgId/projects/:projectId/agent/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: VIEW_PERMISSION, capability: "comms.agent" });
    const body = objectSchema.parse(request.body ?? {});
    const threadId = getParam(request.params, "threadId");
    (await readThreadForAgent(COMMS_AGENT_ID, orgId, threadId, ctx.userId));
    const result = await runAgentTurn(COMMS_AGENT_ID, {
      orgId,
      branchId: ctx.branchId || "default",
      threadId,
      message: String(body.message ?? body.text ?? ""),
      ctx,
      actorUserId: ctx.userId,
      subjectId: getParam(request.params, "projectId")
    });
    return { ok: true, ...result };
  });

  // ── Global communications center (org-wide inboxes) ─────────────────────

  app.get("/organizations/:orgId/inbox", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    return {
      ok: true,
      conversations: await orgCommsInbox(orgId, {
        user_id:ctx.userId,
        snoozed:getQuery(request.query,'snoozed')==='true',
        branch_id:manageCalls(ctx)?undefined:ctx.branchId||"default",
        channel: getQuery(request.query, "channel") || undefined,
        status: getQuery(request.query, "status") || undefined,
        limit: Number(getQuery(request.query, "limit")) || undefined
      })
    };
  });

  app.get("/organizations/:orgId/feed", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    return {
      ok: true,
      messages: (await orgCommsFeed(orgId, {
        branch_id:manageCalls(ctx)?undefined:ctx.branchId||"default",
        channel: getQuery(request.query, "channel") || undefined,
        limit: Number(getQuery(request.query, "limit")) || undefined
      }))
    };
  });

  app.get("/organizations/:orgId/conversations/:conversationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx=await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "apps.comms" });
    const conversation=(await orgConversationDetail(orgId,getParam(request.params,'conversationId')));
    if(!manageCalls(ctx)&&cleanText(asObject(conversation).branch_id||'default')!==(ctx.branchId||'default'))throw forbidden('conversation_branch_forbidden','This conversation belongs to another branch.');
    await customerCallProjectContext(ctx,cleanText(asObject(conversation).project_id));
    return { ok: true, conversation };
  });

  // Channel-appropriate reply on any conversation: email threads through the
  // org inbox, SMS goes out the business number, webchat rides the live-chat
  // team-send path (presence, read state, and widget delivery included).
  app.post("/organizations/:orgId/conversations/:conversationId/reply", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "apps.comms" });
    const body = objectSchema.parse(request.body ?? {});
    const conversationId = getParam(request.params, "conversationId");
    const detail = (await orgConversationDetail(orgId, conversationId)) as Record<string, unknown>;
    const channel = cleanText(detail.channel);
    const projectId = cleanText(detail.project_id);
    const text = String(body.message ?? body.text ?? "");
    if (channel === "webchat") {
      const settings = await loadChatSettings(orgId, ctx.branchId || "default");
      const result = await teamSendMessage(orgId, ctx, settings as never, conversationId, {
        message: text,
        metadata: asObject(body.audio_note).media_id ? { audio_note: asObject(body.audio_note) } : undefined,
        idempotency_key: cleanText(body.idempotency_key) || undefined
      });
      return { ok: true, ...result };
    }
    if (channel === "sms") {
      if (!projectId) throw new PlatformError("conversation_project_missing", 400, "This text conversation is not linked to a project yet.");
      const result = await sendProjectSms(orgId, ctx.branchId || "default", projectId, {
        text,
        audio_note: asObject(body.audio_note),
        idempotency_key: cleanText(body.idempotency_key) || undefined
      }, ctx);
      return { ok: true, ...result };
    }
    if (!projectId) throw new PlatformError("conversation_project_missing", 400, "This email conversation is not linked to a project yet.");
    const result = await sendProjectEmail(orgId, ctx.branchId || "default", projectId, {
      subject: cleanText(body.subject) || `Re: ${cleanText(detail.subject) || "your message"}`.replace(/^Re: Re:/i, 'Re:'),
      text,
      conversation_id: conversationId,
      idempotency_key: cleanText(body.idempotency_key) || undefined
    }, ctx);
    return { ok: true, ...result };
  });

  // ── AI auto-reply drafts ─────────────────────────────────────────────────

  app.get("/organizations/:orgId/projects/:projectId/auto-replies", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: VIEW_PERMISSION, capability: "comms.agent" });
    return {
      ok: true,
      auto_replies: (await listAutoReplyRecords(orgId, {
        project_id: getParam(request.params, "projectId"),
        status: getQuery(request.query, "status") || undefined
      }))
    };
  });

  app.post("/organizations/:orgId/projects/:projectId/auto-replies/:autoReplyId/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.agent" });
    const record = await dispatchAutoReplyDraft(orgId, ctx.branchId || "default", getParam(request.params, "projectId"), getParam(request.params, "autoReplyId"), ctx);
    return { ok: true, auto_reply: record };
  });

  app.post("/organizations/:orgId/projects/:projectId/auto-replies/:autoReplyId/dismiss", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: SEND_PERMISSION, capability: "comms.agent" });
    const record = await dismissAutoReplyDraft(orgId, getParam(request.params, "projectId"), getParam(request.params, "autoReplyId"));
    return { ok: true, auto_reply: record };
  });

  // ── Test-mode inbound simulation ─────────────────────────────────────────

  app.post("/organizations/:orgId/projects/:projectId/simulate-inbound", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: PROJECT_SETTINGS_PERMISSION, capability: "apps.comms" });
    const body = simulateSchema.parse(request.body ?? {});
    const result = await simulateProjectInbound(orgId, ctx.branchId || "default", getParam(request.params, "projectId"), body, ctx);
    return { ok: true, ...result };
  });
};
