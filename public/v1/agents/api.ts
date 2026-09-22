// Generic HTTP surface for every registered agent, mounted at /v1/agents:
// agent catalog + centralized settings + usage, and a uniform thread surface
// at /organizations/:orgId/agents/:agentId/threads. Existing per-module
// endpoints (stats, scopes, assistant, comms) stay mounted as thin aliases
// over the same runtime so no frontend breaks.

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { agentDefinition, listAgentDefinitions, requireAgentDefinition } from "./registry.js";
import { agentChannelParticipants } from "./participants.js";
import { loadAgentSettings, saveAgentSettings } from "./settings.js";
import { agentUsageSummary } from "./storage.js";
import { createThreadForAgent, listThreadsForAgent, readThreadForAgent, runAgentTurn } from "./runtime.js";
import { asObject, cleanText, type JsonObject } from "./util.js";
import "../insights/definition.js";

const objectSchema = z.object({}).passthrough();
const SETTINGS_PERMISSION = "manage_company_settings";
const DEFAULT_USE_PERMISSION = "view_projects|manage_projects|manage_company_settings";

function getParam(params: unknown, key: string) {
  const source = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
  return cleanText(source[key]);
}

function publicAgentShape(definition: ReturnType<typeof listAgentDefinitions>[number], settings?: JsonObject) {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    capability: definition.capability ?? null,
    thread_scope: definition.threadScope ?? "org",
    ...(settings ? { settings } : {})
  };
}

export const registerAgentsApi: FastifyPluginAsync = async (app) => {
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
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected agents error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "agents",
    agents: listAgentDefinitions().map((definition) => publicAgentShape(definition)),
    endpoints: {
      catalog: "/organizations/:orgId/agents",
      settings: "/organizations/:orgId/agents/:agentId/settings",
      usage: "/organizations/:orgId/usage",
      threads: "/organizations/:orgId/agents/:agentId/threads"
    }
  }));

  // Catalog + per-org settings for the "AI Agents" settings surface.
  app.get("/organizations/:orgId/agents", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: SETTINGS_PERMISSION });
    const agents = [] as JsonObject[];
    for (const definition of listAgentDefinitions()) {
      const settings = await loadAgentSettings(definition.id, orgId, ctx.branchId || "default").catch(() => null);
      agents.push(publicAgentShape(definition, settings ?? {}));
    }
    return { ok: true, agents };
  });

  app.get("/organizations/:orgId/agents/:agentId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    requireAgentDefinition(agentId);
    const ctx = await requirePlatformAuth(request, { orgId, permission: SETTINGS_PERMISSION });
    return { ok: true, settings: await loadAgentSettings(agentId, orgId, ctx.branchId || "default") };
  });

  app.put("/organizations/:orgId/agents/:agentId/settings", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    requireAgentDefinition(agentId);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: SETTINGS_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const settings = await saveAgentSettings(agentId, orgId, ctx.branchId || "default", body.settings ?? body);
    return { ok: true, settings };
  });

  // Channel-participant agents (for mention pickers / DM lists). Readable by
  // any signed-in team member — it only exposes the agent's display name.
  app.get("/organizations/:orgId/participants", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: DEFAULT_USE_PERMISSION });
    return { ok: true, participants: await agentChannelParticipants(orgId, ctx.branchId || "default") };
  });

  app.get("/organizations/:orgId/usage", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: SETTINGS_PERMISSION });
    const query = objectSchema.parse(request.query ?? {});
    return { ok: true, usage: (await agentUsageSummary(orgId, { since: cleanText((query as JsonObject).since) })) };
  });

  // ── Generic thread surface ───────────────────────────────────────────────

  async function threadAuth(request: Parameters<typeof requirePlatformAuth>[0], orgId: string, agentId: string, csrf = false) {
    const definition = agentDefinition(agentId);
    if (!definition) throw new PlatformError("agent_not_found", 404, `Unknown agent '${agentId}'.`);
    return await requirePlatformAuth(request, {
      orgId,
      csrf,
      permission: definition.usePermission || DEFAULT_USE_PERMISSION,
      ...(definition.capability ? { capability: definition.capability } : {})
    });
  }

  app.get("/organizations/:orgId/agents/:agentId/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    const ctx = await threadAuth(request, orgId, agentId);
    const query = objectSchema.parse(request.query ?? {});
    return {
      ok: true,
      threads: (await listThreadsForAgent(agentId, orgId, {
        actorUserId: ctx.userId,
        ...(query.subject_id !== undefined ? { subjectId: String(query.subject_id ?? "") } : {})
      }))
    };
  });

  app.post("/organizations/:orgId/agents/:agentId/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    const ctx = await threadAuth(request, orgId, agentId, true);
    const body = objectSchema.parse(request.body ?? {});
    const thread = (await createThreadForAgent(agentId, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      subjectId: cleanText(body.subject_id),
      actorUserId: ctx.userId
    }));
    return { ok: true, thread };
  });

  app.get("/organizations/:orgId/agents/:agentId/threads/:threadId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    const ctx = await threadAuth(request, orgId, agentId);
    return { ok: true, ...(await readThreadForAgent(agentId, orgId, getParam(request.params, "threadId"), ctx.userId)) };
  });

  app.post("/organizations/:orgId/agents/:agentId/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const agentId = getParam(request.params, "agentId");
    const ctx = await threadAuth(request, orgId, agentId, true);
    const threadId = getParam(request.params, "threadId");
    (await readThreadForAgent(agentId, orgId, threadId, ctx.userId));
    const body = objectSchema.parse(request.body ?? {});
    const result = await runAgentTurn(agentId, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      threadId,
      message: String(body.message ?? body.text ?? ""),
      ctx,
      actorUserId: ctx.userId,
      actorName: cleanText(asObject(ctx.user as JsonObject | undefined).name),
      input: asObject(body.input)
    });
    return { ok: true, ...result };
  });
};
