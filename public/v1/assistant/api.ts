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
import {
  listAssistantMessages as listLegacyMessages,
  listAssistantThreads as listLegacyThreads
} from "./storage.js";

const objectSchema = z.object({}).passthrough();

const USE_PERMISSION = "use_assistant|view_projects|manage_projects|manage_company_settings";
const SETTINGS_PERMISSION = "manage_company_settings";

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
      actorUserId: ctx.userId
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
