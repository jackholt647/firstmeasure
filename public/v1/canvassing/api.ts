import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { authContextFromRequest, hashPassword, requirePlatformAuth } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, PlatformError, notFound, unauthorized } from "../platform/errors.js";
import { createPlatformLead } from "../platform/api.js";
import {
  addIdentityMembership,
  createIdentity,
  findIdentityByEmail,
  listDocuments,
  readBranchModule,
  saveBranchModule,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { listSharedDocuments, mutateSharedDocument, readSharedDocument } from "../src/database/shared_documents.js";
import { emitWorkEvent } from "../work/engine.js";

import { cleanText, asObject, nowIso, defaultCanvassingSettings, statusesWithLabels, ensureCanvassingSettings, ensureCanvassingEnabled, requireCanvassingAppFlag, requireCanvassingManager, listCanvassingUsers, createOrInviteCanvassingUser, listPins, readPin, savePin, actorFromContext, normalizeContact, reverseGeocode } from "./service.js";

const objectBodySchema = z.object({}).passthrough();
const CANVASSING_MODULE_ID = "canvassing";
const DEFAULT_BRANCH_ID = "default";

export const registerCanvassingApi: FastifyPluginAsync = async (app) => {
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
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "canvassing",
    storage: "storage/canvassing",
    pins: "/v1/canvassing/organizations/:orgId/branch/:branchId/pins",
    promote: "/v1/canvassing/organizations/:orgId/branch/:branchId/pins/:pinId/promote"
  }));

  app.get("/organizations/:orgId/branch/:branchId/settings", async (request) => {
    const orgId = cleanText(asObject(request.params).orgId);
    const branchId = cleanText(asObject(request.params).branchId) || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId });
    await requireCanvassingAppFlag(orgId);
    return { ok: true, ...(await ensureCanvassingSettings(orgId, branchId)) };
  });

  app.put("/organizations/:orgId/branch/:branchId/settings", async (request) => {
    const orgId = cleanText(asObject(request.params).orgId);
    const branchId = cleanText(asObject(request.params).branchId) || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    await requireCanvassingAppFlag(orgId);
    const body = objectBodySchema.parse(request.body ?? {});
    const data = defaultCanvassingSettings(asObject(body.data || body));
    const module = await saveBranchModule(orgId, branchId, CANVASSING_MODULE_ID, {
      data,
      metadata: { kind: "branch_canvassing_settings", source: "canvassing_api" }
    }, { replace: true });
    return { ok: true, module, settings: { ...data, statuses: statusesWithLabels(data) } };
  });

  app.get("/organizations/:orgId/branch/:branchId/users", async (request) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    await requireCanvassingManager(request, orgId);
    await ensureCanvassingEnabled(orgId, branchId);
    return { ok: true, users: await listCanvassingUsers(orgId) };
  });

  app.post("/organizations/:orgId/branch/:branchId/users", async (request, reply) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    await requireCanvassingManager(request, orgId);
    await ensureCanvassingEnabled(orgId, branchId);
    const result = await createOrInviteCanvassingUser(orgId, branchId, objectBodySchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/branch/:branchId/pins", async (request) => {
    const orgId = cleanText(asObject(request.params).orgId);
    const branchId = cleanText(asObject(request.params).branchId) || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId });
    const settings = (await ensureCanvassingEnabled(orgId, branchId)).settings;
    return { ok: true, pins: await listPins(orgId, branchId), settings };
  });

  app.post("/organizations/:orgId/branch/:branchId/pins", async (request, reply) => {
    const orgId = cleanText(asObject(request.params).orgId);
    const branchId = cleanText(asObject(request.params).branchId) || DEFAULT_BRANCH_ID;
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    await ensureCanvassingEnabled(orgId, branchId);
    const pin = await savePin(orgId, branchId, objectBodySchema.parse(request.body ?? {}), actorFromContext(ctx as unknown as JsonObject));
    // Org-scoped: pins are lightweight canvassing records, not projects.
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: branchId,
      type: "canvassing.pin.created",
      idempotency_key: `canvassing.pin.created:${cleanText(pin.id)}`,
      payload: {
        pin_id: cleanText(pin.id),
        address: cleanText(pin.address),
        status_id: cleanText(pin.status_id)
      },
      context: { actor_user_id: cleanText(ctx.userId) }
    });
    reply.code(201);
    return { ok: true, pin };
  });

  app.get("/organizations/:orgId/branch/:branchId/pins/:pinId", async (request) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    await requirePlatformAuth(request, { orgId });
    await ensureCanvassingEnabled(orgId, branchId);
    return { ok: true, pin: await readPin(orgId, branchId, cleanText(params.pinId)) };
  });

  app.patch("/organizations/:orgId/branch/:branchId/pins/:pinId", async (request) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    await ensureCanvassingEnabled(orgId, branchId);
    const pin = await savePin(orgId, branchId, { ...objectBodySchema.parse(request.body ?? {}), id: params.pinId }, actorFromContext(ctx as unknown as JsonObject));
    return { ok: true, pin };
  });

  app.delete("/organizations/:orgId/branch/:branchId/pins/:pinId", async (request) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    await ensureCanvassingEnabled(orgId, branchId);
    const pin = await savePin(orgId, branchId, { id: params.pinId, status_id: "deleted", status_note: "Deleted" }, actorFromContext(ctx as unknown as JsonObject));
    return { ok: true, pin };
  });

  app.post("/organizations/:orgId/branch/:branchId/pins/:pinId/promote", async (request) => {
    const params = asObject(request.params);
    const orgId = cleanText(params.orgId);
    const branchId = cleanText(params.branchId) || DEFAULT_BRANCH_ID;
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    await ensureCanvassingEnabled(orgId, branchId);
    const body = objectBodySchema.parse(request.body ?? {});
    const pin = await readPin(orgId, branchId, cleanText(params.pinId));
    const contact = normalizeContact(body.contact || pin.contact);
    const lead = await createPlatformLead(orgId, {
      branch_id: branchId,
      source_kind: "canvassing",
      stage_id: cleanText(body.stage_id || body.stage || "new_lead"),
      address: cleanText(body.address || pin.address),
      title: cleanText(body.title || pin.title || pin.address || "Canvassing lead"),
      summary: cleanText(body.summary || pin.notes || "Created from a canvassing pin."),
      contacts: contact.name || contact.email || contact.phone ? [contact] : [],
      provider: "Canvassing",
      confidence: 1,
      raw: { pin },
      lead_source: {
        kind: "canvassing",
        pin_id: pin.id,
        coordinates: pin.coordinates,
        status_id: pin.status_id,
        status_label: pin.status_label,
        canvasser: pin.created_by
      },
      notification: {
        source: "canvassing_lead_import",
        title: "New canvassing lead",
        context: { pin_id: pin.id }
      }
    });
    const updatedPin = await savePin(orgId, branchId, {
      ...pin,
      status_id: "lead_created",
      status_note: "Promoted to Platform lead",
      platform_project_id: asObject(lead.project).id,
      lead_created_at: nowIso()
    }, actorFromContext(ctx as unknown as JsonObject));
    const promotedProjectId = cleanText(asObject(lead.project).id);
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: branchId,
      ...(promotedProjectId ? { project_id: promotedProjectId } : {}),
      type: "canvassing.pin.promoted",
      idempotency_key: `canvassing.pin.promoted:${cleanText(pin.id)}`,
      payload: {
        pin_id: cleanText(pin.id),
        project_id: promotedProjectId,
        address: cleanText(updatedPin.address || pin.address)
      },
      context: { actor_user_id: cleanText(ctx.userId) }
    });
    return { ok: true, pin: updatedPin, ...lead };
  });

  app.get("/geocode/reverse", async (request) => {
    const query = asObject(request.query);
    await authContextFromRequest(request).catch(() => null);
    const lat = Number(query.lat);
    const lng = Number(query.lng ?? query.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw badRequest("invalid_coordinates", "lat and lng are required.");
    return { ok: true, result: await reverseGeocode(lat, lng, cleanText(request.headers.host)) };
  });
};
