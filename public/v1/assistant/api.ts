// HTTP surface for the global FirstMate assistant. Thin aliases over the
// centralized agent framework (/v1/agents) so the existing drawer client
// keeps working unchanged; the agent itself is declared in
// agent/definition.ts and executed by agents/runtime.ts.

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import "./capabilities.js";
import "./agent/definition.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { loadAgentSettings, saveAgentSettings } from "../agents/settings.js";
import { importLegacyThreads } from "../agents/storage.js";
import {
  createThreadForAgent,
  listThreadsForAgent,
  readThreadForAgent,
  runAgentTurn
} from "../agents/runtime.js";
import { ASSISTANT_AGENT_ID } from "./agent/definition.js";
import { readInternalUser } from "../internal/storage.js";
import { forbidden } from "../platform/errors.js";
import {
  clearAssistantMemories, deleteAssistantMemory, globalAssistantInstructions,
  listAssistantMemories, readAssistantProfile, saveAssistantMemory,
  saveAssistantProfile, saveGlobalAssistantInstructions
} from "./personalization.js";
import {
  listAssistantMessages as listLegacyMessages,
  listAssistantThreads as listLegacyThreads
} from "./storage.js";

const objectSchema = z.object({}).passthrough();

const USE_PERMISSION = "use_assistant|view_projects|manage_projects|manage_company_settings";
const SETTINGS_PERMISSION = "manage_company_settings";
const profileSchema = z.object({ instructions: z.string().max(4000), memory_enabled: z.boolean() });
const memorySchema = z.object({ content: z.string().trim().min(1).max(500) });

async function platformInstructionAdmin(ctx: { user?: unknown }) {
  const user = (ctx.user && typeof ctx.user === "object" ? ctx.user : {}) as Record<string, unknown>;
  const email = cleanText(user.email).toLowerCase();
  const internal = email ? await readInternalUser(email).catch(() => null) : null;
  const permissions = (internal?.permissions && typeof internal.permissions === "object" ? internal.permissions : {}) as Record<string, unknown>;
  if (!internal || !(["admin", "system_admin"].includes(cleanText(internal.role).toLowerCase())
    || internal.is_admin === true || permissions.is_admin_legacy === true || permissions.platform_admin === true)) {
    throw forbidden("platform_admin_required", "Only a verified platform administrator can edit global assistant instructions.");
  }
  return email;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  const source = params && typeof params === "object" ? params as Record<string, unknown> : {};
  return cleanText(source[key]);
}

// One-time (per org, marker-guarded) copy of pre-framework assistant threads
// from assistant.sqlite into the shared agents.sqlite store.
async function importOrgLegacyThreads(orgId: string) {
  (await importLegacyThreads({
    agentId: ASSISTANT_AGENT_ID,
    marker: `assistant_legacy_import:${orgId}`,
    listThreads: async () => (await listLegacyThreads(orgId, { limit: 100 })),
    listMessages: async (threadId) => (await listLegacyMessages(orgId, threadId, { limit: 500 }))
  }));
}

