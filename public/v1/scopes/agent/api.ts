// HTTP surface for the scope-manager ("Automations") agent, mounted inside
// /v1/scopes. Thin aliases over the centralized agent framework (/v1/agents)
// so the existing Automations settings client keeps working unchanged; the
// agent itself is declared in definition.ts and executed by agents/runtime.ts.

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import "./definition.js";
import { requirePlatformAuth } from "../../platform/auth.js";
import { badRequest } from "../../platform/errors.js";
import { importLegacyThreads } from "../../agents/storage.js";
import {
  createThreadForAgent,
  listThreadsForAgent,
  readThreadForAgent,
  runAgentTurn
} from "../../agents/runtime.js";
import { asArray, asObject, cleanText, type JsonObject } from "../../agents/util.js";
import {
  listAgentMessages as listLegacyMessages,
  listAgentThreads as listLegacyThreads
} from "../../work/storage.js";
import { readScopeTemplate } from "../storage.js";
import { SCOPE_AGENT_ID } from "./definition.js";

const objectSchema = z.object({}).passthrough();
const USE_PERMISSION = "manage_company_settings";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

// The framework stores the focus template id as subject_id; the Automations
// client reads template_id, so responses carry both.
function threadShape(thread: JsonObject | null) {
  if (!thread) return thread;
  return { ...thread, template_id: cleanText(thread.subject_id) };
}

// New runtime messages persist rolled-back ids as data.reverted; legacy
// (imported) messages already carry data.reverted_templates. Alias both ways.
function messageShape(message: unknown) {
  const record = asObject(message);
  const data = asObject(record.data);
  return {
    ...record,
    data: { ...data, reverted_templates: asArray(data.reverted_templates ?? data.reverted) }
  };
}

// One-time (per org, marker-guarded) copy of pre-framework scope-agent
// threads from work.sqlite into the shared agents.sqlite store.
async function importOrgLegacyThreads(orgId: string) {
  (await importLegacyThreads({
    agentId: SCOPE_AGENT_ID,
    marker: `scope_legacy_import:${orgId}`,
    listThreads: async () => (await listLegacyThreads(orgId, { limit: 100 })),
    listMessages: async (threadId) => (await listLegacyMessages(orgId, threadId, { limit: 500 })),
    subjectField: "template_id"
  }));
}

export async function registerScopeAgentRoutes(app: FastifyInstance) {
  app.get("/organizations/:orgId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION });
    (await importOrgLegacyThreads(orgId));
    const query = objectSchema.parse(request.query ?? {});
    const templateId = cleanText(query.template_id);
    const threads = (await listThreadsForAgent(SCOPE_AGENT_ID, orgId, {
      actorUserId: ctx.userId,
      ...(templateId ? { subjectId: templateId } : {})
    }));
    return { ok: true, threads: threads.map((thread) => threadShape(thread)) };
  });

  app.post("/organizations/:orgId/agent/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION });
    const body = objectSchema.parse(request.body ?? {});
    const branchId = cleanText(body.branch_id) || "default";
    const templateId = cleanText(body.template_id);
    if (!templateId) throw badRequest("missing_template_id", "Choose a board to automate first.");
    (await readScopeTemplate(orgId, branchId, templateId));
    const thread = (await createThreadForAgent(SCOPE_AGENT_ID, {
      orgId,
      branchId,
      subjectId: templateId,
      actorUserId: ctx.userId
    }));
    return { ok: true, thread: threadShape(thread) };
  });

  app.get("/organizations/:orgId/agent/threads/:threadId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, permission: USE_PERMISSION });
    (await importOrgLegacyThreads(orgId));
    const { thread, messages } = (await readThreadForAgent(SCOPE_AGENT_ID, orgId, getParam(request.params, "threadId"), ctx.userId));
    return { ok: true, thread: threadShape(thread), messages: messages.map(messageShape) };
  });

  // Runs one agent turn synchronously: the customer's message goes in, the
  // tool loop runs (reads, edits, validation retries, revert on failure), and
  // the assistant's reply plus change summary comes back.
  app.post("/organizations/:orgId/agent/threads/:threadId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: USE_PERMISSION });
    (await importOrgLegacyThreads(orgId));
    const body = objectSchema.parse(request.body ?? {});
    const references = asArray(body.references).map((value) => cleanText(value)).filter(Boolean);
    const referenceNote = references.length
      ? `\n\n(The customer clicked these automations as context: ${references.join(", ")} — keys refer to the automation inventory.)`
      : "";
    const result = await runAgentTurn(SCOPE_AGENT_ID, {
      orgId,
      branchId: cleanText(body.branch_id) || ctx.branchId || "default",
      threadId: getParam(request.params, "threadId"),
      message: String(body.message ?? body.text ?? ""),
      ctx,
      actorUserId: ctx.userId,
      actorName: cleanText(asObject(ctx.user as JsonObject | undefined).name),
      input: { references },
      ...(referenceNote ? { turnNote: referenceNote } : {})
    });
    return {
      ok: true,
      ...result,
      thread: threadShape(result.thread),
      assistant_message: messageShape(result.assistant_message),
      reverted_templates: result.reverted
    };
  });
}
