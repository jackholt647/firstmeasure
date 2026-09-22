// HTTP surface for the stats warehouse: schema catalog, cached metric
// queries, dashboard views, presets, sync controls, and the stats agent.
// Mounted at /v1/stats. The agent endpoints are thin aliases over the
// centralized agent framework (agents/runtime.ts); the agent itself is
// declared in agent/definition.ts. Thread `subject_id` is surfaced to the
// existing client as `view_id`.

import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import "./agent/definition.js";
import { requirePlatformAuth } from "../platform/auth.js";
import { notFound, PlatformError } from "../platform/errors.js";
import {
  listThreadsForAgent,
  readThreadForAgent,
  runAgentTurn
} from "../agents/runtime.js";
import { createAgentThread, importLegacyThreads } from "../agents/storage.js";
import { STATS_AGENT_ID } from "./agent/definition.js";
import { executeStatsQueries } from "./metrics.js";
import { METRIC_PRESETS, VIEW_PRESETS } from "./presets.js";
import {
  listStatsMessages as listLegacyStatsMessages,
  listStatsThreads as listLegacyStatsThreads,
  readViewRecord,
  type JsonObject
} from "./storage.js";
import {
  createViewFromPreset,
  deleteStatsView,
  listStatsViews,
  readStatsView,
  saveStatsView,
  statsSchema
} from "./service.js";
import {
  ensureStatsFreshness,
  startStatsScheduler,
  statsSyncStatus,
  syncOrganizationStats
} from "./sync.js";

const objectSchema = z.object({}).passthrough();

const READ_PERMISSION = "view_projects|manage_projects|manage_company_settings";
const WRITE_PERMISSION = "manage_projects|manage_company_settings";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  const source = params && typeof params === "object" ? params as Record<string, unknown> : {};
  return cleanText(source[key]);
}

// One-time (per org, marker-guarded) copy of pre-framework stats agent
// threads from stats.sqlite into the shared agents.sqlite store. Legacy
// threads keyed conversations by view_id, which maps onto subject_id.
async function importOrgLegacyThreads(orgId: string) {
  (await importLegacyThreads({
    agentId: STATS_AGENT_ID,
    marker: `stats_legacy_import:${orgId}`,
    listThreads: async () => (await listLegacyStatsThreads(orgId, { limit: 100 })),
    listMessages: async (threadId) => (await listLegacyStatsMessages(orgId, threadId, { limit: 500 })),
    subjectField: "view_id"
  }));
}

// The stats client (and its saved routes) reads threads by `view_id`; the
// framework stores the focused view in `subject_id`. Alias it both ways.
function withViewId(thread: unknown) {
  if (!thread || typeof thread !== "object") return thread;
  const record = thread as JsonObject;
  return { ...record, view_id: cleanText(record.subject_id) };
}

// The framework persists rollback info as `reverted`; the client renders
// `reverted_views` on stored assistant messages. Alias without dropping data.
function withRevertedViews(message: unknown) {
  if (!message || typeof message !== "object") return message;
  const record = message as JsonObject;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
    ? record.data as JsonObject
    : {};
  const reverted = Array.isArray(data.reverted_views)
    ? data.reverted_views
    : Array.isArray(data.reverted) ? data.reverted : [];
  return { ...record, data: { ...data, reverted_views: reverted } };
}

