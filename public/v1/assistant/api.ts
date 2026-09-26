// HTTP surface for the global FirstMate assistant. Thin aliases over the
// centralized agent framework (/v1/agents) so the existing drawer client
// keeps working unchanged; the agent itself is declared in
// agent/definition.ts and executed by agents/runtime.ts.

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import "./capabilities.js";
import "./agent/definition.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, badRequest } from "../platform/errors.js";
import { readMediaFile, readMediaMetadata, storeMediaUpload } from "../platform/storage.js";
import { transcribeAudio } from "../audio-notes/transcription.js";
import { loadAgentSettings, saveAgentSettings } from "../agents/settings.js";
import {
  deleteAgentThread, importLegacyThreads, listAssistantDashboard, readAgentThread, removeAssistantDashboardItem,
  searchAgentHistory, updateAgentSchedule
} from "../agents/storage.js";
import {
  agentConfigurationTurnNote, agentIdFromSubject, describeAssistantAgent, ensureAssistantMainThread, listAssistantAgents,
  pinTurnArtifacts, queueAssistantAgentRun, readAssistantAgentDetail, readOwnedAssistantAgent
} from "./agent/agents.js";
import {
  createThreadForAgent,
  listThreadsForAgent,
  readThreadForAgent,
  runAgentTurn
} from "../agents/runtime.js";
import { ASSISTANT_AGENT_ID } from "./agent/definition.js";
import { readInternalUser } from "../internal/storage.js";
import { forbidden, notFound } from "../platform/errors.js";
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
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const inputFilePattern = /\.(pdf|txt|md|json|html|xml|csv|tsv|xls|xlsx|doc|docx|rtf|odt|ppt|pptx|js|ts|py|css|java|sql)$/i;
const imageTypes = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

