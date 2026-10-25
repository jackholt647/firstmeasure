import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { experience } from "./registry.js";
import { notFound } from "../platform/errors.js";
import { listEvents } from "./store.js";
import { availableExperiences, completeGuided, ensureGuidedDefinitions, guidedConversationTurn, recordGuidedEvent } from "./service.js";

/**
 * Guided experiences (docs/architecture/guided-experiences.md), mounted at /v1/guided-experiences. Every route acts
 * as the signed-in person in their own organization; writes need CSRF. Finishing a setup runs its published action
 * with that person's permissions, so the routes add no authority of their own.
 */
const text = (value: unknown) => String(value ?? "").trim();
const params = (request: { params: unknown }) => request.params as { orgId: string; experienceId?: string };

export async function registerGuidedExperiencesApi(app: FastifyInstance) {
  ensureGuidedDefinitions();
  app.get("/organizations/:orgId/experiences", async (request) => {
    const { orgId } = params(request);
    const ctx = await requirePlatformAuth(request, { orgId });
    const query = (request.query || {}) as Record<string, unknown>;
    return { ok: true, ...(await availableExperiences(ctx, { tab: text(query.tab), projectId: text(query.project_id) })) };
  });
  app.post("/organizations/:orgId/experiences/:experienceId/events", async (request) => {
    const { orgId, experienceId } = params(request);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    return { ok: true, ...(await recordGuidedEvent(ctx, text(experienceId), request.body)) };
  });
  app.post("/organizations/:orgId/experiences/:experienceId/complete", async (request) => {
    const { orgId, experienceId } = params(request);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    return { ok: true, ...(await completeGuided(ctx, text(experienceId), request.body)) };
  });
  app.post("/organizations/:orgId/experiences/:experienceId/conversation", async (request) => {
    const { orgId, experienceId } = params(request);
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    return { ok: true, ...(await guidedConversationTurn(ctx, text(experienceId), request.body)) };
  });
  // Exposure, step and outcome events for analysis. Organization administrators only.
  app.get("/organizations/:orgId/experiences/:experienceId/events", async (request) => {
    const { orgId, experienceId } = params(request);
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    if (!experience(text(experienceId))) throw notFound("guided_experience_missing", "That guided experience does not exist.");
    const limit = Number(((request.query || {}) as Record<string, unknown>).limit || 500);
    return { ok: true, events: await listEvents(orgId, text(experienceId), limit) };
  });
}