export const registerStatsApi: FastifyPluginAsync = async (app) => {
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
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected stats error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "stats",
    endpoints: {
      schema: "/organizations/:orgId/schema",
      query: "POST /organizations/:orgId/query",
      views: "/organizations/:orgId/views",
      presets: "/organizations/:orgId/presets",
      sync: "/organizations/:orgId/sync",
      agent_threads: "/organizations/:orgId/agent/threads"
    }
  }));

  app.get("/organizations/:orgId/schema", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    await ensureStatsFreshness(orgId);
    return { ok: true, schema: await statsSchema(orgId), sync: (await statsSyncStatus(orgId)) };
  });

  // Read-only despite the verb: specs travel in the body. Results come from
  // the version-keyed query cache whenever the warehouse hasn't changed.
  app.post("/organizations/:orgId/query", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: READ_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const queries = body.queries && typeof body.queries === "object" && !Array.isArray(body.queries)
      ? body.queries as Record<string, unknown>
      : {};
    await ensureStatsFreshness(orgId);
    return { ok: true, ...(await executeStatsQueries(orgId, queries)), sync: (await statsSyncStatus(orgId)) };
  });

  app.get("/organizations/:orgId/views", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    return { ok: true, views: (await listStatsViews(orgId)) };
  });

  app.get("/organizations/:orgId/views/:viewId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    return { ok: true, view: (await readStatsView(orgId, getParam(request.params, "viewId"))) };
  });

  app.post("/organizations/:orgId/views", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: WRITE_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    if (cleanText(body.preset_id)) {
      return { ok: true, view: (await createViewFromPreset(orgId, cleanText(body.preset_id), ctx.userId)) };
    }
    return { ok: true, view: (await saveStatsView(orgId, { ...body, id: "", created_by_user_id: ctx.userId })) };
  });

  app.put("/organizations/:orgId/views/:viewId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: WRITE_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    return { ok: true, view: (await saveStatsView(orgId, { ...body, id: getParam(request.params, "viewId"), created_by_user_id: ctx.userId })) };
  });

  app.delete("/organizations/:orgId/views/:viewId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: WRITE_PERMISSION });
    (await deleteStatsView(orgId, getParam(request.params, "viewId")));
    return { ok: true };
  });

  app.get("/organizations/:orgId/presets", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    return { ok: true, metric_presets: METRIC_PRESETS, view_presets: VIEW_PRESETS };
  });

  app.get("/organizations/:orgId/sync", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    return { ok: true, sync: (await statsSyncStatus(orgId)) };
  });

  app.post("/organizations/:orgId/sync", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: WRITE_PERMISSION });
    const result = await syncOrganizationStats(orgId, { force: true });
    return { ok: true, result, sync: (await statsSyncStatus(orgId)) };
  });

  // ── Agent (framework-backed; URLs and response shapes unchanged) ────────

  app.get("/organizations/:orgId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    (await importOrgLegacyThreads(orgId));
    const query = objectSchema.parse(request.query ?? {});
    const threads = (await listThreadsForAgent(STATS_AGENT_ID, orgId, {
      ...(query.view_id === undefined ? {} : { subjectId: cleanText(query.view_id) })
    }));
    return { ok: true, threads: threads.map(withViewId) };
  });

  app.post("/organizations/:orgId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: READ_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const viewId = cleanText(body.view_id);
    if (viewId && !(await readViewRecord(orgId, viewId))) {
      throw notFound("stats_view_not_found", "This stats view was not found.");
    }
    // Explicit id: the stats client (deep links, saved routes) recognizes
    // conversations by the historical `stats_thread_` prefix.
    const thread = (await createAgentThread({
      id: `stats_thread_${randomUUID().replace(/-/g, "")}`,
      agent_id: STATS_AGENT_ID,
      organization_id: orgId,
      branch_id: String(body.branch_id ?? "default"),
      subject_id: viewId,
      created_by_user_id: ctx.userId
    }));
    return { ok: true, thread: withViewId(thread) };
  });

  app.get("/organizations/:orgId/agent/threads/:threadId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: READ_PERMISSION });
    (await importOrgLegacyThreads(orgId));
    const detail = (await readThreadForAgent(STATS_AGENT_ID, orgId, getParam(request.params, "threadId")));
    return { ok: true, thread: withViewId(detail.thread), messages: detail.messages.map(withRevertedViews) };
  });

  // Runs one agent turn synchronously: query answering, inline widget
  // renders, and dashboard edits (reverted automatically on failure).
  app.post("/organizations/:orgId/agent/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: READ_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const references = Array.isArray(body.references)
      ? body.references.map((value) => cleanText(value)).filter(Boolean)
      : [];
    const result = await runAgentTurn(STATS_AGENT_ID, {
      orgId,
      branchId: String(body.branch_id ?? "default"),
      threadId: getParam(request.params, "threadId"),
      message: String(body.message ?? body.text ?? ""),
      ctx,
      actorUserId: ctx.userId,
      actorName: cleanText((ctx.user as Record<string, unknown> | undefined)?.name),
      input: { references },
      ...(references.length
        ? { turnNote: `\n\n(The customer highlighted these dashboard widgets as context: ${references.join(", ")}.)` }
        : {})
    });
    return {
      ok: true,
      thread: withViewId(result.thread),
      user_message: result.user_message,
      assistant_message: withRevertedViews(result.assistant_message),
      status: result.status,
      changes: result.changes,
      renders: result.renders,
      reverted_views: result.reverted
    };
  });

  startStatsScheduler();
};