async function uploadedFile(request: unknown) {
  const parts = (request as { parts?: () => AsyncIterable<{ type: string; filename?: string; mimetype?: string; toBuffer?: () => Promise<Buffer> }> }).parts?.();
  if (!parts) throw badRequest("multipart_required", "Upload a file using multipart/form-data.");
  let file: { bytes: Buffer; fileName: string; contentType: string } | null = null;
  for await (const part of parts) {
    if (part.type !== "file") continue;
    if (file) throw badRequest("too_many_files", "Upload one file at a time.");
    const bytes = await part.toBuffer?.();
    if (!bytes?.length || bytes.length > MAX_ATTACHMENT_BYTES) throw badRequest("invalid_attachment", "Choose a file no larger than 20 MB.");
    file = { bytes, fileName: String(part.filename || "attachment").slice(0, 160), contentType: String(part.mimetype || "application/octet-stream").toLowerCase() };
  }
  if (!file) throw badRequest("missing_attachment", "Choose a file to upload.");
  return file;
}

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
      threads: "/organizations/:orgId/threads",
      agents: "/organizations/:orgId/agents",
      dashboard: "/organizations/:orgId/dashboard"
    }
  }));

  app.get("/organizations/:orgId/context", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    (await importOrgLegacyThreads(orgId));
    const settings = await loadAgentSettings(ASSISTANT_AGENT_ID, orgId, ctx.branchId || "default");
    const mainThread = await ensureAssistantMainThread(orgId, ctx.userId, ctx.branchId || "default");
    return {
      ok: true,
      settings: { enabled: settings.enabled !== false, assistant_name: cleanText(settings.assistant_name || settings.display_name) },
      main_thread: mainThread,
      threads: (await listThreadsForAgent(ASSISTANT_AGENT_ID, orgId, { actorUserId: ctx.userId })),
      agents: await listAssistantAgents(orgId, ctx.userId),
      dashboard: await listAssistantDashboard(orgId, ctx.userId)
    };
  });

  // Personal agents: scheduled tasks created by the assistant on the user's behalf.
  app.get("/organizations/:orgId/agents", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, agents: await listAssistantAgents(orgId, ctx.userId) };
  });

  app.get("/organizations/:orgId/agents/:agentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    const detail = await readAssistantAgentDetail(orgId, ctx.userId, getParam(request.params, "agentId"));
    if (!detail) throw notFound("assistant_agent_not_found", "This agent was not found.");
    return { ok: true, ...detail };
  });

  app.patch("/organizations/:orgId/agents/:agentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const body = z.object({ status: z.enum(["active", "paused"]).optional(), title: z.string().trim().min(1).max(32).optional() }).parse(request.body ?? {});
    const entry = await readOwnedAssistantAgent(orgId, ctx.userId, getParam(request.params, "agentId"));
    if (!entry) throw notFound("assistant_agent_not_found", "This agent was not found.");
    const patch: Record<string, unknown> = {};
    if (body.title) patch.title = body.title;
    if (body.status) {
      patch.status = body.status;
      // Resuming must not replay occurrences missed while paused.
      if (body.status === "active" && cleanText(entry.status) !== "active") patch.last_fired_at = new Date().toISOString();
    }
    const updated = Object.keys(patch).length ? await updateAgentSchedule(cleanText(entry.id), patch) : entry;
    return { ok: true, agent: describeAssistantAgent(updated || entry) };
  });

  app.delete("/organizations/:orgId/agents/:agentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const entry = await readOwnedAssistantAgent(orgId, ctx.userId, getParam(request.params, "agentId"));
    if (!entry) throw notFound("assistant_agent_not_found", "This agent was not found.");
    await updateAgentSchedule(cleanText(entry.id), { status: "cancelled" });
    const thread = await readAgentThread(ASSISTANT_AGENT_ID, orgId, cleanText(entry.origin_thread_id));
    if (thread && cleanText(thread.status) !== "working") await deleteAgentThread(ASSISTANT_AGENT_ID, orgId, cleanText(thread.id));
    return { ok: true, deleted: true };
  });

  app.post("/organizations/:orgId/agents/:agentId/run", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const entry = await readOwnedAssistantAgent(orgId, ctx.userId, getParam(request.params, "agentId"));
    if (!entry) throw notFound("assistant_agent_not_found", "This agent was not found.");
    return { ok: true, queued: await queueAssistantAgentRun(entry) };
  });

  // The dashboard beside the chat: artifacts the assistant and agents produced.
  app.get("/organizations/:orgId/dashboard", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    return { ok: true, dashboard: await listAssistantDashboard(orgId, ctx.userId) };
  });

  app.delete("/organizations/:orgId/dashboard/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    await removeAssistantDashboardItem(orgId, ctx.userId, getParam(request.params, "itemId"));
    return { ok: true, dashboard: await listAssistantDashboard(orgId, ctx.userId) };
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

  app.get("/organizations/:orgId/search", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION, capability: "apps.assistant" });
    const query = cleanText((request.query as Record<string, unknown> | undefined)?.q).slice(0, 200);
    const matches = query.length >= 2 ? await searchAgentHistory(ASSISTANT_AGENT_ID, orgId, ctx.userId, query) : [];
    const threads = await Promise.all([...new Set(matches.map((match) => String(match.thread_id)))].map(async (id) => {
      const thread = await readAgentThread(ASSISTANT_AGENT_ID, orgId, id);
      return thread?.created_by_user_id === ctx.userId ? thread : null;
    }));
    return { ok: true, matches, threads: threads.filter(Boolean) };
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

  app.post("/organizations/:orgId/threads/:threadId/attachments", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const threadId = getParam(request.params, "threadId");
    await readThreadForAgent(ASSISTANT_AGENT_ID, orgId, threadId, ctx.userId);
    const file = await uploadedFile(request);
    const media = await storeMediaUpload(orgId, {
      ...file,
      ownerType: "assistant_user", ownerId: ctx.userId, slot: "attachment",
      scope: "assistant_conversation", metadata: { thread_id: threadId },
      thumbnails: false, compression: false
    });
    return { ok: true, attachment: { media_id: media.id, file_name: media.file_name, content_type: media.content_type, size_bytes: media.size_bytes } };
  });

  app.post("/organizations/:orgId/transcriptions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const file = await uploadedFile(request);
    if (!file.contentType.startsWith("audio/")) throw badRequest("invalid_audio", "Record an audio file for dictation.");
    return { ok: true, transcription: await transcribeAudio(file) };
  });

  app.post("/organizations/:orgId/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION, capability: "apps.assistant" });
    const body = objectSchema.parse(request.body ?? {});
    const threadId = getParam(request.params, "threadId");
    const { thread } = await readThreadForAgent(ASSISTANT_AGENT_ID, orgId, threadId, ctx.userId);
    const turnNote = agentIdFromSubject(thread.subject_id) ? await agentConfigurationTurnNote(orgId, ctx.userId, thread) : "";
    const attachmentIds = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachmentIds.length > 5) throw badRequest("too_many_attachments", "Add up to five files per message.");
    const contentParts: Record<string, unknown>[] = [];
    const attachments: Record<string, unknown>[] = [];
    for (const rawId of attachmentIds) {
      const mediaId = cleanText(rawId);
      const metadata = await readMediaMetadata(orgId, mediaId);
      const owner = metadata?.owner && typeof metadata.owner === "object" ? metadata.owner as Record<string, unknown> : {};
      const mediaMetadata = metadata?.metadata && typeof metadata.metadata === "object" ? metadata.metadata as Record<string, unknown> : {};
      if (owner.type !== "assistant_user" || owner.id !== ctx.userId || mediaMetadata.thread_id !== threadId) {
        throw badRequest("attachment_not_owned", "This attachment does not belong to this conversation.");
      }
      const file = await readMediaFile(orgId, mediaId);
      if (file.bytes.length > MAX_ATTACHMENT_BYTES) throw badRequest("invalid_attachment", "An attachment is too large.");
      const item = { media_id: mediaId, file_name: file.fileName, content_type: file.contentType, size_bytes: file.bytes.length };
      attachments.push(item);
      if (imageTypes.has(file.contentType)) {
        contentParts.push({ type: "input_image", image_url: `data:${file.contentType};base64,${file.bytes.toString("base64")}` });
      } else if (inputFilePattern.test(file.fileName)) {
        contentParts.push({ type: "input_file", filename: file.fileName, file_data: `data:${file.contentType};base64,${file.bytes.toString("base64")}` });
      } else if (file.contentType.startsWith("audio/")) {
        const transcript = await transcribeAudio({ bytes: file.bytes, fileName: file.fileName, contentType: file.contentType });
        contentParts.push({ type: "input_text", text: `Audio attachment ${file.fileName} transcript: ${transcript.text}` });
      } else {
        contentParts.push({ type: "input_text", text: `The user attached ${file.fileName} (${file.contentType}). Its contents are stored but are not available for analysis in this turn; explain this limitation if asked about the contents.` });
      }
    }
    const result = await runAgentTurn(ASSISTANT_AGENT_ID, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      threadId,
      message: String(body.message ?? body.text ?? ""),
      input: { attachments },
      contentParts,
      ctx,
      actorUserId: ctx.userId,
      actorName: cleanText((ctx.user as Record<string, unknown> | undefined)?.name),
      ...(turnNote ? { turnNote } : {})
    });
    const dashboard = await pinTurnArtifacts(orgId, ctx.userId, threadId, result);
    return { ok: true, ...result, ...(dashboard ? { dashboard } : {}) };
  });
};