export const registerAssistantApi: FastifyPluginAsync = async (app) => {
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
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected assistant error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "assistant",
    endpoints: {
      context: "/organizations/:orgId/context",
      settings: "/organizations/:orgId/settings",
      profile: "/organizations/:orgId/profile",
      memories: "/organizations/:orgId/memories",
      threads: "/organizations/:orgId/threads"
    }
  }));

  app.get("/organizations/:orgId/context", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    (await importOrgLegacyThreads(orgId));
    const settings = await loadAgentSettings(ASSISTANT_AGENT_ID, orgId, ctx.branchId || "default");
    return {
      ok: true,
      settings: { enabled: settings.enabled !== false, assistant_name: cleanText(settings.assistant_name || settings.display_name) },
      threads: (await listThreadsForAgent(ASSISTANT_AGENT_ID, orgId, { actorUserId: ctx.userId }))
    };
  });

  app.get("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: SETTINGS_PERMISSION });
    return { ok: true, settings: await loadAgentSettings(ASSISTANT_AGENT_ID, orgId, ctx.branchId || "default") };
  });

  app.put("/organizations/:orgId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const settings = await saveAgentSettings(ASSISTANT_AGENT_ID, orgId, ctx.branchId || "default", body.settings ?? body);
    return { ok: true, settings };
  });

  app.get("/organizations/:orgId/global-instructions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: SETTINGS_PERMISSION });
    let can_edit = false;
    try { await platformInstructionAdmin(ctx); can_edit = true; } catch {}
    return { ok: true, instructions: await globalAssistantInstructions(), can_edit };
  });

  app.put("/organizations/:orgId/global-instructions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const actor = await platformInstructionAdmin(ctx);
    const { instructions } = z.object({ instructions: z.string().max(8000) }).parse(request.body);
    return { ok: true, instructions: await saveGlobalAssistantInstructions(instructions, actor), can_edit: true };
  });

  app.get("/organizations/:orgId/profile", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, profile: await readAssistantProfile(orgId, ctx.userId) };
  });

  app.put("/organizations/:orgId/profile", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, profile: await saveAssistantProfile(orgId, ctx.userId, profileSchema.parse(request.body)) };
  });

  app.get("/organizations/:orgId/memories", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, memories: await listAssistantMemories(orgId, ctx.userId) };
  });

  app.post("/organizations/:orgId/memories", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const profile = await readAssistantProfile(orgId, ctx.userId);
    if (!profile.memory_enabled) throw forbidden("memory_disabled", "Turn on memory before adding memories.");
    const { content } = memorySchema.parse(request.body);
    const id = await saveAssistantMemory(orgId, ctx.userId, content);
    return { ok: true, id, memories: await listAssistantMemories(orgId, ctx.userId) };
  });

  app.put("/organizations/:orgId/memories/:memoryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const { content } = memorySchema.parse(request.body);
    const id = await saveAssistantMemory(orgId, ctx.userId, content, getParam(request.params, "memoryId"));
    return { ok: true, id, memories: await listAssistantMemories(orgId, ctx.userId) };
  });

  app.delete("/organizations/:orgId/memories/:memoryId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, deleted: await deleteAssistantMemory(orgId, ctx.userId, getParam(request.params, "memoryId")) };
  });

  app.delete("/organizations/:orgId/memories", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    await clearAssistantMemories(orgId, ctx.userId);
    return { ok: true };
  });

  app.get("/organizations/:orgId/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    (await importOrgLegacyThreads(orgId));
    return { ok: true, threads: (await listThreadsForAgent(ASSISTANT_AGENT_ID, orgId, { actorUserId: ctx.userId })) };
  });

  app.post("/organizations/:orgId/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const body = objectSchema.parse(request.body ?? {});
    const thread = (await createThreadForAgent(ASSISTANT_AGENT_ID, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      actorUserId: ctx.userId,
      subjectId: body.subject_id === "notifications" ? "notifications" : undefined,
      title: body.subject_id === "notifications" ? "Notification setup" : undefined
    }));
    return { ok: true, thread };
  });

  app.get("/organizations/:orgId/threads/:threadId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    (await importOrgLegacyThreads(orgId));
    return { ok: true, ...(await readThreadForAgent(ASSISTANT_AGENT_ID, orgId, getParam(request.params, "threadId"), ctx.userId)) };
  });

  app.post("/organizations/:orgId/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const body = objectSchema.parse(request.body ?? {});
    const threadId = getParam(request.params, "threadId");
    (await readThreadForAgent(ASSISTANT_AGENT_ID, orgId, threadId, ctx.userId));
    const result = await runAgentTurn(ASSISTANT_AGENT_ID, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      threadId,
      message: String(body.message ?? body.text ?? ""),
      ctx,
      actorUserId: ctx.userId,
      actorName: cleanText((ctx.user as Record<string, unknown> | undefined)?.name)
    });
    return { ok: true, ...result };
  });
};
