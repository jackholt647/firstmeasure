import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ZodError, z } from "zod";

import { handleCommunicationsLegacyAction } from "../communications/api.js";
import { getAppleKeyInfo, readAppleKeyStore, setAppleKey } from "../firstmeasure/apple.js";
import { getFirstMeasureProjectIndexStatus, listIndexedProjectManifests, queryIndexedProjectManifests, rebuildFirstMeasureProjectIndex } from "../firstmeasure/project_index.js";
import { getCurrentRushMode, listRushModes } from "../firstmeasure/rush.js";
import { MANAGEMENT_TIME_ZONE, managementDateKey, managementDayBounds } from "../firstmeasure/reporting_time.js";
import {
  buildQaShiftLeaderboard,
  normalizeQaShiftDateKey,
  qaShiftDateKey,
  qaShiftQueryWindow,
  type QaShiftPointEvent
} from "../firstmeasure/qa_shifts.js";
import { getProjectDetail, listProjectFiles, patchManifest, saveAppMetadata } from "../firstmeasure/storage.js";
import { env } from "../src/config/env.js";
import {
  attachReferralOrganization,
  getReferralPartner as getCrmReferralPartner,
  listReferralPartners as listCrmReferralPartners,
  referralRewardReport as crmReferralRewardReport,
  referralRows as crmReferralRows,
  saveReferralPartner as saveCrmReferralPartner,
  searchReferralOrganizations,
  updateReferralRewardStatus as updateCrmReferralRewardStatus
} from "./crm/referrals.js";
import { PlatformError, badRequest, forbidden, notFound, unauthorized } from "../platform/errors.js";
import {
  addIdentityMembership,
  createAuthSession,
  createOrganization,
  createIdentity,
  findIdentityByEmail,
  listIdentityMemberships,
  listDocuments,
  listOrganizations,
  patchOrganization,
  patchIdentity,
  readGlobal,
  readOrganization,
  saveGlobal,
  upsertDocument
} from "../platform/storage.js";
import { authContextFromRequest, buildAuthContext, hashPassword, setPlatformAuthCookies } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import {
  asObject,
  deleteInternalUser,
  deleteInternalDocument,
  ensureInternalStorage,
  listInternalDocuments,
  listInternalUsers,
  patchInternalUser,
  readInternalDocument,
  readInternalUser,
  rebuildInternalUserIndex,
  saveInternalDocument,
  saveInternalUser
} from "./storage.js";
import {
  getDataAgentSettings,
  handleDataAgentLegacyAction,
  listDataAgentSessions,
  putDataAgentSettings
} from "./data_agent.js";
import { registerDiagnosticsApi } from "./diagnostics.js";
import {
  createInternalTeam,
  listInternalTeams,
  normalizeTeamId,
  readInternalTeam,
  updateInternalTeam
} from "./teams.js";
import {
  createPublicFirstMeasureApiKey,
  listPublicFirstMeasureApiKeys,
  readPublicFirstMeasureApiKey,
  revokePublicFirstMeasureApiKey,
  type PublicFirstMeasureApiKeyRecord
} from "../public-firstmeasure/keys.js";
import { createPublicFirstMeasureKeyDelivery } from "../public-firstmeasure/key_delivery.js";
import { hasPublicFirstMeasureApiKeySecret } from "../public-firstmeasure/key_secret_vault.js";

const objectSchema = z.object({}).passthrough();
const userSaveSchema = objectSchema.extend({
  email: z.string().optional(),
  name: z.string().optional()
});
const internalUserEmailSchema = z.string().trim().email().max(254);

type JsonObject = Record<string, unknown>;
const BONUS_OFFER_ID = "bonus_upfront_match_v1";
const BONUS_OFFER_ROLLOUT_COLLECTION = "bonus_offer_rollouts";
const technicianLeaderboardCache = new Map<string, { expiresAt: number; value: JsonObject }>();
const technicianLeaderboardInflight = new Map<string, Promise<JsonObject>>();

type CallScript = JsonObject & {
  id: string;
  title: string;
  description: string;
  body: string;
  created_at: number;
  updated_at: number;
  created_by_email: string;
  updated_by_email: string;
  usage_count: number;
  last_used_at: number;
};

export const registerInternalApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, success: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        success: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }
    app.log.error(error);
    reply.code(500);
    const payload: JsonObject = { ok: false, success: false, error: "internal_error", message: "An unexpected error occurred." };
    if (isDebugRequest(request)) {
      payload.debug = errorDebugPayload(error);
    }
    return reply.send(payload);
  });

  await ensureInternalStorage();

  app.get("/", async () => ({
    ok: true,
    success: true,
    api: "internal",
    routes: {
      me: "/me",
      users: "/users",
      organizations: "/organizations",
      stats: "/stats/overview",
      diagnostics: "/diagnostics",
      shifts: "/shifts/schedules",
      state: "/state/:collection",
      admin: "/admin"
    }
  }));

  void app.register(registerDiagnosticsApi, { prefix: "/diagnostics" });

  app.post("/legacy-action", async (request, reply) => {
    const body = objectSchema.parse(request.body ?? {});
    const result = await handleLegacyAction(app, body, request, reply);
    if (asObject(result).status_code) reply.code(Number(asObject(result).status_code));
    return result;
  });

  app.post("/tutorial-projects/:tutorialId/artifacts", async (request, reply) => {
    const params = asObject(request.params);
    const query = asObject(request.query);
    const requestActor = actorFromRequest(request);
    const actor = {
      ...requestActor,
      email: requestActor.email || String(query.actor_email ?? "").trim().toLowerCase(),
      name: requestActor.name || String(query.actor_name ?? "").trim(),
      role: requestActor.role || String(query.actor_role ?? "").trim()
    };
    const tutorialId = String(params.tutorialId ?? "").trim();
    const courseId = tutorialCourseId(query);
    const actorEmail = String(actor.email ?? "").trim().toLowerCase();
    const studentEmail = String(query.student_email ?? actorEmail).trim().toLowerCase();
    if (!actorEmail) return reply.code(401).send({ ok: false, success: false, error: "Not logged in" });
    if (!studentEmail || !isTutorialProjectId(tutorialId)) {
      return reply.code(400).send({ ok: false, success: false, error: "Invalid tutorial artifact upload request." });
    }
    if (studentEmail !== actorEmail && !(await canManageTutorials(actor))) {
      return reply.code(403).send({ ok: false, success: false, error: "Unauthorized" });
    }
    const dir = tutorialProjectDir(courseId, studentEmail, tutorialId);
    const manifest = asObject(await readJsonFile(path.join(dir, "manifest.json"), {}));
    if (String(manifest.id ?? "") !== tutorialId) {
      return reply.code(404).send({ ok: false, success: false, error: "Tutorial project not found." });
    }
    if (manifest.locked_for_student && studentEmail === actorEmail) {
      return reply.code(409).send({ ok: false, success: false, error: "This test project is locked." });
    }
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ ok: false, success: false, error: "No artifact was uploaded." });
    const requestedName = String(query.file_name ?? upload.filename ?? "artifact.bin");
    const fileName = path.basename(requestedName).replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "artifact.bin";
    const artifactsDir = path.join(dir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(path.join(artifactsDir, fileName), await upload.toBuffer());
    manifest.updated_at = new Date().toISOString();
    await writeJsonFile(path.join(dir, "manifest.json"), manifest);
    await makeTutorialProjectPhpWritable(dir);
    return { ok: true, success: true, artifact: { name: fileName } };
  });

  app.post("/tutorial-projects/:tutorialId/pdf-state", async (request, reply) => {
    const params = asObject(request.params);
    const query = asObject(request.query);
    const requestActor = actorFromRequest(request);
    const actor = {
      ...requestActor,
      email: requestActor.email || String(query.actor_email ?? "").trim().toLowerCase(),
      name: requestActor.name || String(query.actor_name ?? "").trim(),
      role: requestActor.role || String(query.actor_role ?? "").trim()
    };
    const upload = await request.file();
    if (!upload || upload.fieldname !== "pdf_state") {
      return reply.code(400).send({ ok: false, success: false, error: "The tutorial PDF grading snapshot was not uploaded." });
    }
    let pdfState: unknown;
    try {
      pdfState = JSON.parse((await upload.toBuffer()).toString("utf8"));
    } catch {
      return reply.code(400).send({ ok: false, success: false, error: "The tutorial PDF grading snapshot was not valid JSON." });
    }
    if (!pdfState || typeof pdfState !== "object" || Array.isArray(pdfState)) {
      return reply.code(400).send({ ok: false, success: false, error: "The tutorial PDF grading snapshot was empty." });
    }
    const result = await saveTutorialProjectEditor({
      course_id: query.course_id,
      student_email: query.student_email,
      tutorial_id: params.tutorialId,
      pdf_state: pdfState
    }, actor);
    const statusCode = Number(asObject(result).status_code);
    if (Number.isFinite(statusCode) && statusCode >= 400) reply.code(statusCode);
    return result;
  });

  app.get("/bootstrap", async (request) => {
    const actor = actorFromRequest(request);
    const [user, stats, status, featureFlags] = await Promise.all([
      actor.email ? readInternalUser(actor.email) : Promise.resolve(null),
      buildInternalStats(),
      readInternalDocument("portal_status", "current"),
      readInternalDocument("feature_flags", "current")
    ]);
    return {
      ok: true,
      success: true,
      actor,
      user: user ? publicInternalUser(user) : null,
      stats,
      portal_status: status?.data ?? {},
      feature_flags: featureFlags?.data ?? {}
    };
  });

  app.get("/me", async (request) => {
    const actor = actorFromRequest(request);
    const user = actor.email ? await readInternalUser(actor.email) : null;
    return {
      ok: true,
      success: true,
      authenticated: Boolean(user || actor.email),
      user: user ? publicInternalUser(user) : {
        id: actor.email || "",
        email: actor.email || "",
        name: actor.name || actor.email || "",
        role: actor.role || "user",
        department: actor.department || "",
        permissions: {}
      },
      actor
    };
  });

  app.get("/users", async (request) => {
    const query = asObject(request.query);
    const users = filterUsers(await listInternalUsers(query), query);
    return { ok: true, success: true, users: publicInternalUsers(users), count: users.length };
  });

  app.get("/users/team", async (request) => {
    const query = { ...asObject(request.query), visible_team: true };
    const users = filterUsers(await listInternalUsers(query), query);
    return { ok: true, success: true, users: publicInternalUsers(users), count: users.length };
  });

  app.get("/teams", async (request) => {
    const query = asObject(request.query);
    const [teams, users] = await Promise.all([
      listInternalTeams({ includeArchived: query.include_archived === "1" || query.include_archived === "true" }),
      listInternalUsers()
    ]);
    return {
      ok: true,
      success: true,
      teams: teams.map((team) => ({ ...team, stats: internalTeamStats(users, team.id) })),
      unassigned_stats: internalTeamStats(users, ""),
      count: teams.length
    };
  });

  app.post("/teams", async (request, reply) => {
    const body = objectSchema.parse(request.body ?? {});
    let team;
    try {
      team = await createInternalTeam(body);
    } catch (error) {
      throw teamInputError(error);
    }
    await assignManagersToTeam(team.id, team.manager_user_ids, actorFromRequest(request).email);
    reply.code(201);
    return { ok: true, success: true, team };
  });

  app.put("/teams/:teamId", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    let team;
    try {
      team = await updateInternalTeam(param(request.params, "teamId"), body);
    } catch (error) {
      throw teamInputError(error);
    }
    if (!team) throw notFound("internal_team_not_found", "Internal team was not found.");
    if (body.manager_user_ids !== undefined) {
      await assignManagersToTeam(team.id, team.manager_user_ids, actorFromRequest(request).email);
    }
    return { ok: true, success: true, team };
  });

  app.post("/admin/users-index/rebuild", async () => await rebuildInternalUserIndex());
  app.get("/admin/users-login-audit", async (request) => await auditInternalUserLogins(asObject(request.query)));
  app.post("/admin/users-login-sync", async (request) => await syncInternalUserLogins(objectSchema.parse(request.body ?? {})));

  app.get("/admin/firstmeasure-api-key-organizations", async (request) => {
    await requireInternalApiKeyAdmin(request);
    const query = asObject(request.query);
    const search = cleanText(query.q ?? query.search).toLowerCase();
    const keyFilter = ["all", "active", "none"].includes(cleanText(query.key_filter).toLowerCase())
      ? cleanText(query.key_filter).toLowerCase()
      : "active";
    const requestedPageSize = Number.parseInt(cleanText(query.per_page ?? query.page_size ?? query.limit), 10);
    const pageSize = Number.isFinite(requestedPageSize) ? Math.max(1, Math.min(100, requestedPageSize)) : 25;
    const requestedPage = Math.max(1, Number.parseInt(cleanText(query.page), 10) || 1);
    const internalOrgId = internalPlatformOrgId();
    const now = Date.now();
    const keyRecords = await listPublicFirstMeasureApiKeys();
    const keysByOrg = new Map<string, PublicFirstMeasureApiKeyRecord[]>();
    for (const record of keyRecords) {
      const orgId = cleanText(record.org_id);
      if (!orgId) continue;
      const records = keysByOrg.get(orgId) ?? [];
      records.push(record);
      keysByOrg.set(orgId, records);
    }
    const isActiveKey = (record: PublicFirstMeasureApiKeyRecord) => {
      if (record.status !== "active") return false;
      const expiresAt = Date.parse(cleanText(record.expires_at));
      return !Number.isFinite(expiresAt) || expiresAt > now;
    };
    const activeOrgIds = new Set(
      [...keysByOrg.entries()]
        .filter(([, records]) => records.some(isActiveKey))
        .map(([orgId]) => orgId)
    );

    // The common "active" view starts from the much smaller API-key registry and
    // reads only the organization manifests represented there. The other views
    // must enumerate organizations in order to include organizations without keys.
    const candidates = keyFilter === "active"
      ? (await Promise.all([...activeOrgIds].map((orgId) => readOrganization(orgId).catch(() => null))))
          .filter((organization): organization is JsonObject => Boolean(organization))
      : await listOrganizations();
    const matches = candidates
      .filter((organization) => cleanText(organization.id).toLowerCase() !== internalOrgId)
      .filter((organization) => keyFilter !== "none" || !activeOrgIds.has(cleanText(organization.id)))
      .filter((organization) => {
        if (!search) return true;
        const orgId = cleanText(organization.id);
        const keySearchText = (keysByOrg.get(orgId) ?? []).map((record) => [
          record.name,
          record.key_prefix,
          record.last4,
          record.mode,
          record.status
        ].join(" ")).join(" ");
        return `${cleanText(organization.name)} ${orgId} ${keySearchText}`.toLowerCase().includes(search);
      })
      .sort((a, b) => cleanText(a.name || a.id).localeCompare(cleanText(b.name || b.id), undefined, {
        numeric: true,
        sensitivity: "base"
      }));
    const total = matches.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const pageRows = matches.slice((page - 1) * pageSize, page * pageSize);
    return {
      ok: true,
      success: true,
      organizations: pageRows.map((organization) => {
        const orgId = cleanText(organization.id);
        const records = keysByOrg.get(orgId) ?? [];
        const activeRecords = records.filter(isActiveKey);
        return {
          id: orgId,
          name: cleanText(organization.name) || orgId,
          status: cleanText(organization.status) || "active",
          is_test: Boolean(organization.is_test ?? asObject(organization.metadata).is_test),
          active_key_count: activeRecords.length,
          total_key_count: records.length,
          latest_key_at: records[0]?.created_at ?? null
        };
      }),
      count: pageRows.length,
      total,
      key_filter: keyFilter,
      pagination: {
        page,
        per_page: pageSize,
        total_count: total,
        total_pages: totalPages
      }
    };
  });

  app.get("/admin/firstmeasure-api-keys", async (request) => {
    await requireInternalApiKeyAdmin(request);
    const query = asObject(request.query);
    const orgId = cleanText(query.org_id || query.organization_id);
    const records = await listPublicFirstMeasureApiKeys(orgId || undefined);
    return {
      ok: true,
      success: true,
      keys: await Promise.all(records.map(publicFirstMeasureApiKeyRecordWithDelivery)),
      count: records.length
    };
  });

  app.post("/admin/firstmeasure-api-keys", async (request, reply) => {
    setApiKeySecretResponseHeaders(reply);
    const actor = await requireInternalApiKeyAdmin(request);
    const body = objectSchema.parse(request.body ?? {});
    const orgId = cleanText(body.org_id || body.organization_id);
    if (!orgId) throw badRequest("missing_organization_id", "An organization is required.");
    const mode = normalizeFirstMeasureApiKeyMode(body.mode);
    const expiresAt = normalizeApiKeyExpiresAt(body.expires_at ?? body.expiration_date ?? body.expires);
    if (Boolean(body.revoke_existing)) {
      await revokeActivePublicFirstMeasureApiKeysForOrganization(orgId);
    }
    const created = await createPublicFirstMeasureApiKey({
      orgId,
      name: cleanText(body.name) || "FirstMeasure API key",
      mode,
      createdBy: cleanText(actor.email),
      expiresAt,
      metadata: {
        source: "internal_admin_portal",
        created_by_email: cleanText(actor.email),
        created_by_name: cleanText(actor.name)
      }
    });
    const delivery = body.create_delivery_link === false
      ? null
      : await createPublicFirstMeasureKeyDelivery({
        keyId: created.record.key_id,
        createdBy: cleanText(actor.email),
        ttlHours: body.delivery_ttl_hours
      });
    reply.code(201);
    return {
      ok: true,
      success: true,
      key: created.key,
      record: await publicFirstMeasureApiKeyRecordWithDelivery(created.record),
      delivery: delivery ? publicFirstMeasureKeyDeliveryResponse(request, delivery) : null
    };
  });

  app.post("/admin/firstmeasure-api-keys/:keyId/delivery-links", async (request, reply) => {
    setApiKeySecretResponseHeaders(reply);
    const actor = await requireInternalApiKeyAdmin(request);
    const body = objectSchema.parse(request.body ?? {});
    const delivery = await createPublicFirstMeasureKeyDelivery({
      keyId: param(request.params, "keyId"),
      createdBy: cleanText(actor.email),
      ttlHours: body.delivery_ttl_hours
    });
    reply.code(201);
    return {
      ok: true,
      success: true,
      delivery: publicFirstMeasureKeyDeliveryResponse(request, delivery)
    };
  });

  app.post("/admin/firstmeasure-api-keys/:keyId/revoke", async (request) => {
    await requireInternalApiKeyAdmin(request);
    const record = await revokePublicFirstMeasureApiKey(param(request.params, "keyId"));
    return {
      ok: true,
      success: true,
      record: await publicFirstMeasureApiKeyRecordWithDelivery(record)
    };
  });

  app.post("/admin/firstmeasure-api-keys/:keyId/reroll", async (request, reply) => {
    setApiKeySecretResponseHeaders(reply);
    const actor = await requireInternalApiKeyAdmin(request);
    const keyId = param(request.params, "keyId");
    const existing = await readPublicFirstMeasureApiKey(keyId);
    const body = objectSchema.parse(request.body ?? {});
    const expiresAt = Object.prototype.hasOwnProperty.call(body, "expires_at")
      || Object.prototype.hasOwnProperty.call(body, "expiration_date")
      || Object.prototype.hasOwnProperty.call(body, "expires")
      ? normalizeApiKeyExpiresAt(body.expires_at ?? body.expiration_date ?? body.expires)
      : (existing.expires_at ?? null);
    const mode = body.mode ? normalizeFirstMeasureApiKeyMode(body.mode) : existing.mode;
    const oldRecord = await revokePublicFirstMeasureApiKey(keyId);
    const created = await createPublicFirstMeasureApiKey({
      orgId: existing.org_id,
      name: cleanText(body.name) || existing.name || "FirstMeasure API key",
      mode,
      createdBy: cleanText(actor.email),
      expiresAt,
      scopes: existing.scopes,
      metadata: {
        ...asObject(existing.metadata),
        source: "internal_admin_portal",
        rerolled_from_key_id: existing.key_id,
        rerolled_by_email: cleanText(actor.email),
        rerolled_by_name: cleanText(actor.name)
      }
    });
    const delivery = body.create_delivery_link === false
      ? null
      : await createPublicFirstMeasureKeyDelivery({
        keyId: created.record.key_id,
        createdBy: cleanText(actor.email),
        ttlHours: body.delivery_ttl_hours
      });
    reply.code(201);
    return {
      ok: true,
      success: true,
      key: created.key,
      old_record: await publicFirstMeasureApiKeyRecordWithDelivery(oldRecord),
      record: await publicFirstMeasureApiKeyRecordWithDelivery(created.record),
      delivery: delivery ? publicFirstMeasureKeyDeliveryResponse(request, delivery) : null
    };
  });

  app.post("/users", async (request, reply) => {
    const body = userSaveSchema.parse(request.body ?? {});
    requireValidInternalUserEmail(body, true);
    await requireExistingTeamAssignment(body);
    const user = await saveInternalUser(body, { changedBy: actorFromRequest(request).email });
    await syncUserManagerTeam(user);
    const platform_login = await maybeSyncInternalUserPlatformLogin(user, body);
    reply.code(201);
    return { ok: true, success: true, user: publicInternalUser(user), platform_login };
  });

  app.get("/users/:userId", async (request) => {
    const user = await readInternalUser(param(request.params, "userId"));
    if (!user) throw notFound("internal_user_not_found", "Internal user was not found.");
    return { ok: true, success: true, user: publicInternalUser(user) };
  });

  app.put("/users/:userId", async (request) => {
    const body = userSaveSchema.parse(request.body ?? {});
    requireValidInternalUserEmail(body, false);
    await requireExistingTeamAssignment(body);
    const user = await saveInternalUser(
      { ...body, id: param(request.params, "userId") },
      { changedBy: actorFromRequest(request).email }
    );
    await syncUserManagerTeam(user);
    const platform_login = await maybeSyncInternalUserPlatformLogin(user, body);
    return { ok: true, success: true, user: publicInternalUser(user), platform_login };
  });

  app.patch("/users/:userId", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    await requireExistingTeamAssignment(body);
    const existing = await readInternalUser(param(request.params, "userId"));
    if (!existing) throw notFound("internal_user_not_found", "Internal user was not found.");
    const user = await saveInternalUser(
      { ...existing, ...body, id: existing.id },
      { changedBy: actorFromRequest(request).email }
    );
    await syncUserManagerTeam(user);
    if (!user) throw notFound("internal_user_not_found", "Internal user was not found.");
    return { ok: true, success: true, user: publicInternalUser(user) };
  });

  app.delete("/users/:userId", async (request) => {
    const deleted = await deleteInternalUser(param(request.params, "userId"));
    if (!deleted) throw notFound("internal_user_not_found", "Internal user was not found.");
    return { ok: true, success: true, deleted: true };
  });

  app.get("/queue/live-trained-users", async () => {
    const users = (await listInternalUsers()).filter((user) => {
      if (user.status === "disabled" || user.disabled === true) return false;
      return Boolean(user.training_complete);
    });
    return { ok: true, success: true, users: publicInternalUsers(users), count: users.length };
  });

  app.get("/queue/admin-teams", async () => {
    const teams = (await listInternalTeams()).map((team) => ({ id: team.id, label: team.name }));
    return { ok: true, success: true, teams };
  });

  app.get("/organizations", async (request) => {
    const query = asObject(request.query);
    if (query.paginate === "1" || query.paginate === "true" || query.paginate === true) {
      const result = await paginatedOrganizationDashboard(query);
      return { ok: true, success: true, ...result };
    }
    const organizations = compactOrganizationSummaries(await buildOrganizationSummaries(query));
    return { ok: true, success: true, organizations, count: organizations.length };
  });

  app.get("/organizations/dashboard", async (request) => {
    const query = asObject(request.query);
    if (query.paginate === "1" || query.paginate === "true" || query.paginate === true) {
      const result = await paginatedOrganizationDashboard(query);
      return { ok: true, success: true, ...result };
    }
    const organizations = compactOrganizationSummaries(await buildOrganizationSummaries(query));
    const totals = organizations.reduce((acc, org) => {
      acc.credits_balance += Number(org.credits_balance || 0);
      acc.users += Number(org.user_count || 0);
      if (org.is_test) acc.test_organizations += 1;
      return acc;
    }, { organizations: organizations.length, users: 0, credits_balance: 0, test_organizations: 0 });
    return { ok: true, success: true, organizations, totals };
  });

  app.get("/organizations/:orgId", async (request) => organizationDetail(param(request.params, "orgId"), asObject(request.query)));
  app.get("/organizations/:orgId/detail", async (request) => organizationDetail(param(request.params, "orgId"), asObject(request.query)));

  app.patch("/organizations/:orgId", async (request) => {
    const orgId = param(request.params, "orgId");
    const body = objectSchema.parse(request.body ?? {});
    const manifestPatch = asObject(body.manifest ?? body.organization ?? body);
    const globalPatch = asObject(body.global);
    const organization = Object.keys(manifestPatch).length ? await patchOrganization(orgId, manifestPatch) : await readOrganization(orgId);
    const global = Object.keys(globalPatch).length ? await saveGlobal(orgId, { data: globalPatch }) : await readGlobal(orgId);
    return { ok: true, success: true, organization, global };
  });

  app.post("/organizations/:orgId/sales-owner", async (request) => {
    const orgId = param(request.params, "orgId");
    const body = objectSchema.parse(request.body ?? {});
    const salesOwnerEmail = String(body.sales_owner_email ?? body.email ?? "").trim().toLowerCase();
    const organization = await patchOrganization(orgId, { sales_owner_email: salesOwnerEmail });
    return { ok: true, success: true, organization };
  });

  app.post("/organizations/:orgId/test-flag", async (request) => {
    const orgId = param(request.params, "orgId");
    const body = objectSchema.parse(request.body ?? {});
    const isTest = Boolean(body.is_test ?? body.test ?? body.enabled);
    const organization = await patchOrganization(orgId, { is_test: isTest, metadata: { is_test: isTest } });
    const global = await saveGlobal(orgId, { data: { is_test: isTest } });
    return { ok: true, success: true, organization, global, is_test: isTest };
  });

  app.get("/bonus-offers", async () => internalBonusOfferDashboard());
  app.get("/bonus-offers/customers", async () => {
    const customers = await internalBonusOfferCustomers();
    return { ok: true, success: true, customers, organizations: customers, count: customers.length };
  });
  app.get("/bonus-offers/rollouts", async () => {
    const rollouts = await internalBonusOfferRollouts();
    return { ok: true, success: true, rollouts, count: rollouts.length };
  });
  app.post("/bonus-offers/rollouts", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    return await internalLaunchBonusOfferRollout(body, actorFromRequest(request));
  });
  app.post("/bonus-offers/rollouts/:rolloutId/cancel", async (request) => {
    const body = objectSchema.parse(request.body ?? {});
    return await internalCancelBonusOfferRollout(param(request.params, "rolloutId"), body, actorFromRequest(request));
  });

  app.post("/admin/organizations/:orgId/app-flags", async (request) => {
    const actor = await requireInternalFeatureFlagAdmin(request);
    const orgId = param(request.params, "orgId");
    if (!orgId) throw badRequest("missing_organization_id", "An organization is required.");
    const body = objectSchema.parse(request.body ?? {});
    const patchData: JsonObject = {};
    const hasFlags = Object.prototype.hasOwnProperty.call(body, "app_flags") || Object.prototype.hasOwnProperty.call(body, "flags");
    const hasVariants = Object.prototype.hasOwnProperty.call(body, "app_variants") || Object.prototype.hasOwnProperty.call(body, "variants");
    if (hasFlags) patchData.app_flags = asObject(body.app_flags ?? body.flags);
    if (hasVariants) patchData.app_variants = asObject(body.app_variants ?? body.variants);
    if (!hasFlags && !hasVariants) throw badRequest("missing_app_flags", "App flags or variants are required.");
    const global = await saveGlobal(orgId, {
      data: patchData,
      metadata: {
        app_flags_updated_by_email: cleanText(actor.email).toLowerCase(),
        app_flags_updated_by_name: cleanText(actor.name),
        app_flags_updated_at: new Date().toISOString(),
        app_flags_source: "measure_internal_feature_flags"
      }
    });
    return { ok: true, success: true, org_id: orgId, global };
  });

  app.post("/organizations/:orgId/pairs", async (request) => {
    const orgId = param(request.params, "orgId");
    const body = objectSchema.parse(request.body ?? {});
    const leadIds = Array.isArray(body.lead_ids) ? body.lead_ids.map(String) : [];
    const global = await saveGlobal(orgId, {
      data: {
        paired_lead_ids: leadIds,
        paired_primary_lead_id: String(body.primary_lead_id ?? leadIds[0] ?? ""),
        paired_at: new Date().toISOString()
      }
    });
    return { ok: true, success: true, global };
  });

  app.get("/organizations/:orgId/credits", async (request) => {
    const orgId = param(request.params, "orgId");
    const query = asObject(request.query);
    const global = await readGlobal(orgId);
    const data = asObject(global.data);
    const limit = Math.max(0, Math.min(500, Number(query.limit ?? 100) || 100));
    const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger.slice(-limit).reverse() : [];
    return {
      ok: true,
      success: true,
      org_id: orgId,
      balance: numberValue(data.credits_balance),
      ledger,
      ledger_count: Array.isArray(data.credits_ledger) ? data.credits_ledger.length : 0
    };
  });

  app.post("/organizations/:orgId/credits/adjust", async (request) => {
    const orgId = param(request.params, "orgId");
    const body = objectSchema.parse(request.body ?? {});
    const result = await applyCreditDelta(orgId, body, actorFromRequest(request).email);
    return { ok: true, success: true, ...result };
  });

  app.get("/shifts/schedules", async (request) => {
    const users = filterShiftUsers(filterUsers(await listInternalUsers(), asObject(request.query)));
    return {
      ok: true,
      success: true,
      schedules: users.map((user) => shiftScheduleRow(user, String(asObject(request.query).week_of ?? ""))),
      users
    };
  });

  app.get("/shifts/me", async (request) => {
    const actor = actorFromRequest(request);
    const user = actor.email ? await readInternalUser(actor.email) : null;
    return {
      ok: true,
      success: true,
      schedule: user?.shift_schedule ?? {},
      user: user ? publicInternalUser(user) : null
    };
  });

  app.get("/shifts/current-status", async () => {
    const status = await readInternalDocument("shifts", "current_status");
    return { ok: true, success: true, status: status?.data ?? {}, document: status };
  });

  app.post("/shifts/current-status", async (request) => {
    const document = await saveInternalDocument("shifts", "current_status", objectSchema.parse(request.body ?? {}));
    return { ok: true, success: true, status: document.data, document };
  });

  app.get("/shifts/session-stats", async () => {
    const document = await readInternalDocument("shifts", "session_stats");
    return { ok: true, success: true, stats: document?.data ?? {}, document };
  });

  app.post("/shifts/schedules/:userId", async (request) => {
    await requireShiftScheduleManager(actorFromRequest(request));
    const userId = param(request.params, "userId");
    const body = objectSchema.parse(request.body ?? {});
    const schedule = asObject(body.shift_schedule ?? body.schedule ?? body);
    const user = await patchInternalUser(userId, { shift_schedule: schedule });
    if (!user) throw notFound("internal_user_not_found", "Internal user was not found.");
    return { ok: true, success: true, user: publicInternalUser(user), schedule: user.shift_schedule ?? {} };
  });

  app.post("/shifts/rates/:userId", async (request) => {
    await requireShiftScheduleManager(actorFromRequest(request));
    const userId = param(request.params, "userId");
    const body = objectSchema.parse(request.body ?? {});
    const user = await patchInternalUser(userId, { shift_rate: numberValue(body.shift_rate ?? body.rate) });
    if (!user) throw notFound("internal_user_not_found", "Internal user was not found.");
    return { ok: true, success: true, user: publicInternalUser(user), shift_rate: user.shift_rate };
  });

  app.get("/stats/overview", async (request) => {
    await requireFullInternalAdmin(actorFromRequest(request));
    return { ok: true, success: true, stats: await buildInternalStats() };
  });

  app.get("/portal/status", async () => {
    const document = await readInternalDocument("portal_status", "current");
    return { ok: true, success: true, status: document?.data ?? {}, document };
  });

  app.put("/portal/status", async (request) => {
    const document = await saveInternalDocument("portal_status", "current", objectSchema.parse(request.body ?? {}), { replace: true });
    return { ok: true, success: true, status: document.data, document };
  });

  app.get("/feature-flags", async () => {
    const document = await readInternalDocument("feature_flags", "current");
    return { ok: true, success: true, flags: document?.data ?? {}, document };
  });

  app.put("/feature-flags", async (request) => {
    const document = await saveInternalDocument("feature_flags", "current", objectSchema.parse(request.body ?? {}), { replace: true });
    return { ok: true, success: true, flags: document.data, document };
  });

  app.put("/admin/app-flag-defaults", async (request) => {
    const actor = await requireInternalFeatureFlagAdmin(request);
    const body = objectSchema.parse(request.body ?? {});
    const record = {
      schema_version: 1,
      id: "app_flag_defaults",
      data: {
        app_flags: asObject(body.app_flags || body.feature_flags || body.flags)
      },
      updated_at: new Date().toISOString(),
      updated_by: cleanText(actor.email).toLowerCase()
    };
    await writeJsonFile(platformAppFlagDefaultsConfigPath(), record);
    return { ok: true, success: true, defaults: record };
  });

  app.get("/server-config", async () => ({
    ok: true,
    success: true,
    configs: await listInternalDocuments("server_config")
  }));

  app.put("/server-config/:key", async (request) => {
    const document = await saveInternalDocument("server_config", param(request.params, "key"), objectSchema.parse(request.body ?? {}), { replace: true });
    return { ok: true, success: true, config: document };
  });

  app.get("/coupons", async (request) => {
    const coupons = filterInternalDocuments(await listInternalDocuments("coupons"), asObject(request.query));
    return { ok: true, success: true, coupons, count: coupons.length };
  });

  app.post("/coupons", async (request, reply) => {
    const body = objectSchema.parse(request.body ?? {});
    const id = String(body.id ?? body.code ?? `coupon_${Date.now()}`);
    const document = await saveInternalDocument("coupons", id, body, { replace: true });
    reply.code(201);
    return { ok: true, success: true, coupon: document };
  });

  app.get("/coupons/:id", async (request) => {
    const coupon = await readInternalDocument("coupons", param(request.params, "id"));
    if (!coupon) throw notFound("coupon_not_found", "Coupon was not found.");
    return { ok: true, success: true, coupon };
  });

  app.patch("/coupons/:id", async (request) => ({
    ok: true,
    success: true,
    coupon: await saveInternalDocument("coupons", param(request.params, "id"), objectSchema.parse(request.body ?? {}))
  }));

  app.delete("/coupons/:id", async (request) => {
    const deleted = await deleteInternalDocument("coupons", param(request.params, "id"));
    if (!deleted) throw notFound("coupon_not_found", "Coupon was not found.");
    return { ok: true, success: true, deleted };
  });

  app.get("/tutorials/:collection", async (request) => {
    const documents = filterInternalDocuments(await listInternalDocuments(`tutorials_${param(request.params, "collection")}`), asObject(request.query));
    return { ok: true, success: true, documents, count: documents.length };
  });

  app.put("/tutorials/:collection/:id", async (request) => ({
    ok: true,
    success: true,
    document: await saveInternalDocument(
      `tutorials_${param(request.params, "collection")}`,
      param(request.params, "id"),
      objectSchema.parse(request.body ?? {}),
      { replace: true }
    )
  }));

  app.get("/data-agent/settings", async () => {
    return await getDataAgentSettings();
  });

  app.put("/data-agent/settings", async (request) => {
    return await putDataAgentSettings(objectSchema.parse(request.body ?? {}), actorFromRequest(request));
  });

  app.get("/data-agent/sessions", async (request) => ({
    ...(await listDataAgentSessions(actorFromRequest(request))),
    query: asObject(request.query)
  }));

  app.put("/data-agent/sessions/:id", async (request) => ({
    ok: true,
    success: true,
    session: await saveInternalDocument("data_agent_sessions", param(request.params, "id"), objectSchema.parse(request.body ?? {}), { replace: true })
  }));

  app.delete("/data-agent/sessions/:id", async (request) => ({
    ok: true,
    success: true,
    deleted: await deleteInternalDocument("data_agent_sessions", param(request.params, "id"))
  }));

  app.put("/data-agent/runs/:id", async (request) => ({
    ok: true,
    success: true,
    run: await saveInternalDocument("data_agent_runs", param(request.params, "id"), objectSchema.parse(request.body ?? {}), { replace: true })
  }));

  app.get("/sample-reports/projects", async (request) => (
    sampleReportsList(app, asObject(request.query), actorFromRequest(request), request)
  ));

  app.get("/sample-reports/projects/:id/bundle", async (request) => (
    sampleReportsBundle(app, param(request.params, "id"), actorFromRequest(request), request)
  ));

  app.post("/sample-reports/favorites", async (request) => (
    sampleReportsToggleFavorite(asObject(request.body), actorFromRequest(request))
  ));

  app.get("/state/:collection", async (request) => {
    const collection = param(request.params, "collection");
    if (["manager_audit", "manager_review_samples", "manager_review_config"].includes(collection)) {
      await requireManagerReviewOverrideAccess(actorFromRequest(request));
    }
    return {
      ok: true,
      success: true,
      documents: filterInternalDocuments(await listInternalDocuments(collection), asObject(request.query))
    };
  });

  app.put("/state/:collection/:id", async (request) => {
    const collection = param(request.params, "collection");
    if (["manager_audit", "manager_review_samples", "manager_review_config"].includes(collection)) {
      await requireManagerReviewOverrideAccess(actorFromRequest(request));
    }
    return {
      ok: true,
      success: true,
      document: await saveInternalDocument(
        collection,
        param(request.params, "id"),
        objectSchema.parse(request.body ?? {}),
        { replace: true }
      )
    };
  });

  app.get("/admin/index-status", async () => ({
    ok: true,
    success: true,
    index: await getFirstMeasureProjectIndexStatus()
  }));

  app.post("/admin/reindex", async () => ({
    ok: true,
    success: true,
    result: await rebuildFirstMeasureProjectIndex()
  }));

  app.get("/admin/rush-modes/current", async () => {
    const current = await getCurrentRushMode();
    return {
      ...current,
      ok: true,
      success: true
    };
  });

  app.get("/admin/rush-modes", async () => ({
    ok: true,
    success: true,
    rush_modes: await listRushModes()
  }));

  app.get("/admin/apple-key", async () => ({
    ok: true,
    success: true,
    ...(await getAppleKeyInfo())
  }));

  app.post("/admin/apple-key", async (request) => ({
    ok: true,
    success: true,
    ...(await setAppleKey({ ...objectSchema.parse(request.body ?? {}), actor: actorFromRequest(request) }))
  }));
};

function param(params: unknown, key: string) {
  return String(asObject(params)[key] ?? "").trim();
}

function actorFromRequest(request: FastifyRequest) {
  const headers = request.headers;
  const query = asObject(request.query);
  const body = asObject(request.body);
  const bodyActor = asObject(body.actor);
  return {
    email: String(headers["x-internal-user-email"] ?? query.actor_email ?? query.email ?? bodyActor.email ?? body.actor_email ?? "").trim().toLowerCase(),
    name: String(headers["x-internal-user-name"] ?? query.actor_name ?? query.name ?? bodyActor.name ?? body.actor_name ?? "").trim(),
    role: String(headers["x-internal-user-role"] ?? query.actor_role ?? query.role ?? bodyActor.role ?? body.actor_role ?? "").trim(),
    department: String(headers["x-internal-user-department"] ?? query.department ?? bodyActor.department ?? body.department ?? "").trim()
  };
}

function isDebugRequest(request: FastifyRequest) {
  const debugHeader = String(firstHeaderValue(request.headers["x-firstmeasure-debug"]) ?? "").trim().toLowerCase();
  if (debugHeader !== "1" && debugHeader !== "true") return false;
  const body = asObject(request.body);
  const bodyActor = asObject(body.actor);
  const query = asObject(request.query);
  const role = String(
    bodyActor.role
      ?? body.actor_role
      ?? query.actor_role
      ?? firstHeaderValue(request.headers["x-internal-user-role"])
      ?? ""
  ).trim().toLowerCase();
  const email = String(
    bodyActor.email
      ?? body.actor_email
      ?? query.actor_email
      ?? firstHeaderValue(request.headers["x-internal-user-email"])
      ?? ""
  ).trim().toLowerCase();
  return role === "admin" || role === "system_admin" || email.endsWith("@1m8.ai");
}

function firstHeaderValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function errorDebugPayload(error: unknown): JsonObject {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }
  const data = error as Error & JsonObject;
  const cause = data.cause instanceof Error ? data.cause as Error & JsonObject : null;
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
    code: data.code ?? null,
    statusCode: data.statusCode ?? null,
    org_id: data.org_id ?? null,
    operation: data.operation ?? null,
    details: data.details ?? null,
    cause: cause ? {
      name: cause.name,
      message: cause.message,
      stack: cause.stack,
      code: cause.code ?? null
    } : null
  };
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function internalPlatformOrgId() {
  return cleanText(process.env.INTERNAL_PLATFORM_ORG_ID || process.env.STAFF_PLATFORM_ORG_ID || "legacy_internal").toLowerCase();
}

async function ensureInternalPlatformOrganization(orgId = internalPlatformOrgId()) {
  try {
    return await readOrganization(orgId);
  } catch (error) {
    if (!(error instanceof PlatformError) || error.statusCode !== 404) throw error;
  }
  try {
    return await createOrganization({
      id: orgId,
      name: orgId === "legacy_internal" ? "Internal Staff" : "Internal Staff Organization",
      status: "active",
      metadata: {
        kind: "internal_staff",
        internal_staff_org: true,
        source: "internal_users_sync",
        created_at: new Date().toISOString()
      },
      global: {
        kind: "internal_staff",
        internal_staff_org: true,
        credits_balance: 0,
        credits_ledger: [],
        contact: {},
        report_settings: {}
      }
    });
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 409) return await readOrganization(orgId);
    throw error;
  }
}

function platformUserRoleForInternal(user: JsonObject) {
  const role = cleanText(user.role || "member").toLowerCase();
  if (role === "admin" || role === "system_admin") return "admin";
  if (role === "manager" || role === "sales_manager") return "manager";
  return role || "member";
}

function publicInternalUser(user: JsonObject) {
  const value = { ...user };
  for (const key of ["password", "password_hash", "password_algo", "otp", "reset_token", "tokens"]) {
    delete value[key];
  }
  return value;
}

function publicInternalUsers(users: JsonObject[]) {
  return users.map(publicInternalUser);
}

async function passwordMaterialForInternalUser(user: JsonObject, input: JsonObject = {}) {
  const password = String(input.password ?? "").trim();
  if (password) {
    return {
      password_hash: await hashPassword(password),
      password_algo: "bcrypt",
      source: "submitted_password"
    };
  }

  const storedHash = cleanText(input.password_hash || user.password_hash);
  if (storedHash) {
    return {
      password_hash: storedHash,
      password_algo: cleanText(input.password_algo || user.password_algo || (storedHash.startsWith("$2y$") ? "php-password-hash" : "bcrypt")),
      source: "stored_password_hash"
    };
  }

  return null;
}

async function findIdentityByEmailOrNull(email: string) {
  try {
    return await findIdentityByEmail(email);
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode !== 404) throw error;
    return null;
  }
}

async function ensureInternalUserPlatformLogin(user: JsonObject, input: JsonObject = {}) {
  const passwordMaterial = await passwordMaterialForInternalUser(user, input);
  const email = cleanText(user.email || input.email).toLowerCase();
  if (!email) throw badRequest("missing_email", "An email is required to create a login.");

  const orgId = internalPlatformOrgId();
  await ensureInternalPlatformOrganization(orgId);

  let identity: JsonObject;
  let createdIdentity = false;
  const status = cleanText(user.status || "active") || "active";
  const identityPatch: JsonObject = {
    name: cleanText(user.name || input.name || email),
    status,
    metadata: {
      source: "internal_users_sync",
      internal_user_id: cleanText(user.id),
      synced_at: new Date().toISOString(),
      ...(passwordMaterial ? { password_source: passwordMaterial.source, invite_pending: false } : { invite_pending: true })
    }
  };
  if (passwordMaterial) {
    identityPatch.password_hash = passwordMaterial.password_hash;
    identityPatch.password_algo = passwordMaterial.password_algo;
  }

  const existingIdentity = await findIdentityByEmailOrNull(email);
  if (existingIdentity) {
    identity = existingIdentity;
    identity = await patchIdentity(String(identity.id ?? ""), identityPatch);
  } else {
    identity = await createIdentity({
      email,
      name: cleanText(user.name || input.name || email),
      status,
      password_hash: passwordMaterial?.password_hash ?? "",
      password_algo: passwordMaterial?.password_algo ?? "pending-invite",
      metadata: {
        source: "internal_users_sync",
        internal_user_id: cleanText(user.id),
        ...(passwordMaterial ? { password_source: passwordMaterial.source, invite_pending: false } : { invite_pending: true }),
        synced_at: new Date().toISOString()
      }
    });
    createdIdentity = true;
  }

  const role = platformUserRoleForInternal(user);
  const platformUser = await upsertDocument(
    orgId,
    "users",
    {
      id: cleanText(user.id || `user_${String(identity.id ?? "").replace(/^identity_/, "")}`),
      data: {
        identity_id: identity.id,
        email,
        name: cleanText(user.name || input.name || email),
        phone: cleanText(user.phone || ""),
        role,
        status: cleanText(user.status || "active") || "active",
        department: cleanText(user.department || "production"),
        team_id: cleanText(user.team_id || "default"),
        branch_id: cleanText(user.branch_id || "default"),
        permissions: asObject(user.permissions),
        profile: asObject(user.profile),
        metadata: {
          source: "internal_users_sync",
          internal_user_id: cleanText(user.id)
        }
      },
      metadata: { kind: "internal_staff_user", identity_id: identity.id }
    },
    { replace: true }
  );
  await addIdentityMembership(String(identity.id), orgId, String(platformUser.id), role);

  return {
    synced: true,
    org_id: orgId,
    created_identity: createdIdentity,
    identity_id: identity.id,
    user_id: platformUser.id,
    role,
    login_ready: Boolean(cleanText(identity.password_hash)),
    password_source: passwordMaterial?.source ?? "pending"
  };
}

async function maybeSyncInternalUserPlatformLogin(user: JsonObject, input: JsonObject) {
  return await ensureInternalUserPlatformLogin(user, input);
}

function isStrictInternalAdmin(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  return role === "admin"
    || role === "system_admin"
    || Boolean(user.is_admin)
    || Boolean(permissions.is_admin_legacy)
    || Boolean(permissions.platform_admin)
    || Boolean(permissions.manage_users);
}

function isInternalApiKeyAdmin(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  return role === "admin"
    || role === "system_admin"
    || Boolean(user.is_admin)
    || Boolean(permissions.is_admin_legacy)
    || Boolean(permissions.platform_admin);
}

function isFullInternalAdmin(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  return role === "admin"
    || role === "system_admin"
    || Boolean(user.is_admin)
    || Boolean(permissions.is_admin_legacy)
    || Boolean(permissions.platform_admin);
}

function canManageShiftSchedules(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  return isFullInternalAdmin(user)
    || role === "manager"
    || Boolean(permissions.manage_queue);
}

async function internalActorUser(actor: JsonObject) {
  const email = cleanText(actor.email).toLowerCase();
  if (!email) throw unauthorized("missing_internal_actor", "An authenticated internal user is required.");
  const user = await readInternalUser(email).catch(() => null);
  if (!user) throw unauthorized("unknown_internal_actor", "The internal user could not be verified.");
  return user;
}

async function requireFullInternalAdmin(actor: JsonObject) {
  const user = await internalActorUser(actor);
  if (!isFullInternalAdmin(user)) {
    throw forbidden("admin_required", "Only full admins can view statistics.");
  }
  return user;
}

async function requireShiftScheduleManager(actor: JsonObject) {
  const user = await internalActorUser(actor);
  if (!canManageShiftSchedules(user)) {
    throw forbidden("manager_required", "Only managers can edit shift schedules.");
  }
  return user;
}

async function requireInternalApiKeyAdmin(request: FastifyRequest) {
  const actor = actorFromRequest(request);
  const actorEmail = cleanText(actor.email).toLowerCase();
  if (!actorEmail) throw unauthorized("missing_internal_actor", "An internal admin user is required.");
  const user = await readInternalUser(actorEmail).catch(() => null);
  if (!isInternalApiKeyAdmin(user)) {
    throw forbidden("admin_required", "Only internal admins can manage FirstMeasure API keys.");
  }
  return {
    ...actor,
    user: user ? publicInternalUser(user) : null
  };
}

async function requireInternalFeatureFlagAdmin(request: FastifyRequest) {
  const actor = actorFromRequest(request);
  const actorEmail = cleanText(actor.email).toLowerCase();
  if (!actorEmail) throw unauthorized("missing_internal_actor", "An internal admin user is required.");
  const user = await readInternalUser(actorEmail).catch(() => null);
  const permissions = asObject(user?.permissions);
  if (!isStrictInternalAdmin(user) && !Boolean(permissions.manage_sales_users) && !Boolean(permissions.platform_admin)) {
    throw forbidden("admin_required", "Only internal admins can manage app feature flags.");
  }
  return {
    ...actor,
    user: user ? publicInternalUser(user) : null
  };
}

function normalizeFirstMeasureApiKeyMode(value: unknown): "test" | "live" {
  const mode = cleanText(value || "live").toLowerCase();
  if (mode === "test" || mode === "live") return mode;
  throw badRequest("invalid_api_key_mode", "API key mode must be live or test.");
}

function normalizeApiKeyExpiresAt(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);
  const parsed = new Date(dateOnly ? `${text}T23:59:59.999Z` : text);
  if (Number.isNaN(parsed.getTime())) {
    throw badRequest("invalid_api_key_expiration", "Expiration date is invalid.");
  }
  if (parsed.getTime() <= Date.now()) {
    throw badRequest("invalid_api_key_expiration", "Expiration date must be in the future.");
  }
  return parsed.toISOString();
}

function publicFirstMeasureApiKeyRecord(record: PublicFirstMeasureApiKeyRecord) {
  const expiresAt = cleanText(record.expires_at);
  const expiresTime = expiresAt ? Date.parse(expiresAt) : NaN;
  return {
    schema_version: record.schema_version,
    key_id: record.key_id,
    org_id: record.org_id,
    name: record.name,
    mode: record.mode,
    status: record.status,
    scopes: Array.isArray(record.scopes) ? record.scopes : [],
    key_prefix: record.key_prefix,
    last4: record.last4,
    created_at: record.created_at,
    created_by: record.created_by,
    expires_at: expiresAt || null,
    expired: Number.isFinite(expiresTime) ? expiresTime <= Date.now() : false,
    last_used_at: record.last_used_at,
    revoked_at: record.revoked_at,
    metadata: asObject(record.metadata)
  };
}

async function publicFirstMeasureApiKeyRecordWithDelivery(record: PublicFirstMeasureApiKeyRecord) {
  return {
    ...publicFirstMeasureApiKeyRecord(record),
    delivery_available: record.status === "active"
      && await hasPublicFirstMeasureApiKeySecret(record.key_id)
  };
}

function publicFirstMeasureKeyDeliveryResponse(
  request: FastifyRequest,
  created: Awaited<ReturnType<typeof createPublicFirstMeasureKeyDelivery>>
) {
  const forwardedHost = cleanText(request.headers["x-forwarded-host"]);
  const host = forwardedHost || cleanText(request.headers.host);
  const proto = cleanText(request.headers["x-forwarded-proto"]) || request.protocol || "https";
  const origin = host ? `${proto}://${host}` : "https://app.1m8.ai";
  return {
    ...created.delivery,
    url: `${origin.replace(/\/+$/, "")}/api-key-delivery/#${created.token}`
  };
}

function setApiKeySecretResponseHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("Referrer-Policy", "no-referrer");
}

async function revokeActivePublicFirstMeasureApiKeysForOrganization(orgId: string) {
  const records = await listPublicFirstMeasureApiKeys(orgId);
  const active = records.filter((record) => record.status === "active");
  await Promise.all(active.map((record) => revokePublicFirstMeasureApiKey(record.key_id)));
}

async function startCustomerImpersonation(request: FastifyRequest, reply: FastifyReply, body: JsonObject, actor: JsonObject) {
  const actorEmail = cleanText(actor.email).toLowerCase();
  if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "missing_admin_actor" };

  const adminUser = await readInternalUser(actorEmail).catch(() => null);
  if (!adminUser || !isStrictInternalAdmin(adminUser)) {
    return { ok: false, success: false, status_code: 403, error: "strict_admin_required" };
  }

  const email = cleanText(body.email || body.user_email).toLowerCase();
  const requestedOrgId = cleanText(body.org_id || body.organization_id);
  if (!email) return { ok: false, success: false, status_code: 400, error: "missing_user_email" };

  const identity = await findIdentityByEmailOrNull(email);
  if (!identity) return { ok: false, success: false, status_code: 404, error: "identity_not_found" };

  const memberships = await listIdentityMemberships(String(identity.id ?? "")).catch(() => []);
  const selected = memberships.find((entry) => {
    const organization = asObject(asObject(entry).organization);
    return requestedOrgId ? cleanText(organization.id) === requestedOrgId : cleanText(organization.id) !== internalPlatformOrgId();
  }) ?? (requestedOrgId ? undefined : memberships[0]);
  if (!selected) return { ok: false, success: false, status_code: 404, error: "membership_not_found" };

  const organization = asObject(asObject(selected).organization);
  const userDocument = asObject(asObject(selected).user);
  const user = asObject(userDocument.data);
  const orgId = cleanText(organization.id);
  const userId = cleanText(userDocument.id || user.id);
  if (!orgId || !userId) return { ok: false, success: false, status_code: 500, error: "invalid_membership" };

  const role = cleanText(user.role || asObject(selected).role || "member") || "member";
  const permissions = asObject(user.permissions);
  const branchId = cleanText(user.branch_id || "default") || "default";
  const restoreSessionId = await adminRestorePlatformSessionId(request, adminUser, actor);
  const { sessionId, session } = await createAuthSession({
    identity_id: identity.id,
    organization_id: orgId,
    user_id: userId,
    role,
    permissions_snapshot: permissions,
    branch_id: branchId,
    metadata: {
      impersonated: true,
      impersonated_by_email: actorEmail,
      impersonated_by_name: cleanText(actor.name || adminUser?.name || actorEmail),
      impersonated_at: new Date().toISOString(),
      restore_session_id: restoreSessionId,
      source: "internal_customers_tab"
    }
  });
  const ctx = await buildAuthContext(sessionId, session);
  setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);

  return {
    ok: true,
    success: true,
    impersonating: true,
    email,
    org_id: orgId,
    user_id: userId,
    admin_email: actorEmail,
    redirect_url: "/portal/"
  };
}

async function adminRestorePlatformSessionId(request: FastifyRequest, adminUser: JsonObject, actor: JsonObject) {
  const actorEmail = cleanText(actor.email || adminUser.email).toLowerCase();
  const current = await authContextFromRequest(request).catch(() => null);
  const currentMetadata = asObject(current?.session?.metadata);
  const nestedRestoreId = cleanText(currentMetadata.restore_session_id);
  if (nestedRestoreId) return nestedRestoreId;
  if (current && !cleanText(currentMetadata.impersonated_by_email)) return current.sessionId;

  const login = await ensureInternalUserPlatformLogin(adminUser, {});
  const { sessionId } = await createAuthSession({
    identity_id: login.identity_id,
    organization_id: login.org_id,
    user_id: login.user_id,
    role: login.role,
    permissions_snapshot: asObject(adminUser.permissions),
    branch_id: cleanText(adminUser.branch_id || "default") || "default",
    metadata: {
      source: "internal_customers_tab_restore_session",
      internal_admin_email: actorEmail,
      created_at: new Date().toISOString()
    }
  });
  return sessionId;
}

function loginAuditUserView(user: JsonObject, status: string, details: JsonObject = {}) {
  return {
    id: cleanText(user.id),
    email: cleanText(user.email).toLowerCase(),
    name: cleanText(user.name),
    role: cleanText(user.role),
    department: cleanText(user.department),
    team_id: cleanText(user.team_id),
    training_complete: Boolean(user.training_complete),
    has_stored_password_hash: Boolean(cleanText(user.password_hash)),
    status,
    ...details
  };
}

async function internalUserLoginStatus(user: JsonObject, orgId: string) {
  const email = cleanText(user.email).toLowerCase();
  if (!email) return loginAuditUserView(user, "missing_email");
  const identity = await findIdentityByEmailOrNull(email);
  if (!identity) return loginAuditUserView(user, "missing_identity");
  const memberships = await listIdentityMemberships(String(identity.id ?? "")).catch(() => []);
  const membership = memberships.find((entry) => {
    const organization = asObject(asObject(entry).organization);
    const userDoc = asObject(asObject(entry).user);
    const userData = asObject(userDoc.data);
    return cleanText(organization.id) === orgId
      && cleanText(userData.email).toLowerCase() === email;
  });
  if (!membership) {
    return loginAuditUserView(user, "missing_staff_membership", { identity_id: identity.id });
  }
  if (!cleanText(identity.password_hash)) {
    return loginAuditUserView(user, "missing_password", {
      identity_id: identity.id,
      platform_user_id: asObject(asObject(membership).user).id
    });
  }
  return loginAuditUserView(user, "ok", {
    identity_id: identity.id,
    platform_user_id: asObject(asObject(membership).user).id
  });
}

async function auditInternalUserLogins(query: JsonObject = {}) {
  const orgId = cleanText(query.org_id || internalPlatformOrgId()).toLowerCase();
  await ensureInternalPlatformOrganization(orgId);
  const includeAll = query.all === true || query.all === "1" || query.all === "true";
  const users = await listInternalUsers(includeAll ? {} : { visible_team: true });
  const rows = [];
  for (const user of users) rows.push(await internalUserLoginStatus(user, orgId));
  const counts = rows.reduce<Record<string, number>>((acc, row) => {
    const status = cleanText(row.status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    success: true,
    org_id: orgId,
    checked: rows.length,
    counts,
    needs_repair: rows.filter((row) => row.status !== "ok"),
    rows
  };
}

async function syncInternalUserLogins(body: JsonObject = {}) {
  const orgId = cleanText(body.org_id || internalPlatformOrgId()).toLowerCase();
  await ensureInternalPlatformOrganization(orgId);
  const dryRun = body.dry_run !== false && body.dry_run !== "0";
  const includeAll = body.all === true || body.all === "1" || body.all === "true";
  const defaultPassword = String(body.default_password ?? "").trim();
  const users = await listInternalUsers(includeAll ? {} : { visible_team: true });
  const results: JsonObject[] = [];

  for (const user of users) {
    const before = await internalUserLoginStatus(user, orgId);
    if (before.status === "ok") {
      results.push({ ...before, action: "none" });
      continue;
    }
    if (dryRun) {
      const canUseStoredPassword = Boolean(await passwordMaterialForInternalUser(user, {}));
      results.push({
        ...before,
        action: (before.status === "missing_identity" || before.status === "missing_password") && !defaultPassword
          ? (canUseStoredPassword ? "would_sync_existing_password" : "would_need_password")
          : "would_sync"
      });
      continue;
    }
    if ((before.status === "missing_identity" || before.status === "missing_password") && !defaultPassword && !(await passwordMaterialForInternalUser(user, {}))) {
      results.push({ ...before, action: "skipped", error: "default_password_required" });
      continue;
    }

    try {
      const syncInput = (before.status === "missing_identity" || before.status === "missing_password") ? { password: defaultPassword } : {};
      let platform_login = await ensureInternalUserPlatformLogin(user, syncInput);
      if (!platform_login.synced && before.status === "missing_staff_membership") {
        const identity = await findIdentityByEmail(cleanText(user.email).toLowerCase());
        const role = platformUserRoleForInternal(user);
        const platformUser = await upsertDocument(
          orgId,
          "users",
          {
            id: cleanText(user.id || `user_${String(identity.id ?? "").replace(/^identity_/, "")}`),
            data: {
              identity_id: identity.id,
              email: cleanText(user.email).toLowerCase(),
              name: cleanText(user.name || user.email),
              role,
              status: cleanText(user.status || "active") || "active",
              department: cleanText(user.department || "production"),
              team_id: cleanText(user.team_id || "default"),
              branch_id: cleanText(user.branch_id || "default"),
              permissions: asObject(user.permissions),
              profile: asObject(user.profile),
              metadata: { source: "internal_users_login_repair", internal_user_id: cleanText(user.id) }
            },
            metadata: { kind: "internal_staff_user", identity_id: identity.id }
          },
          { replace: true }
        );
        await addIdentityMembership(String(identity.id), orgId, String(platformUser.id), role);
        platform_login = {
          synced: true,
          org_id: orgId,
          created_identity: false,
          identity_id: identity.id,
          user_id: platformUser.id,
          role,
          login_ready: Boolean(cleanText(identity.password_hash)),
          password_source: "existing_identity"
        };
      }
      const after = await internalUserLoginStatus(user, orgId);
      results.push({ ...after, action: "synced", platform_login });
    } catch (error) {
      results.push({
        ...before,
        action: "failed",
        error: error instanceof Error ? error.message : "sync_failed"
      });
    }
  }

  const counts = results.reduce<Record<string, number>>((acc, row) => {
    const status = cleanText(row.status || "unknown");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    success: true,
    dry_run: dryRun,
    org_id: orgId,
    checked: results.length,
    counts,
    results
  };
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function filterUsers(users: JsonObject[], query: JsonObject) {
  const department = String(query.department ?? "").trim().toLowerCase();
  const teamId = String(query.team_id ?? query.team ?? "").trim().toLowerCase();
  const status = String(query.status ?? "").trim().toLowerCase();
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  return users.filter((user) => {
    if (department && String(user.department ?? "").toLowerCase() !== department) return false;
    if (teamId && String(user.team_id ?? "").toLowerCase() !== teamId) return false;
    if (status && String(user.status ?? "").toLowerCase() !== status) return false;
    if (search) {
      const haystack = `${user.name ?? ""} ${user.email ?? ""} ${user.team_id ?? ""} ${user.department ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function internalTeamStats(users: JsonObject[], teamId: string) {
  const normalizedTeamId = normalizeTeamId(teamId);
  const members = users.filter((user) => {
    if (user.disabled === true || String(user.status ?? "").toLowerCase() === "disabled") return false;
    if (String(user.account_type ?? "employee").toLowerCase() === "customer") return false;
    return normalizeTeamId(user.team_id) === normalizedTeamId;
  });
  const countRole = (role: string) => members.filter((user) => String(user.role ?? "").toLowerCase() === role).length;
  return {
    members: members.length,
    managers: countRole("manager"),
    qas: countRole("qa"),
    technicians: countRole("technician")
  };
}

function requireValidInternalUserEmail(input: JsonObject, required: boolean) {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email && !required) return;
  const parsed = internalUserEmailSchema.safeParse(email);
  if (!parsed.success) {
    throw badRequest(
      email ? "invalid_email" : "missing_email",
      email ? "Enter a valid email address." : "An email is required to create an internal user."
    );
  }
  input.email = parsed.data.toLowerCase();
}

function teamInputError(error: unknown) {
  const code = error instanceof Error ? error.message : "invalid_team";
  if (code === "team_name_required") return badRequest(code, "A team name is required.");
  if (code === "team_name_too_long") return badRequest(code, "Team names must be 100 characters or fewer.");
  return badRequest("invalid_team", "The team could not be saved.");
}

async function requireExistingTeamAssignment(input: JsonObject) {
  if (!("team_id" in input) && !("team" in input)) return;
  const teamId = normalizeTeamId(input.team_id ?? input.team);
  if (!teamId) return;
  if (!(await readInternalTeam(teamId))) {
    throw badRequest("internal_team_not_found", "Select an existing team or No Team.");
  }
}

async function assignManagersToTeam(teamId: string, managerUserIds: string[], changedBy: string) {
  if (!managerUserIds.length) return;
  const wanted = new Set(managerUserIds.map((value) => String(value).trim().toLowerCase()));
  const users = await listInternalUsers();
  for (const user of users) {
    const id = String(user.id ?? "").trim().toLowerCase();
    const email = String(user.email ?? "").trim().toLowerCase();
    if (!wanted.has(id) && !wanted.has(email)) continue;
    if (normalizeTeamId(user.team_id) === teamId) continue;
    const saved = await saveInternalUser({ ...user, team_id: teamId }, { changedBy });
    await syncUserManagerTeam(saved);
  }
}

async function syncUserManagerTeam(user: JsonObject) {
  const userId = String(user.id ?? "").trim().toLowerCase();
  const userEmail = String(user.email ?? "").trim().toLowerCase();
  if (!userId && !userEmail) return;
  const assignedTeamId = normalizeTeamId(user.team_id);
  const isManager = String(user.role ?? "").trim().toLowerCase() === "manager";
  const teams = await listInternalTeams({ includeArchived: true });
  for (const team of teams) {
    const withoutUser = team.manager_user_ids.filter((value) => {
      const normalized = String(value).trim().toLowerCase();
      return normalized !== userId && normalized !== userEmail;
    });
    if (isManager && assignedTeamId === team.id) withoutUser.push(userId || userEmail);
    const nextIds = [...new Set(withoutUser)];
    if (JSON.stringify(nextIds) === JSON.stringify(team.manager_user_ids)) continue;
    await updateInternalTeam(team.id, { manager_user_ids: nextIds });
  }
}

function leaderboardPacificDay(value: unknown) {
  const requested = String(value ?? "").trim();
  const match = requested.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) return requested;
  return managementDateKey();
}

function leaderboardDayBounds(date: string) {
  const bounds = managementDayBounds(date);
  return { startMs: bounds.startMs, endMs: Math.min(bounds.endExclusiveMs - 1, Date.now()) };
}

function projectLeaderboardTechnician(project: JsonObject) {
  const workflow = asObject(project.workflow);
  const histories = [project.work_history, workflow.work_history, workflow.history]
    .filter(Array.isArray)
    .flat() as unknown[];
  const technicianEvents = new Set(["submitted_for_qa", "correction_submitted", "claimed_new", "claimed_correction", "reopened_project_claimed"]);
  for (const rawEvent of [...histories].reverse()) {
    const event = asObject(rawEvent);
    if (!technicianEvents.has(String(event.event ?? event.type ?? "").toLowerCase())) continue;
    const email = String(event.worker_email ?? event.assigned_to_email ?? event.actor_email ?? event.user_email ?? event.by_email ?? "").trim().toLowerCase();
    if (email) return { email, name: String(event.worker_name ?? event.assigned_to_name ?? event.actor_name ?? event.user_name ?? email).trim() || email };
  }
  for (const [emailKey, nameKey] of [
    ["qa_paid_to_email", "qa_paid_to_name"],
    ["display_technician_email", "display_technician_name"],
    ["latest_technician_email", "latest_technician_name"],
    ["original_technician_email", "original_technician_name"],
    ["assigned_to_email", "assigned_to_name"],
    ["technician_email", "technician_name"],
    ["drafter_email", "drafter_name"]
  ] as const) {
    const email = String(project[emailKey] ?? "").trim().toLowerCase();
    if (email) return { email, name: String(project[nameKey] ?? email).trim() || email };
  }
  return { email: "", name: "" };
}

function projectQaReviewer(project: JsonObject) {
  for (const [emailKey, nameKey] of [
    ["qa_approved_by_email", "qa_approved_by_name"],
    ["qa_approved_by", "qa_approved_by_name"],
    ["qa_reviewed_by_email", "qa_reviewed_by_name"],
    ["qa_reviewed_by", "qa_reviewed_by_name"]
  ] as const) {
    const email = String(project[emailKey] ?? "").trim().toLowerCase();
    if (email) return { email, name: String(project[nameKey] ?? email).trim() || email };
  }
  const workflow = asObject(project.workflow);
  const histories = [project.work_history, workflow.work_history, workflow.history]
    .filter(Array.isArray)
    .flat() as unknown[];
  const qaEvents = new Set(["qa_approved", "qa_approved_pending_manager", "qa_reviewed"]);
  for (const rawEvent of [...histories].reverse()) {
    const event = asObject(rawEvent);
    if (!qaEvents.has(String(event.event ?? event.type ?? "").toLowerCase())) continue;
    const email = String(event.qa_email ?? event.qa_reviewer_email ?? event.by_email ?? event.user_email ?? event.actor_email ?? "").trim().toLowerCase();
    if (email) return { email, name: String(event.qa_name ?? event.qa_reviewer_name ?? event.user_name ?? event.actor_name ?? email).trim() || email };
  }
  return { email: "", name: "" };
}

function projectTimestampMs(project: JsonObject, ...keys: string[]) {
  const timestamps = asObject(project.timestamps);
  for (const key of keys) {
    const parsed = bonusOfferDateMs(project[key], timestamps[key]);
    if (parsed) return parsed;
  }
  return 0;
}

function projectLeaderboardPoints(project: JsonObject) {
  for (const key of ["point_value", "project_points", "points_value", "points"]) {
    const value = Number(project[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const raw = String(project.complexity ?? "").trim().toLowerCase();
  const normalized = /^\d+$/.test(raw) ? raw : raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const points: Record<string, number> = {
    "1": 2, "2": 3, "3": 4, "4": 6, "5": 10,
    very_simple: 2, very_simple_project: 2, simple: 3, simple_project: 3,
    standard: 4, standard_project: 4, complex: 6, complex_project: 6,
    very_complex: 10, very_complex_project: 10
  };
  return points[normalized] ?? 1;
}

async function buildCachedTechnicianLeaderboard(input: JsonObject) {
  const teamRaw = String(input.team ?? input.team_id ?? "all").trim();
  const teamId = !teamRaw || teamRaw.toLowerCase() === "all" ? "all" : teamRaw;
  const date = leaderboardPacificDay(input.date);
  const key = `${teamId.toLowerCase()}|${date}`;
  const force = parseBooleanish(input.force);
  const cached = technicianLeaderboardCache.get(key);
  if (!force && cached && cached.expiresAt > Date.now()) return { ...cached.value, cached: true };
  if (technicianLeaderboardInflight.has(key)) return await technicianLeaderboardInflight.get(key)!;

  const promise = (async () => {
    const startedAt = Date.now();
    const bounds = leaderboardDayBounds(date);
    const qaShiftDate = input.date ? normalizeQaShiftDateKey(input.date) : qaShiftDateKey();
    const qaShiftWindow = qaShiftQueryWindow(qaShiftDate);
    const [submissionResult, qaActivityResult, users] = await Promise.all([
      queryIndexedProjectManifests({
        // Projects retain their historical team. Team leaderboards follow the
        // technician's current roster team, so fetch candidates across teams
        // and apply the live-user filter below.
        activityStartMs: bounds.startMs,
        activityEndMs: bounds.endMs,
        // uploaded_at is the authoritative technician submission time. Include
        // completed_at in the candidate set for legacy rows that predate it.
        activityFields: ["uploaded", "completed"],
        limit: 20_000
      }),
      queryIndexedProjectManifests({
        activityStartMs: qaShiftWindow.queryStartMs,
        activityEndMs: qaShiftWindow.queryEndMs,
        activityFields: ["completed", "updated"],
        limit: 20_000
      }),
      listInternalUsers()
    ]);
    const qaEmails = new Set(users
      .filter((user) => String(user.role ?? "").toLowerCase() === "qa")
      .map((user) => String(user.email ?? "").trim().toLowerCase())
      .filter(Boolean));
    const rosterEmails = new Set(users
      .filter((user) => teamId === "all" || normalizeTeamId(user.team_id) === normalizeTeamId(teamId))
      .map((user) => String(user.email ?? "").trim().toLowerCase())
      .filter(Boolean));
    const rows = new Map<string, { email: string; name: string; completed_count: number; points: number; first_submission_at: string; last_submission_at: string }>();
    for (const manifest of submissionResult.projects) {
      const project = asObject(manifest);
      if (project.is_filler === true || project.is_tutorial_instance === true) continue;
      const submittedMs = projectTimestampMs(project, "uploaded_at", "completed_at");
      if (submittedMs < bounds.startMs || submittedMs > bounds.endMs) continue;
      const technician = projectLeaderboardTechnician(project);
      if (!technician.email || qaEmails.has(technician.email)) continue;
      if (teamId !== "all" && !rosterEmails.has(technician.email)) continue;
      const row = rows.get(technician.email) ?? {
        email: technician.email,
        name: technician.name || technician.email,
        completed_count: 0,
        points: 0,
        first_submission_at: new Date(submittedMs).toISOString(),
        last_submission_at: new Date(submittedMs).toISOString()
      };
      row.completed_count += 1;
      row.points += projectLeaderboardPoints(project);
      if (submittedMs < Date.parse(row.first_submission_at)) row.first_submission_at = new Date(submittedMs).toISOString();
      if (submittedMs > Date.parse(row.last_submission_at)) row.last_submission_at = new Date(submittedMs).toISOString();
      rows.set(technician.email, row);
    }
    const qaEvents: QaShiftPointEvent[] = [];
    for (const manifest of qaActivityResult.projects) {
      const project = asObject(manifest);
      if (project.is_filler === true || project.is_tutorial_instance === true) continue;
      const approvedMs = projectTimestampMs(project, "qa_approved_at", "qa_reviewed_at", "qa_completed_at");
      if (approvedMs < qaShiftWindow.queryStartMs || approvedMs > qaShiftWindow.queryEndMs) continue;
      const reviewer = projectQaReviewer(project);
      if (!reviewer.email) continue;
      if (teamId !== "all" && !rosterEmails.has(reviewer.email)) continue;
      qaEvents.push({
        email: reviewer.email,
        name: reviewer.name || reviewer.email,
        occurredAtMs: approvedMs,
        points: projectLeaderboardPoints(project),
        projectId: String(project.id ?? project.folder ?? project.project_id ?? "").trim()
      });
    }
    const qaShiftLeaderboard = buildQaShiftLeaderboard(qaEvents, qaShiftDate);
    const leaderboard = [...rows.values()].sort((a, b) =>
      b.points - a.points || b.completed_count - a.completed_count || a.name.localeCompare(b.name)
    );
    let rank = 0;
    let previous = "";
    leaderboard.forEach((row, index) => {
      row.points = Math.round(row.points * 100) / 100;
      const signature = `${row.points}|${row.completed_count}`;
      if (signature !== previous) rank = index + 1;
      (row as typeof row & { rank: number }).rank = rank;
      previous = signature;
    });
    const value: JsonObject = {
      ok: true,
      success: true,
      leaderboard,
      technicians: leaderboard,
      qa_stats: qaShiftLeaderboard.leaderboard,
      qa_shifts: qaShiftLeaderboard.shifts,
      qa_shift_date: qaShiftLeaderboard.date,
      qa_shift_timezone: qaShiftLeaderboard.timezone,
      qa_shift_gap_hours: qaShiftLeaderboard.shift_gap_hours,
      team: teamId,
      date,
      timezone: MANAGEMENT_TIME_ZONE,
      source: "project_index",
      cached: false,
      query_ms: Date.now() - startedAt
    };
    const today = leaderboardPacificDay("");
    technicianLeaderboardCache.set(key, {
      expiresAt: Date.now() + (date === today ? 20_000 : 3_600_000),
      value
    });
    if (technicianLeaderboardCache.size > 250) {
      const oldestKey = technicianLeaderboardCache.keys().next().value;
      if (oldestKey) technicianLeaderboardCache.delete(oldestKey);
    }
    return value;
  })().finally(() => technicianLeaderboardInflight.delete(key));

  technicianLeaderboardInflight.set(key, promise);
  return await promise;
}

function hasShiftScheduleBlocks(user: JsonObject) {
  const schedule = asObject(user.shift_schedule);
  const recurring = normalizeShiftDayMap(schedule.recurring);
  if (SHIFT_DAYS.some((day) => Array.isArray(recurring[day]) && (recurring[day] as unknown[]).length > 0)) return true;
  const overrides = normalizeShiftOverrides(schedule.overrides);
  return Object.keys(overrides).length > 0;
}

function filterShiftUsers(users: JsonObject[]) {
  return users.filter((user) => {
    if (user.disabled === true || String(user.status ?? "").toLowerCase() === "disabled") return false;
    if (String(user.account_type ?? "employee").toLowerCase() === "customer") return false;
    return Boolean(user.training_complete) || hasShiftScheduleBlocks(user);
  });
}

function filterInternalDocuments(documents: JsonObject[], query: JsonObject) {
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  const status = String(query.status ?? "").trim().toLowerCase();
  const offset = Math.max(0, Math.floor(Number(query.offset ?? 0)) || 0);
  const limit = Math.max(1, Math.min(500, Math.floor(Number(query.limit ?? 100)) || 100));
  const filtered = documents.filter((document) => {
    const data = asObject(document.data);
    if (status && String(data.status ?? document.status ?? "").toLowerCase() !== status) return false;
    if (!search) return true;
    return JSON.stringify({ id: document.id, data }).toLowerCase().includes(search);
  });
  return filtered.slice(offset, offset + limit);
}

function tutorialCourseId(input: JsonObject) {
  const raw = String(input.course_id ?? "default").trim().toLowerCase();
  if (!raw || raw === "default") return "default";
  const slug = raw.replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
  return slug || "default";
}

function defaultTutorialCourseForUser(user: JsonObject) {
  if (user.assigned_tutorial_course_id) {
    return tutorialCourseId({ course_id: user.assigned_tutorial_course_id });
  }
  const createdAt = String(user.created_at ?? "").trim();
  const createdTs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const refreshCutoffTs = Date.parse("2026-05-01T00:00:00");
  return Number.isFinite(createdTs) && createdTs < refreshCutoffTs ? "software-update-refresh" : "default";
}

function tutorialSafeUser(email: unknown) {
  const safe = String(email ?? "").trim().toLowerCase().replace(/[^a-zA-Z0-9_@.-]/g, "_");
  return safe || "anonymous";
}

function tutorialStorageRoot() {
  const configured = process.env.MEASURE_INTERNAL_TUTORIALS_ROOT || process.env.TUTORIALS_STORAGE_ROOT;
  if (configured) {
    return path.resolve(configured);
  }

  const publicRoot = path.resolve(process.cwd(), "..");
  return path.join(publicRoot, "storage", "measure", "internal", "tutorials");
}

function tutorialCourseBaseDir(courseId: string) {
  const root = tutorialStorageRoot();
  return courseId === "default" ? root : path.join(root, "courses", courseId);
}

function tutorialCurriculumPath(courseId: string) {
  return path.join(tutorialCourseBaseDir(courseId), "master", "curriculum.json");
}

function tutorialUserCourseDir(courseId: string, email: string) {
  return path.join(tutorialStorageRoot(), "users", tutorialSafeUser(email), "courses", courseId || "default");
}

function tutorialProgressPath(courseId: string, email: string) {
  return path.join(tutorialUserCourseDir(courseId, email), "progress.json");
}

function tutorialLegacyProgressPath(courseId: string, email: string) {
  return path.join(tutorialCourseBaseDir(courseId), tutorialSafeUser(email), "progress.json");
}

function tutorialProjectsDir(courseId: string, email: string) {
  return path.join(tutorialUserCourseDir(courseId, email), "projects");
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string, fallback: unknown = {}) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function platformAppFlagDefaultsConfigPath() {
  return path.join(path.resolve(process.cwd(), env.platformStorageRoot), "config", "app_flag_defaults.json");
}

function tutorialDefaultProgress(): JsonObject {
  return {
    completed_videos: [],
    completed_projects: [],
    current_chapter: 1,
    test_attempts: {}
  };
}

async function readTutorialProgress(courseId: string, email: string) {
  const primary = tutorialProgressPath(courseId, email);
  const legacy = tutorialLegacyProgressPath(courseId, email);
  const raw = await readJsonFile(await pathExists(primary) ? primary : legacy, tutorialDefaultProgress());
  const progress = { ...tutorialDefaultProgress(), ...asObject(raw) };
  if (!Array.isArray(progress.completed_videos)) progress.completed_videos = [];
  if (!Array.isArray(progress.completed_projects)) progress.completed_projects = [];
  if (!progress.test_attempts || typeof progress.test_attempts !== "object" || Array.isArray(progress.test_attempts)) progress.test_attempts = {};
  progress.current_chapter = Math.max(1, Math.floor(Number(progress.current_chapter ?? 1)) || 1);
  return progress;
}

async function listTutorialProjectsForUser(email: string, courseId: string) {
  const dir = tutorialProjectsDir(courseId, email);
  const projects: JsonObject[] = [];
  if (!(await pathExists(dir))) return projects;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^tutorial_[a-f0-9]{16,64}$/i.test(entry.name)) continue;
    await makeTutorialProjectPhpWritable(path.join(dir, entry.name));
    const manifest = asObject(await readJsonFile(path.join(dir, entry.name, "manifest.json"), {}));
    if (!Object.keys(manifest).length) continue;
    projects.push({
      ...manifest,
      id: entry.name,
      folder: entry.name,
      is_tutorial_instance: true,
      tutorial_course_id: courseId,
      original_master_id: manifest.source_project_id ?? manifest.original_master_id ?? ""
    });
  }
  projects.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  return projects;
}

function progressItemCount(value: unknown) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as JsonObject).length;
  return 0;
}

async function countTutorialProjectManifests(dir: string) {
  if (!(await pathExists(dir))) return 0;
  let count = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^tutorial_[a-f0-9]{16,64}$/i.test(entry.name)) continue;
      if (await pathExists(path.join(dir, entry.name, "manifest.json"))) count += 1;
    }
  } catch {
    return 0;
  }
  return count;
}

async function countTutorialProjectsForCourse(email: string, courseId: string) {
  const safe = tutorialSafeUser(email);
  const root = tutorialStorageRoot();
  const dirs = [
    tutorialProjectsDir(courseId, email),
    courseId === "default"
      ? path.join(root, safe, "projects")
      : path.join(root, "courses", courseId, safe, "projects")
  ];
  const seen = new Set<string>();
  let count = 0;
  for (const dir of dirs) {
    const key = path.resolve(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    count += await countTutorialProjectManifests(dir);
  }
  return count;
}

async function tutorialCandidateCourses(email: string, user: JsonObject, selectedCourseId: string) {
  const safe = tutorialSafeUser(email);
  const root = tutorialStorageRoot();
  const courses = new Set<string>([
    selectedCourseId,
    defaultTutorialCourseForUser(user),
    "default",
    "software-update-refresh"
  ]);
  const newCoursesRoot = path.join(root, "users", safe, "courses");
  if (await pathExists(newCoursesRoot)) {
    try {
      for (const entry of await readdir(newCoursesRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) courses.add(entry.name);
      }
    } catch {
      // Ignore unreadable per-user tutorial directories.
    }
  }
  const legacyCoursesRoot = path.join(root, "courses");
  if (await pathExists(legacyCoursesRoot)) {
    try {
      for (const entry of await readdir(legacyCoursesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
        if (await pathExists(path.join(legacyCoursesRoot, entry.name, safe))) courses.add(entry.name);
      }
    } catch {
      // Ignore unreadable legacy tutorial directories.
    }
  }
  return [...courses].filter(Boolean);
}

function sanitizeTutorialSourceProjectId(projectId: unknown) {
  return String(projectId ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function isTutorialProjectId(projectId: unknown) {
  return /^tutorial_[a-f0-9]{16,64}$/i.test(String(projectId ?? ""));
}

function tutorialProjectDir(courseId: string, email: string, tutorialId: string) {
  return path.join(tutorialProjectsDir(courseId, email), tutorialId);
}

async function makeTutorialProjectPhpWritable(dir: string) {
  // Tutorial grading/completion still runs in PHP. These files are created by
  // Node, so explicitly permit the PHP worker to update this isolated instance.
  await Promise.all([
    chmod(dir, 0o777).catch(() => undefined),
    chmod(path.join(dir, "artifacts"), 0o777).catch(() => undefined),
    ...["manifest.json", "answer_key.json", "metadata.json", "pdf_state.json"].map((name) =>
      chmod(path.join(dir, name), 0o666).catch(() => undefined)
    )
  ]);
}

async function newTutorialProjectId(courseId: string, email: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = `tutorial_${randomBytes(12).toString("hex")}`;
    if (!(await pathExists(tutorialProjectDir(courseId, email, id)))) return id;
  }
  return `tutorial_${randomBytes(16).toString("hex")}`;
}

function tutorialEditorUrl(courseId: string, tutorialId: string) {
  return `editor.php?tutorial=1&folder=${encodeURIComponent(tutorialId)}&course_id=${encodeURIComponent(courseId)}`;
}

async function createTutorialProjectInstance(
  sourceProjectIdRaw: unknown,
  courseId: string,
  email: string,
  chapterId: unknown,
  options: JsonObject = {}
) {
  const sourceProjectId = sanitizeTutorialSourceProjectId(sourceProjectIdRaw);
  if (!sourceProjectId || isTutorialProjectId(sourceProjectId)) {
    return { ok: false, success: false, status_code: 400, error: "A real source project ID is required." };
  }

  let sourceBundle: Awaited<ReturnType<typeof getProjectDetail>>;
  try {
    sourceBundle = await getProjectDetail(sourceProjectId);
  } catch {
    return { ok: false, success: false, status_code: 404, error: "Source project not found." };
  }

  const tutorialId = await newTutorialProjectId(courseId, email);
  const dir = tutorialProjectDir(courseId, email, tutorialId);
  const now = new Date().toISOString();
  const sourceManifest = asObject(sourceBundle.manifest);
  const manifest: JsonObject = {
    id: tutorialId,
    status: "tutorial_in_progress",
    is_tutorial_instance: true,
    tutorial_mode: true,
    tutorial_course_id: courseId,
    source_project_id: sourceProjectId,
    original_master_id: sourceProjectId,
    owner_email: email,
    chapter_id: Math.max(1, Math.floor(Number(chapterId)) || 1),
    source_address: sourceManifest.address ?? "",
    created_at: now,
    updated_at: now,
    tutorial_progress: {}
  };
  for (const key of ["tutorial_kind", "test_attempt_id", "test_id", "test_title", "test_sequence_index", "test_sequence_total", "test_started_at", "test_due_at", "draft_reject_attempt_id", "draft_reject_round_id", "draft_reject_title", "draft_reject_mode", "draft_reject_expected_decision", "draft_reject_sequence_index", "draft_reject_sequence_total", "draft_reject_started_at", "locked_for_student", "curriculum_project_id", "practice_project_name"]) {
    if (Object.prototype.hasOwnProperty.call(options, key)) manifest[key] = options[key];
  }

  await mkdir(path.join(dir, "artifacts"), { recursive: true });
  await writeJsonFile(path.join(dir, "manifest.json"), manifest);
  await writeJsonFile(path.join(dir, "answer_key.json"), {
    version: 0,
    source_project_id: sourceProjectId,
    generated_at: now,
    generated_by: "node_placeholder",
    metrics: null
  });
  await writeJsonFile(path.join(dir, "metadata.json"), {
    geometry: null,
    createdFromSourceProjectId: sourceProjectId,
    tutorialProjectId: tutorialId
  });
  await makeTutorialProjectPhpWritable(dir);

  return {
    ok: true,
    success: true,
    folder: tutorialId,
    tutorial_id: tutorialId,
    source_project_id: sourceProjectId,
    course_id: courseId,
    editor_url: tutorialEditorUrl(courseId, tutorialId)
  };
}

async function canManageTutorials(actor: JsonObject) {
  const role = String(actor.role ?? "").toLowerCase();
  if (role === "admin") return true;
  const email = String(actor.email ?? "").trim().toLowerCase();
  if (!email) return false;
  const user = await readInternalUser(email).catch(() => null);
  const permissions = asObject(user?.permissions);
  return Boolean(user?.is_admin || String(user?.role ?? "").toLowerCase() === "admin" || permissions.manage_tutorials || permissions.is_admin_legacy);
}

function tutorialProgressForTrainee(progressRaw: JsonObject) {
  const progress = structuredClone(progressRaw);
  const attempts = asObject(progress.test_attempts);
  for (const [attemptId, attemptRaw] of Object.entries(attempts)) {
    const attempt = asObject(attemptRaw);
    for (const key of ["final_score", "project_scores", "project_weights", "grading_version", "scored_at"]) {
      delete attempt[key];
    }
    if (["completed", "calculating", "submitted"].includes(String(attempt.status ?? "").toLowerCase())) {
      attempt.grade_hidden = true;
      attempt.score_status = "submitted";
    }
    attempts[attemptId] = attempt;
  }
  progress.test_attempts = attempts;
  return progress;
}

function tutorialProjectsForTrainee(projects: JsonObject[]) {
  return projects.map((projectRaw) => {
    const project = { ...projectRaw };
    const isExam = String(project.tutorial_kind ?? "") === "test" || Boolean(project.test_attempt_id);
    const isGradedDecisionRound = String(project.tutorial_kind ?? "") === "draft_reject"
      && String(project.draft_reject_mode ?? "") === "test";
    if (isExam || isGradedDecisionRound) {
      for (const key of ["score", "project_score", "score_details", "score_breakdown", "grading_version", "scored_at", "tutorial_score", "tutorial_score_details", "tutorial_grading_version", "tutorial_scored_at"]) {
        delete project[key];
      }
      project.grade_hidden = true;
      if (!["tutorial_in_progress", "in_progress"].includes(String(project.status ?? "").toLowerCase())) {
        project.score_status = "submitted";
        project.tutorial_score_status = "submitted";
      }
    }
    return project;
  });
}

function tutorialProjectSourceId(projectRaw: unknown) {
  const project = asObject(projectRaw);
  return project.project_id ?? project.source_project_id ?? project.id ?? "";
}

async function startTutorialTestAttempt(courseId: string, actorEmail: string, body: JsonObject) {
  const curriculum = asObject(await readJsonFile(tutorialCurriculumPath(courseId), { chapters: [] }));
  const chapters = Array.isArray(curriculum.chapters) ? curriculum.chapters.map(asObject) : [];
  const chapterNumber = Math.max(1, Math.floor(Number(body.chapter_id ?? body.chapter)) || 1);
  const chapter = chapters[chapterNumber - 1];
  if (!chapter) return { ok: false, success: false, status_code: 404, error: "Test chapter not found." };

  const tests = Array.isArray(chapter.tests) ? chapter.tests.map(asObject) : [];
  const requestedTestId = cleanText(body.test_id ?? body.test);
  const test = tests.find((candidate) => String(candidate.id ?? "test_1") === requestedTestId) ?? tests[0];
  if (!test) return { ok: false, success: false, status_code: 400, error: "This chapter does not include a test section." };
  const testId = String(test.id ?? "test_1");
  const progress = await readTutorialProgress(courseId, actorEmail);
  const attempts = asObject(progress.test_attempts);

  const previous = Object.values(attempts)
    .map(asObject)
    .filter((attempt) => String(attempt.type ?? "") !== "draft_reject")
    .filter((attempt) => String(attempt.chapter_id ?? "") === String(chapterNumber))
    .filter((attempt) => String(attempt.test_id ?? "test_1") === testId)
    .sort((a, b) => String(b.started_at ?? "").localeCompare(String(a.started_at ?? "")));
  const active = previous.find((attempt) => String(attempt.status ?? "") === "in_progress");
  const resumeAttempt = body.resume_attempt === true || String(body.resume_attempt ?? "").toLowerCase() === "true" || String(body.resume_attempt ?? "") === "1";
  if (resumeAttempt && active) {
    for (const tutorialId of Array.isArray(active.tutorial_project_ids) ? active.tutorial_project_ids : []) {
      const manifest = asObject(await readJsonFile(path.join(tutorialProjectDir(courseId, actorEmail, String(tutorialId)), "manifest.json"), {}));
      if (Object.keys(manifest).length && !manifest.locked_for_student) {
        return { ok: true, success: true, attempt_id: active.id, folder: tutorialId, editor_url: tutorialEditorUrl(courseId, String(tutorialId)) };
      }
    }
  }
  const completedPrevious = previous.filter((attempt) => ["completed", "submitted", "calculating"].includes(String(attempt.status ?? "")));
  if (completedPrevious.length && test.retakeable === false) {
    return { ok: false, success: false, status_code: 409, error: "This test cannot be retaken." };
  }
  const waitHours = Math.max(0, Math.floor(Number(test.retake_wait_hours ?? 0)) || 0);
  const latestPrevious = completedPrevious[0];
  if (latestPrevious && waitHours > 0 && latestPrevious.completed_at) {
    const readyAt = Date.parse(String(latestPrevious.completed_at)) + waitHours * 3600000;
    if (Number.isFinite(readyAt) && readyAt > Date.now()) {
      return { ok: false, success: false, status_code: 409, error: "This test is not available for retake yet." };
    }
  }

  const pool = (Array.isArray(test.projects) ? test.projects : [])
    .map((project) => ({ definition: asObject(project), source_project_id: sanitizeTutorialSourceProjectId(tutorialProjectSourceId(project)) }))
    .filter((project) => Boolean(project.source_project_id));
  if (!pool.length) return { ok: false, success: false, status_code: 400, error: "This test has no project pool." };
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const swap = pool[index]!;
    pool[index] = pool[swapIndex]!;
    pool[swapIndex] = swap;
  }
  const sampleCount = Math.max(1, Math.floor(Number(test.sample_count ?? Math.min(5, pool.length))) || 1);
  const selected = pool.slice(0, Math.min(sampleCount, pool.length));
  const attemptId = `test_${randomBytes(12).toString("hex")}`;
  const startedAt = new Date().toISOString();
  const timeLimitMinutes = Math.max(0, Math.floor(Number(test.time_limit_minutes ?? 0)) || 0);
  const dueAt = timeLimitMinutes ? new Date(Date.now() + timeLimitMinutes * 60000).toISOString() : null;
  const tutorialProjectIds: string[] = [];
  const projectWeights: JsonObject = {};

  for (const [index, selectedProject] of selected.entries()) {
    const created = await createTutorialProjectInstance(selectedProject.source_project_id, courseId, actorEmail, chapterNumber, {
      tutorial_kind: "test",
      test_attempt_id: attemptId,
      test_id: testId,
      test_title: test.title ?? "Test",
      test_sequence_index: index + 1,
      test_sequence_total: selected.length,
      test_started_at: startedAt,
      test_due_at: dueAt
    });
    if (!created.success) continue;
    const tutorialId = String(created.tutorial_id ?? created.folder ?? "");
    if (!tutorialId) continue;
    tutorialProjectIds.push(tutorialId);
    projectWeights[tutorialId] = Number.isFinite(Number(selectedProject.definition.weight)) ? Number(selectedProject.definition.weight) : 1;
  }
  if (!tutorialProjectIds.length) {
    return { ok: false, success: false, status_code: 500, error: "Could not create test project instances." };
  }

  attempts[attemptId] = {
    id: attemptId,
    chapter_id: chapterNumber,
    test_id: testId,
    test_title: test.title ?? "Test",
    status: "in_progress",
    score_status: "hidden",
    started_at: startedAt,
    due_at: dueAt,
    time_limit_minutes: timeLimitMinutes,
    passing_score_percent: Math.max(0, Math.min(100, Number(test.passing_score_percent ?? 80) || 80)),
    sample_count: tutorialProjectIds.length,
    completed_count: 0,
    project_scores: {},
    project_weights: projectWeights,
    tutorial_project_ids: tutorialProjectIds,
    source_project_ids: selected.map((project) => project.source_project_id)
  };
  progress.test_attempts = attempts;
  await writeJsonFile(tutorialProgressPath(courseId, actorEmail), progress);
  const firstTutorialId = tutorialProjectIds[0]!;
  return {
    ok: true,
    success: true,
    attempt_id: attemptId,
    folder: firstTutorialId,
    editor_url: tutorialEditorUrl(courseId, firstTutorialId)
  };
}

async function tutorialExamGrades(courseId: string) {
  const users = (await listInternalUsers()).filter((user) => String(user.account_type ?? "employee").toLowerCase() !== "customer");
  const rows: JsonObject[] = [];
  for (const user of users) {
    const email = String(user.email ?? "").trim().toLowerCase();
    if (!email) continue;
    const [progress, projects] = await Promise.all([
      readTutorialProgress(courseId, email),
      listTutorialProjectsForUser(email, courseId)
    ]);
    const projectsById = new Map(projects.map((project) => [String(project.id ?? ""), project]));
    for (const [attemptKey, attemptRaw] of Object.entries(asObject(progress.test_attempts))) {
      const attempt = asObject(attemptRaw);
      if (String(attempt.type ?? "") === "draft_reject") continue;
      const startedAt = String(attempt.started_at ?? "");
      const completedAt = String(attempt.completed_at ?? attempt.updated_at ?? "");
      const startMs = Date.parse(startedAt);
      const endMs = Date.parse(completedAt);
      const projectIds = Array.isArray(attempt.tutorial_project_ids) ? attempt.tutorial_project_ids.map(String) : [];
      const projectScores = asObject(attempt.project_scores);
      const projectWeights = asObject(attempt.project_weights);
      // Repair submissions made while PHP could calculate the grade and update
      // progress, but could not update the Node-owned project manifest.
      for (const tutorialId of projectIds) {
        const project = projectsById.get(tutorialId);
        const storedScore = asObject(projectScores[tutorialId]);
        if (!project || !Number.isFinite(Number(storedScore.score))) continue;
        const projectStatus = String(project.status ?? "").toLowerCase();
        const alreadySubmitted = Boolean(project.completed_at)
          || Boolean(project.locked_for_student)
          || projectStatus.includes("completed")
          || projectStatus.includes("locked");
        if (alreadySubmitted) continue;
        const repairedAt = String(storedScore.scored_at ?? attempt.updated_at ?? new Date().toISOString());
        const repairedProject: JsonObject = {
          ...project,
          status: "tutorial_completed",
          locked_for_student: true,
          completed_at: repairedAt,
          updated_at: repairedAt,
          tutorial_score: Number(storedScore.score),
          tutorial_score_status: storedScore.score_status ?? "scored",
          tutorial_score_details: {
            score: Number(storedScore.score),
            status: "scored",
            max_score: 100,
            grading_version: 5,
            categories: asObject(storedScore.categories)
          },
          tutorial_scored_at: repairedAt,
          tutorial_grading_version: 5
        };
        const projectDir = tutorialProjectDir(courseId, email, tutorialId);
        await writeJsonFile(path.join(projectDir, "manifest.json"), repairedProject);
        await makeTutorialProjectPhpWritable(projectDir);
        projectsById.set(tutorialId, repairedProject);
      }
      const projectRows = projectIds.map((tutorialId, index) => {
        const project = projectsById.get(tutorialId) ?? {};
        const storedScore = asObject(projectScores[tutorialId]);
        const manifestScore = project.tutorial_score;
        const score = storedScore.score ?? manifestScore ?? null;
        const storedCategories = asObject(storedScore.categories);
        const manifestCategories = asObject(asObject(project.tutorial_score_details).categories);
        const categories = Object.keys(storedCategories).length ? storedCategories : manifestCategories;
        const categoryScores = Object.fromEntries(
          ["line_types", "facet_count", "area", "pitch_areas"].map((key) => {
            const rawValue = asObject(categories[key]).score;
            const value = Number(rawValue);
            return [key, rawValue !== null && rawValue !== undefined && rawValue !== "" && Number.isFinite(value)
              ? Math.max(0, Math.min(25, value))
              : null];
          })
        );
        const projectStatus = String(project.status ?? "").toLowerCase();
        const submitted = Boolean(project.completed_at)
          || Boolean(project.locked_for_student)
          || projectStatus.includes("completed")
          || projectStatus.includes("locked");
        return {
          tutorial_id: tutorialId,
          sequence: Number(project.test_sequence_index ?? index + 1) || index + 1,
          label: project.address ?? project.source_address ?? project.source_project_id ?? tutorialId,
          status: project.status ?? "",
          submitted,
          score: typeof score === "number" && Number.isFinite(score) ? score : null,
          score_status: storedScore.score_status ?? project.tutorial_score_status ?? (submitted ? "calculating" : "in_progress"),
          category_scores: categoryScores,
          weight: Number.isFinite(Number(projectWeights[tutorialId])) ? Number(projectWeights[tutorialId]) : 1
        };
      });
      const scoredProjects = projectRows.filter((project) => typeof project.score === "number");
      const provisionalWeight = scoredProjects.reduce((sum, project) => sum + Math.max(0, Number(project.weight) || 1), 0);
      const provisionalScore = provisionalWeight > 0
        ? scoredProjects.reduce((sum, project) => sum + Number(project.score) * Math.max(0, Number(project.weight) || 1), 0) / provisionalWeight
        : null;
      const categoryScores = Object.fromEntries(
        ["line_types", "facet_count", "area", "pitch_areas"].map((key) => {
          const available = scoredProjects.filter((project) => {
            const value = asObject(project.category_scores)[key];
            return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
          });
          const weight = available.reduce((sum, project) => sum + Math.max(0, Number(project.weight) || 1), 0);
          const score = weight > 0
            ? available.reduce((sum, project) => sum + Number(asObject(project.category_scores)[key]) * Math.max(0, Number(project.weight) || 1), 0) / weight
            : null;
          return [key, score === null ? null : Math.round(score * 100) / 100];
        })
      );
      rows.push({
        attempt_key: attemptKey,
        attempt_id: attempt.id ?? attemptKey,
        student_name: user.name ?? email,
        student_email: email,
        exam_title: attempt.test_title ?? `Chapter ${attempt.chapter_id ?? ""} Test`,
        chapter_id: attempt.chapter_id ?? null,
        status: attempt.status ?? "",
        score_status: attempt.score_status ?? "",
        score: attempt.final_score ?? null,
        passed: attempt.passed ?? null,
        reviewed_at: attempt.admin_reviewed_at ?? null,
        reviewed_by_email: attempt.admin_reviewed_by_email ?? null,
        reviewed_by_name: attempt.admin_reviewed_by_name ?? null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null,
        scored_project_count: scoredProjects.length,
        total_project_count: projectRows.length,
        provisional_score: provisionalScore === null ? null : Math.round(provisionalScore * 100) / 100,
        category_scores: categoryScores,
        projects: projectRows
      });
    }
  }
  rows.sort((a, b) => String(b.completed_at ?? b.started_at ?? "").localeCompare(String(a.completed_at ?? a.started_at ?? "")));
  return rows;
}

async function saveTutorialProjectEditor(body: JsonObject, actor: JsonObject) {
  const courseId = tutorialCourseId(body);
  const actorEmail = String(actor.email ?? "").trim().toLowerCase();
  const studentEmail = String(body.student_email ?? actorEmail).trim().toLowerCase();
  const tutorialId = String(body.tutorial_id ?? body.project_id ?? "").trim();
  if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "Not logged in" };
  if (!studentEmail || !isTutorialProjectId(tutorialId)) {
    return { ok: false, success: false, status_code: 400, error: "Invalid tutorial project save request." };
  }
  if (studentEmail !== actorEmail && !(await canManageTutorials(actor))) {
    return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
  }
  const dir = tutorialProjectDir(courseId, studentEmail, tutorialId);
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = asObject(await readJsonFile(manifestPath, {}));
  if (!Object.keys(manifest).length || String(manifest.id ?? "") !== tutorialId) {
    return { ok: false, success: false, status_code: 404, error: "Tutorial project not found." };
  }
  if (manifest.locked_for_student && studentEmail === actorEmail) {
    return { ok: false, success: false, status_code: 409, error: "This test project is locked." };
  }

  let savedMetadata: JsonObject | null = null;
  if (body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)) {
    const metadataPath = path.join(dir, "metadata.json");
    savedMetadata = { ...asObject(await readJsonFile(metadataPath, {})), ...asObject(body.metadata) };
    await writeJsonFile(metadataPath, savedMetadata);
    const verified = asObject(await readJsonFile(metadataPath, {}));
    if (Object.prototype.hasOwnProperty.call(savedMetadata, "geometry")
      && JSON.stringify(verified.geometry ?? null) !== JSON.stringify(savedMetadata.geometry ?? null)) {
      return { ok: false, success: false, status_code: 500, error: "Tutorial geometry verification failed after saving." };
    }
  }
  if (Object.prototype.hasOwnProperty.call(body, "pdf_state")) {
    await writeJsonFile(path.join(dir, "pdf_state.json"), body.pdf_state);
  }
  manifest.updated_at = new Date().toISOString();
  const layerConfig = asObject(asObject(savedMetadata).layer_config);
  const radius = Number(asObject(layerConfig.__radius).scale);
  if (Number.isFinite(radius) && radius > 0) manifest.radius_meters = radius;
  await writeJsonFile(manifestPath, manifest);
  await makeTutorialProjectPhpWritable(dir);
  const geometry = asObject(asObject(savedMetadata).geometry);
  return {
    ok: true,
    success: true,
    folder: tutorialId,
    course_id: courseId,
    saved_geometry_points: Array.isArray(geometry.points) ? geometry.points.length : 0,
    saved_geometry_connections: Array.isArray(geometry.connections) ? geometry.connections.length : 0
  };
}

async function setTutorialExamReviewed(courseId: string, studentEmailRaw: unknown, attemptIdRaw: unknown, attemptKeyRaw: unknown, reviewed: boolean, actor: JsonObject) {
  const studentEmail = String(studentEmailRaw ?? "").trim().toLowerCase();
  const attemptId = String(attemptIdRaw ?? "").trim();
  if (!studentEmail || !attemptId) {
    return { ok: false, success: false, status_code: 400, error: "Student email and attempt ID are required." };
  }
  const progress = await readTutorialProgress(courseId, studentEmail);
  const attempts = asObject(progress.test_attempts);
  const requestedKey = String(attemptKeyRaw ?? "").trim();
  const attemptKey = requestedKey && Object.prototype.hasOwnProperty.call(attempts, requestedKey)
    ? requestedKey
    : Object.keys(attempts).find((key) => key === attemptId || String(asObject(attempts[key]).id ?? "") === attemptId);
  if (!attemptKey) return { ok: false, success: false, status_code: 404, error: "Exam attempt not found." };
  const attempt = asObject(attempts[attemptKey]);
  if (reviewed) {
    attempt.admin_reviewed_at = new Date().toISOString();
    attempt.admin_reviewed_by_email = actor.email ?? null;
    attempt.admin_reviewed_by_name = actor.name ?? null;
  } else {
    delete attempt.admin_reviewed_at;
    delete attempt.admin_reviewed_by_email;
    delete attempt.admin_reviewed_by_name;
  }
  attempts[attemptKey] = attempt;
  progress.test_attempts = attempts;
  await writeJsonFile(tutorialProgressPath(courseId, studentEmail), progress);
  return {
    ok: true,
    success: true,
    attempt_key: attemptKey,
    attempt_id: attemptId,
    student_email: studentEmail,
    reviewed_at: attempt.admin_reviewed_at ?? null,
    reviewed_by_email: attempt.admin_reviewed_by_email ?? null,
    reviewed_by_name: attempt.admin_reviewed_by_name ?? null
  };
}

async function handleTutorialLegacyAction(action: string, body: JsonObject, actor: JsonObject) {
  const courseId = tutorialCourseId(body);
  const actorEmail = String(actor.email ?? body.actor_email ?? body.user_email ?? "").trim().toLowerCase();

  if (action === "fetch_curriculum") {
    const curriculum = await readJsonFile(tutorialCurriculumPath(courseId), { chapters: [] });
    const isAdmin = await canManageTutorials(actor);
    const progress = actorEmail ? await readTutorialProgress(courseId, actorEmail) : tutorialDefaultProgress();
    return {
      ok: true,
      success: true,
      course_id: courseId,
      curriculum,
      progress: isAdmin ? progress : tutorialProgressForTrainee(progress),
      is_admin: isAdmin
    };
  }

  if (action === "save_curriculum") {
    if (!(await canManageTutorials(actor))) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
    const raw = body.curriculum;
    const curriculum = typeof raw === "string" ? JSON.parse(raw) : asObject(raw);
    if (!Array.isArray(asObject(curriculum).chapters)) return { ok: false, success: false, status_code: 400, error: "Invalid curriculum" };
    await writeJsonFile(tutorialCurriculumPath(courseId), curriculum);
    return { ok: true, success: true, course_id: courseId, curriculum };
  }

  if (action === "list_tutorial_projects") {
    if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "Not logged in" };
    const projects = await listTutorialProjectsForUser(actorEmail, courseId);
    return {
      ok: true,
      success: true,
      course_id: courseId,
      projects: (await canManageTutorials(actor)) ? projects : tutorialProjectsForTrainee(projects)
    };
  }

  if (action === "start_tutorial_test_attempt") {
    if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "Not logged in" };
    return await startTutorialTestAttempt(courseId, actorEmail, body);
  }

  if (action === "fetch_tutorial_exam_grades") {
    if (!(await canManageTutorials(actor))) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
    return { ok: true, success: true, course_id: courseId, attempts: await tutorialExamGrades(courseId) };
  }

  if (action === "set_tutorial_exam_reviewed") {
    if (!(await canManageTutorials(actor))) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
    const reviewed = body.reviewed === true || String(body.reviewed ?? "").toLowerCase() === "true" || String(body.reviewed ?? "") === "1";
    return await setTutorialExamReviewed(courseId, body.email ?? body.student_email, body.attempt_id, body.attempt_key, reviewed, actor);
  }

  if (action === "start_tutorial_project") {
    if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "Not logged in" };
    return await createTutorialProjectInstance(
      body.project_id ?? body.master_id ?? body.source_project_id,
      courseId,
      actorEmail,
      body.chapter_id,
      {
        curriculum_project_id: cleanText(body.curriculum_project_id),
        practice_project_name: cleanText(body.practice_project_name)
      }
    );
  }

  if (action === "update_progress") {
    if (!actorEmail) return { ok: false, success: false, status_code: 401, error: "Not logged in" };
    const progress = await readTutorialProgress(courseId, actorEmail);
    const type = String(body.type ?? "");
    const id = String(body.id ?? "");
    if (type === "video") {
      const completed = Array.isArray(progress.completed_videos) ? progress.completed_videos : [];
      const exists = completed.some((item) => typeof item === "string" ? item === id : asObject(item).url === id);
      if (!exists) completed.push({ url: id, date: new Date().toISOString() });
      progress.completed_videos = completed;
    } else if (type === "chapter_complete") {
      const chapterId = Math.max(1, Math.floor(Number(id)) || 1);
      progress.current_chapter = Math.max(Number(progress.current_chapter ?? 1), chapterId + 1);
    }
    await writeJsonFile(tutorialProgressPath(courseId, actorEmail), progress);
    return { ok: true, success: true, course_id: courseId, progress };
  }

  if (action === "fetch_student_list") {
    if (!(await canManageTutorials(actor))) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
    const users = (await listInternalUsers()).filter((user) => String(user.account_type ?? "employee").toLowerCase() !== "customer");
    const students = await Promise.all(users.map(async (user) => {
      const email = String(user.email ?? "");
      const selectedProgress = await readTutorialProgress(courseId, email);
      const selectedCompletedVideos = progressItemCount(selectedProgress.completed_videos);
      const selectedCompletedProjects = progressItemCount(selectedProgress.completed_projects);
      const selectedTestAttempts = progressItemCount(selectedProgress.test_attempts);
      const selectedProjectCount = await countTutorialProjectsForCourse(email, courseId);
      const currentChapter = Math.max(1, Math.floor(Number(selectedProgress.current_chapter ?? 1)) || 1);
      const selectedHasActivity = currentChapter > 1
        || selectedCompletedVideos > 0
        || selectedCompletedProjects > 0
        || selectedTestAttempts > 0
        || selectedProjectCount > 0;

      let completedVideos = 0;
      let completedProjects = 0;
      let testAttempts = 0;
      let projectCount = 0;
      let maxChapter = currentChapter;
      const activeCourses: string[] = [];
      for (const candidateCourseId of await tutorialCandidateCourses(email, user, courseId)) {
        const progress = await readTutorialProgress(candidateCourseId, email);
        const courseVideos = progressItemCount(progress.completed_videos);
        const courseProjects = progressItemCount(progress.completed_projects);
        const courseAttempts = progressItemCount(progress.test_attempts);
        const courseProjectCount = await countTutorialProjectsForCourse(email, candidateCourseId);
        const courseChapter = Math.max(1, Math.floor(Number(progress.current_chapter ?? 1)) || 1);
        completedVideos += courseVideos;
        completedProjects += courseProjects;
        testAttempts += courseAttempts;
        projectCount += courseProjectCount;
        maxChapter = Math.max(maxChapter, courseChapter);
        if (courseChapter > 1 || courseVideos > 0 || courseProjects > 0 || courseAttempts > 0 || courseProjectCount > 0) {
          activeCourses.push(candidateCourseId);
        }
      }

      const trainingComplete = Boolean(user.training_complete);
      const seenTutorial = Boolean(user.seen_tutorial);
      const hasActivity = trainingComplete
        || selectedHasActivity
        || maxChapter > 1
        || completedVideos > 0
        || completedProjects > 0
        || testAttempts > 0
        || projectCount > 0;
      const activityLabel = selectedHasActivity
        ? `Chapter ${currentChapter}`
        : trainingComplete
          ? "Training complete"
          : activeCourses.length
            ? "Active in another curriculum"
            : "Not started";
      return {
        email,
        name: user.name ?? "Unknown",
        current_chapter: currentChapter,
        has_activity: hasActivity,
        activity_label: activityLabel,
        training_complete: trainingComplete,
        seen_tutorial: seenTutorial,
        activity_counts: {
          completed_videos: completedVideos,
          completed_projects: completedProjects,
          test_attempts: testAttempts,
          tutorial_projects: projectCount,
          selected_completed_videos: selectedCompletedVideos,
          selected_completed_projects: selectedCompletedProjects,
          selected_test_attempts: selectedTestAttempts,
          selected_tutorial_projects: selectedProjectCount
        },
        last_active: "Unknown"
      };
    }));
    return { ok: true, success: true, course_id: courseId, students };
  }

  if (action === "fetch_student_details") {
    if (!(await canManageTutorials(actor))) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };
    const email = String(body.email ?? body.student_id ?? "").trim().toLowerCase();
    const progress = await readTutorialProgress(courseId, email);
    const projects = await listTutorialProjectsForUser(email, courseId);
    return { ok: true, success: true, course_id: courseId, progress, projects };
  }

  return {
    ok: false,
    success: false,
    status_code: 501,
    error: `${action} needs the PHP tutorial engine bridge to create tutorial project instances.`
  };
}

async function buildInternalStats() {
  const [users, organizations] = await Promise.all([listInternalUsers(), buildOrganizationSummaries({})]);
  return {
    internal_users: users.length,
    trained_users: users.filter((user) => user.training_complete).length,
    organizations: organizations.length,
    test_organizations: organizations.filter((org) => org.is_test).length,
    credits_balance: organizations.reduce((sum, org) => sum + Number(org.credits_balance || 0), 0)
  };
}

function orgBrandingSource(organization: JsonObject, globalData: JsonObject) {
  const metadata = asObject(organization.metadata);
  const legacyGlobal = asObject(globalData.legacy_org_snapshot);
  const legacyMetadata = asObject(metadata.legacy_snapshot);
  return {
    ...asObject(legacyMetadata.branding),
    ...asObject(legacyGlobal.branding),
    ...asObject(metadata.branding),
    ...asObject(globalData.branding)
  };
}

function normalizeOrgLogoUrl(value: unknown) {
  const logo = cleanText(value);
  if (!logo) return "";
  if (/^(https?:|data:)/i.test(logo)) return logo;
  if (logo.startsWith("/v1/")) return logo.replace(/\/file(\?|$)/, "/logo$1");
  if (logo.startsWith("/")) return logo.startsWith("/storage/") ? logo : "";
  return "";
}

function organizationBrandingView(orgId: string, organization: JsonObject, globalData: JsonObject) {
  const branding = orgBrandingSource(organization, globalData);
  const colors = asObject(branding.colors);
  const logoRaw = cleanText(branding.logo);
  const logoNodeUrl = normalizeOrgLogoUrl(branding.logo_node_url);
  const logoUrl = normalizeOrgLogoUrl(logoRaw) || logoNodeUrl;
  return {
    ...branding,
    logo: logoUrl,
    logo_url: logoUrl,
    logo_node_url: logoNodeUrl || logoUrl,
    logo_source: logoRaw,
    logo_import_source: cleanText(branding.logo_import_source),
    logo_migration_status: logoUrl ? "node" : (logoRaw ? "external_or_unknown" : "none"),
    colors: {
      primary: cleanText(colors.primary || colors.accent || "#d93025"),
      secondary: cleanText(colors.secondary || "#111111"),
      accent: cleanText(colors.accent || colors.primary || "#d93025")
    },
    organization_id: orgId
  };
}

type OrganizationSummaryCacheEntry = {
  expiresAt: number;
  organizations: JsonObject[];
  totals: JsonObject;
};

const ORGANIZATION_SUMMARY_CACHE_TTL_MS = 60_000;
const organizationSummaryCache = new Map<string, OrganizationSummaryCacheEntry>();

type StatsCreditRevenueCacheEntry = {
  expiresAt: number;
  payload: JsonObject;
};

const STATS_CREDIT_REVENUE_CACHE_TTL_MS = 60_000;
const statsCreditRevenueCache = new Map<string, StatsCreditRevenueCacheEntry>();

function clearOrganizationSummaryCache() {
  organizationSummaryCache.clear();
}

function clearStatsCreditRevenueCache() {
  statsCreditRevenueCache.clear();
}

function organizationSummaryCacheKey(query: JsonObject) {
  return JSON.stringify({
    q: cleanText(query.q ?? query.search).toLowerCase(),
    include_credits: query.include_credits !== false && query.include_credits !== "0",
    include_internal: query.include_internal === true || query.include_internal === "1" || query.include_internal === "true"
  });
}

async function compactCachedOrganizationSummaries(query: JsonObject) {
  const key = organizationSummaryCacheKey(query);
  const cached = organizationSummaryCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { organizations: cached.organizations, totals: cached.totals, cached: true };
  }
  const organizations = compactOrganizationSummaries(await buildOrganizationSummaries(query));
  const totals = summarizeOrganizations(organizations);
  organizationSummaryCache.set(key, {
    expiresAt: Date.now() + ORGANIZATION_SUMMARY_CACHE_TTL_MS,
    organizations,
    totals
  });
  return { organizations, totals, cached: false };
}

function customerDashboardFilters(value: unknown) {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return asObject(value);
}

function customerDashboardBoolean(value: unknown, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function customerDashboardPageSize(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 200;
  const rounded = Math.round(parsed / 100) * 100;
  return Math.max(100, Math.min(1000, rounded));
}

export function customerDashboardRowMatches(row: JsonObject, filters: JsonObject, search: string) {
  const users = Array.isArray(row.users) ? row.users : [];
  const searchable = [
    row.id,
    row.name,
    row.assigned_sales_name,
    row.assigned_sales_email,
    ...users.flatMap((user) => {
      const record = asObject(user);
      return [record.name, record.email];
    })
  ].map((value) => String(value ?? "").toLowerCase());
  if (search && !searchable.some((value) => value.includes(search))) return false;

  for (const [column, rawValue] of Object.entries(filters)) {
    const needle = String(rawValue ?? "").trim().toLowerCase();
    if (!needle) continue;
    let haystack = "";
    if (column === "name") haystack = String(row.name ?? "");
    else if (column === "email") {
      haystack = [
        asObject(row.contact).email,
        ...users.flatMap((user) => {
          const record = asObject(user);
          return [record.email, asObject(record.contact).email, asObject(record.profile).email];
        })
      ].map((value) => String(value ?? "")).join(" ");
    }
    else if (column === "users") haystack = String(users.length);
    else if (column === "lifetimeOrders") haystack = String(row.lifetimeOrders ?? 0);
    else if (column === "rolling7") haystack = String(row.rolling7 ?? 0);
    else if (column === "avgOrdersDay") haystack = String(row.avgOrdersDay ?? 0);
    else if (column === "credits") haystack = String(row.credits_balance ?? 0);
    else if (column === "salesperson") haystack = String(row.assigned_sales_name ?? row.assigned_sales_email ?? "Unassigned");
    else if (column === "created") {
      const created = row.created_at ? new Date(String(row.created_at)) : null;
      haystack = created && Number.isFinite(created.getTime())
        ? `${String(row.created_at)} ${created.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`
        : String(row.created_at ?? "");
    } else continue;
    if (!haystack.toLowerCase().includes(needle)) return false;
  }
  return true;
}

async function organizationMatchesCustomerEmail(orgId: string, needle: string) {
  if (!needle) return true;
  const [users, global] = await Promise.all([
    listDocuments(orgId, "users").catch(() => []),
    readGlobal(orgId).catch(() => null)
  ]);
  const globalData = asObject(global?.data);
  const emails = [
    asObject(globalData.contact).email,
    globalData.email,
    globalData.billing_email,
    ...users.flatMap((user) => {
      const record = asObject(user);
      const data = asObject(record.data);
      return [data.email, asObject(data.contact).email, asObject(data.profile).email];
    })
  ];
  return emails.some((email) => String(email ?? "").trim().toLowerCase().includes(needle));
}

function sortCustomerDashboardRows(rows: JsonObject[], sortColumn: string, sortDirection: string) {
  const direction = sortDirection === "desc" ? -1 : 1;
  const numericColumns = new Set(["users", "lifetimeOrders", "rolling7", "avgOrdersDay", "credits", "created"]);
  return [...rows].sort((a, b) => {
    let left: string | number = "";
    let right: string | number = "";
    if (sortColumn === "users") {
      left = Array.isArray(a.users) ? a.users.length : Number(a.user_count ?? 0);
      right = Array.isArray(b.users) ? b.users.length : Number(b.user_count ?? 0);
    } else if (sortColumn === "lifetimeOrders") {
      left = Number(a.lifetimeOrders ?? 0);
      right = Number(b.lifetimeOrders ?? 0);
    } else if (sortColumn === "rolling7") {
      left = Number(a.rolling7 ?? 0);
      right = Number(b.rolling7 ?? 0);
    } else if (sortColumn === "avgOrdersDay") {
      left = Number(a.avgOrdersDay ?? 0);
      right = Number(b.avgOrdersDay ?? 0);
    } else if (sortColumn === "credits") {
      left = Number(a.credits_balance ?? 0);
      right = Number(b.credits_balance ?? 0);
    } else if (sortColumn === "salesperson") {
      left = String(a.assigned_sales_name ?? a.assigned_sales_email ?? "zzzz").toLowerCase();
      right = String(b.assigned_sales_name ?? b.assigned_sales_email ?? "zzzz").toLowerCase();
    } else if (sortColumn === "created") {
      left = Date.parse(String(a.created_at ?? "")) || 0;
      right = Date.parse(String(b.created_at ?? "")) || 0;
    } else {
      left = String(a.name ?? a.id ?? "").toLowerCase();
      right = String(b.name ?? b.id ?? "").toLowerCase();
    }
    if (numericColumns.has(sortColumn)) return (Number(left) - Number(right)) * direction;
    return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: "base" }) * direction;
  });
}

function customerDashboardTotals(rows: JsonObject[]) {
  const real = rows.filter((row) => !row.is_test);
  const rolling7 = real.reduce((sum, row) => sum + Number(row.rolling7 ?? 0), 0);
  return {
    organizations: real.length,
    test_organizations: rows.length - real.length,
    users: real.reduce((sum, row) => sum + Number(row.user_count ?? (Array.isArray(row.users) ? row.users.length : 0)), 0),
    lifetime_orders: real.reduce((sum, row) => sum + Number(row.lifetimeOrders ?? 0), 0),
    rolling7,
    avg_orders_day: Math.round((rolling7 / 7) * 100) / 100,
    credits_balance: real.reduce((sum, row) => sum + Number(row.credits_balance ?? 0), 0)
  };
}

async function mapCustomerOrganizationsWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function paginatedOrganizationDashboard(query: JsonObject) {
  const pageSize = customerDashboardPageSize(query.per_page ?? query.page_size ?? query.limit);
  const requestedPage = Math.max(1, Number.parseInt(String(query.page ?? "1"), 10) || 1);
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  const filters = customerDashboardFilters(query.filters);
  const sortColumn = String(query.sort_col ?? query.sort ?? "name").trim() || "name";
  const sortDirection = String(query.sort_dir ?? query.direction ?? "asc").trim().toLowerCase() === "desc" ? "desc" : "asc";
  const hideTest = customerDashboardBoolean(query.hide_test, false);
  const hideCommissionPaid = customerDashboardBoolean(query.hide_commission_paid, false);
  const activeFilterColumns = Object.entries(filters)
    .filter(([, value]) => String(value ?? "").trim() !== "")
    .map(([column]) => column);
  const requiresCompleteSummaries = Boolean(
    search
    || activeFilterColumns.some((column) => !["name", "created", "email"].includes(column))
    || hideCommissionPaid
    || !["name", "created"].includes(sortColumn)
  );

  let matchingRows: JsonObject[];
  let totals: JsonObject;
  let totalsComplete = true;

  if (requiresCompleteSummaries) {
    const cached = await compactCachedOrganizationSummaries({ include_credits: true });
    matchingRows = cached.organizations
      .filter((row) => !hideTest || !row.is_test)
      .filter((row) => !hideCommissionPaid || Number(row.lifetimeOrders ?? 0) < 10)
      .filter((row) => customerDashboardRowMatches(row, filters, search));
    matchingRows = sortCustomerDashboardRows(matchingRows, sortColumn, sortDirection);
    totals = customerDashboardTotals(matchingRows);
  } else {
    const internalOrgId = internalPlatformOrgId();
    let manifests = (await listOrganizations())
      .filter((org) => String(org.id ?? "").toLowerCase() !== internalOrgId)
      .filter((org) => !hideTest || !Boolean(org.is_test ?? asObject(org.metadata).is_test));
    const nameFilter = String(filters.name ?? "").trim().toLowerCase();
    const createdFilter = String(filters.created ?? "").trim().toLowerCase();
    const emailFilter = String(filters.email ?? "").trim().toLowerCase();
    if (nameFilter) {
      manifests = manifests.filter((org) =>
        `${String(org.name ?? "")} ${String(org.id ?? "")}`.toLowerCase().includes(nameFilter)
      );
    }
    if (createdFilter) {
      manifests = manifests.filter((org) => {
        const raw = String(org.created_at ?? "");
        const created = raw ? new Date(raw) : null;
        const text = created && Number.isFinite(created.getTime())
          ? `${raw} ${created.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}`
          : raw;
        return text.toLowerCase().includes(createdFilter);
      });
    }
    if (emailFilter) {
      const emailMatches = await mapCustomerOrganizationsWithConcurrency(
        manifests,
        16,
        async (org) => organizationMatchesCustomerEmail(String(org.id ?? ""), emailFilter)
      );
      manifests = manifests.filter((_, index) => emailMatches[index]);
    }
    manifests.sort((a, b) => {
      if (sortColumn === "created") {
        const delta = (Date.parse(String(a.created_at ?? "")) || 0) - (Date.parse(String(b.created_at ?? "")) || 0);
        return sortDirection === "desc" ? -delta : delta;
      }
      const delta = String(a.name ?? a.id ?? "").localeCompare(String(b.name ?? b.id ?? ""), undefined, { numeric: true, sensitivity: "base" });
      return sortDirection === "desc" ? -delta : delta;
    });
    const totalCount = manifests.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
    const page = Math.min(requestedPage, totalPages);
    const pageManifests = manifests.slice((page - 1) * pageSize, page * pageSize);
    matchingRows = compactOrganizationSummaries(await mapCustomerOrganizationsWithConcurrency(
      pageManifests,
      16,
      (org) => buildOrganizationSummaryRow(org, true)
    ));
    totals = {
      organizations: totalCount,
      test_organizations: 0,
      users: null,
      lifetime_orders: null,
      rolling7: null,
      avg_orders_day: null,
      credits_balance: null
    };
    totalsComplete = false;
    return {
      organizations: matchingRows,
      orgs: matchingRows,
      count: matchingRows.length,
      totals,
      totals_complete: totalsComplete,
      pagination: {
        page,
        per_page: pageSize,
        total_count: totalCount,
        total_pages: totalPages
      }
    };
  }

  const totalCount = matchingRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const page = Math.min(requestedPage, totalPages);
  const organizations = matchingRows.slice((page - 1) * pageSize, page * pageSize);
  return {
    organizations,
    orgs: organizations,
    count: organizations.length,
    totals,
    totals_complete: totalsComplete,
    pagination: {
      page,
      per_page: pageSize,
      total_count: totalCount,
      total_pages: totalPages
    }
  };
}

async function buildOrganizationSummaries(query: JsonObject) {
  const search = String(query.q ?? query.search ?? "").trim().toLowerCase();
  const includeCredits = query.include_credits !== false && query.include_credits !== "0";
  const includeInternal = query.include_internal === true || query.include_internal === "1" || query.include_internal === "true";
  const internalOrgId = internalPlatformOrgId();
  const orgs = await listOrganizations();
  const visibleOrgs = orgs.filter((org) => includeInternal || String(org.id ?? "").toLowerCase() !== internalOrgId);
  const rows = await mapCustomerOrganizationsWithConcurrency(
    visibleOrgs,
    16,
    (org) => buildOrganizationSummaryRow(org, includeCredits)
  );
  return rows.filter((row) => {
    if (!search) return true;
    return `${row.id} ${row.name} ${row.sales_owner_email ?? ""}`.toLowerCase().includes(search);
  });
}

type OrganizationSummaryPreloadedData = {
  global: Awaited<ReturnType<typeof readGlobal>>;
  users: Awaited<ReturnType<typeof listDocuments>>;
  projects: Awaited<ReturnType<typeof listDocuments>>;
  indexedProjectRows: Awaited<ReturnType<typeof firstMeasureProjectRowsForOrg>>;
};

async function buildOrganizationSummaryRow(
  org: JsonObject,
  includeCredits: boolean,
  preloaded?: OrganizationSummaryPreloadedData
) {
  const orgId = String(org.id ?? "");
  try {
    const loaded = preloaded ?? await (async () => {
      const [global, users, projects, indexedProjectRows] = await Promise.all([
        readGlobal(orgId).catch(() => null),
        listDocuments(orgId, "users").catch(() => []),
        listDocuments(orgId, "projects").catch(() => []),
        firstMeasureProjectRowsForOrg(orgId)
      ]);
      return { global, users, projects, indexedProjectRows };
    })();
    const { global, users, projects, indexedProjectRows } = loaded;
    const globalData = asObject(global?.data);
    const projectRows = projectRowsWithUserReferences(projects, users, indexedProjectRows);
    const contacts = contactRowsForProjects(projectRows);
    const customerUsers = users.map((user) => organizationUserView(user, projectRows));
    const orderEvents = orderEventsForProjects(projectRows);
    const lifetimeOrders = projectRows.length;
    const rolling7 = countUsageEventsRecent(orderEvents, 7);
    const latestOrderEvent = [...orderEvents].sort((a, b) => b.date_ms - a.date_ms)[0] ?? null;
    const latestOrder = latestOrderEvent?.project ?? null;
    const latestOrderMs = orderEvents.reduce((max, event) => Math.max(max, event.date_ms), 0);
    const daysSinceLastOrder = latestOrderMs ? Math.max(0, (Date.now() - latestOrderMs) / 86_400_000) : null;
    const inactive = !latestOrderMs || daysSinceLastOrder !== null && daysSinceLastOrder > 14;
    const lastActiveRolling7 = latestOrderMs
      ? orderEvents.filter((event) => event.date_ms >= latestOrderMs - 7 * 86_400_000 && event.date_ms <= latestOrderMs).length
      : 0;
    const creditsLedger = Array.isArray(globalData.credits_ledger) ? globalData.credits_ledger : [];
    const salesOwnerEmail = String(org.sales_owner_email ?? globalData.sales_owner_email ?? globalData.assigned_sales_email ?? "").trim().toLowerCase();
    return {
      id: orgId,
      name: String(org.name ?? orgId),
      status: String(org.status ?? "active"),
      created_at: org.created_at ?? null,
      updated_at: org.updated_at ?? null,
      sales_owner_email: salesOwnerEmail || null,
      assigned_sales_email: salesOwnerEmail || null,
      assigned_sales_name: globalData.assigned_sales_name ?? (salesOwnerEmail || ""),
      assigned_sales_by_email: globalData.assigned_sales_by_email ?? null,
      assigned_sales_at: globalData.assigned_sales_at ?? null,
      is_test: Boolean(org.is_test ?? asObject(org.metadata).is_test ?? globalData.is_test),
      users: customerUsers,
      user_count: customerUsers.length,
      contacts,
      contact_count: contacts.length,
      latest_credit_entry: creditsLedger.length ? creditsLedger[creditsLedger.length - 1] : null,
      credits_balance: organizationCreditBalance(org, globalData, includeCredits),
      credits_ledger: includeCredits ? creditsLedger : undefined,
      credits_ledger_count: includeCredits ? creditsLedger.length : undefined,
      free_expedite_uses: Math.max(0, Math.round(numberValue(globalData.free_expedite_uses))),
      free_expedite_ledger: Array.isArray(globalData.free_expedite_ledger) ? globalData.free_expedite_ledger : [],
      free_expedite_ledger_count: Array.isArray(globalData.free_expedite_ledger) ? globalData.free_expedite_ledger.length : 0,
      paired_lead_ids: Array.isArray(globalData.paired_lead_ids) ? globalData.paired_lead_ids : [],
      paired_primary_lead_id: globalData.paired_primary_lead_id ?? null,
      paired_at: globalData.paired_at ?? null,
      paired_leads: Array.isArray(globalData.paired_leads) ? globalData.paired_leads : [],
      contact: globalData.contact ?? null,
      billing: globalData.billing ?? null,
      report_settings: globalData.report_settings ?? null,
      ...globalData,
      projects: projectRows,
      orders: projectRows,
      latest_order: latestOrder,
      latest_order_at: latestOrderMs ? new Date(latestOrderMs).toISOString() : null,
      days_since_last_order: daysSinceLastOrder === null ? null : Math.round(daysSinceLastOrder * 10) / 10,
      inactive,
      lifetimeOrders,
      orders_count: lifetimeOrders,
      rolling7,
      avgOrdersDay: Number((rolling7 / 7).toFixed(2)),
      last_active_rolling7: lastActiveRolling7,
      last_active_avg_orders_day: Number((lastActiveRolling7 / 7).toFixed(2)),
      branding: organizationBrandingView(orgId, org, globalData)
    };
  } catch (error) {
    throw annotateError(error, {
      message: `Organization summary failed for org '${orgId || "(missing id)"}'.`,
      org_id: orgId,
      operation: "buildOrganizationSummaryRow"
    });
  }
}

function bonusOfferInstanceMap(value: unknown) {
  return asObject(value);
}

function bonusOfferDateMs(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
    const text = cleanText(value);
    if (!text) continue;
    const isoish = text.includes("T") ? text : text.replace(" ", "T");
    const withZone = /[zZ]|[+-]\d\d:?\d\d$/.test(isoish) ? isoish : `${isoish}Z`;
    const parsed = Date.parse(withZone);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function bonusOfferMoney(value: unknown) {
  const amount = numberValue(value, Number.NaN);
  return Number.isFinite(amount) ? Math.round(Math.abs(amount) * 100) / 100 : 0;
}

function firstPositiveBonusMoney(...values: unknown[]) {
  for (const value of values) {
    const amount = bonusOfferMoney(value);
    if (amount > 0) return amount;
  }
  return 0;
}

function bonusOfferProjectAmount(project: JsonObject) {
  const measurement = asObject(project.measurement_project ?? project.measurement);
  const raw = asObject(measurement.raw);
  const manifest = asObject(project.manifest);
  return firstPositiveBonusMoney(
    project.amount_charged,
    measurement.amount_charged,
    raw.amount_charged,
    manifest.amount_charged,
    project.charged_amount,
    project.charge_amount,
    project.revenue
  );
}

function bonusOfferUsageEventsForProjects(projects: JsonObject[], nowMs = Date.now()) {
  return projects
    .map((project) => ({
      project,
      amount: bonusOfferProjectAmount(project),
      date_ms: orderTimestampMs(project)
    }))
    .filter((event) => event.amount > 0 && event.date_ms > 0 && event.date_ms <= nowMs);
}

function orderEventsForProjects(projects: JsonObject[], nowMs = Date.now()) {
  return projects
    .map((project) => ({
      project,
      date_ms: orderTimestampMs(project)
    }))
    .filter((event) => event.date_ms > 0 && event.date_ms <= nowMs);
}

function countUsageEventsRecent(events: Array<{ date_ms: number }>, days: number, nowMs = Date.now()) {
  const cutoff = nowMs - days * 86_400_000;
  return events.filter((event) => event.date_ms >= cutoff && event.date_ms <= nowMs).length;
}

function organizationCreditBalance(org: JsonObject, globalData: JsonObject, includeCredits: boolean) {
  if (!includeCredits) return undefined;
  return numberValue(
    globalData.credits_balance
      ?? org.credits_balance
      ?? asObject(org.metadata).credits_balance
  );
}

function bonusOfferRoundingIncrement(baseValue: number) {
  const value = Math.abs(Number(baseValue || 0));
  if (value < 500) return 100;
  if (value < 1000) return 250;
  return 500;
}

function bonusOfferMonthLabel(months: number) {
  return Number.isInteger(months) ? String(months) : String(Math.round(months * 10) / 10);
}

function normalizedInternalBonusConfig(inputValue: unknown) {
  const input = asObject(inputValue);
  const baseMonths = Math.max(0.01, numberValue(input.base_months ?? input.lowest_months, 2));
  const windowHours = Math.max(1, Math.round(numberValue(input.window_hours ?? input.duration_hours, 24)));
  const tiersInput = Array.isArray(input.tiers) ? input.tiers : [];
  const fallbackTiers = [
    { id: "tier_1", label: `${bonusOfferMonthLabel(baseMonths)}-month load`, multiplier: 1, months: baseMonths, match_percent: 25 },
    { id: "tier_2", label: `${bonusOfferMonthLabel(baseMonths * 2)}-month load`, multiplier: 2, months: baseMonths * 2, match_percent: 50 },
    { id: "tier_3", label: `${bonusOfferMonthLabel(baseMonths * 4)}-month load`, multiplier: 4, months: baseMonths * 4, match_percent: 50 }
  ];
  const tiers = (tiersInput.length ? tiersInput : fallbackTiers)
    .slice(0, 8)
    .map((entry, index) => {
      const spec = asObject(entry);
      const multiplier = Math.max(0, numberValue(spec.multiplier ?? spec.month_multiplier ?? (index === 0 ? 1 : index === 1 ? 2 : 4), index === 0 ? 1 : index === 1 ? 2 : 4));
      const months = Math.max(0.01, numberValue(spec.months ?? spec.month_count ?? baseMonths * multiplier, baseMonths * multiplier));
      const matchPercent = Math.max(0, numberValue(spec.match_percent ?? spec.bonus_percent ?? spec.match ?? (index === 0 ? 25 : 50), index === 0 ? 25 : 50));
      return {
        id: cleanText(spec.id) || `tier_${index + 1}`,
        label: cleanText(spec.label) || `${bonusOfferMonthLabel(months)}-month load`,
        multiplier,
        months,
        match_percent: matchPercent
      };
    })
    .filter((tier) => tier.multiplier > 0);
  return {
    label: cleanText(input.label || input.name) || "Credit usage bonus offer",
    base_months: baseMonths,
    window_hours: windowHours,
    starts_at: cleanText(input.starts_at || input.scheduled_at),
    cancel_existing: input.cancel_existing !== false && input.cancel_existing !== "false" && input.cancel_existing !== "0",
    cancel_existing_scope: internalBonusCancelScope(
      input.cancel_existing_scope ?? input.cancel_scope ?? input.cancel_mode
        ?? (input.cancel_unviewed_only === true || input.cancel_unviewed_only === "true" || input.cancel_unviewed_only === "1" ? "unviewed" : "")
    ),
    tiers: tiers.length ? tiers : fallbackTiers
  };
}

function internalBonusCancelScope(value: unknown) {
  const scope = cleanText(value).toLowerCase().replace(/-/g, "_");
  return ["unviewed", "not_viewed", "never_viewed"].includes(scope) ? "unviewed" : "unclaimed";
}

function internalBonusStatusIsCancelable(statusInput: unknown, scopeInput: unknown) {
  const status = cleanText(statusInput).toLowerCase();
  const scope = internalBonusCancelScope(scopeInput);
  const neverViewed = status === "scheduled" || status === "available";
  return scope === "unviewed" ? neverViewed : neverViewed || status === "viewed";
}

function internalBonusRunRateForOrg(row: JsonObject, configInput: unknown = {}) {
  const config = normalizedInternalBonusConfig(configInput);
  const nowMs = Date.now();
  const projects = Array.isArray(row.projects) ? row.projects.map((project) => asObject(project)) : [];
  const usageEvents = bonusOfferUsageEventsForProjects(projects, nowMs);
  const firstOrderMs = usageEvents.reduce((min, event) => Math.min(min, event.date_ms), Infinity);
  const latestUsageMs = usageEvents.reduce((max, event) => Math.max(max, event.date_ms), 0);
  const signupMs = bonusOfferDateMs(row.created_at, asObject(row.metadata).created_at, row.signup_at) || (Number.isFinite(firstOrderMs) ? firstOrderMs : 0);
  const accountAgeDays = signupMs ? Math.max(0, (nowMs - signupMs) / 86_400_000) : 0;
  const inactive = !latestUsageMs || nowMs - latestUsageMs > 14 * 86_400_000;
  const useLastMonth = accountAgeDays > 30;
  const windowEndMs = inactive ? (latestUsageMs || nowMs) : nowMs;
  const windowStartMs = inactive
    ? latestUsageMs - 7 * 86_400_000
    : useLastMonth ? nowMs - 30 * 86_400_000 : (signupMs || (Number.isFinite(firstOrderMs) ? firstOrderMs : nowMs));
  const windowEvents = usageEvents.filter((event) => event.date_ms >= windowStartMs && event.date_ms <= windowEndMs);
  const windowCreditUsage = Math.round(windowEvents.reduce((sum, event) => sum + event.amount, 0) * 100) / 100;
  const observedDays = inactive
    ? 7
    : useLastMonth ? 30 : Math.max(1, Math.min(30, accountAgeDays || ((windowEndMs - windowStartMs) / 86_400_000) || 1));
  const monthlyUsage = useLastMonth && !inactive ? windowCreditUsage : Math.round((windowCreditUsage / observedDays) * 30 * 100) / 100;
  const baseValue = Math.round(monthlyUsage * config.base_months * 100) / 100;
  const roundingIncrement = bonusOfferRoundingIncrement(baseValue);
  const roundedBaseValue = Math.max(0, Math.round(baseValue / roundingIncrement) * roundingIncrement);
  const tiers = roundedBaseValue > 0 ? config.tiers.map((tier) => {
    const customerPays = Math.max(0, Math.round(roundedBaseValue * tier.multiplier));
    const bonusDollars = Math.round(customerPays * (tier.match_percent / 100) * 100) / 100;
    const absoluteCustomerPays = Math.round(monthlyUsage * tier.months * 100) / 100;
    return {
      id: tier.id,
      label: tier.label,
      months: tier.months,
      multiplier: tier.multiplier,
      customer_pays: customerPays,
      bonus_dollars: bonusDollars,
      total_account_value: Math.round((customerPays + bonusDollars) * 100) / 100,
      match_percent: tier.match_percent,
      type: "credit_usage_run_rate",
      absolute_customer_pays: absoluteCustomerPays,
      absolute_bonus_dollars: Math.round(absoluteCustomerPays * (tier.match_percent / 100) * 100) / 100,
      absolute_total_account_value: Math.round(absoluteCustomerPays * (1 + tier.match_percent / 100) * 100) / 100,
      rounding_increment: roundingIncrement
    };
  }) : [];
  return {
    tiers,
    basis: {
      window: inactive ? "last_active_7_days" : useLastMonth ? "last_30_days" : "lifetime_prorated",
      inactive,
      account_age_days: Math.round(accountAgeDays * 10) / 10,
      days_since_last_charged_order: latestUsageMs ? Math.round(((nowMs - latestUsageMs) / 86_400_000) * 10) / 10 : null,
      observed_days: Math.round(observedDays * 10) / 10,
      window_start: new Date(windowStartMs).toISOString(),
      window_end: new Date(windowEndMs).toISOString(),
      latest_charged_order_at: latestUsageMs ? new Date(latestUsageMs).toISOString() : null,
      charged_order_count: windowEvents.length,
      lifetime_charged_order_count: usageEvents.length,
      monthly_credit_usage_estimate: monthlyUsage,
      base_months: config.base_months,
      base_credit_usage_estimate: baseValue,
      rounded_base_customer_pays: roundedBaseValue,
      rounding_increment: roundingIncrement
    }
  };
}

function internalBonusInstanceStatus(instanceInput: unknown, nowMs = Date.now()) {
  const instance = asObject(instanceInput);
  const status = cleanText(instance.status || "scheduled").toLowerCase();
  if (status === "cancelled" || status === "archived") return "cancelled";
  if (instance.claimed === true || status === "claimed" || cleanText(instance.claimed_at)) return "claimed";
  const startsAt = bonusOfferDateMs(instance.starts_at || instance.scheduled_at || instance.created_at);
  if (startsAt && nowMs < startsAt) return "scheduled";
  const viewedAt = bonusOfferDateMs(instance.viewed_at || instance.first_shown_at);
  const expiresAt = bonusOfferDateMs(instance.expires_at || instance.ends_at);
  if (viewedAt && expiresAt && nowMs > expiresAt) return "expired";
  return viewedAt ? "viewed" : "available";
}

function publicInternalBonusInstance(instanceInput: unknown) {
  const instance = asObject(instanceInput);
  const tiers = Array.isArray(instance.tiers) ? instance.tiers.map((tier) => asObject(tier)) : [];
  return {
    id: cleanText(instance.id),
    offer_id: cleanText(instance.offer_id || BONUS_OFFER_ID),
    rollout_id: cleanText(instance.rollout_id),
    label: cleanText(instance.label || instance.name || "Bonus offer"),
    status: internalBonusInstanceStatus(instance),
    created_at: cleanText(instance.created_at),
    starts_at: cleanText(instance.starts_at),
    viewed_at: cleanText(instance.viewed_at || instance.first_shown_at),
    expires_at: cleanText(instance.expires_at || instance.ends_at),
    claimed_at: cleanText(instance.claimed_at),
    window_hours: numberValue(instance.window_hours ?? instance.duration_hours, 24),
    paid_dollars: numberValue(instance.paid_dollars),
    bonus_dollars: numberValue(instance.bonus_dollars),
    total_credited: numberValue(instance.total_credited),
    selected_tier_id: cleanText(instance.selected_tier_id),
    tiers,
    max_bonus_dollars: tiers.reduce((max, tier) => Math.max(max, numberValue(tier.bonus_dollars)), 0),
    max_customer_pays: tiers.reduce((max, tier) => Math.max(max, numberValue(tier.customer_pays)), 0),
    basis: asObject(instance.basis)
  };
}

function internalBonusHistory(globalData: JsonObject) {
  return Object.values(bonusOfferInstanceMap(globalData.bonus_offer_instances))
    .map(publicInternalBonusInstance)
    .filter((instance) => instance.id)
    .sort((a, b) => bonusOfferDateMs(b.created_at || b.starts_at) - bonusOfferDateMs(a.created_at || a.starts_at));
}

async function internalBonusOfferCustomers() {
  const rows = await buildOrganizationSummaries({ include_credits: true });
  return await Promise.all(rows.map(async (row) => {
    const history = internalBonusHistory(row);
    const preview = internalBonusRunRateForOrg(row, {});
    const flagEnabled = await isAppFlagEnabled(cleanText(row.id), "firstmeasure", "bonus_upfront_match").catch(() => false);
    return {
      ...compactOrganizationSummary(row),
      bonus_flag_enabled: flagEnabled,
      bonus_offer_preview: preview,
      bonus_offer_history: history,
      active_bonus_offer: history.find((offer) => ["available", "viewed", "scheduled"].includes(offer.status)) || null,
      bonus_offer_claim_count: history.filter((offer) => offer.status === "claimed").length,
      bonus_offer_total_paid: history.reduce((sum, offer) => sum + numberValue(offer.paid_dollars), 0),
      bonus_offer_total_bonus: history.reduce((sum, offer) => sum + numberValue(offer.bonus_dollars), 0)
    };
  }));
}

async function internalBonusOfferRollouts() {
  const documents = await listInternalDocuments(BONUS_OFFER_ROLLOUT_COLLECTION);
  return await Promise.all(documents.map(async (document) => {
    const rollout = asObject(document.data ?? document);
    const launchAssignments = Array.isArray(rollout.assignments) ? rollout.assignments.map((entry) => asObject(entry)) : [];
    const assignments = await Promise.all(launchAssignments.map(async (assignment) => {
      const orgId = cleanText(assignment.org_id);
      const instanceId = cleanText(assignment.instance_id);
      if (!orgId || !instanceId) return assignment;
      const global = await readGlobal(orgId).catch(() => null);
      const instance = asObject(bonusOfferInstanceMap(asObject(global?.data).bonus_offer_instances)[instanceId]);
      if (!cleanText(instance.id)) return assignment;
      const live = publicInternalBonusInstance(instance);
      return {
        ...assignment,
        status: live.status,
        viewed_at: live.viewed_at,
        expires_at: live.expires_at,
        claimed_at: live.claimed_at,
        paid_dollars: live.paid_dollars,
        bonus_dollars: live.bonus_dollars,
        total_credited: live.total_credited
      };
    }));
    const counts = assignments.reduce<Record<string, number>>((acc, assignment) => {
      const status = cleanText(assignment.status || "assigned");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const statusSummary = {
      not_viewed: numberValue(counts.scheduled) + numberValue(counts.available) + numberValue(counts.assigned),
      viewed: numberValue(counts.viewed),
      claimed: numberValue(counts.claimed),
      expired: numberValue(counts.expired),
      cancelled: numberValue(counts.cancelled),
      ever_viewed: assignments.filter((assignment) => {
        const status = cleanText(assignment.status).toLowerCase();
        return Boolean(cleanText(assignment.viewed_at)) || ["viewed", "claimed", "expired"].includes(status);
      }).length
    };
    return {
      ...rollout,
      assignments,
      assignment_count: assignments.length,
      status_counts: counts,
      status_summary: statusSummary,
      not_viewed_count: statusSummary.not_viewed,
      viewed_count: statusSummary.viewed,
      claimed_count: statusSummary.claimed,
      expired_count: statusSummary.expired,
      total_paid_dollars: assignments.reduce((sum, assignment) => sum + numberValue(assignment.paid_dollars), 0),
      total_bonus_dollars: assignments.reduce((sum, assignment) => sum + numberValue(assignment.bonus_dollars), 0)
    };
  }));
}

async function internalBonusOfferDashboard() {
  const [customers, rollouts] = await Promise.all([
    internalBonusOfferCustomers(),
    internalBonusOfferRollouts()
  ]);
  return { ok: true, success: true, customers, organizations: customers, rollouts };
}

function bonusOfferRolloutId() {
  return `bonus_rollout_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

function bonusOfferInstanceId() {
  return `bonus_offer_${Date.now()}_${randomBytes(4).toString("hex")}`;
}

async function internalLaunchBonusOfferRollout(body: JsonObject, actor: JsonObject) {
  const orgIds = Array.isArray(body.org_ids)
    ? body.org_ids.map((id) => cleanText(id)).filter(Boolean)
    : String(body.org_ids || "").split(",").map((id) => cleanText(id)).filter(Boolean);
  if (!orgIds.length) throw badRequest("missing_org_ids", "Select at least one organization for the bonus offer rollout.");
  const config = normalizedInternalBonusConfig(body.config || body);
  const rolloutId = cleanText(body.id) || bonusOfferRolloutId();
  const now = new Date().toISOString();
  const startsAt = config.starts_at && Number.isFinite(Date.parse(config.starts_at)) ? new Date(Date.parse(config.starts_at)).toISOString() : now;
  const rows = await buildOrganizationSummaries({ include_credits: true, include_internal: true });
  const rowById = new Map(rows.map((row) => [cleanText(row.id), row]));
  const assignments: JsonObject[] = [];
  const skipped: JsonObject[] = [];

  for (const orgId of Array.from(new Set(orgIds))) {
    const row = rowById.get(orgId);
    if (!row) {
      skipped.push({ org_id: orgId, reason: "organization_not_found" });
      continue;
    }
    const runRate = internalBonusRunRateForOrg(row, config);
    if (!runRate.tiers.length) {
      skipped.push({ org_id: orgId, name: row.name, reason: "no_credit_usage" });
      continue;
    }
    const global = await readGlobal(orgId);
    const globalData = asObject(global.data);
    const currentInstances = bonusOfferInstanceMap(globalData.bonus_offer_instances);
    const nextInstances = config.cancel_existing
      ? Object.fromEntries(Object.entries(currentInstances).map(([id, entry]) => {
        const instance = asObject(entry);
        const status = internalBonusInstanceStatus(instance);
        if (internalBonusStatusIsCancelable(status, config.cancel_existing_scope)) {
          return [id, { ...instance, status: "cancelled", cancelled_at: now, cancelled_by_rollout_id: rolloutId, cancelled_scope: config.cancel_existing_scope, updated_at: now }];
        }
        return [id, instance];
      }))
      : { ...currentInstances };
    const instanceId = bonusOfferInstanceId();
    const instance = {
      id: instanceId,
      offer_id: BONUS_OFFER_ID,
      rollout_id: rolloutId,
      label: config.label,
      status: bonusOfferDateMs(startsAt) > Date.now() ? "scheduled" : "available",
      created_at: now,
      updated_at: now,
      starts_at: startsAt,
      window_hours: config.window_hours,
      config: {
        base_months: config.base_months,
        window_hours: config.window_hours,
        tiers: config.tiers
      },
      tiers: runRate.tiers,
      basis: runRate.basis,
      viewed: false,
      claimed: false,
      created_by_email: cleanText(actor.email),
      created_by_name: cleanText(actor.name),
      source: "internal_bonus_offer_rollout"
    };
    await saveGlobal(orgId, {
      data: {
        bonus_offer_instances: {
          ...nextInstances,
          [instanceId]: instance
        }
      }
    });
    assignments.push({
      org_id: orgId,
      org_name: cleanText(row.name),
      instance_id: instanceId,
      status: instance.status,
      starts_at: startsAt,
      tiers: runRate.tiers,
      basis: runRate.basis
    });
  }

  const rollout = {
    id: rolloutId,
    name: config.label,
    status: bonusOfferDateMs(startsAt) > Date.now() ? "scheduled" : "active",
    offer_id: BONUS_OFFER_ID,
    created_at: now,
    updated_at: now,
    starts_at: startsAt,
    window_hours: config.window_hours,
    config: {
      base_months: config.base_months,
      window_hours: config.window_hours,
      tiers: config.tiers,
      cancel_existing: config.cancel_existing,
      cancel_existing_scope: config.cancel_existing_scope
    },
    selected_org_ids: orgIds,
    assignments,
    skipped,
    created_by_email: cleanText(actor.email),
    created_by_name: cleanText(actor.name)
  };
  const document = await saveInternalDocument(BONUS_OFFER_ROLLOUT_COLLECTION, rolloutId, rollout, { replace: true });
  return { ok: true, success: true, rollout: asObject(document.data), assignments, skipped };
}

async function internalCancelBonusOfferRollout(rolloutIdInput: string, body: JsonObject, actor: JsonObject) {
  const rolloutId = cleanText(rolloutIdInput || body.rollout_id);
  if (!rolloutId) throw badRequest("missing_rollout_id", "A rollout id is required.");
  const cancelScope = internalBonusCancelScope(body.cancel_scope ?? body.cancel_mode ?? body.mode);
  const document = await readInternalDocument(BONUS_OFFER_ROLLOUT_COLLECTION, rolloutId);
  if (!document) throw notFound("rollout_not_found", "Bonus offer rollout was not found.");
  const rollout = asObject(document.data ?? document);
  const now = new Date().toISOString();
  const assignments = Array.isArray(rollout.assignments) ? rollout.assignments.map((entry) => asObject(entry)) : [];
  const nextAssignments: JsonObject[] = [];
  for (const assignment of assignments) {
    const orgId = cleanText(assignment.org_id);
    const instanceId = cleanText(assignment.instance_id);
    if (!orgId || !instanceId) {
      nextAssignments.push(assignment);
      continue;
    }
    const global = await readGlobal(orgId).catch(() => null);
    const data = asObject(global?.data);
    const instances = bonusOfferInstanceMap(data.bonus_offer_instances);
    const instance = asObject(instances[instanceId]);
    const status = internalBonusInstanceStatus(instance);
    if (global && cleanText(instance.id) && internalBonusStatusIsCancelable(status, cancelScope)) {
      const next = { ...instance, status: "cancelled", cancelled_at: now, cancelled_by_email: cleanText(actor.email), cancelled_scope: cancelScope, updated_at: now };
      await saveGlobal(orgId, { data: { bonus_offer_instances: { ...instances, [instanceId]: next } } });
      nextAssignments.push({ ...assignment, status: "cancelled", cancelled_at: now, cancelled_scope: cancelScope });
    } else {
      nextAssignments.push({ ...assignment, status });
    }
  }
  const hasRemainingOpenAssignments = nextAssignments.some((assignment) => {
    const status = cleanText(assignment.status).toLowerCase();
    return ["scheduled", "available", "viewed"].includes(status);
  });
  const nextRollout = {
    ...rollout,
    status: hasRemainingOpenAssignments ? "partially_cancelled" : "cancelled",
    cancelled_at: now,
    cancelled_by_email: cleanText(actor.email),
    cancel_scope: cancelScope,
    updated_at: now,
    assignments: nextAssignments
  };
  const saved = await saveInternalDocument(BONUS_OFFER_ROLLOUT_COLLECTION, rolloutId, nextRollout, { replace: true });
  return { ok: true, success: true, rollout: asObject(saved.data) };
}

async function diagnoseOrganizationSummaries(body: JsonObject) {
  const includeCredits = body.include_credits !== false && body.include_credits !== "0";
  const includeInternal = body.include_internal === true || body.include_internal === "1" || body.include_internal === "true";
  const internalOrgId = internalPlatformOrgId();
  const orgs = await listOrganizations();
  const visibleOrgs = orgs.filter((org) => includeInternal || String(org.id ?? "").toLowerCase() !== internalOrgId);
  const rows: JsonObject[] = [];
  for (const org of visibleOrgs) {
    const orgId = String(org.id ?? "");
    const started = Date.now();
    try {
      const row = await buildOrganizationSummaryRow(org, includeCredits);
      JSON.stringify(row);
      rows.push({
        ok: true,
        org_id: orgId,
        name: row.name,
        ms: Date.now() - started,
        users: Array.isArray(row.users) ? row.users.length : 0,
        projects: Array.isArray(row.projects) ? row.projects.length : 0,
        credits_ledger_count: row.credits_ledger_count ?? null
      });
    } catch (error) {
      rows.push({
        ok: false,
        org_id: orgId,
        name: String(org.name ?? orgId),
        ms: Date.now() - started,
        debug: errorDebugPayload(annotateError(error, {
          message: `Organization diagnostics failed for org '${orgId || "(missing id)"}'.`,
          org_id: orgId,
          operation: "diagnoseOrganizationSummaries"
        }))
      });
    }
  }
  return {
    ok: true,
    success: true,
    include_credits: includeCredits,
    checked: rows.length,
    failures: rows.filter((row) => row.ok === false),
    rows
  };
}

function compactOrganizationSummaries(rows: JsonObject[]) {
  return rows.map(compactOrganizationSummary);
}

function statsCreditRevenueCacheKey(body: JsonObject) {
  return JSON.stringify({
    start: cleanText(body.start ?? body.start_at ?? body.range_start),
    end: cleanText(body.end ?? body.end_at ?? body.range_end),
    prev_start: cleanText(body.prev_start ?? body.previous_start),
    prev_end: cleanText(body.prev_end ?? body.previous_end)
  });
}

function statsCreditRevenueDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 100_000_000_000 ? value : value * 1000;
  }
  const text = cleanText(value);
  if (!text) return 0;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return Number.isFinite(numeric) ? (numeric > 100_000_000_000 ? numeric : numeric * 1000) : 0;
  }
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const withZone = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statsCreditRevenueAmount(entryInput: unknown) {
  const entry = asObject(entryInput);
  const delta = numberValue(entry.delta ?? entry.amount ?? entry.credit_delta ?? entry.value);
  if (!(delta > 0)) return 0;

  const reason = cleanText(entry.reason ?? entry.type ?? entry.event).toLowerCase();
  const meta = asObject(entry.meta);
  const firstPositive = (...values: unknown[]) => {
    for (const value of values) {
      const amount = numberValue(value);
      if (amount > 0) return amount;
    }
    return 0;
  };
  const isStripeCheckout = [
    "stripe_checkout_paid",
    "stripe_checkout_completed",
    "stripe_payment_succeeded",
    "stripe_manual_fulfill",
    "credit_purchase",
    "credits_purchase",
    "credits_loaded"
  ].includes(reason) || reason.includes("checkout") && reason.includes("paid");
  const isStripeAutoTopup = reason === "stripe_auto_topup"
    || reason === "stripe_autotopup"
    || reason.includes("auto_topup")
    || reason.includes("autotopup");

  if (isStripeCheckout) {
    const paidDollars = firstPositive(
      meta.paid_dollars,
      meta.paidDollars,
      meta.amount_paid_dollars,
      meta.charged_dollars,
      meta.amount_dollars,
      entry.paid_dollars,
      entry.amount_paid_dollars,
      entry.charged_dollars,
      entry.amount_dollars
    );
    if (paidDollars > 0) return paidDollars;

    const bonusDollars = numberValue(meta.bonus_dollars);
    if (bonusDollars > 0) return Math.max(0, delta - bonusDollars);

    const amountTotal = firstPositive(meta.amount_total, meta.amountTotal, entry.amount_total, entry.amountTotal);
    return amountTotal > 0 ? amountTotal / 100 : delta;
  }

  if (isStripeAutoTopup) {
    const topupDollars = firstPositive(
      meta.topup_dollars,
      meta.topupDollars,
      meta.paid_dollars,
      meta.amount_dollars,
      entry.topup_dollars,
      entry.amount_dollars
    );
    if (topupDollars > 0) return topupDollars;

    const amountCents = firstPositive(meta.amount_cents, meta.amountCents, meta.amount_total, entry.amount_cents, entry.amountCents, entry.amount_total);
    return amountCents > 0 ? amountCents / 100 : delta;
  }

  return 0;
}

async function statsCreditRevenueForRanges(body: JsonObject) {
  const startMs = statsCreditRevenueDate(body.start ?? body.start_at ?? body.range_start);
  const endMs = statsCreditRevenueDate(body.end ?? body.end_at ?? body.range_end);
  const prevStartMs = statsCreditRevenueDate(body.prev_start ?? body.previous_start);
  const prevEndMs = statsCreditRevenueDate(body.prev_end ?? body.previous_end);
  if (!startMs || !endMs || endMs <= startMs) throw badRequest("invalid_stats_revenue_range", "A valid stats revenue start and end are required.");

  const key = statsCreditRevenueCacheKey(body);
  const cached = statsCreditRevenueCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ...cached.payload, cached: true };

  const internalOrgId = internalPlatformOrgId();
  const orgs = await listOrganizations();
  let actualRevenue = 0;
  let prevActualRevenue = 0;
  let scannedOrganizations = 0;
  let scannedEntries = 0;
  const minStartMs = prevStartMs && prevEndMs && prevEndMs > prevStartMs ? Math.min(startMs, prevStartMs) : startMs;
  const maxEndMs = prevStartMs && prevEndMs && prevEndMs > prevStartMs ? Math.max(endMs, prevEndMs) : endMs;

  await Promise.all(orgs.map(async (org) => {
    const orgId = cleanText(org.id);
    if (!orgId || orgId.toLowerCase() === internalOrgId) return;
    const global = await readGlobal(orgId).catch(() => null);
    const data = asObject(global?.data);
    if (Boolean(org.is_test ?? asObject(org.metadata).is_test ?? data.is_test)) return;
    const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger : [];
    if (!ledger.length) return;
    scannedOrganizations++;
    for (const entry of ledger) {
      const ts = statsCreditRevenueDate(asObject(entry).ts ?? asObject(entry).created_at ?? asObject(entry).createdAt ?? asObject(entry).timestamp ?? asObject(entry).date);
      if (!ts || ts < minStartMs || ts >= maxEndMs) continue;
      const amount = statsCreditRevenueAmount(entry);
      if (!(amount > 0)) continue;
      scannedEntries++;
      if (ts >= startMs && ts < endMs) actualRevenue += amount;
      if (prevStartMs && prevEndMs && prevEndMs > prevStartMs && ts >= prevStartMs && ts < prevEndMs) prevActualRevenue += amount;
    }
  }));

  const payload = {
    ok: true,
    success: true,
    actual_revenue: Math.round(actualRevenue * 100) / 100,
    prev_actual_revenue: Math.round(prevActualRevenue * 100) / 100,
    scanned_organizations: scannedOrganizations,
    scanned_entries: scannedEntries,
    cached: false
  };
  statsCreditRevenueCache.set(key, {
    expiresAt: Date.now() + STATS_CREDIT_REVENUE_CACHE_TTL_MS,
    payload
  });
  return payload;
}

function compactOrganizationSummary(row: JsonObject) {
  const users = Array.isArray(row.users) ? row.users.map(compactOrganizationUser) : [];
  const contacts = Array.isArray(row.contacts) ? row.contacts : [];
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    is_test: Boolean(row.is_test),
    sales_owner_email: row.sales_owner_email ?? null,
    assigned_sales_email: row.assigned_sales_email ?? null,
    assigned_sales_name: row.assigned_sales_name ?? "",
    assigned_sales_by_email: row.assigned_sales_by_email ?? null,
    assigned_sales_at: row.assigned_sales_at ?? null,
    users,
    user_count: Number(row.user_count ?? users.length) || users.length,
    contact_count: Number(row.contact_count ?? contacts.length) || contacts.length,
    projects_count: Array.isArray(row.projects) ? row.projects.length : Number(row.projects_count ?? row.orders_count ?? row.lifetimeOrders ?? 0) || 0,
    orders_count: Number(row.orders_count ?? row.lifetimeOrders ?? row.projects_count ?? 0) || 0,
    lifetimeOrders: Number(row.lifetimeOrders ?? row.orders_count ?? row.projects_count ?? 0) || 0,
    rolling7: Number(row.rolling7 ?? 0) || 0,
    avgOrdersDay: Number(row.avgOrdersDay ?? 0) || 0,
    last_active_rolling7: Number(row.last_active_rolling7 ?? row.rolling7 ?? 0) || 0,
    last_active_avg_orders_day: Number(row.last_active_avg_orders_day ?? row.avgOrdersDay ?? 0) || 0,
    inactive: Boolean(row.inactive),
    days_since_last_order: row.days_since_last_order === null || row.days_since_last_order === undefined ? null : Number(row.days_since_last_order),
    latest_order_at: row.latest_order_at ?? null,
    latest_order: compactOrder(row.latest_order),
    latest_credit_entry: compactLedgerEntry(row.latest_credit_entry),
    credits_balance: row.credits_balance,
    credits_ledger_count: Number(row.credits_ledger_count ?? (Array.isArray(row.credits_ledger) ? row.credits_ledger.length : 0)) || 0,
    free_expedite_uses: Number(row.free_expedite_uses ?? 0) || 0,
    free_expedite_ledger_count: Number(row.free_expedite_ledger_count ?? (Array.isArray(row.free_expedite_ledger) ? row.free_expedite_ledger.length : 0)) || 0,
    paired_lead_ids: Array.isArray(row.paired_lead_ids) ? row.paired_lead_ids.map(String) : [],
    paired_primary_lead_id: row.paired_primary_lead_id ?? null,
    paired_at: row.paired_at ?? null,
    paired_leads: Array.isArray(row.paired_leads) ? row.paired_leads.map(compactPairedLead) : [],
    contact: compactContact(row.contact),
    billing: asObject(row.billing),
    report_settings: asObject(row.report_settings),
    branding: asObject(row.branding)
  };
}

function compactOrganizationUser(user: unknown) {
  const data = asObject(user);
  const profile = asObject(data.profile);
  const contact = asObject(data.contact);
  return {
    id: data.id ?? "",
    name: data.name ?? "",
    email: data.email ?? "",
    phone: data.phone ?? contact.phone ?? profile.phone ?? "",
    title: data.title ?? profile.title ?? profile.job_title ?? contact.title ?? "",
    company: data.company ?? profile.company ?? contact.company ?? "",
    address: data.address ?? contact.address ?? profile.address ?? "",
    contact: compactContact(contact),
    created_at: data.created_at ?? null,
    org_permission_level: data.org_permission_level ?? data.permission_level ?? "",
    permission_level: data.permission_level ?? data.org_permission_level ?? "",
    orderCount: Number(data.orderCount ?? data.order_count ?? 0) || 0,
    order_count: Number(data.order_count ?? data.orderCount ?? 0) || 0
  };
}

function compactOrder(order: unknown) {
  const data = asObject(order);
  if (!Object.keys(data).length) return null;
  const issuer = asObject(data.issuer);
  return {
    id: data.id ?? data.folder ?? "",
    address: data.address ?? data.property_address ?? "",
    status: data.status ?? "",
    owner_email: data.owner_email ?? asObject(data.owner_ref).email ?? data.customer_email ?? data.email ?? "",
    issuer: { email: data.issuer_email ?? issuer.email ?? "" },
    created_at: data.created_at ?? data.submitted_at ?? data.completed_at ?? data.updated_at ?? null,
    revenue: Number(data.revenue ?? data.amount_charged ?? 0) || 0,
    source: data.source ?? ""
  };
}

function compactLedgerEntry(entry: unknown) {
  const data = asObject(entry);
  if (!Object.keys(data).length) return null;
  const meta = asObject(data.meta);
  return {
    ts: data.ts ?? data.created_at ?? null,
    reason: data.reason ?? "",
    delta: data.delta ?? data.amount ?? 0,
    balance_after: data.balance_after ?? data.balance ?? null,
    balance: data.balance ?? data.balance_after ?? null,
    applied_for_user_email: data.applied_for_user_email ?? meta.applied_for_user_email ?? "",
    address: data.address ?? meta.address ?? "",
    meta: {
      address: meta.address ?? "",
      applied_for_user_email: meta.applied_for_user_email ?? ""
    }
  };
}

function compactPairedLead(lead: unknown) {
  const data = asObject(lead);
  return {
    id: data.id ?? "",
    company_name: data.company_name ?? data.name ?? "",
    name: data.name ?? data.company_name ?? ""
  };
}

function compactContact(contact: unknown) {
  const data = asObject(contact);
  return {
    email: data.email ?? "",
    phone: data.phone ?? "",
    address: data.address ?? ""
  };
}

function annotateError(error: unknown, context: JsonObject & { message: string }) {
  if (!(error instanceof Error)) {
    const wrapped = new Error(`${context.message} ${String(error)}`) as Error & JsonObject;
    Object.assign(wrapped, context);
    return wrapped;
  }
  const wrapped = new Error(`${context.message} ${error.message}`) as Error & JsonObject;
  Object.assign(wrapped, context, {
    cause: error,
    original_name: error.name,
    original_stack: error.stack
  });
  return wrapped;
}

function paginationParams(options: JsonObject, pageKeys: string[], perPageKeys: string[], defaultPerPage = 50) {
  const firstValue = (keys: string[]) => {
    for (const key of keys) {
      if (options[key] !== undefined && options[key] !== null && options[key] !== "") return options[key];
    }
    return undefined;
  };
  const page = Math.max(1, Math.round(Number(firstValue(pageKeys)) || 1));
  const perPage = Math.max(1, Math.min(200, Math.round(Number(firstValue(perPageKeys)) || defaultPerPage)));
  return { page, perPage };
}

function paginateRows<T>(rows: T[], page: number, perPage: number) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const offset = (currentPage - 1) * perPage;
  return {
    rows: rows.slice(offset, offset + perPage),
    pagination: {
      page: currentPage,
      current_page: currentPage,
      per_page: perPage,
      limit: perPage,
      total,
      total_count: total,
      total_pages: totalPages
    }
  };
}

async function organizationDetail(orgId: string, options: JsonObject = {}) {
  const [organization, global, users, projects, indexedProjectRows] = await Promise.all([
    readOrganization(orgId),
    readGlobal(orgId),
    listDocuments(orgId, "users").catch(() => []),
    listDocuments(orgId, "projects").catch(() => []),
    firstMeasureProjectRowsForOrg(orgId)
  ]);
  const globalData = asObject(global.data);
  const branding = organizationBrandingView(orgId, organization, globalData);
  const projectRows = projectRowsWithUserReferences(projects, users, indexedProjectRows);
  const contacts = contactRowsForProjects(projectRows);
  const summary = await buildOrganizationSummaryRow(organization, true, {
    global,
    users,
    projects,
    indexedProjectRows
  });
  const creditsLedger = Array.isArray(globalData.credits_ledger) ? globalData.credits_ledger : [];
  const freeExpediteLedger = Array.isArray(globalData.free_expedite_ledger) ? globalData.free_expedite_ledger : [];
  const { page: ordersPage, perPage: ordersPerPage } = paginationParams(options, ["orders_page", "ordersPage", "page"], ["orders_per_page", "ordersPerPage", "per_page", "limit"]);
  const { page: ledgerPage, perPage: ledgerPerPage } = paginationParams(options, ["ledger_page", "ledgerPage"], ["ledger_per_page", "ledgerPerPage", "per_page", "limit"]);
  const sortedProjectRows = [...projectRows].sort((a, b) => orderTimestampMs(b) - orderTimestampMs(a));
  const sortedCreditsLedger = [...creditsLedger].sort((a, b) => {
    const at = Date.parse(String(asObject(a).ts ?? asObject(a).created_at ?? "")) || 0;
    const bt = Date.parse(String(asObject(b).ts ?? asObject(b).created_at ?? "")) || 0;
    return bt - at;
  });
  const pagedOrders = paginateRows(sortedProjectRows, ordersPage, ordersPerPage);
  const pagedCreditsLedger = paginateRows(sortedCreditsLedger, ledgerPage, ledgerPerPage);
  const compactOrders = pagedOrders.rows.map(compactOrder).filter((order) => order !== null);
  const compactCreditsLedger = pagedCreditsLedger.rows.map(compactLedgerEntry).filter((entry) => entry !== null);
  const detailOrganization = {
    ...summary,
    ...organization,
    ...globalData,
    branding,
    users: users.map((user) => organizationUserView(user, projectRows)),
    contacts,
    projects: compactOrders,
    orders: compactOrders,
    orders_pagination: pagedOrders.pagination,
    credits_balance: organizationCreditBalance(organization, globalData, true),
    credits_ledger: compactCreditsLedger,
    credits_pagination: pagedCreditsLedger.pagination,
    credits_ledger_count: creditsLedger.length,
    free_expedite_uses: Math.max(0, Math.round(numberValue(globalData.free_expedite_uses))),
    free_expedite_ledger: freeExpediteLedger,
    free_expedite_ledger_count: freeExpediteLedger.length
  };
  return {
    ok: true,
    success: true,
    ...summary,
    organization: detailOrganization,
    global,
    branding,
    org: detailOrganization,
    users: users.map((user) => organizationUserView(user, projectRows)),
    contacts,
    projects: compactOrders,
    orders: compactOrders,
    orders_pagination: pagedOrders.pagination,
    credits_ledger: compactCreditsLedger,
    credits_pagination: pagedCreditsLedger.pagination,
    credits_ledger_count: creditsLedger.length,
    free_expedite_uses: Math.max(0, Math.round(numberValue(globalData.free_expedite_uses))),
    free_expedite_ledger: freeExpediteLedger,
    free_expedite_ledger_count: freeExpediteLedger.length,
    counts: {
      users: users.length,
      contacts: contacts.length,
      projects: projectRows.length
    }
  };
}

async function applyCreditDelta(orgId: string, body: JsonObject, actorEmail: string) {
  let amount = numberValue(body.amount ?? body.delta);
  const direction = cleanText(body.direction).toLowerCase();
  if (direction === "deduct" && amount > 0) amount = -amount;
  if ((direction === "add" || direction === "credit") && amount < 0) amount = Math.abs(amount);
  if (amount === 0) throw badRequest("invalid_credit_amount", "Credit amount must be non-zero.");
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const balance = numberValue(data.credits_balance);
  const ledger = Array.isArray(data.credits_ledger) ? [...data.credits_ledger] : [];
  const entry = {
    ts: new Date().toISOString(),
    delta: Math.round(amount * 100) / 100,
    reason: String(body.reason || "internal_adjustment"),
    by_email: actorEmail || null,
    applied_for_user_email: body.applied_for_user_email ?? null,
    meta: asObject(body.meta),
    unit: String(body.unit || "usd_dollars"),
    balance_after: Math.round((balance + amount) * 100) / 100
  };
  ledger.push(entry);
  const document = await saveGlobal(orgId, {
    data: {
      credits_balance: entry.balance_after,
      credits_ledger: ledger
    },
    metadata: {
      last_credit_mutation_at: entry.ts,
      last_credit_mutation_reason: entry.reason
    }
  });
  clearOrganizationSummaryCache();
  clearStatsCreditRevenueCache();
  return {
    org_id: orgId,
    balance: entry.balance_after,
    ledger_entry: entry,
    ledger_count: ledger.length,
    document
  };
}

async function applyFreeExpediteDelta(orgId: string, body: JsonObject, actorEmail: string) {
  let amount = Math.round(numberValue(body.amount ?? body.delta));
  const direction = cleanText(body.direction).toLowerCase();
  if (direction === "deduct" && amount > 0) amount = -amount;
  if ((direction === "add" || direction === "credit") && amount < 0) amount = Math.abs(amount);
  if (amount === 0) throw badRequest("invalid_free_expedite_amount", "Free expedite uses amount must be non-zero.");
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const balance = Math.max(0, Math.round(numberValue(data.free_expedite_uses)));
  const next = balance + amount;
  if (next < 0) throw badRequest("insufficient_free_expedite_uses", "Cannot deduct more free expedite uses than the organization has.");
  const ledger = Array.isArray(data.free_expedite_ledger) ? [...data.free_expedite_ledger] : [];
  const entry = {
    ts: new Date().toISOString(),
    delta: amount,
    reason: String(body.reason || "internal_free_expedite_adjustment"),
    by_email: actorEmail || null,
    meta: asObject(body.meta),
    balance_after: next
  };
  ledger.push(entry);
  const document = await saveGlobal(orgId, {
    data: {
      free_expedite_uses: next,
      free_expedite_ledger: ledger
    },
    metadata: {
      last_free_expedite_mutation_at: entry.ts,
      last_free_expedite_mutation_reason: entry.reason
    }
  });
  return {
    org_id: orgId,
    free_expedite_uses: next,
    free_expedite_ledger_entry: entry,
    free_expedite_ledger_count: ledger.length,
    document
  };
}

function internalUserCanCancelProjects(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  return role === "admin" || role === "system_admin" || Boolean(user.is_admin) || Boolean(permissions.cancel_projects);
}

async function handleCancelProjectLegacyAction(app: FastifyInstance, body: JsonObject, actor: JsonObject) {
  const actorEmail = cleanText(actor.email).toLowerCase();
  const actorName = cleanText(actor.name || actorEmail);
  const user = actorEmail ? await readInternalUser(actorEmail).catch(() => null) : null;
  if (!internalUserCanCancelProjects(user)) return { ok: false, success: false, status_code: 403, error: "Unauthorized" };

  const projectId = cleanText(body.folder || body.project_id || body.id);
  if (!projectId) return { ok: false, success: false, status_code: 400, error: "Project folder is required" };
  const refundMode = cleanText(body.refund_mode || body.refundMode).toLowerCase();
  if (!["refund", "no_refund"].includes(refundMode)) {
    return { ok: false, success: false, status_code: 400, error: "Please choose whether to refund credits for this cancellation" };
  }

  const detail = await injectJson(app, "GET", `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`);
  if (asObject(detail).success === false || asObject(detail).ok === false || !asObject(detail).project) {
    return { ok: false, success: false, status_code: 404, error: "Project not found" };
  }
  const project = asObject(detail.project);
  const manifest = asObject(project.manifest || project);
  const status = cleanText(manifest.status).toLowerCase();
  if (["completed", "rejected", "rejected_no_coverage", "cancelled"].includes(status)) {
    return { ok: false, success: false, status_code: 400, error: "Only active projects can be cancelled" };
  }

  const ownerRef = asObject(manifest.owner_ref);
  const issuer = asObject(manifest.issuer);
  const organizationRef = asObject(manifest.organization_ref);
  const workflow = asObject(manifest.workflow);
  const ownerEmail = cleanText(manifest.owner_email || ownerRef.email || issuer.email).toLowerCase();
  const organizationId = cleanText(manifest.organization_id || organizationRef.id).toLowerCase();
  const refundAmount = Math.max(0, numberValue(manifest.amount_charged));
  const now = new Date().toISOString();
  let workHistory: unknown[] = [];
  if (Array.isArray(manifest.work_history)) workHistory = [...manifest.work_history];
  else if (Array.isArray(workflow.history)) workHistory = [...workflow.history];
  else if (Array.isArray(workflow.work_history)) workHistory = [...workflow.work_history];

  let refundResult: JsonObject | null = null;
  if (refundMode === "refund") {
    if (refundAmount <= 0) return { ok: false, success: false, status_code: 400, error: "This project does not have charged credits available to refund" };
    if (!organizationId) return { ok: false, success: false, status_code: 400, error: "This project does not have an associated organization available for refund" };
    refundResult = await applyCreditDelta(organizationId, {
      amount: refundAmount,
      reason: "cancellation_refund",
      applied_for_user_email: ownerEmail || null,
      meta: {
        project_id: projectId,
        address: manifest.address || "",
        project_type: manifest.project_type || "residential",
        source: "internal_portal_cancel_project",
        cancelled_by_email: actorEmail || null,
        cancelled_by_name: actorName || null,
        organization_id: organizationId,
        refund: refundAmount
      }
    }, actorEmail);
    workHistory.push({
      event: "credit_refunded",
      ts: now,
      by_email: actorEmail || null,
      by_name: actorName || null,
      refund_amount: refundAmount,
      refund_reason: "cancellation_refund",
      project_id: projectId,
      refund_scope: "org",
      refund_to_email: ownerEmail || null,
      refund_to_organization_id: organizationId,
      note: "Refunded as part of project cancellation"
    });
  }

  workHistory.push({
    event: "cancelled_project",
    ts: now,
    by_email: actorEmail || null,
    by_name: actorName || null,
    refund_decision: refundMode === "refund" ? "refunded" : "not_refunded",
    refund_amount: refundMode === "refund" ? refundAmount : 0,
    project_id: projectId,
    note: refundMode === "refund" ? `Project cancelled and $${refundAmount} refunded to credits` : "Project cancelled without refunding credits"
  });

  const patch = {
    status: "cancelled",
    cancelled_at: now,
    cancelled_by_email: actorEmail || null,
    cancelled_by_name: actorName || null,
    cancellation_refund_decision: refundMode === "refund" ? "refunded" : "not_refunded",
    cancellation_refunded: refundMode === "refund",
    cancellation_refund_amount: refundMode === "refund" ? refundAmount : 0,
    cancellation_refund_at: refundMode === "refund" ? now : null,
    cancellation_refund_by_email: refundMode === "refund" ? actorEmail || null : null,
    cancellation_refund_by_name: refundMode === "refund" ? actorName || null : null,
    cancellation: {
      cancelled_at: now,
      cancelled_by_email: actorEmail || null,
      cancelled_by_name: actorName || null,
      refund_decision: refundMode === "refund" ? "refunded" : "not_refunded",
      refund_amount: refundMode === "refund" ? refundAmount : 0,
      refund_at: refundMode === "refund" ? now : null,
      refund_by_email: refundMode === "refund" ? actorEmail || null : null,
      refund_by_name: refundMode === "refund" ? actorName || null : null,
      refund_scope: refundMode === "refund" ? "org" : null,
      customer_email: ownerEmail || null,
      organization_id: organizationId || null
    },
    timestamps: {
      ...asObject(manifest.timestamps),
      cancelled_at: now,
      updated_at: now
    },
    work_history: workHistory,
    workflow: {
      ...workflow,
      history: workHistory,
      work_history: workHistory
    }
  };
  const updated = await injectJson(app, "PATCH", `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`, patch);
  if (asObject(updated).success === false || asObject(updated).ok === false) {
    return {
      ok: false,
      success: false,
      status_code: Number(asObject(updated).status_code || 500),
      error: `Failed to cancel project.${refundMode === "refund" ? " Credit refund may have already been applied; please check the customer transaction history before retrying." : ""}`
    };
  }
  return {
    ok: true,
    success: true,
    project: asObject(updated.project).manifest || updated.project,
    refund_applied: refundMode === "refund",
    refunded: refundMode === "refund",
    refund_amount: refundMode === "refund" ? refundAmount : 0,
    refund_result: refundResult
  };
}

function numericUnix(value: unknown) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.floor(numeric);
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function callScriptView(input: JsonObject): CallScript {
  const data = asObject(input.data ?? input);
  const id = String(data.id ?? input.id ?? "").trim();
  const now = Math.floor(Date.now() / 1000);
  return {
    ...data,
    id,
    title: String(data.title ?? ""),
    description: String(data.description ?? ""),
    body: String(data.body ?? ""),
    created_at: numericUnix(data.created_at) || now,
    updated_at: numericUnix(data.updated_at) || now,
    created_by_email: String(data.created_by_email ?? ""),
    updated_by_email: String(data.updated_by_email ?? ""),
    usage_count: Number(data.usage_count ?? 0) || 0,
    last_used_at: numericUnix(data.last_used_at)
  };
}

function sortCallScripts(rows: CallScript[]) {
  return rows.sort((a, b) => {
    const usage = Number(b.usage_count || 0) - Number(a.usage_count || 0);
    if (usage !== 0) return usage;
    const updated = Number(b.updated_at || 0) - Number(a.updated_at || 0);
    if (updated !== 0) return updated;
    return String(a.title || "").localeCompare(String(b.title || ""));
  });
}

async function listCallScripts() {
  return sortCallScripts((await listInternalDocuments("call_scripts")).map(callScriptView).filter((script) => script.id));
}

function callScriptCanManage(user: JsonObject | null) {
  if (!user) return false;
  const permissions = asObject(user.permissions);
  if (permissions.manage_users || permissions.manage_sales_users || permissions.create_users) return true;
  const role = String(user.role ?? "").trim().toLowerCase();
  return ["admin", "system_admin", "lead", "sales_manager", "manager"].includes(role);
}

async function requireCallScriptAccess(actor: JsonObject) {
  const email = String(actor.email ?? "").trim().toLowerCase();
  const user = email ? await readInternalUser(email) : null;
  if (!user || String(user.account_type ?? "employee").toLowerCase() === "customer") {
    return { ok: false as const, user: null, error: "Unauthorized" };
  }
  return { ok: true as const, user, error: "" };
}

function newCallScriptId() {
  return `script_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function handleCallScriptLegacyAction(action: string, body: JsonObject, actor: JsonObject) {
  const access = await requireCallScriptAccess(actor);
  if (!access.ok) return { ok: false, success: false, status_code: 401, error: access.error };
  const canManage = callScriptCanManage(access.user);
  const rows = await listCallScripts();
  const actorEmail = String(actor.email ?? "").trim().toLowerCase();
  const now = Math.floor(Date.now() / 1000);

  if (action === "call_script_list") return { ok: true, success: true, scripts: rows, can_manage: canManage };

  const id = String(body.id ?? "").trim();
  const existing = rows.find((row) => row.id === id);
  if (action === "call_script_get") {
    if (!existing) return { ok: false, success: false, status_code: 404, error: "Script not found" };
    return { ok: true, success: true, script: existing, can_manage: canManage };
  }

  if (action === "call_script_save") {
    if (!canManage) return { ok: false, success: false, status_code: 403, error: "Only managers can edit call scripts" };
    const title = String(body.title ?? "").trim();
    if (!title) return { ok: false, success: false, status_code: 400, error: "Title is required" };
    const script: CallScript = {
      ...(existing ?? {}),
      id: existing?.id || id || newCallScriptId(),
      title,
      description: String(body.description ?? ""),
      body: String(body.body ?? ""),
      created_at: existing?.created_at || now,
      updated_at: now,
      created_by_email: existing?.created_by_email || actorEmail,
      updated_by_email: actorEmail,
      usage_count: existing?.usage_count || 0,
      last_used_at: existing?.last_used_at || 0
    };
    await saveInternalDocument("call_scripts", script.id, script, { replace: true });
    return { ok: true, success: true, scripts: await listCallScripts(), script };
  }

  if (action === "call_script_delete") {
    if (!canManage) return { ok: false, success: false, status_code: 403, error: "Only managers can delete call scripts" };
    if (!existing) return { ok: false, success: false, status_code: 404, error: "Script not found" };
    await deleteInternalDocument("call_scripts", existing.id);
    return { ok: true, success: true, scripts: await listCallScripts() };
  }

  if (action === "call_script_touch") {
    if (!existing) return { ok: false, success: false, status_code: 404, error: "Script not found" };
    const next = { ...existing, usage_count: Number(existing.usage_count || 0) + 1, last_used_at: now };
    await saveInternalDocument("call_scripts", existing.id, next, { replace: true });
    return { ok: true, success: true, script: next };
  }

  return { ok: false, success: false, status_code: 404, error: "Unknown call script action" };
}

async function handleLegacyAction(app: FastifyInstance, body: JsonObject, request: FastifyRequest, reply: FastifyReply) {
  const action = String(body.action ?? "").trim();
  const requestActor = actorFromRequest(request);
  const bodyActor = asObject(body.actor);
  const actor = {
    ...bodyActor,
    ...requestActor,
    email: requestActor.email || String(bodyActor.email ?? body.actor_email ?? body.current_user_email ?? body.user_email ?? "").trim().toLowerCase(),
    name: requestActor.name || String(bodyActor.name ?? body.actor_name ?? body.current_user_name ?? body.user_name ?? "").trim(),
    role: requestActor.role || String(bodyActor.role ?? body.actor_role ?? body.current_user_role ?? body.user_role ?? "").trim()
  };
  if (!action) throw badRequest("missing_action", "A legacy action is required.");

  switch (action) {
    case "call_script_list":
    case "call_script_get":
    case "call_script_save":
    case "call_script_delete":
    case "call_script_touch":
      return await handleCallScriptLegacyAction(action, body, actor);
    case "fetch_users": {
      const users = filterShiftUsers(filterUsers(await listInternalUsers(), body));
      return { ok: true, success: true, users: publicInternalUsers(users) };
    }
    case "save_user": {
      const email = String(body.email ?? "").trim().toLowerCase();
      requireValidInternalUserEmail(body, true);
      await requireExistingTeamAssignment(body);
      const user = await saveInternalUser({
        id: body.id || email,
        email,
        name: body.name,
        password: body.password,
        team_id: body.team ?? body.team_id,
        department: body.department,
        complexity_preference: body.complexity_preference,
        drafter_rank: body.drafter_rank,
        ...(typeof body.p1_eligible === "boolean" ? { p1_eligible: body.p1_eligible } : {}),
        ...(typeof body.p2_eligible === "boolean" ? { p2_eligible: body.p2_eligible } : {}),
        is_qa_trainee: body.is_qa_trainee === "1" || body.is_qa_trainee === true,
        queue_mode: body.queue_mode,
        role: body.role,
        permissions: parseJsonish(body.permissions, {}),
        training_complete: body.training_complete === "1" || body.training_complete === true,
        shift_rate: body.shift_rate
      }, { changedBy: String(actor.email ?? "") });
      await syncUserManagerTeam(user);
      const platform_login = await maybeSyncInternalUserPlatformLogin(user, body);
      return { ok: true, success: true, user: publicInternalUser(user), platform_login };
    }
    case "delete_user": {
      const deleted = await deleteInternalUser(String(body.email ?? body.id ?? ""));
      return { ok: true, success: deleted, deleted };
    }
    case "queue_live_trained_users": {
      const users = (await listInternalUsers()).filter((user) => user.status !== "disabled" && user.disabled !== true && user.training_complete);
      return { ok: true, success: true, users: publicInternalUsers(users) };
    }
    case "queue_admin_teams": {
      const teams = (await listInternalTeams()).map((team) => ({ id: team.id, label: team.name }));
      return { ok: true, success: true, teams };
    }
    case "get_user_queue_mode": {
      const email = String(body.email ?? body.user_email ?? actor.email ?? "").trim().toLowerCase();
      const user = email ? await readInternalUser(email) : null;
      const mode = String(user?.queue_mode ?? "disabled").trim().toLowerCase() || "disabled";
      const labels: Record<string, string> = {
        disabled: "Disabled",
        wait_for_feedback: "Wait For Feedback",
        hot_swap: "Hot Swap"
      };
      return {
        ok: true,
        success: true,
        queue_mode: mode,
        queue_mode_label: labels[mode] ?? mode,
        blocked: false,
        blocked_reason: "",
        user
      };
    }
    case "set_user_queue_mode": {
      const email = String(body.email ?? body.user_email ?? actor.email ?? "").trim().toLowerCase();
      const queueMode = String(body.queue_mode ?? "disabled").trim().toLowerCase() || "disabled";
      const validModes = new Set(["disabled", "wait_for_feedback", "hot_swap"]);
      if (!email) return { ok: false, success: false, error: "missing_user_email" };
      if (!validModes.has(queueMode)) return { ok: false, success: false, error: "invalid_queue_mode" };
      const user = await patchInternalUser(email, {
        queue_mode: queueMode,
        queue_mode_updated_at: new Date().toISOString(),
        queue_mode_updated_by: actor.email || null
      });
      return {
        ok: true,
        success: Boolean(user),
        queue_mode: queueMode,
        queue_mode_label: queueMode.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()),
        user
      };
    }
    case "debug_organization_summaries": {
      if (!isDebugRequest(request)) return { ok: false, success: false, status_code: 403, error: "forbidden" };
      return await diagnoseOrganizationSummaries(body);
    }
    case "stats_credit_revenue": {
      await requireFullInternalAdmin(actor);
      return await statsCreditRevenueForRanges(body);
    }
    case "fetch_organizations_list":
    case "customer_org_dashboard_data": {
      if (body.paginate === "1" || body.paginate === "true" || body.paginate === true) {
        const result = await paginatedOrganizationDashboard(body);
        return { ok: true, success: true, ...result };
      }
      const result = await compactCachedOrganizationSummaries({ include_credits: true });
      return { ok: true, success: true, organizations: result.organizations, orgs: result.organizations, totals: result.totals, cached: result.cached };
    }
    case "customer_org_detail": {
      const orgId = String(body.org_id ?? body.id ?? "").trim();
      return await organizationDetail(orgId, body);
    }
    case "org_assign_sales_owner": {
      const orgId = String(body.org_id ?? "").trim();
      const organization = await patchOrganization(orgId, { sales_owner_email: String(body.email ?? body.sales_owner_email ?? "").trim().toLowerCase() });
      clearOrganizationSummaryCache();
      return { ok: true, success: true, organization };
    }
    case "org_set_test_flag": {
      const orgId = String(body.org_id ?? "").trim();
      const isTest = body.is_test === "1" || body.is_test === true;
      const organization = await patchOrganization(orgId, { is_test: isTest, metadata: { is_test: isTest } });
      await saveGlobal(orgId, { data: { is_test: isTest } });
      clearOrganizationSummaryCache();
      return { ok: true, success: true, organization, is_test: isTest };
    }
    case "admin_adjust_org_credits": {
      const result = await applyCreditDelta(String(body.org_id ?? ""), { amount: body.amount ?? body.delta, reason: body.reason, meta: parseJsonish(body.meta, {}) }, actor.email);
      return { ok: true, success: true, ...result };
    }
    case "admin_adjust_org_free_expedites": {
      const result = await applyFreeExpediteDelta(String(body.org_id ?? ""), {
        amount: body.amount ?? body.delta,
        direction: body.direction,
        reason: body.reason,
        meta: parseJsonish(body.meta, {})
      }, actor.email);
      return { ok: true, success: true, ...result };
    }
    case "customer_pair_candidates": {
      return { ok: true, success: true, candidates: [], organizations: await buildOrganizationSummaries({ include_credits: false }) };
    }
    case "lead_pair_search": {
      return { ok: true, success: true, leads: [], q: String(body.q ?? "") };
    }
    case "customer_apply_pairs": {
      const pairs = Array.isArray(parseJsonish(body.pairs, [])) ? parseJsonish(body.pairs, []) as unknown[] : [];
      return { ok: true, success: true, pairs };
    }
    case "admin_impersonate_user": {
      return await startCustomerImpersonation(request, reply, body, actor);
    }
    case "stats_data": {
      await requireFullInternalAdmin(actor);
      return { ok: true, success: true, stats: await buildInternalStats() };
    }
    case "fetch_all_users_with_orders": {
      const users = await listInternalUsers();
      return { ok: true, success: true, users: publicInternalUsers(users) };
    }
    case "shift_get_schedules": {
      const viewer = await internalActorUser(actor);
      const canEdit = canManageShiftSchedules(viewer);
      const users = filterShiftUsers(filterUsers(await listInternalUsers(), body));
      return {
        ok: true,
        success: true,
        view_level: "all",
        edit_level: canEdit ? "all" : "none",
        schedules: users.map((user) => shiftScheduleRow(user, String(body.week_of ?? ""))),
        users: publicInternalUsers(users)
      };
    }
    case "shift_get_my_schedule": {
      const user = actor.email ? await readInternalUser(actor.email) : null;
      return { ok: true, success: true, schedule: user?.shift_schedule ?? {}, user: user ? publicInternalUser(user) : null };
    }
    case "shift_current_status": {
      const document = await readInternalDocument("shifts", "current_status");
      return { ok: true, success: true, ...(document?.data ?? {}), status: document?.data ?? {} };
    }
    case "shift_session_stats":
    case "shift_personal_snapshot": {
      const document = await readInternalDocument("shifts", action === "shift_session_stats" ? "session_stats" : `personal_${actor.email || "anonymous"}`);
      return {
        ok: true,
        success: true,
        shift: asObject(asObject(document?.data).shift),
        stats: {
          technician: asObject(asObject(document?.data).technician),
          qa: asObject(asObject(document?.data).qa)
        },
        data: document?.data ?? {}
      };
    }
    case "shift_save_schedule": {
      await requireShiftScheduleManager(actor);
      const userId = String(body.target_email ?? body.email ?? body.user_id ?? "").trim();
      const schedule = asObject(parseJsonish(body.schedule ?? body.shift_schedule, {}));
      const recurring = parseJsonish(body.recurring, undefined);
      const overrides = parseJsonish(body.overrides, undefined);
      if (recurring !== undefined) schedule.recurring = normalizeShiftDayMap(recurring);
      if (overrides !== undefined) schedule.overrides = normalizeShiftOverrides(overrides);
      const user = await patchInternalUser(userId, { shift_schedule: asObject(schedule) });
      return { ok: true, success: Boolean(user), user: user ? publicInternalUser(user) : null };
    }
    case "shift_save_day_override":
    case "shift_remove_day_override": {
      await requireShiftScheduleManager(actor);
      const userId = String(body.target_email ?? body.email ?? body.user_id ?? actor.email ?? "").trim();
      const date = String(body.date ?? "").trim();
      const user = userId ? await readInternalUser(userId) : null;
      if (!user || !date) return { ok: false, success: false, error: "missing_shift_override_target" };
      const schedule = asObject(user.shift_schedule);
      const overrides = normalizeShiftOverrides(schedule.overrides);
      if (action === "shift_remove_day_override") {
        delete overrides[date];
      } else {
        overrides[date] = parseJsonish(body.blocks, []);
      }
      const updated = await patchInternalUser(userId, { shift_schedule: { ...schedule, overrides, updated_at: new Date().toISOString(), updated_by: actor.email || null } });
      const document = await saveInternalDocument("shift_overrides", `${userId}_${date}`, { ...body, email: userId, date, removed: action === "shift_remove_day_override" }, { replace: true });
      return { ok: true, success: Boolean(updated), user: updated, override: document };
    }
    case "portal_status_snapshot": {
      return await injectJson(app, "POST", "/v1/firstmeasure/status/snapshot", { ...body, actor });
    }
    case "rush_mode_current":
      return await injectJson(app, "GET", "/v1/internal/admin/rush-modes/current");
    case "rush_mode_list":
      return await injectJson(app, "GET", "/v1/internal/admin/rush-modes");
    case "rush_mode_start":
      return await injectJson(app, "POST", "/v1/firstmeasure/admin/rush-modes", { ...body, actor });
    case "rush_mode_automation_get":
      return await injectJson(app, "POST", "/v1/firstmeasure/admin/rush-modes/automation", { actor });
    case "rush_mode_automation_set":
      return await injectJson(app, "POST", "/v1/firstmeasure/admin/rush-modes/automation/update", { ...body, actor });
    case "pj_rebuild":
      return await injectJson(app, "POST", "/v1/internal/admin/reindex");
    case "server_config_list": {
      return { ok: true, success: true, configs: await listInternalDocuments("server_config") };
    }
    case "server_config_set": {
      const key = String(body.key ?? body.name ?? "").trim();
      const value = parseJsonish(body.value, body.value);
      const document = await saveInternalDocument("server_config", key, { key, value }, { replace: true });
      return { ok: true, success: true, config: document, value };
    }
    case "get_apple_key_info": {
      const store = await readAppleKeyStore();
      return {
        ok: true,
        success: true,
        key: store.key || null,
        updated_at_utc: store.updated_at_utc,
        tile_version: store.tile_version
      };
    }
    case "set_apple_key":
      return await injectJson(app, "POST", "/v1/internal/admin/apple-key", {
        key: body.key,
        tile_version: body.tile_version,
        actor
      });
    case "coupon_admin_list": {
      const coupons = (await listInternalDocuments("coupons")).map((document) => couponView(document));
      return { ok: true, success: true, coupons };
    }
    case "coupon_admin_get": {
      const coupon = await readInternalDocument("coupons", String(body.code_hash ?? body.id ?? ""));
      return { ok: true, success: Boolean(coupon), coupon: coupon ? couponView(coupon) : null, error: coupon ? undefined : "not_found" };
    }
    case "coupon_admin_create": {
      const code = String(body.code || `FM-${Math.random().toString(36).slice(2, 8)}`).toUpperCase();
      const codeHash = String(body.code_hash || code.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"));
      const coupon = await saveInternalDocument("coupons", codeHash, { ...body, code_hash: codeHash, code, status: body.status || "active" }, { replace: true });
      return { ok: true, success: true, code, coupon: couponView(coupon) };
    }
    case "coupon_admin_update": {
      const codeHash = String(body.code_hash ?? "");
      const coupon = await saveInternalDocument("coupons", codeHash, body);
      return { ok: true, success: true, coupon: couponView(coupon) };
    }
    case "coupon_admin_delete": {
      const deleted = await deleteInternalDocument("coupons", String(body.code_hash ?? ""));
      return { ok: true, success: Boolean(deleted), deleted };
    }
    case "commission_dashboard": {
      return await commissionDashboard(actor.email);
    }
    case "commission_save_user_settings": {
      const email = String(body.user_email ?? "").trim().toLowerCase();
      if (!email) return { ok: false, success: false, error: "Missing user" };
      await saveInternalDocument("commission_user_settings", email, {
        user_email: email,
        monthly_quota: Math.max(0, Number(body.monthly_quota ?? 0) || 0),
        base_pay_cents: Math.round((Number(body.base_pay ?? 0) || 0) * 100),
        milestone_payout_cents: Math.round((Number(body.milestone_payout ?? 0) || 0) * 100),
        updated_at: Math.floor(Date.now() / 1000),
        updated_by_email: actor.email
      }, { replace: true });
      return await commissionDashboard(actor.email);
    }
    case "commission_mark_payroll_completed": {
      const payrollId = String(body.payroll_id ?? "").trim();
      const existing = payrollId ? await readInternalDocument("commission_payrolls", payrollId) : null;
      if (!existing) return { ok: false, success: false, error: "Missing payroll" };
      await saveInternalDocument("commission_payrolls", payrollId, {
        ...asObject(existing.data),
        status: "completed",
        completed_at: Math.floor(Date.now() / 1000),
        completed_by_email: actor.email,
        updated_at: Math.floor(Date.now() / 1000)
      }, { replace: true });
      return await commissionDashboard(actor.email);
    }
    case "commission_export_report": {
      const dashboard = await commissionDashboard(actor.email);
      return { ok: true, success: true, filename: `commissions_${String(dashboard.current_month ?? "current").replace("-", "_")}.csv`, csv: commissionCsv(dashboard) };
    }
    case "lead_sales_users":
      return { ok: true, success: true, users: await salesUsers() };
    case "lead_my_leads":
      return await salesLeads(body, actor.email);
    case "lead_my_followups":
      return await salesFollowups(body, actor.email);
    case "lead_get":
      return await salesLeadDetail(String(body.lead_id ?? body.id ?? ""));
    case "lead_dashboard":
      return await salesDashboard(body, actor.email);
    case "lead_pipeline_snapshot":
      return await salesPipelineSnapshot(body, actor.email);
    case "lead_sequences_snapshot":
      return await salesSequencesSnapshot(body, actor.email);
    case "lead_analytics":
      return await salesAnalytics(body, actor.email);
    case "lead_list_list":
      return await salesLeadLists(body);
    case "lead_list_leads":
      return await salesListLeads(body);
    case "lead_list_get":
      return await salesLeadListDetail(String(body.list_id ?? body.id ?? ""));
    case "lead_orum_import_history":
      return { ok: true, success: true, runs: sqliteRows("leads", "SELECT * FROM lead_import_runs ORDER BY created_at DESC LIMIT 100") };
    case "lead_preview_orum_csv":
    case "lead_confirm_orum_import":
    case "lead_import_orum_csv":
      return { ok: true, success: true, rows: 0, matched: 0, unmatched: [], message: "Node import endpoint is ready; CSV parsing migration is pending." };
    case "lead_export_leads_csv":
    case "lead_export_csv":
      return { ok: true, success: true, csv: "", filename: "leads.csv" };
    case "lead_dashboard_task_save":
    case "lead_dashboard_task_toggle":
    case "lead_dashboard_task_delete":
    case "lead_list_save":
    case "lead_list_delete":
    case "lead_save":
    case "lead_delete":
    case "lead_add_note":
    case "lead_save_contact":
    case "lead_save_contact_note":
    case "lead_select_contact":
    case "lead_save_followup":
    case "lead_update_company_email":
    case "lead_update_core_fields":
    case "lead_set_primary_contact":
    case "lead_save_stage":
    case "lead_save_milestone":
    case "lead_assign_org_credits":
    case "lead_save_email_branding":
    case "lead_sequence_action":
    case "lead_schedule_calendar":
    case "lead_send_sms":
    case "crm_call_annotation_save":
      return { ok: true, success: true, saved: true, node_bridge: true };
    case "crm_settings_get": {
      const document = await readInternalDocument("crm_settings", "current");
      return { ok: true, success: true, settings: document?.data ?? {}, crm_settings: document?.data ?? {} };
    }
    case "crm_settings_save": {
      const document = await saveInternalDocument("crm_settings", "current", body, { replace: true });
      return { ok: true, success: true, settings: document.data, crm_settings: document.data };
    }
    case "google_connection_status":
    case "gmail_connection_status":
    case "gmail_disconnect":
    case "gmail_background_sync":
    case "gmail_debug_snapshot":
    case "lead_sync_gmail":
    case "lead_send_email":
      return await handleCommunicationsLegacyAction(action, body, request);
    case "mock_comms_settings_get":
      return { ok: true, success: true, settings: {} };
    case "mock_comms_settings_save":
    case "mock_comms_reset":
    case "mock_comms_inject_gmail":
    case "mock_comms_inject_calendar":
      return { ok: true, success: true };
    case "lead_bulk_email_send":
    case "lead_bulk_email_bootstrap":
    case "lead_bulk_email_preview":
      return await handleCommunicationsLegacyAction(action, body, request);
    case "lead_email_sample_bundle":
      return { ok: true, success: true, bundle: {}, samples: [] };
    case "referral_partner_list":
    case "referral_partners_list":
      return { ok: true, success: true, partners: listCrmReferralPartners() };
    case "referral_partner_get":
      return getCrmReferralPartner(String(body.id ?? body.partner_id ?? ""));
    case "referral_partner_save":
      return await saveCrmReferralPartner(body);
    case "referral_org_search":
      {
        const organizations = await searchReferralOrganizations(String(body.query ?? ""), Number(body.limit ?? 80) || 80);
        return { ok: true, success: true, rows: organizations, organizations };
      }
    case "referral_manual_attach":
      return await attachReferralOrganization(body);
    case "referral_rewards_dashboard":
    case "referral_reward_dashboard":
    case "referral_reward_report":
      return { ok: true, success: true, rows: crmReferralRewardReport(), rewards: crmReferralRows("referral_reward_ledger"), attributions: crmReferralRows("referral_attributions") };
    case "referral_reward_update_status":
      return updateCrmReferralRewardStatus(String(body.reward_id ?? ""), String(body.status ?? "pending"));
    case "list_sample_projects":
      return await sampleReportsList(app, body, actor, request);
    case "load_sample_project_bundle":
      return await sampleReportsBundle(app, String(body.folder ?? body.project_id ?? body.id ?? ""), actor, request);
    case "toggle_sample_favorite":
      return await sampleReportsToggleFavorite(body, actor);
    case "lead_create_territory_lists":
    case "lead_generate_daily_lists":
    case "lead_generate_followup_lists":
    case "lead_assign_list":
    case "lead_distribute_unassigned":
      return { ok: true, success: true, created: [], updated: 0 };
    case "lead_list_fetcher_get_config":
      return { ok: true, success: true, status: "ok", config: {} };
    case "lead_list_fetcher_get_tile_status":
      return { ok: true, success: true, status: "ok", tiles: {} };
    case "lead_list_fetcher_get_raw_businesses":
      return { ok: true, success: true, status: "ok", businesses: [] };
    case "lead_list_fetcher_get_detail_index":
      return { ok: true, success: true, status: "ok", index: {} };
    case "lead_list_fetcher_save_config":
      return { ok: true, success: true, status: "ok", config: body };
    case "lead_list_fetcher_pull_tile":
      return { ok: true, success: true, status: "ok", result: { tile_key: body.tile_key, pulled: 0, node_bridge: true } };
    case "lead_list_fetcher_pull_details_batch":
      return { ok: true, success: true, status: "ok", fetched: 0, node_bridge: true };
    case "data_agent_get_settings":
    case "data_agent_save_settings":
    case "data_agent_list_sessions":
    case "data_agent_get_session":
    case "data_agent_bootstrap":
    case "data_agent_delete_session":
    case "data_agent_rename_session":
    case "data_agent_start_run":
    case "data_agent_get_run":
    case "data_agent_new_session":
      return await handleDataAgentLegacyAction(action, body);
    case "list_tutorial_projects":
    case "fetch_curriculum":
    case "fetch_student_list":
    case "fetch_tutorial_exam_grades":
    case "set_tutorial_exam_reviewed":
      return await handleTutorialLegacyAction(action, body, actor);
    case "save_tutorial_project_editor":
      return await saveTutorialProjectEditor(body, actor);
    case "fetch_student_details":
      return await handleTutorialLegacyAction(action, body, actor);
    case "update_progress":
    case "save_curriculum":
    case "start_tutorial_project":
    case "start_tutorial_test_attempt":
    case "start_tutorial_draft_reject_round":
      return await handleTutorialLegacyAction(action, body, actor);
    case "technician_leaderboard":
      return await buildCachedTechnicianLeaderboard(body);
    case "my_active_projects": {
      const status = asObject(await injectJson(app, "POST", "/v1/firstmeasure/queue/status/compat", {
        ...body,
        actor,
        include_active_projects: true
      }));
      const projects = Array.isArray(status.active_projects) ? status.active_projects : [];
      return { ok: true, success: true, projects, count: projects.length, source: "queue_status" };
    }
    case "claim_next_for_me": {
      // "Next" must first resume work already owned by this actor. The legacy
      // bridge previously skipped this and claimed only from the unassigned queue,
      // which stranded active work whenever the new-work queue was empty.
      const status = asObject(await injectJson(app, "POST", "/v1/firstmeasure/queue/status/compat", {
        ...body,
        actor,
        include_active_projects: true
      }));
      const actorEmail = String(actor.email ?? "").trim().toLowerCase();
      const excludedProjectId = String(body.exclude_project_id ?? body.exclude_folder ?? "").trim();
      const resumableStatuses = new Set(["queued", "ready", "processing", "in_progress", "correction_needed", "requeue"]);
      const activeProjects = Array.isArray(status.active_projects) ? status.active_projects : [];
      const resumeProject = activeProjects
        .map((project) => asObject(project))
        .find((project) => {
          const projectId = String(project.id ?? project.folder ?? project.project_id ?? "").trim();
          if (!projectId || projectId === excludedProjectId) return false;
          const projectStatus = String(project.status ?? "").trim().toLowerCase().replace(/\s+/g, "_");
          if (!resumableStatuses.has(projectStatus)) return false;
          const assignedEmail = String(project.assigned_to_email ?? "").trim().toLowerCase();
          const correctionEmail = String(project.correction_to_email ?? "").trim().toLowerCase();
          return actorEmail !== "" && (assignedEmail === actorEmail || correctionEmail === actorEmail);
        });
      if (resumeProject) {
        const folder = String(resumeProject.id ?? resumeProject.folder ?? resumeProject.project_id ?? "").trim();
        return {
          ok: true,
          success: true,
          found: true,
          resumed: true,
          source: "existing_active",
          folder,
          address: String(resumeProject.address ?? ""),
          project: resumeProject
        };
      }
      return await injectJson(app, "POST", "/v1/firstmeasure/queue/claim-next/compat", { ...body, actor });
    }
    case "check_hot_swap":
      return { ok: true, success: true, has_swap: false, reason: "node_monitor_no_swap_needed" };
    case "execute_hot_swap":
      return await injectJson(app, "POST", "/v1/firstmeasure/queue/claim-next/compat", {
        ...body,
        actor,
        project_id: body.target_folder ?? body.folder ?? body.project_id
      });
    case "record_reopened_project_claim": {
      const projectId = String(body.folder ?? body.project_id ?? body.id ?? "").trim();
      if (!projectId) return { ok: false, success: false, error: "missing_project_id" };
      const document = await saveInternalDocument("reopened_project_claims", projectId, {
        project_id: projectId,
        actor,
        claimed_at: new Date().toISOString()
      }, { replace: true });
      return { ok: true, success: true, claim: document };
    }
    case "qa_queue_move_to_top":
      return await injectProject(app, body, "/qa/priority", { prioritized: true, actor });
    case "qa_queue_clear_priority":
      return await injectProject(app, body, "/qa/priority", { prioritized: false, actor });
    case "manager_complexity_override":
      return await injectProject(app, body, "", { complexity: body.complexity, actor }, "PATCH");
    case "reject_no_coverage":
      return await injectProject(app, body, "/coverage/reject", { ...body, actor });
    case "cancel_project":
      return await handleCancelProjectLegacyAction(app, body, actor);
    case "reopen_completed_project":
      return await injectProject(app, body, "/status", { status: "not_started", actor });
    case "set_break_status":
      return { ok: true, success: true };
    case "manager_review_data":
      return await managerReviewData(app, actor, false, body);
    case "manager_review_results":
      return await managerReviewResults(body, actor);
    case "manager_review_settings_get":
      return { ok: true, success: true, settings: await managerReviewSettings(actor, false) };
    case "manager_review_settings_save":
      return { ok: true, success: true, settings: await managerReviewSettings(actor, true, body) };
    case "manager_review_project_bundle":
      return await managerReviewProjectBundle(body, actor);
    case "manager_review_annotations_save":
      return await managerReviewSaveAnnotations(body, actor);
    case "manager_audit_mark":
      return await managerReviewMarkAudit(body, actor);
    case "manager_review_override":
      return await managerReviewOverride(body, actor);
    default:
      throw badRequest("unsupported_legacy_action", `Node internal API does not support legacy action '${action}'.`);
  }
}

function managerReviewText(...values: unknown[]) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

async function managerReviewActorUser(actor: JsonObject) {
  const email = String(actor.email ?? "").trim().toLowerCase();
  if (!email) throw unauthorized("manager_review_login_required", "Manager Review requires a signed-in internal user.");
  const user = await readInternalUser(email);
  if (!user) throw forbidden("manager_review_user_not_found", "The signed-in user is not registered for internal Manager Review access.");
  return user;
}

async function requireManagerReviewAccess(actor: JsonObject) {
  const user = await managerReviewActorUser(actor);
  const permissions = asObject(user.permissions);
  const allowed = isStrictInternalAdmin(user)
    || Boolean(permissions.perform_manager_review);
  if (!allowed) throw forbidden("manager_review_forbidden", "This user cannot perform blind manager reviews.");
  return user;
}

async function requireManagerReviewResultsAccess(actor: JsonObject) {
  const user = await managerReviewActorUser(actor);
  const permissions = asObject(user.permissions);
  const role = String(user.role ?? "").trim().toLowerCase();
  const isManager = isStrictInternalAdmin(user) || role === "manager" || Boolean(permissions.view_manager_review_results);
  const canOverride = isStrictInternalAdmin(user) || role === "manager";
  const isQa = role === "qa" || Boolean(permissions.manage_qa);
  if (!isManager && !isQa) throw forbidden("manager_review_results_forbidden", "This user cannot view Manager Review results.");
  return { user, isManager, isQa, canOverride };
}

async function requireManagerReviewOverrideAccess(actor: JsonObject) {
  const user = await managerReviewActorUser(actor);
  const role = String(user.role ?? "").trim().toLowerCase();
  if (!isStrictInternalAdmin(user) && role !== "manager") {
    throw forbidden("manager_review_override_forbidden", "Only managers can exclude Manager Review results from scoring.");
  }
  return user;
}

function managerReviewQaActor(manifest: JsonObject) {
  const workflow = asObject(manifest.workflow);
  const directEmail = managerReviewText(
    manifest.qa_reviewer_email,
    manifest.qa_reviewed_by_email,
    manifest.qa_reviewed_by,
    manifest.qa_approved_by_email,
    manifest.qa_approved_by,
    asObject(workflow.qa_claim).email
  ).toLowerCase();
  const directName = managerReviewText(
    manifest.qa_reviewer_name,
    manifest.qa_reviewed_by_name,
    manifest.qa_approved_by_name,
    asObject(workflow.qa_claim).name,
    directEmail
  );
  if (directEmail) return { email: directEmail, name: directName };
  const history = Array.isArray(manifest.work_history)
    ? manifest.work_history
    : (Array.isArray(workflow.history) ? workflow.history : []);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = asObject(history[index]);
    const type = String(event.event ?? event.type ?? "").trim().toLowerCase();
    if (!["qa_approved", "qa_approved_pending_manager", "qa_reviewed", "qa_claimed", "qa_bulk_approved"].includes(type)) continue;
    const email = managerReviewText(event.qa_email, event.qa_reviewer_email, event.by_email, event.user_email).toLowerCase();
    if (email) return { email, name: managerReviewText(event.qa_name, event.qa_reviewer_name, event.by_name, event.user_name, email) };
  }
  return { email: "", name: "" };
}

function managerReviewTechnician(manifest: JsonObject) {
  const workflow = asObject(manifest.workflow);
  const assigned = asObject(workflow.assigned_to);
  const email = managerReviewText(
    manifest.assigned_to_email,
    manifest.technician_email,
    manifest.drafter_email,
    assigned.email
  ).toLowerCase();
  return {
    email,
    name: managerReviewText(manifest.assigned_to_name, manifest.technician_name, manifest.drafter_name, assigned.name, email)
  };
}

function managerReviewAuditRecord(manifest: JsonObject) {
  const audit = asObject(manifest.audit);
  const record = asObject(manifest.manager_audit_record ?? audit.manager_audit_record);
  const status = managerReviewText(manifest.manager_audit_status, audit.manager_audit_status, record.status);
  if (!status) return null;
  const scoreRaw = record.quality_score ?? manifest.manager_audit_quality_score ?? audit.manager_audit_quality_score;
  const score = scoreRaw === null || scoreRaw === undefined || scoreRaw === "" ? null : Number(scoreRaw);
  return {
    ...record,
    status,
    outcome: managerReviewText(record.outcome, status === "flagged" ? "issue" : "pass"),
    quality_score: Number.isFinite(score) ? Math.max(0, Math.min(100, score as number)) : null,
    note: managerReviewText(record.note, manifest.manager_audit_note, audit.manager_audit_note) || null,
    attachments: Array.isArray(record.attachments)
      ? record.attachments
      : (Array.isArray(manifest.manager_audit_attachments)
        ? manifest.manager_audit_attachments
        : (Array.isArray(audit.manager_audit_attachments) ? audit.manager_audit_attachments : [])),
    issue_categories: Array.isArray(record.issue_categories)
      ? record.issue_categories
      : (Array.isArray(manifest.manager_audit_issue_categories)
        ? manifest.manager_audit_issue_categories
        : (managerReviewText(record.issue_category, manifest.manager_audit_issue_category, audit.manager_audit_issue_category)
          ? [managerReviewText(record.issue_category, manifest.manager_audit_issue_category, audit.manager_audit_issue_category)]
          : [])),
    issue_category: managerReviewText(record.issue_category, manifest.manager_audit_issue_category, audit.manager_audit_issue_category) || null,
    severity: managerReviewText(record.severity, manifest.manager_audit_severity, audit.manager_audit_severity) || null,
    score_excluded: Boolean(record.score_excluded ?? manifest.manager_audit_score_excluded ?? audit.manager_audit_score_excluded),
    score_excluded_at: managerReviewText(record.score_excluded_at, manifest.manager_audit_score_excluded_at, audit.manager_audit_score_excluded_at) || null,
    score_excluded_by_email: managerReviewText(record.score_excluded_by_email, manifest.manager_audit_score_excluded_by_email, audit.manager_audit_score_excluded_by_email) || null,
    reviewed_at: managerReviewText(record.reviewed_at, manifest.manager_audit_updated_at, audit.manager_audit_updated_at) || null,
    reviewer_email: managerReviewText(record.reviewer_email, manifest.manager_audit_updated_by_email, audit.manager_audit_updated_by_email) || null,
    reviewer_name: managerReviewText(record.reviewer_name, manifest.manager_audit_updated_by_name, audit.manager_audit_updated_by_name) || null
  };
}

function managerReviewProjectRow(manifest: JsonObject, includeIdentities: boolean) {
  const timestamps = asObject(manifest.timestamps);
  const audit = managerReviewAuditRecord(manifest);
  const base: JsonObject = {
    id: managerReviewText(manifest.id, manifest.folder, manifest.project_id),
    address: managerReviewText(manifest.address, manifest.formatted_address),
    status: managerReviewText(manifest.status, "completed"),
    created_at: managerReviewText(manifest.created_at, timestamps.created_at) || null,
    completed_at: managerReviewText(manifest.completed_at, timestamps.completed_at, manifest.updated_at, timestamps.updated_at) || null,
    project_type: managerReviewText(manifest.project_type, manifest.type, "residential"),
    complexity: manifest.complexity ?? null,
    is_filler: Boolean(manifest.is_filler),
    is_vip: Boolean(manifest.is_vip),
    is_expedited: Boolean(manifest.is_expedited),
    manager_audit_status: audit?.status ?? null,
    manager_audit_note: audit?.note ?? null,
    manager_audit_quality_score: audit?.quality_score ?? null,
    manager_audit_issue_category: audit?.issue_category ?? null,
    manager_audit_issue_categories: audit?.issue_categories ?? [],
    manager_audit_attachments: Array.isArray(audit?.attachments) ? audit.attachments : [],
    manager_audit_severity: audit?.severity ?? null,
    manager_audit_score_excluded: audit?.score_excluded ?? false,
    manager_audit_updated_at: audit?.reviewed_at ?? null
  };
  if (!includeIdentities) return base;
  const qa = managerReviewQaActor(manifest);
  const technician = managerReviewTechnician(manifest);
  return {
    ...base,
    qa_reviewer_email: qa.email,
    qa_reviewer_name: qa.name,
    assigned_to_email: technician.email,
    assigned_to_name: technician.name,
    manager_audit: audit,
    manager_audit_history: Array.isArray(manifest.manager_audit_history) ? manifest.manager_audit_history : []
  };
}

const MANAGER_REVIEW_DEFAULT_DAILY_TARGET = 100;
const MANAGER_REVIEW_MAX_DAILY_TARGET = 1000;

function managerReviewDocumentData(document: unknown) {
  return asObject(asObject(document).data);
}

function managerReviewSampleDate(value: unknown) {
  const requested = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : new Date().toISOString().slice(0, 10);
}

function managerReviewDatesAfter(startDate: string, endDate: string) {
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(cursor.getTime()) || !Number.isFinite(end.getTime())) return dates;
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor < end) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function managerReviewManifestAvailableBy(manifest: JsonObject, sampleDate: string) {
  const timestamps = asObject(manifest.timestamps);
  const raw = managerReviewText(
    manifest.completed_at,
    timestamps.completed_at,
    manifest.rejected_at,
    timestamps.rejected_at,
    manifest.updated_at,
    timestamps.updated_at
  );
  if (!raw) return true;
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T") + "Z";
  const completedAt = new Date(normalized).getTime();
  const endOfSampleDay = new Date(`${sampleDate}T23:59:59.999Z`).getTime();
  return !Number.isFinite(completedAt) || completedAt <= endOfSampleDay;
}

function managerReviewSampleEntry(manifest: JsonObject): JsonObject {
  const qa = managerReviewQaActor(manifest);
  const technician = managerReviewTechnician(manifest);
  return {
    project_id: managerReviewText(manifest.id, manifest.folder, manifest.project_id),
    address: managerReviewText(manifest.address, manifest.formatted_address) || null,
    qa_email: qa.email || null,
    qa_name: qa.name || null,
    technician_email: technician.email || null,
    technician_name: technician.name || null,
    project_type: managerReviewText(manifest.project_type, manifest.type, "residential"),
    complexity: manifest.complexity ?? null,
    team_id: managerReviewText(manifest.team_id, manifest.team, "default"),
    team_name: managerReviewText(manifest.team_name, manifest.team_id, manifest.team, "Default"),
    completed_at: managerReviewText(manifest.completed_at, asObject(manifest.timestamps).completed_at) || null,
    project_status: managerReviewText(manifest.status, "completed")
  };
}

async function managerReviewSettings(actor: JsonObject, save: boolean, body: JsonObject = {}) {
  if (save) await requireManagerReviewOverrideAccess(actor);
  else {
    const user = await managerReviewActorUser(actor);
    const permissions = asObject(user.permissions);
    if (!isStrictInternalAdmin(user) && !Boolean(permissions.perform_manager_review)) {
      await requireManagerReviewResultsAccess(actor);
    }
  }
  const existing = managerReviewDocumentData(await readInternalDocument("manager_review_config", "settings"));
  let dailyTarget = Number(existing.daily_target ?? MANAGER_REVIEW_DEFAULT_DAILY_TARGET);
  if (!Number.isInteger(dailyTarget) || dailyTarget < 1 || dailyTarget > MANAGER_REVIEW_MAX_DAILY_TARGET) {
    dailyTarget = MANAGER_REVIEW_DEFAULT_DAILY_TARGET;
  }
  if (save) {
    const requested = Number(body.daily_target);
    if (!Number.isInteger(requested) || requested < 1 || requested > MANAGER_REVIEW_MAX_DAILY_TARGET) {
      throw badRequest("invalid_manager_review_daily_target", `Daily sample target must be a whole number from 1 to ${MANAGER_REVIEW_MAX_DAILY_TARGET}.`);
    }
    dailyTarget = requested;
    await saveInternalDocument("manager_review_config", "settings", { data: { daily_target: dailyTarget } }, { replace: true });
  }
  return { daily_target: dailyTarget, max_daily_target: MANAGER_REVIEW_MAX_DAILY_TARGET };
}

async function managerReviewQueryProjects(app: FastifyInstance, target: number): Promise<JsonObject[]> {
  void app;
  const result = await queryIndexedProjectManifests({
    statuses: ["completed", "rejected", "rejected_no_coverage"],
    activityStartMs: Date.now() - 30 * 24 * 60 * 60 * 1000,
    activityFields: ["completed", "rejected", "updated"],
    includeInstantOnly: true,
    limit: Math.min(20000, Math.max(2000, target * 50))
  });
  return result.projects.map((item: unknown) => asObject(item));
}

function managerReviewStratifiedCandidates(manifests: JsonObject[], sampleDate: string) {
  const groups = new Map<string, JsonObject[]>();
  for (const manifest of manifests) {
    const key = managerReviewQaActor(manifest).email || "unknown";
    const group = groups.get(key) ?? [];
    group.push(manifest);
    groups.set(key, group);
  }
  const hash = (manifest: JsonObject) => createHash("sha256")
    .update(`${sampleDate}:${managerReviewText(manifest.id, manifest.folder, manifest.project_id)}`)
    .digest("hex");
  const orderedGroups = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, group]) => group.sort((a, b) => hash(a).localeCompare(hash(b))));
  const selected: JsonObject[] = [];
  for (let index = 0; ; index += 1) {
    let added = false;
    for (const group of orderedGroups) {
      const candidate = group[index];
      if (candidate) {
        selected.push(candidate);
        added = true;
      }
    }
    if (!added) break;
  }
  return selected;
}

async function managerReviewData(app: FastifyInstance, actor: JsonObject, includeIdentities: boolean, body: JsonObject = {}) {
  if (includeIdentities) await requireManagerReviewResultsAccess(actor);
  else await requireManagerReviewAccess(actor);
  const settings = await managerReviewSettings(actor, false);
  const configuredTarget = Number(settings.daily_target);
  const sampleDate = managerReviewSampleDate(body.sample_date);
  const manifests = await managerReviewQueryProjects(app, configuredTarget);
  const manifestsById = new Map(manifests.map((manifest) => [managerReviewText(manifest.id, manifest.folder, manifest.project_id), manifest]));
  const sampleDocuments = await listInternalDocuments("manager_review_samples");
  const existingSample = managerReviewDocumentData(sampleDocuments.find((document) => String(document.id ?? "") === sampleDate));

  const sampledIds = new Set<string>();
  for (const document of sampleDocuments) {
    const documentEntries = managerReviewDocumentData(document).entries;
    for (const entry of Array.isArray(documentEntries) ? documentEntries : []) {
      const id = managerReviewText(asObject(entry).project_id);
      if (id) sampledIds.add(id);
    }
  }
  const latestPriorDate = sampleDocuments
    .map((document) => String(document.id ?? ""))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < sampleDate)
    .sort()
    .at(-1);
  if (latestPriorDate) {
    const missedDates = managerReviewDatesAfter(latestPriorDate, sampleDate).slice(-31);
    for (const missedDate of missedDates) {
      if (sampleDocuments.some((document) => String(document.id ?? "") === missedDate)) continue;
      const candidatesForMissedDay = manifests.filter((manifest) => {
        const id = managerReviewText(manifest.id, manifest.folder, manifest.project_id);
        return Boolean(id)
          && !sampledIds.has(id)
          && !managerReviewAuditRecord(manifest)
          && managerReviewManifestAvailableBy(manifest, missedDate);
      });
      const missedEntries = managerReviewStratifiedCandidates(candidatesForMissedDay, missedDate)
        .slice(0, configuredTarget)
        .map(managerReviewSampleEntry);
      for (const entry of missedEntries) sampledIds.add(managerReviewText(entry.project_id));
      const backfilledAt = new Date().toISOString();
      const saved = await saveInternalDocument("manager_review_samples", missedDate, {
        data: {
          schema_version: 1,
          sample_date: missedDate,
          configured_target: configuredTarget,
          entries: missedEntries,
          created_at: backfilledAt,
          updated_at: backfilledAt,
          generated_as_backfill: true
        }
      }, { replace: true });
      sampleDocuments.push(saved);
    }
  }

  const existingEntries = (Array.isArray(existingSample.entries) ? existingSample.entries : [])
    .map((entry) => asObject(entry))
    .filter((entry) => Boolean(managerReviewText(entry.project_id)));

  const previouslySampled = new Set<string>();
  for (const document of sampleDocuments) {
    if (String(document.id ?? "") === sampleDate) continue;
    const previousEntries = managerReviewDocumentData(document).entries;
    for (const entry of Array.isArray(previousEntries) ? previousEntries : []) {
      const id = managerReviewText(asObject(entry).project_id);
      if (id) previouslySampled.add(id);
    }
  }

  const currentIds = new Set(existingEntries.map((entry) => managerReviewText(entry.project_id)));
  const candidates = manifests.filter((manifest) => {
    const id = managerReviewText(manifest.id, manifest.folder, manifest.project_id);
    return Boolean(id) && !currentIds.has(id) && !previouslySampled.has(id) && !managerReviewAuditRecord(manifest);
  });
  let entries = [...existingEntries];
  if (entries.length > configuredTarget) {
    const reviewed = entries.filter((entry) => Boolean(managerReviewAuditRecord(manifestsById.get(managerReviewText(entry.project_id)) ?? {})));
    const reviewedEntries = new Set(reviewed);
    const unreviewed = entries.filter((entry) => !reviewedEntries.has(entry));
    entries = [...reviewed, ...unreviewed.slice(0, Math.max(0, configuredTarget - reviewed.length))];
  }
  const needed = Math.max(0, configuredTarget - entries.length);
  entries.push(...managerReviewStratifiedCandidates(candidates, sampleDate).slice(0, needed).map(managerReviewSampleEntry));

  const priorEntries = sampleDocuments
    .filter((document) => String(document.id ?? "") < sampleDate)
    .sort((a, b) => String(a.id ?? "").localeCompare(String(b.id ?? "")))
    .flatMap((document) => {
      const data = managerReviewDocumentData(document);
      return (Array.isArray(data.entries) ? data.entries : []).map((entry) => ({
        entry: asObject(entry),
        sample_date: managerReviewText(data.sample_date, document.id)
      }));
    });
  const allQueueEntries = [
    ...priorEntries,
    ...entries.map((entry) => ({ entry, sample_date: sampleDate }))
  ];
  const missingIds = allQueueEntries
    .map(({ entry }) => managerReviewText(entry.project_id))
    .filter((id) => id && !manifestsById.has(id));
  await Promise.all(missingIds.map(async (id) => {
    try {
      manifestsById.set(id, asObject((await getProjectDetail(id)).manifest));
    } catch {
      // Keep the assignment stable even if an old project is no longer available.
    }
  }));

  const now = new Date().toISOString();
  await saveInternalDocument("manager_review_samples", sampleDate, {
    data: {
      schema_version: 1,
      sample_date: sampleDate,
      configured_target: configuredTarget,
      entries,
      created_at: managerReviewText(existingSample.created_at, now),
      updated_at: now
    }
  }, { replace: true });

  const queueProjectIds = new Set<string>();
  const relevantQueueEntries = allQueueEntries.filter(({ entry, sample_date: assignmentDate }) => {
    const id = managerReviewText(entry.project_id);
    const manifest = manifestsById.get(id);
    if (!id || !manifest || queueProjectIds.has(id)) return false;
    const audit = managerReviewAuditRecord(manifest);
    const isCurrentAssignment = assignmentDate === sampleDate;
    const wasCaughtUpToday = Boolean(audit?.reviewed_at && String(audit.reviewed_at).slice(0, 10) === sampleDate);
    if (!isCurrentAssignment && audit && !wasCaughtUpToday) return false;
    queueProjectIds.add(id);
    return true;
  });
  const projects: JsonObject[] = relevantQueueEntries.map(({ entry, sample_date: assignmentDate }) => ({
    ...managerReviewProjectRow(manifestsById.get(managerReviewText(entry.project_id)) ?? {}, includeIdentities),
    sample_date: assignmentDate
  }));
  const completed = projects.filter((project) => Boolean(project.manager_audit_status)).length;
  const priorProjects = projects.filter((project) => project.sample_date !== sampleDate);
  const backlogRemaining = priorProjects.filter((project) => !project.manager_audit_status).length;
  const sampleDays = new Set(projects.map((project) => String(project.sample_date ?? "")).filter(Boolean)).size;
  return {
    ok: true,
    success: true,
    blind: !includeIdentities,
    projects,
    count: projects.length,
    sample: {
      date: sampleDate,
      configured_target: configuredTarget,
      target: projects.length,
      selected: projects.length,
      today_selected: entries.length,
      completed,
      remaining: Math.max(0, projects.length - completed),
      backlog: priorProjects.length,
      backlog_remaining: backlogRemaining,
      sample_days: sampleDays,
      candidate_pool: candidates.length + existingEntries.length
    }
  };
}

function managerReviewAggregate(rows: JsonObject[], keyField: string, labelField: string) {
  const groups = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = managerReviewText(row[keyField], "unknown");
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const reviewed = group.filter((row) => Boolean(row.audit_status));
    const scored = reviewed.filter((row) => !row.score_excluded);
    const issues = scored.filter((row) => row.audit_status === "flagged");
    return {
      key,
      label: managerReviewText(group[0]?.[labelField], key === "unknown" ? "Unknown" : key),
      total: group.length,
      reviewed: reviewed.length,
      unreviewed: group.length - reviewed.length,
      issues: issues.length,
      excluded: reviewed.length - scored.length,
      average_quality: scored.length ? 100 * (scored.length - issues.length) / scored.length : null,
      pass_rate: scored.length ? 100 * (scored.length - issues.length) / scored.length : null
    };
  }).sort((a, b) => b.total - a.total || String(a.label).localeCompare(String(b.label)));
}

function managerReviewResultOptions(rows: JsonObject[], valueField: string, labelField = valueField) {
  const options = new Map<string, string>();
  for (const row of rows) {
    const value = managerReviewText(row[valueField]);
    if (value) options.set(value, managerReviewText(row[labelField], value));
  }
  return [...options.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
}

async function managerReviewResults(body: JsonObject, actor: JsonObject) {
  const access = await requireManagerReviewResultsAccess(actor);
  const viewerEmail = String(access.user.email ?? "").trim().toLowerCase();
  const settings = await managerReviewSettings(actor, false);
  const auditByProject = new Map<string, JsonObject>();
  for (const document of await listInternalDocuments("manager_audit")) {
    const wrapped = asObject(document);
    const data = managerReviewDocumentData(document);
    const audit = Object.keys(data).length ? data : wrapped;
    const projectId = managerReviewText(audit.project_id, wrapped.id);
    if (projectId) auditByProject.set(projectId, audit);
  }

  const allRows: JsonObject[] = [];
  for (const document of await listInternalDocuments("manager_review_samples")) {
    const data = managerReviewDocumentData(document);
    const sampleDate = managerReviewText(data.sample_date, document.id);
    for (const rawEntry of Array.isArray(data.entries) ? data.entries : []) {
      const entry = asObject(rawEntry);
      const projectId = managerReviewText(entry.project_id);
      if (!projectId) continue;
      const audit = auditByProject.get(projectId) ?? {};
      const auditSample = asObject(audit.sample);
      const scoreValue = audit.quality_score;
      const score = scoreValue === null || scoreValue === undefined || scoreValue === "" ? null : Number(scoreValue);
      allRows.push({
        project_id: projectId,
        address: managerReviewText(entry.address, auditSample.address),
        sample_date: sampleDate,
        qa_email: managerReviewText(entry.qa_email, auditSample.qa_email).toLowerCase(),
        qa_name: managerReviewText(entry.qa_name, auditSample.qa_name, entry.qa_email, auditSample.qa_email, "Unknown"),
        technician_email: managerReviewText(entry.technician_email, auditSample.technician_email).toLowerCase(),
        technician_name: managerReviewText(entry.technician_name, auditSample.technician_name, entry.technician_email, auditSample.technician_email, "Unknown"),
        project_type: managerReviewText(entry.project_type, auditSample.project_type, "Unknown"),
        complexity: managerReviewText(entry.complexity, auditSample.complexity, "Unknown"),
        team_id: managerReviewText(entry.team_id, auditSample.team_id, "default"),
        team_name: managerReviewText(entry.team_name, auditSample.team_name, entry.team_id, auditSample.team_id, "Default"),
        audit_status: managerReviewText(audit.status),
        quality_score: Number.isFinite(score) ? score : null,
        note: managerReviewText(audit.note) || null,
        issue_categories: Array.isArray(audit.issue_categories)
          ? audit.issue_categories
          : (managerReviewText(audit.issue_category) ? [managerReviewText(audit.issue_category)] : []),
        attachments: Array.isArray(audit.attachments) ? audit.attachments : [],
        score_excluded: Boolean(audit.score_excluded),
        score_excluded_at: managerReviewText(audit.score_excluded_at) || null,
        reviewed_at: managerReviewText(audit.reviewed_at) || null
      });
    }
  }

  // Preserve historic audits created before daily sample documents existed.
  if (!allRows.length) {
    for (const audit of auditByProject.values()) {
      const sample = asObject(audit.sample);
      const score = Number(audit.quality_score);
      allRows.push({
        project_id: managerReviewText(audit.project_id),
        address: managerReviewText(sample.address),
        sample_date: managerReviewText(audit.reviewed_at).slice(0, 10),
        qa_email: managerReviewText(sample.qa_email).toLowerCase(),
        qa_name: managerReviewText(sample.qa_name, sample.qa_email, "Unknown"),
        technician_email: managerReviewText(sample.technician_email).toLowerCase(),
        technician_name: managerReviewText(sample.technician_name, sample.technician_email, "Unknown"),
        project_type: managerReviewText(sample.project_type, "Unknown"),
        complexity: managerReviewText(sample.complexity, "Unknown"),
        team_id: managerReviewText(sample.team_id, "default"),
        team_name: managerReviewText(sample.team_name, sample.team_id, "Default"),
        audit_status: managerReviewText(audit.status),
        quality_score: Number.isFinite(score) ? score : null,
        note: managerReviewText(audit.note) || null,
        issue_categories: Array.isArray(audit.issue_categories)
          ? audit.issue_categories
          : (managerReviewText(audit.issue_category) ? [managerReviewText(audit.issue_category)] : []),
        attachments: Array.isArray(audit.attachments) ? audit.attachments : [],
        score_excluded: Boolean(audit.score_excluded),
        score_excluded_at: managerReviewText(audit.score_excluded_at) || null,
        reviewed_at: managerReviewText(audit.reviewed_at) || null
      });
    }
  }

  const qaUsers = new Map<string, JsonObject>();
  await Promise.all([...new Set(allRows.map((row) => String(row.qa_email ?? "").trim().toLowerCase()).filter(Boolean))].map(async (email) => {
    const user = await readInternalUser(email).catch(() => null);
    if (user) qaUsers.set(email, asObject(user));
  }));
  for (const row of allRows) {
    const qaUser = qaUsers.get(String(row.qa_email ?? "").trim().toLowerCase());
    if (!qaUser) continue;
    const userTeamId = managerReviewText(qaUser.team_id, qaUser.team);
    if (userTeamId && ["", "default", "unknown"].includes(String(row.team_id ?? "").toLowerCase())) {
      row.team_id = userTeamId;
      row.team_name = managerReviewText(qaUser.team_name, userTeamId);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const rollingStart = new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const start = rollingStart;
  const end = today;
  const dateRows = allRows.filter((row) => String(row.sample_date) >= start && String(row.sample_date) <= end);
  const qaEmail = access.isManager ? managerReviewText(body.qa_email).toLowerCase() : viewerEmail;
  const teamId = access.isManager ? managerReviewText(body.team_id) : "";
  const auditStatus = managerReviewText(body.audit_status).toLowerCase();
  const rows = dateRows.filter((row) => {
    if (qaEmail && row.qa_email !== qaEmail) return false;
    if (teamId && row.team_id !== teamId) return false;
    if (auditStatus === "unreviewed" && row.audit_status) return false;
    if (auditStatus && auditStatus !== "unreviewed" && row.audit_status !== auditStatus) return false;
    return true;
  });
  const reviewed = rows.filter((row) => Boolean(row.audit_status));
  const scored = reviewed.filter((row) => !row.score_excluded);
  const issues = scored.filter((row) => row.audit_status === "flagged");
  const page = Math.max(1, Math.floor(Number(body.page) || 1));
  const pageSize = Math.max(10, Math.min(100, Math.floor(Number(body.page_size) || 25)));
  const sortedRows = [...rows].sort((a, b) => managerReviewText(b.reviewed_at, b.sample_date).localeCompare(managerReviewText(a.reviewed_at, a.sample_date)));
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = sortedRows.slice((safePage - 1) * pageSize, safePage * pageSize);
  await Promise.all(pageRows.map(async (row) => {
    if (row.address || !row.project_id) return;
    try {
      const manifest = asObject((await getProjectDetail(String(row.project_id))).manifest);
      row.address = managerReviewText(manifest.address, manifest.formatted_address, row.project_id);
    } catch {
      row.address = row.project_id;
    }
  }));
  return {
    ok: true,
    success: true,
    filters: { date_start: start, date_end: end, qa_email: qaEmail, team_id: teamId },
    access: { can_view_all: access.isManager, can_override: access.canOverride, viewer_email: viewerEmail },
    settings,
    summary: {
      eligible: rows.length,
      reviewed: reviewed.length,
      unreviewed: rows.length - reviewed.length,
      issues: issues.length,
      excluded: reviewed.length - scored.length,
      average_quality: scored.length ? 100 * (scored.length - issues.length) / scored.length : null,
      pass_rate: scored.length ? 100 * (scored.length - issues.length) / scored.length : null,
      rolling_days: 14
    },
    groups: {
      qa: managerReviewAggregate(rows, "qa_email", "qa_name"),
      team: managerReviewAggregate(rows, "team_id", "team_name")
    },
    options: {
      qa: managerReviewResultOptions(dateRows, "qa_email", "qa_name"),
      team: managerReviewResultOptions(dateRows, "team_id", "team_name")
    },
    results: pageRows,
    pagination: { page: safePage, page_size: pageSize, total_count: sortedRows.length, total_pages: totalPages }
  };
}

async function managerReviewProjectBundle(body: JsonObject, actor: JsonObject) {
  await requireManagerReviewAccess(actor);
  const projectId = managerReviewText(body.folder, body.project_id, body.id);
  if (!projectId) throw badRequest("missing_project_id", "A project id is required.");
  const detail = await getProjectDetail(projectId);
  const manifest = asObject(detail.manifest);
  const row = managerReviewProjectRow(manifest, false);
  return {
    ok: true,
    success: true,
    blind: true,
    manifest: {
      ...row,
      lat: manifest.lat ?? null,
      lng: manifest.lng ?? null
    },
    app_metadata: {
      manager_review_annotations: asObject(detail.app_metadata).manager_review_annotations ?? null
    }
  };
}

async function managerReviewSaveAnnotations(body: JsonObject, actor: JsonObject) {
  const user = await requireManagerReviewAccess(actor);
  const projectId = managerReviewText(body.folder, body.project_id, body.id);
  if (!projectId) throw badRequest("missing_project_id", "A project id is required.");
  const detail = await getProjectDetail(projectId);
  const metadata = asObject(detail.app_metadata);
  const now = new Date().toISOString();
  const annotations = asObject(body.annotations);
  await saveAppMetadata(projectId, {
    ...metadata,
    manager_review_annotations: annotations,
    manager_review_annotations_meta: {
      updated_at: now,
      reviewer_email: String(user.email ?? "") || null,
      reviewer_name: String(user.name ?? user.email ?? "") || null
    }
  });
  return { ok: true, success: true, folder: projectId, saved_at: now };
}

const MANAGER_REVIEW_ISSUE_CATEGORIES = new Set([
  "missing_section",
  "missing_structure",
  "missing_skylight_chimney",
  "wrong_shapes_or_tracing",
  "wrong_line_types",
  "didnt_follow_customer_notes"
]);

async function managerReviewMarkAudit(body: JsonObject, actor: JsonObject) {
  const user = await requireManagerReviewAccess(actor);
  const projectId = managerReviewText(body.folder, body.project_id, body.id);
  const status = String(body.audit_status ?? "").trim().toLowerCase();
  if (!projectId) throw badRequest("missing_project_id", "A project id is required.");
  if (!["reviewed", "flagged"].includes(status)) {
    throw badRequest("invalid_manager_audit_status", "Audit status must be reviewed or flagged.");
  }
  const detail = await getProjectDetail(projectId);
  const manifest = asObject(detail.manifest);
  const projectStatus = String(manifest.status ?? "").trim().toLowerCase();
  if (!["completed", "rejected", "rejected_no_coverage"].includes(projectStatus)) {
    throw badRequest("manager_audit_project_not_eligible", "Only completed or rejected projects can be audited.");
  }
  const now = new Date().toISOString();
  const qualityScore = status === "reviewed" ? 100 : 0;
  const note = String(body.note ?? "").trim() || null;
  const requestedCategories = Array.isArray(body.issue_categories)
    ? body.issue_categories.map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean)
    : (body.issue_category ? [String(body.issue_category).trim().toLowerCase()] : []);
  const issueCategories = status === "flagged" ? [...new Set(requestedCategories)] : [];
  if (status === "flagged" && !issueCategories.length) {
    throw badRequest("manager_audit_category_required", "Select at least one issue category, or submit with none selected to pass the review.");
  }
  if (issueCategories.some((category) => !MANAGER_REVIEW_ISSUE_CATEGORIES.has(category))) {
    throw badRequest("invalid_manager_audit_category", "One or more issue categories are invalid.");
  }
  const issueCategory = issueCategories[0] ?? null;
  const severity = null;
  const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
  if (rawAttachments.length > 5) {
    throw badRequest("manager_audit_too_many_attachments", "A manager review can include up to five screenshots.");
  }
  const attachments = rawAttachments.map((value) => {
    const attachment = asObject(value);
    const name = managerReviewText(attachment.name);
    if (!/^manager-review-[a-z0-9._-]+\.(?:png|jpe?g|webp)$/i.test(name)) {
      throw badRequest("invalid_manager_audit_attachment", "Manager review screenshots must be PNG, JPEG, or WebP project artifacts.");
    }
    return {
      name,
      original_name: managerReviewText(attachment.original_name, name).slice(0, 255)
    };
  });
  if (attachments.length) {
    const projectFiles = new Map((await listProjectFiles(projectId)).map((file) => [file.name, file]));
    for (const attachment of attachments) {
      const file = projectFiles.get(attachment.name);
      if (!file) {
        throw badRequest("manager_audit_attachment_not_found", `Review screenshot '${attachment.name}' was not found on this project.`);
      }
      if (file.size > 10 * 1024 * 1024) {
        throw badRequest("manager_audit_attachment_too_large", "Manager review screenshots must be 10 MB or smaller.");
      }
    }
  }
  const qa = managerReviewQaActor(manifest);
  const technician = managerReviewTechnician(manifest);
  const annotations = asObject(body.annotations);
  const previous = managerReviewAuditRecord(manifest);
  const record: JsonObject = {
    schema_version: 2,
    project_id: projectId,
    status,
    outcome: status === "flagged" ? "issue" : "pass",
    quality_score: qualityScore,
    issue_category: issueCategory,
    issue_categories: issueCategories,
    severity,
    note,
    attachments,
    reviewed_at: now,
    reviewer_email: String(user.email ?? "") || null,
    reviewer_name: String(user.name ?? user.email ?? "") || null,
    reviewer_role: String(user.role ?? "") || null,
    annotation_pages: Object.keys(annotations).length,
    sample: {
      qa_email: qa.email || null,
      qa_name: qa.name || null,
      technician_email: technician.email || null,
      technician_name: technician.name || null,
      project_type: managerReviewText(manifest.project_type, "residential"),
      complexity: manifest.complexity ?? null,
      address: managerReviewText(manifest.address, manifest.formatted_address) || null,
      team_id: managerReviewText(manifest.team_id, manifest.team, "default"),
      team_name: managerReviewText(manifest.team_name, manifest.team_id, manifest.team, "Default"),
      completed_at: managerReviewText(manifest.completed_at, asObject(manifest.timestamps).completed_at) || null,
      project_status: projectStatus
    }
  };
  const auditHistory = Array.isArray(manifest.manager_audit_history) ? [...manifest.manager_audit_history] : [];
  auditHistory.push(record);
  const workHistory = Array.isArray(manifest.work_history) ? [...manifest.work_history] : [];
  workHistory.push({
    event: status === "flagged" ? "manager_audit_flagged" : "manager_audit_reviewed",
    ts: now,
    by_email: user.email ?? null,
    by_name: user.name ?? null,
    manager_audit_status: status,
    quality_score: qualityScore,
    issue_category: issueCategory,
    issue_categories: issueCategories,
    severity,
    note,
    attachment_count: attachments.length,
    previous_manager_audit_status: previous?.status ?? null
  });
  const currentAudit = asObject(manifest.audit);
  await patchManifest(projectId, {
    manager_audit_status: status,
    manager_audit_note: note,
    manager_audit_quality_score: qualityScore,
    manager_audit_issue_category: issueCategory,
    manager_audit_issue_categories: issueCategories,
    manager_audit_severity: severity,
    manager_audit_attachments: attachments,
    manager_audit_updated_at: now,
    manager_audit_updated_by_email: user.email ?? null,
    manager_audit_updated_by_name: user.name ?? null,
    manager_audit_record: record,
    manager_audit_history: auditHistory,
    manager_audit_annotations: annotations,
    audit: {
      ...currentAudit,
      manager_audit_status: status,
      manager_audit_note: note,
      manager_audit_quality_score: qualityScore,
      manager_audit_issue_category: issueCategory,
      manager_audit_issue_categories: issueCategories,
      manager_audit_severity: severity,
      manager_audit_attachments: attachments,
      manager_audit_updated_at: now,
      manager_audit_updated_by_email: user.email ?? null,
      manager_audit_updated_by_name: user.name ?? null,
      manager_audit_record: record,
      manager_audit_annotations: annotations
    },
    work_history: workHistory,
    timestamps: { updated_at: now }
  });
  await saveInternalDocument("manager_audit", projectId, { data: { ...record, history: auditHistory } }, { replace: true });
  return {
    ok: true,
    success: true,
    folder: projectId,
    manager_audit_status: status,
    manager_audit_note: note,
    manager_audit_quality_score: qualityScore,
    manager_audit_attachments: attachments,
    audit: record
  };
}

async function managerReviewOverride(body: JsonObject, actor: JsonObject) {
  const user = await requireManagerReviewOverrideAccess(actor);
  const projectId = managerReviewText(body.folder, body.project_id, body.id);
  if (!projectId) throw badRequest("missing_project_id", "A project id is required.");
  const excluded = body.excluded === true || body.excluded === 1 || String(body.excluded ?? "").toLowerCase() === "true";
  const now = new Date().toISOString();
  const detail = await getProjectDetail(projectId);
  const manifest = asObject(detail.manifest);
  const currentRecord = asObject(manifest.manager_audit_record ?? asObject(manifest.audit).manager_audit_record);
  if (!managerReviewText(currentRecord.status, manifest.manager_audit_status)) {
    throw badRequest("manager_review_not_completed", "Only completed manager-review results can be excluded.");
  }
  const overrideFields = {
    score_excluded: excluded,
    score_excluded_at: excluded ? now : null,
    score_excluded_by_email: excluded ? (user.email ?? null) : null,
    score_excluded_by_name: excluded ? (user.name ?? user.email ?? null) : null
  };
  const record = { ...currentRecord, ...overrideFields };
  const audit = { ...asObject(manifest.audit), ...overrideFields, manager_audit_record: record };
  await patchManifest(projectId, {
    manager_audit_score_excluded: excluded,
    manager_audit_score_excluded_at: overrideFields.score_excluded_at,
    manager_audit_score_excluded_by_email: overrideFields.score_excluded_by_email,
    manager_audit_score_excluded_by_name: overrideFields.score_excluded_by_name,
    manager_audit_record: record,
    audit,
    timestamps: { updated_at: now }
  });
  const stored = managerReviewDocumentData(await readInternalDocument("manager_audit", projectId));
  await saveInternalDocument("manager_audit", projectId, { data: { ...stored, ...record } }, { replace: true });
  return { ok: true, success: true, folder: projectId, score_excluded: excluded };
}

async function injectProject(app: FastifyInstance, body: JsonObject, suffix: string, payload: JsonObject, method: "POST" | "PATCH" = "POST") {
  const id = encodeURIComponent(String(body.folder ?? body.project_id ?? body.id ?? ""));
  if (!id) throw badRequest("missing_project_id", "A project id is required.");
  return await injectJson(app, method, `/v1/firstmeasure/projects/${id}${suffix}`, payload);
}

function sampleReportFolderId(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

function sampleReportsNormalizeFavorites(raw: unknown) {
  const source = Array.isArray(raw) ? raw : [];
  const map = new Map<string, JsonObject>();
  for (const item of source) {
    const entry = asObject(item);
    const id = sampleReportFolderId(entry.id ?? entry.folder_id ?? entry.folder ?? item);
    if (!id) continue;
    const label = String(entry.label ?? entry.name ?? "").trim() || id;
    map.set(id, { id, label });
  }
  return [...map.values()];
}

async function sampleReportsFavoriteConfigs() {
  const document = await readInternalDocument("sample_reports", "favorites");
  return sampleReportsNormalizeFavorites(asObject(document?.data).favorites);
}

async function sampleReportsSaveFavoriteConfigs(configs: JsonObject[]) {
  const favorites = sampleReportsNormalizeFavorites(configs);
  await saveInternalDocument("sample_reports", "favorites", { favorites });
  return favorites;
}

async function sampleReportsCanBrowseAll(actor: JsonObject) {
  const role = String(actor.role ?? "").trim().toLowerCase();
  if (["admin", "system_admin", "sales_manager", "manager"].includes(role)) return true;
  const email = String(actor.email ?? "").trim().toLowerCase();
  const user = email ? await readInternalUser(email).catch(() => null) : null;
  if (!user) return false;
  if (String(user.role ?? "").trim().toLowerCase() === "admin" || Boolean(user.is_admin)) return true;
  const permissions = asObject(user.permissions);
  return Boolean(permissions.manage_users || permissions.manage_sales_users || permissions.is_admin_legacy || permissions.view_all_projects);
}

function sampleReportsProjectSummary(project: JsonObject, request: { headers: Record<string, unknown>; protocol?: string } | null = null) {
  const folderId = sampleReportFolderId(project.id ?? project.folder);
  if (!folderId) return null;
  const status = String(project.status ?? "").trim().toLowerCase() || (project.completed_at ? "completed" : "unknown");
  const projectTypeRaw = String(project.project_type ?? "residential").trim().toLowerCase();
  const projectType = ["residential", "commercial", "multifamily"].includes(projectTypeRaw) ? projectTypeRaw : "residential";
  const timestamps = asObject(project.timestamps);
  const createdAt = String(project.created_at ?? timestamps.created_at ?? "");
  const completedAt = String(project.completed_at ?? timestamps.completed_at ?? "");
  const uploadedAt = String(project.uploaded_at ?? timestamps.uploaded_at ?? "");
  const sortAt = uploadedAt || completedAt || createdAt;
  const artifacts = asObject(project.artifacts);
  const hasPdfState = Boolean(project.has_pdf_state ?? artifacts.has_pdf_state);
  const isComplete = status === "completed" || status === "complete";
  const hasSavedReport = isComplete && Boolean(project.has_report_pdf ?? artifacts.has_report_pdf ?? artifacts.has_main_pdf);
  const organizationRef = asObject(project.organization_ref);
  const ownerRef = asObject(project.owner_ref);
  const issuer = asObject(project.issuer);
  const thumbnail = String(project.thumbnail ?? project.thumbnail_url ?? "").trim()
    || (request ? `${buildInternalApiBase(request)}/firstmeasure/projects/${encodeURIComponent(folderId)}/thumbnail?w=420` : "");

  return {
    id: folderId,
    address: String(project.address ?? ""),
    status,
    project_type: projectType,
    created_at: createdAt,
    completed_at: completedAt,
    uploaded_at: uploadedAt,
    sort_at: sortAt,
    complexity: project.complexity ?? null,
    thumbnail,
    pdf_state_asset: request ? `${buildInternalApiBase(request)}/firstmeasure/projects/${encodeURIComponent(folderId)}/editor/pdf-state` : "",
    has_pdf_state: hasPdfState,
    has_saved_report: hasSavedReport,
    report_url: request && hasSavedReport ? `${buildInternalApiBase(request)}/firstmeasure/projects/${encodeURIComponent(folderId)}/pdf?slot=main` : "",
    issuer_name: String(issuer.name ?? project.issuer_name ?? ""),
    owner_email: String(project.owner_email ?? ownerRef.email ?? ""),
    organization_id: String(project.organization_id ?? organizationRef.id ?? "").trim().toLowerCase(),
    is_filler: Boolean(project.is_filler)
  };
}

function buildInternalApiBase(request: { headers: Record<string, unknown>; protocol?: string }) {
  const host = String(request.headers.host ?? "127.0.0.1:3111");
  const proto = request.protocol || (host.includes("127.0.0.1") || host.includes("localhost") ? "http" : "https");
  return `${proto}://${host}/v1`;
}

async function sampleReportsQueryProjects(app: FastifyInstance, payload: JsonObject) {
  const response = await injectJson(app, "POST", "/v1/firstmeasure/projects/query", payload);
  return {
    count: Math.max(0, Number(response.count ?? 0) || 0),
    projects: Array.isArray(response.projects) ? response.projects.map((item: unknown) => asObject(item)) : []
  };
}

async function sampleReportsList(
  app: FastifyInstance,
  input: JsonObject,
  actor: JsonObject,
  request: { headers: Record<string, unknown>; protocol?: string }
) {
  const searchRaw = String(input.search ?? "").trim();
  const search = searchRaw.toLowerCase();
  let projectType = String(input.project_type ?? "all").trim().toLowerCase();
  let reportState = String(input.report_state ?? "all").trim().toLowerCase();
  const page = Math.max(1, Math.floor(Number(input.page ?? 1)) || 1);
  const limit = Math.max(1, Math.min(48, Math.floor(Number(input.limit ?? 18)) || 18));
  if (!["all", "residential", "commercial", "multifamily"].includes(projectType)) projectType = "all";
  if (!["all", "saved_report", "generated_only"].includes(reportState)) reportState = "all";

  const favoriteConfigs = await sampleReportsFavoriteConfigs();
  const favoriteIds = favoriteConfigs.map((entry) => String(entry.id ?? "")).filter(Boolean);
  const favoriteMap = new Map(favoriteConfigs.map((entry) => [String(entry.id ?? ""), entry]));
  const canBrowseAll = await sampleReportsCanBrowseAll(actor);
  let sourceProjects: JsonObject[] = [];
  let sourceCount = 0;

  if (canBrowseAll) {
    const payload: JsonObject = {
      statuses: ["completed"],
      include_all: true,
      view: "full",
      limit: Math.min(500, Math.max((page * limit) + favoriteIds.length + 15, limit))
    };
    if (searchRaw) payload.search = searchRaw;
    if (projectType !== "all") payload.project_type = projectType;
    if (reportState === "saved_report") payload.has_report_pdf = true;
    if (reportState === "generated_only") payload.has_report_pdf = false;
    const result = await sampleReportsQueryProjects(app, payload);
    sourceProjects = result.projects;
    sourceCount = result.count;
  }

  const sourceIds = new Set(sourceProjects.map((project) => sampleReportFolderId(project.id)).filter(Boolean));
  for (const favoriteId of favoriteIds) {
    if (sourceIds.has(favoriteId)) continue;
    const detail = await injectJson(app, "GET", `/v1/firstmeasure/projects/${encodeURIComponent(favoriteId)}`);
    const project = asObject(detail.project).manifest ? asObject(asObject(detail.project).manifest) : asObject(detail.project);
    if (Object.keys(project).length) sourceProjects.push(project);
  }
  if (!canBrowseAll) sourceCount = sourceProjects.length;

  const seen = new Set<string>();
  const items: JsonObject[] = [];
  const apiBase = buildInternalApiBase(request);
  for (const source of sourceProjects) {
    const summary = sampleReportsProjectSummary(source, request);
    if (!summary || seen.has(String(summary.id))) continue;
    seen.add(String(summary.id));
    if (String(summary.status) !== "completed") continue;
    if (!summary.has_pdf_state) continue;
    if (projectType !== "all" && summary.project_type !== projectType) continue;
    if (reportState === "saved_report" && !summary.has_saved_report) continue;
    if (reportState === "generated_only" && summary.has_saved_report) continue;
    if (search && !canBrowseAll) {
      const haystack = `${summary.address} ${summary.project_type} ${summary.status} ${summary.issuer_name} ${summary.owner_email}`.toLowerCase();
      if (!haystack.includes(search)) continue;
    }
    const row: JsonObject = {
      ...summary,
      is_favorite: favoriteMap.has(String(summary.id)),
      favorite_label: String(asObject(favoriteMap.get(String(summary.id))).label ?? ""),
      pdf_state_asset: `${apiBase}/firstmeasure/projects/${encodeURIComponent(String(summary.id))}/editor/pdf-state`,
      report_url: `${apiBase}/firstmeasure/projects/${encodeURIComponent(String(summary.id))}/pdf?slot=main`,
      thumbnail: `${apiBase}/firstmeasure/projects/${encodeURIComponent(String(summary.id))}/thumbnail?w=420`
    };
    items.push(row);
  }

  items.sort((a, b) => {
    const aFav = Boolean(a.is_favorite);
    const bFav = Boolean(b.is_favorite);
    if (aFav !== bFav) return aFav ? -1 : 1;
    const ta = Date.parse(String(a.sort_at ?? "")) || 0;
    const tb = Date.parse(String(b.sort_at ?? "")) || 0;
    return tb === ta ? String(a.address ?? "").localeCompare(String(b.address ?? "")) : tb - ta;
  });

  const totalCount = search ? items.length : Math.max(sourceCount, items.length);
  const totalPages = Math.max(1, Math.ceil(totalCount / limit));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * limit;
  const projects = items.slice(offset, offset + limit);

  return {
    ok: true,
    success: true,
    projects,
    favorite_ids: favoriteIds,
    favorite_configs: favoriteConfigs,
    sample_reports_admin: canBrowseAll,
    search_notice: search && sourceCount > 0 && items.length === 0
      ? "Matching projects were found, but they are not sample-ready yet. These projects are usually missing a saved pdf_state snapshot."
      : null,
    pagination: {
      current_page: currentPage,
      total_pages: totalPages,
      total_count: totalCount,
      limit
    }
  };
}

async function sampleReportsBundle(
  app: FastifyInstance,
  rawFolderId: string,
  actor: JsonObject,
  request: { headers: Record<string, unknown>; protocol?: string }
) {
  const folderId = sampleReportFolderId(rawFolderId);
  if (!folderId) return { ok: false, success: false, error: "Missing folder" };
  const canBrowseAll = await sampleReportsCanBrowseAll(actor);
  const favoriteIds = new Set((await sampleReportsFavoriteConfigs()).map((entry) => String(entry.id ?? "")));
  if (!canBrowseAll && !favoriteIds.has(folderId)) {
    return { ok: false, success: false, error: "Only pinned favorites are available for this account" };
  }
  const bundle = await injectJson(app, "GET", `/v1/firstmeasure/projects/${encodeURIComponent(folderId)}/editor`);
  if (!bundle || bundle.ok === false) return { ok: false, success: false, error: "Project not found" };
  const manifest = asObject(bundle.manifest);
  const organizationId = String(manifest.organization_id ?? asObject(manifest.organization_ref).id ?? "").trim();
  const platformOrg = organizationId ? await readOrganization(organizationId).catch(() => null) : null;
  const organization = platformOrg ? {
    id: String(platformOrg.organization_id ?? platformOrg.id ?? organizationId),
    name: String(platformOrg.name ?? ""),
    branding: asObject(platformOrg.branding),
    report_settings: asObject(platformOrg.report_settings)
  } : (bundle.organization ?? null);

  const apiBase = buildInternalApiBase(request);
  return {
    ok: true,
    success: true,
    folder: folderId,
    manifest,
    organization,
    app_metadata: asObject(bundle.app_metadata),
    pdf_state_asset: `${apiBase}/firstmeasure/projects/${encodeURIComponent(folderId)}/editor/pdf-state`,
    report_url: `${apiBase}/firstmeasure/projects/${encodeURIComponent(folderId)}/pdf?slot=main`,
    thumbnail: `${apiBase}/firstmeasure/projects/${encodeURIComponent(folderId)}/thumbnail?w=420`
  };
}

async function sampleReportsToggleFavorite(body: JsonObject, actor: JsonObject) {
  if (!(await sampleReportsCanBrowseAll(actor))) {
    return { ok: false, success: false, error: "Only managers can update shared sample pins" };
  }
  const folderId = sampleReportFolderId(body.folder ?? body.project_id ?? body.id);
  if (!folderId) return { ok: false, success: false, error: "Missing folder" };
  const favorite = parseBooleanish(body.favorite ?? body.enabled);
  const label = String(body.label ?? "").trim();
  const map = new Map((await sampleReportsFavoriteConfigs()).map((entry) => [String(entry.id ?? ""), entry]));
  if (favorite) {
    const existing = asObject(map.get(folderId));
    map.set(folderId, { id: folderId, label: label || String(existing.label ?? "") || folderId });
  } else {
    map.delete(folderId);
  }
  const favoriteConfigs = await sampleReportsSaveFavoriteConfigs([...map.values()]);
  return {
    ok: true,
    success: true,
    folder: folderId,
    favorite,
    favorite_label: favorite ? String(asObject(map.get(folderId)).label ?? folderId) : "",
    favorite_ids: favoriteConfigs.map((entry) => String(entry.id ?? "")),
    favorite_configs: favoriteConfigs
  };
}

function parseBooleanish(value: unknown) {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

function documentData(document: JsonObject) {
  const data = asObject(document.data);
  return Object.keys(data).length ? { id: document.id, ...data } : document;
}

function compactStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [value])
    .map((item) => cleanText(item))
    .filter(Boolean);
}

function contactRowsForProjects(projects: JsonObject[]) {
  const byKey = new Map<string, JsonObject>();
  for (const project of projects) {
    const projectId = cleanText(project.id || project.project_id || project.folder);
    const contacts = Array.isArray(project.contacts) ? project.contacts.map((entry) => asObject(entry)) : [];
    for (const contact of contacts) {
      const name = cleanText(contact.name || contact.full_name);
      const email = cleanText(contact.email).toLowerCase();
      const phone = cleanText(contact.phone || (Array.isArray(contact.phones) ? contact.phones[0] : ""));
      if (!name && !email && !phone) continue;
      const key = email || phone.replace(/\D+/g, "") || name.toLowerCase();
      const current = byKey.get(key);
      const projectIds = new Set(compactStringArray(asObject(current).project_ids));
      if (projectId) projectIds.add(projectId);
      byKey.set(key, {
        ...asObject(current),
        id: cleanText(asObject(current).id) || `contact_${createHash("sha1").update(key).digest("hex").slice(0, 12)}`,
        name: cleanText(asObject(current).name) || name,
        email: cleanText(asObject(current).email) || email,
        phone: cleanText(asObject(current).phone) || phone,
        role: cleanText(asObject(current).role || contact.role),
        project_ids: [...projectIds]
      });
    }
  }
  return [...byKey.values()].sort((a, b) => cleanText(a.name || a.email || a.phone).localeCompare(cleanText(b.name || b.email || b.phone)));
}

async function firstMeasureProjectRowsForOrg(orgId: string) {
  const cleanOrgId = cleanText(orgId);
  if (!cleanOrgId) return [];
  try {
    const result = await queryIndexedProjectManifests({
      organization_id: cleanOrgId,
      limit: 20_000,
      includeInstantOnly: true
    });
    return result.projects.map(firstMeasureManifestOrderRow);
  } catch {
    return [];
  }
}

function firstMeasureManifestOrderRow(manifest: JsonObject) {
  const ownerRef = asObject(manifest.owner_ref);
  const issuer = asObject(manifest.issuer);
  const organizationRef = asObject(manifest.organization_ref);
  const timestamps = asObject(manifest.timestamps);
  return {
    id: manifest.id ?? manifest.folder ?? "",
    folder: manifest.id ?? manifest.folder ?? "",
    address: manifest.address ?? manifest.property_address ?? "",
    status: manifest.status ?? "",
    owner_email: manifest.owner_email ?? ownerRef.email ?? "",
    customer_email: manifest.customer_email ?? ownerRef.email ?? issuer.email ?? "",
    issuer_email: manifest.issuer_email ?? issuer.email ?? "",
    organization_id: manifest.organization_id ?? organizationRef.id ?? "",
    created_at: manifest.created_at ?? timestamps.created_at ?? null,
    queued_at: manifest.queued_at ?? timestamps.queued_at ?? null,
    submitted_at: manifest.submitted_at ?? manifest.queued_at ?? timestamps.queued_at ?? null,
    processed_at: manifest.processed_at ?? timestamps.processed_at ?? null,
    started_at: manifest.started_at ?? timestamps.started_at ?? null,
    uploaded_at: manifest.uploaded_at ?? timestamps.uploaded_at ?? null,
    completed_at: manifest.completed_at ?? timestamps.completed_at ?? null,
    rejected_at: manifest.rejected_at ?? timestamps.rejected_at ?? null,
    cancelled_at: manifest.cancelled_at ?? timestamps.cancelled_at ?? null,
    updated_at: manifest.updated_at ?? timestamps.updated_at ?? null,
    amount_charged: manifest.amount_charged ?? 0,
    revenue: manifest.amount_charged ?? 0,
    instant_enabled: manifest.instant_enabled ?? false,
    instant_only: manifest.instant_only ?? false,
    source: "firstmeasure_project_index",
    manifest
  };
}

function orderAliasValues(row: JsonObject) {
  const measurement = asObject(row.measurement_project ?? row.measurement);
  const raw = asObject(measurement.raw);
  const manifest = asObject(row.manifest);
  const manifestMeasurement = asObject(manifest.measurement_project ?? manifest.measurement);
  const manifestRaw = asObject(manifestMeasurement.raw);
  return [
    row.id,
    row.folder,
    row.project_id,
    row.projectId,
    row.firstmeasure_project_id,
    row.measurement_project_id,
    row.measurement_id,
    row.source_project_id,
    row.original_master_id,
    row.platform_project_id,
    row.base_project_id,
    measurement.id,
    measurement.folder,
    measurement.project_id,
    measurement.projectId,
    measurement.firstmeasure_project_id,
    measurement.measurement_project_id,
    raw.id,
    raw.folder,
    raw.project_id,
    raw.projectId,
    manifest.id,
    manifest.folder,
    manifest.project_id,
    manifest.projectId,
    manifest.firstmeasure_project_id,
    manifest.measurement_project_id,
    manifest.source_project_id,
    manifest.original_master_id,
    manifestMeasurement.id,
    manifestMeasurement.folder,
    manifestMeasurement.project_id,
    manifestMeasurement.projectId,
    manifestRaw.id,
    manifestRaw.folder,
    manifestRaw.project_id,
    manifestRaw.projectId
  ].map((value) => cleanText(value)).filter(Boolean);
}

function orderAliasKey(value: unknown) {
  const key = cleanText(value).toLowerCase();
  return key ? `order:${key}` : "";
}

function mergeProjectOrderRows(existing: JsonObject, incoming: JsonObject) {
  const merged: JsonObject = { ...incoming, ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (merged[key] === undefined || merged[key] === null || merged[key] === "") {
      merged[key] = value;
    }
  }
  return merged;
}

function projectRowsWithUserReferences(projects: JsonObject[], users: JsonObject[], indexedProjects: JsonObject[] = []) {
  const rows: JsonObject[] = [];
  const seen = new Map<string, number>();
  const addRow = (row: JsonObject) => {
    const aliases = [...new Set(orderAliasValues(row).map(orderAliasKey).filter(Boolean))];
    const existingIndex = aliases.map((alias) => seen.get(alias)).find((index) => index !== undefined);
    if (existingIndex !== undefined) {
      const existingRow = rows[existingIndex];
      const mergedRow = existingRow ? mergeProjectOrderRows(existingRow, row) : row;
      rows[existingIndex] = mergedRow;
      orderAliasValues(mergedRow).map(orderAliasKey).filter(Boolean).forEach((alias) => seen.set(alias, existingIndex));
      return;
    }
    const index = rows.length;
    rows.push(row);
    aliases.forEach((alias) => seen.set(alias, index));
  };
  projects.map(documentData).forEach(addRow);
  for (const indexedProject of indexedProjects) {
    addRow(indexedProject);
  }
  for (const userDocument of users) {
    const user = documentData(userDocument);
    const email = cleanText(user.email).toLowerCase();
    const refs = Array.isArray(user.projects) ? user.projects : [];
    refs.forEach((ref, index) => {
      const refData = typeof ref === "object" && ref !== null ? asObject(ref) : {};
      const projectId = cleanText(
        refData.id
          ?? refData.folder
          ?? refData.project_id
          ?? refData.projectId
          ?? refData.firstmeasure_project_id
          ?? refData.measurement_project_id
          ?? (typeof ref === "string" || typeof ref === "number" ? ref : "")
      );
      if (!projectId) return;
      addRow({
        id: projectId,
        folder: projectId,
        project_id: refData.project_id ?? refData.projectId ?? projectId,
        firstmeasure_project_id: refData.firstmeasure_project_id ?? refData.measurement_project_id ?? "",
        measurement_project_id: refData.measurement_project_id ?? refData.firstmeasure_project_id ?? "",
        address: refData.address ?? refData.property_address ?? "",
        owner_email: email,
        customer_email: email,
        issuer_email: email,
        created_at: refData.created_at ?? refData.submitted_at ?? refData.completed_at ?? refData.updated_at ?? null,
        submitted_at: refData.submitted_at ?? null,
        completed_at: refData.completed_at ?? null,
        updated_at: refData.updated_at ?? null,
        status: refData.status ?? refData.project_status ?? "unknown",
        source: "user_project_reference",
        user_project_reference_index: index
      });
    });
  }
  return rows;
}

function organizationUserView(document: JsonObject, projects: JsonObject[] = []) {
  const data = documentData(document);
  const orgPermissions = asObject(data.org_permissions);
  const level = cleanText(orgPermissions.level || data.org_permission_level || data.permission_level || data.role || "viewer").toLowerCase() || "viewer";
  const items = asObject(orgPermissions.items ?? data.permissions);
  const stats = asObject(data.stats);
  const storedOrderCount = numberValue(data.orderCount ?? data.order_count ?? data.orders_count ?? stats.projects_ordered ?? stats.order_count, Number.NaN);
  const orderCount = Number.isFinite(storedOrderCount) ? storedOrderCount : organizationUserOrderCount(data, projects);
  return {
    ...data,
    org_permissions: { level, items },
    org_permission_level: level,
    permission_level: level,
    orderCount,
    order_count: orderCount
  };
}

function organizationUserOrderCount(user: JsonObject, projects: JsonObject[]) {
  const email = cleanText(user.email).toLowerCase();
  const userId = cleanText(user.id);
  if (!email && !userId) return 0;
  return projects.filter((project) => {
    const ownerRef = asObject(project.owner_ref);
    const issuer = asObject(project.issuer);
    const emailMatches = [
      project.owner_email,
      ownerRef.email,
      project.customer_email,
      project.email,
      project.issuer_email,
      issuer.email,
      project.user_email,
      project.created_by_email
    ].some((value) => email && cleanText(value).toLowerCase() === email);
    const idMatches = [
      project.user_id,
      project.created_by_user_id,
      ownerRef.user_id,
      ownerRef.id,
      issuer.user_id,
      issuer.id
    ].some((value) => userId && cleanText(value) === userId);
    return emailMatches || idMatches;
  }).length;
}

function countRecent(rows: JsonObject[], days: number) {
  const cutoff = Date.now() - days * 86_400_000;
  return rows.filter((row) => orderTimestampMs(row) >= cutoff).length;
}

function latestByTime(rows: JsonObject[]) {
  return [...rows].sort((a, b) => orderTimestampMs(b) - orderTimestampMs(a))[0] ?? null;
}

function timestampMs(row: JsonObject) {
  const value = row.created_at ?? row.submitted_at ?? row.completed_at ?? row.updated_at ?? row.ts ?? 0;
  if (typeof value === "number") return value > 10_000_000_000 ? value : value * 1000;
  const raw = String(value || "").trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(" ", "T")}Z` : raw;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function orderTimestampMs(row: JsonObject) {
  const measurement = asObject(row.measurement_project ?? row.measurement);
  const raw = asObject(measurement.raw);
  const manifest = asObject(row.manifest);
  const timestamps = asObject(raw.timestamps);
  const manifestTimestamps = asObject(manifest.timestamps);
  const values = [
    measurement.submitted_at,
    measurement.queued_at,
    measurement.created_at,
    raw.submitted_at,
    raw.queued_at,
    raw.created_at,
    manifest.submitted_at,
    manifest.queued_at,
    manifest.created_at,
    manifest.completed_at,
    manifest.updated_at,
    manifestTimestamps.submitted_at,
    manifestTimestamps.queued_at,
    timestamps.created_at,
    timestamps.queued_at,
    manifestTimestamps.created_at,
    manifestTimestamps.completed_at,
    manifestTimestamps.updated_at,
    row.submitted_at,
    row.queued_at,
    row.completed_at,
    row.uploaded_at,
    row.created_at,
    row.updated_at,
    row.ts
  ];
  for (const value of values) {
    const ts = timestampMs({ created_at: value });
    if (ts > 0) return ts;
  }
  return 0;
}

const SHIFT_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

function shiftScheduleRow(user: JsonObject, weekOf = "") {
  const schedule = asObject(user.shift_schedule);
  const recurring = normalizeShiftDayMap(schedule.recurring);
  const overrides = normalizeShiftOverrides(schedule.overrides);
  const week = buildShiftWeek(recurring, overrides, weekOf);
  return {
    email: user.email,
    name: user.name,
    team_id: user.team_id,
    department: user.department,
    role: user.role,
    drafter_rank: user.drafter_rank,
    shift_rate: user.shift_rate,
    shift_schedule: schedule,
    recurring,
    overrides,
    week
  };
}

function normalizeShiftDayMap(value: unknown) {
  const source = asObject(value);
  const map: JsonObject = {};
  for (const day of SHIFT_DAYS) {
    const blocks = source[day];
    map[day] = Array.isArray(blocks) ? blocks : [];
  }
  return map;
}

function normalizeShiftOverrides(value: unknown) {
  if (Array.isArray(value)) {
    const map: JsonObject = {};
    for (const item of value) {
      const row = asObject(item);
      const date = String(row.date ?? row.server_date ?? "").trim();
      if (date) map[date] = Array.isArray(row.blocks) ? row.blocks : [];
    }
    return map;
  }
  return asObject(value);
}

function buildShiftWeek(recurring: JsonObject, overrides: JsonObject, weekOf: string) {
  const monday = parseYmd(weekOf) ?? startOfIsoWeek(new Date());
  const week: JsonObject = {};
  for (let index = 0; index < SHIFT_DAYS.length; index += 1) {
    const date = new Date(monday);
    date.setUTCDate(monday.getUTCDate() + index);
    const dateKey = ymd(date);
    const day = SHIFT_DAYS[index] ?? "monday";
    const isOverride = Object.prototype.hasOwnProperty.call(overrides, dateKey);
    const blocks = isOverride ? overrides[dateKey] : recurring[day];
    week[day] = {
      date: dateKey,
      blocks: Array.isArray(blocks) ? blocks : [],
      is_override: isOverride
    };
  }
  return week;
}

function parseYmd(value: string) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function startOfIsoWeek(value: Date) {
  const date = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 1 - day);
  return date;
}

function ymd(value: Date) {
  return value.toISOString().slice(0, 10);
}

async function commissionDashboard(actorEmail: string): Promise<JsonObject> {
  const [users, settingsDocs, eventDocs, milestoneDocs, payrollDocs] = await Promise.all([
    listInternalUsers(),
    listInternalDocuments("commission_user_settings"),
    listInternalDocuments("commission_events"),
    listInternalDocuments("commission_milestones"),
    listInternalDocuments("commission_payrolls")
  ]);
  const actor = actorEmail || users.find((user) => user.permissions && asObject(user.permissions).manage_payroll)?.email || users[0]?.email || "";
  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const salesUsers = users.filter((user) => ["salesperson", "sales_manager", "admin"].includes(String(user.role ?? "").toLowerCase()));
  const settingsByEmail = new Map(settingsDocs.map((doc) => [String(asObject(doc.data).user_email ?? doc.id).toLowerCase(), asObject(doc.data)]));
  const events = eventDocs.map((doc) => asObject(doc.data));
  const milestones = milestoneDocs.map((doc) => asObject(doc.data));
  const payroll = payrollDocs.map((doc) => asObject(doc.data));
  const actorSettings = commissionSettings(settingsByEmail.get(actor), actor);
  const actorEvents = events.filter((event) => String(event.user_email ?? "").toLowerCase() === actor);
  const actorPayroll = payroll.filter((row) => String(row.user_email ?? "").toLowerCase() === actor).sort((a, b) => Number(b.due_date ?? 0) - Number(a.due_date ?? 0));
  const actorMilestones = milestones.filter((row) => String(row.sales_email ?? row.user_email ?? "").toLowerCase() === actor);
  const actorBreakdown = commissionBreakdown(actorEvents);
  const team = salesUsers.map((user) => {
    const email = String(user.email ?? "").toLowerCase();
    const userEvents = events.filter((event) => String(event.user_email ?? "").toLowerCase() === email);
    const breakdown = commissionBreakdown(userEvents);
    const settings = commissionSettings(settingsByEmail.get(email), email);
    return {
      email,
      name: user.name ?? email,
      settings,
      current_hits: Number(asObject(breakdown.milestone).count ?? 0),
      current_commission_cents: Number(breakdown.total_payout_cents ?? 0),
      breakdown
    };
  }).sort((a, b) => Number(b.current_commission_cents) - Number(a.current_commission_cents));
  const actorUser = actor ? await readInternalUser(actor) : null;
  const canManage = Boolean(asObject(actorUser?.permissions).manage_payroll || String(actorUser?.role ?? "") === "admin");
  return {
    ok: true,
    success: true,
    can_manage: canManage,
    actor_email: actor,
    current_month: currentMonth,
    settings: actorSettings,
    summary: {
      quota: actorSettings.monthly_quota,
      current_hits: Number(asObject(actorBreakdown.milestone).count ?? 0),
      quota_remaining: Math.max(0, Number(actorSettings.monthly_quota ?? 0) - Number(asObject(actorBreakdown.milestone).count ?? 0)),
      current_commission_cents: Number(actorBreakdown.total_payout_cents ?? 0),
      monthly_base_pay_cents: Number(actorSettings.base_pay_cents ?? 0) * 2,
      next_commission_due_ts: Math.floor(Date.now() / 1000),
      next_commission_amount_cents: Number(actorBreakdown.total_payout_cents ?? 0),
      milestone_payout_cents: Number(actorSettings.milestone_payout_cents ?? 1000),
      breakdown: actorBreakdown
    },
    payroll: actorPayroll.slice(0, 24),
    events: actorEvents.slice(0, 250),
    milestones: actorMilestones.slice(0, 100),
    sales_users: team,
    manager_payroll: canManage ? payroll.sort((a, b) => Number(b.due_date ?? 0) - Number(a.due_date ?? 0)).slice(0, 400) : [],
    manager_events: canManage ? events.slice(0, 1000) : [],
    manager_milestones: canManage ? milestones.slice(0, 400) : []
  };
}

function commissionSettings(settings: JsonObject | undefined, email: string) {
  return {
    user_email: email,
    monthly_quota: Number(settings?.monthly_quota ?? 0) || 0,
    base_pay_cents: Number(settings?.base_pay_cents ?? 0) || 0,
    milestone_payout_cents: Number(settings?.milestone_payout_cents ?? 1000) || 1000
  };
}

function commissionBreakdown(events: JsonObject[]) {
  const breakdown: JsonObject = { total_payout_cents: 0 };
  for (const event of events) {
    const type = String(event.event_type ?? "other");
    const amount = Number(event.payout_cents ?? 0) || 0;
    const current = asObject(breakdown[type]);
    breakdown[type] = {
      count: Number(current.count ?? 0) + 1,
      payout_cents: Number(current.payout_cents ?? 0) + amount
    };
    breakdown.total_payout_cents = Number(breakdown.total_payout_cents ?? 0) + amount;
  }
  return breakdown;
}

function commissionCsv(dashboard: JsonObject) {
  const rows = Array.isArray(dashboard.sales_users) ? dashboard.sales_users : [];
  const lines = [["SDR", "Email", "Total Cents", "Quota"].join(",")];
  for (const row of rows) {
    const data = asObject(row);
    lines.push([data.name, data.email, data.current_commission_cents, asObject(data.settings).monthly_quota].map(csvCell).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw;
}

function crmStorageRoot() {
  return path.resolve(process.cwd(), process.env.CRM_STORAGE_ROOT ?? "storage/crm");
}

function crmDbPath(name: "leads" | "referrals") {
  return path.join(crmStorageRoot(), "databases", name === "leads" ? "leads.sqlite" : "referrals.sqlite");
}

function withSqlite<T>(name: "leads" | "referrals", fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(crmDbPath(name), { readOnly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function sqliteRows(name: "leads" | "referrals", sql: string, params: Record<string, unknown> = {}) {
  try {
    return (withSqlite(name, (db) => db.prepare(sql).all(sqliteParams(sql, params) as any)) as JsonObject[]).map(normalizeSqliteRow);
  } catch {
    return [];
  }
}

function sqliteGet(name: "leads" | "referrals", sql: string, params: Record<string, unknown> = {}) {
  try {
    const row = withSqlite(name, (db) => db.prepare(sql).get(sqliteParams(sql, params) as any));
    return row ? normalizeSqliteRow(row as JsonObject) : null;
  } catch {
    return null;
  }
}

function sqliteParams(sql: string, params: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(params).filter(([key]) => {
    const bare = key.replace(/^[:@$]/, "");
    return sql.includes(`:${bare}`) || sql.includes(`$${bare}`) || sql.includes(`@${bare}`);
  }));
}

function normalizeSqliteRow(row: JsonObject) {
  const next = { ...row };
  for (const key of Object.keys(next)) {
    if (!key.endsWith("_json") || typeof next[key] !== "string") continue;
    try {
      next[key.replace(/_json$/, "")] = JSON.parse(String(next[key] || "{}"));
    } catch {
      next[key.replace(/_json$/, "")] = {};
    }
  }
  return next;
}

async function salesUsers() {
  return (await listInternalUsers())
    .filter((user) => ["salesperson", "sales_manager", "admin"].includes(String(user.role ?? "").toLowerCase()))
    .map((user) => ({ email: user.email, name: user.name, role: user.role, permissions: user.permissions }));
}

function targetEmailClause(target: unknown, actorEmail: string) {
  const targetEmail = String(target ?? "mine").trim().toLowerCase();
  if (!targetEmail || targetEmail === "__all__") return { sql: "", params: {} };
  const email = targetEmail === "mine" ? actorEmail : targetEmail;
  return email ? { sql: " AND COALESCE(lm.assigned_to_email, '') = :target_email", params: { target_email: email } } : { sql: "", params: {} };
}

async function salesLeads(body: JsonObject, actorEmail: string) {
  const page = Math.max(1, Number(body.page ?? 1) || 1);
  const perPage = Math.max(1, Math.min(200, Number(body.per_page ?? body.limit ?? 50) || 50));
  const offset = (page - 1) * perPage;
  const q = String(body.q ?? "").trim();
  const target = targetEmailClause(body.target_email, actorEmail);
  const searchSql = q ? " AND (lm.company LIKE :q OR lm.lead_name LIKE :q OR lm.email LIKE :q OR lm.phone LIKE :q OR lm.address LIKE :q OR lm.website LIKE :q)" : "";
  const params = { ...target.params, q: `%${q}%`, limit: perPage, offset };
  const where = `WHERE 1=1${target.sql}${searchSql}`;
  const total = Number(sqliteGet("leads", `SELECT COUNT(*) AS total FROM lead_memberships lm ${where}`, params)?.total ?? 0);
  const leads = sqliteRows("leads", `
    SELECT lm.*, ll.name AS list_name, ll.assigned_to_email AS list_assigned_to_email,
      (SELECT COUNT(*) FROM lead_contacts c WHERE c.lead_id = lm.id) AS contact_count,
      (SELECT MAX(dialed_at) FROM lead_dial_events de WHERE de.lead_id = lm.id) AS latest_callback_at,
      (SELECT MIN(due_at) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS next_followup_at,
      (SELECT COUNT(*) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS open_followup_count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${where}
    ORDER BY lm.updated_at DESC
    LIMIT :limit OFFSET :offset
  `, params);
  return { ok: true, success: true, leads, total, total_pages: Math.max(1, Math.ceil(total / perPage)), page, per_page: perPage };
}

async function salesFollowups(body: JsonObject, actorEmail: string) {
  const targetEmail = String(body.target_email ?? "mine").trim().toLowerCase();
  const email = targetEmail === "mine" ? actorEmail : targetEmail;
  const sql = `
    SELECT fu.*, lm.company, lm.phone, lm.address, ll.name AS list_name
    FROM lead_followups fu
    LEFT JOIN lead_memberships lm ON lm.id = fu.lead_id
    LEFT JOIN lead_lists ll ON ll.id = fu.list_id
    WHERE fu.status = 'open' ${email && email !== "__all__" ? "AND fu.owner_email = :email" : ""}
    ORDER BY fu.due_at ASC
    LIMIT 250
  `;
  return { ok: true, success: true, followups: sqliteRows("leads", sql, { email }) };
}

async function salesLeadDetail(leadId: string) {
  const id = String(leadId || "").trim();
  const lead = sqliteGet("leads", `
    SELECT lm.*, ll.name AS list_name, ll.assigned_to_email AS list_assigned_to_email
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    WHERE lm.id = :id LIMIT 1
  `, { id });
  if (!lead) return { ok: false, success: false, error: "lead_not_found" };
  return {
    ok: true,
    success: true,
    lead,
    contacts: sqliteRows("leads", "SELECT * FROM lead_contacts WHERE lead_id = :id ORDER BY updated_at DESC LIMIT 200", { id }),
    notes: sqliteRows("leads", "SELECT * FROM lead_notes WHERE lead_id = :id ORDER BY created_at DESC LIMIT 200", { id }),
    followups: sqliteRows("leads", "SELECT * FROM lead_followups WHERE lead_id = :id ORDER BY due_at ASC LIMIT 200", { id }),
    activity: sqliteRows("leads", "SELECT * FROM lead_activity_items WHERE lead_id = :id ORDER BY happened_at DESC LIMIT 200", { id }),
    dial_events: sqliteRows("leads", "SELECT * FROM lead_dial_events WHERE lead_id = :id ORDER BY dialed_at DESC LIMIT 200", { id })
  };
}

async function salesDashboard(body: JsonObject, actorEmail: string) {
  const leads = await salesLeads({ ...body, page: 1, per_page: 12 }, actorEmail);
  const due = await salesFollowups({ ...body, target_email: body.target_email }, actorEmail);
  const hot = (leads.leads as JsonObject[]).slice(0, 10).map((row) => ({
    lead_id: row.id,
    company: row.company,
    stage: row.status ?? "",
    stage_label: leadStageLabel(row.status),
    days_since_touch: 0
  }));
  const sales = await salesUsers();
  return {
    ok: true,
    success: true,
    today: new Date().toISOString(),
    totals: {
      leads: leads.total,
      due_followups: (due.followups as unknown[]).length,
      users: sales.length
    },
    cards: {
      meetings: [],
      unread: [],
      morning: [],
      afternoon: [],
      other: []
    },
    tasks: [],
    task_assignee: actorEmail,
    leaderboard: await salesDashboardLeaderboard(actorEmail),
    sales_users: sales,
    pipeline: { hot, cold: [] },
    due_followups: due.followups
  };
}

async function salesDashboardLeaderboard(actorEmail: string) {
  const userByEmail = new Map((await salesUsers()).map((user) => [String(user.email ?? "").toLowerCase(), user]));
  const rows = sqliteRows("leads", `
    SELECT
      COALESCE(ll.assigned_to_email, lm.assigned_to_email, '') AS email,
      COUNT(*) AS stage_progress,
      SUM(CASE WHEN lm.status = 'info_sent' THEN 1 ELSE 0 END) AS info_sent,
      SUM(CASE WHEN lm.status = 'info_received' THEN 1 ELSE 0 END) AS info_received,
      SUM(CASE WHEN lm.status IN ('signed_up', 'sign_up', 'signup') THEN 1 ELSE 0 END) AS sign_ups,
      SUM(CASE WHEN lm.status IN ('funded_500_plus', 'funded') THEN 1 ELSE 0 END) AS funded_500_plus
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    WHERE COALESCE(ll.assigned_to_email, lm.assigned_to_email, '') <> ''
    GROUP BY COALESCE(ll.assigned_to_email, lm.assigned_to_email, '')
    ORDER BY stage_progress DESC
    LIMIT 50
  `);
  return rows.map((row, index) => {
    const email = String(row.email ?? "").toLowerCase();
    const user = userByEmail.get(email);
    return {
      rank: index + 1,
      email,
      name: String(user?.name ?? row.name ?? email),
      is_me: email === actorEmail,
      stage_progress: Number(row.stage_progress ?? 0),
      info_sent: Number(row.info_sent ?? 0),
      info_received: Number(row.info_received ?? 0),
      sign_ups: Number(row.sign_ups ?? 0),
      funded_500_plus: Number(row.funded_500_plus ?? 0),
      funded_value: 0
    };
  });
}

function leadStageLabel(stage: unknown) {
  const raw = String(stage ?? "").trim();
  if (!raw) return "";
  return raw.replace(/_/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

async function salesPipelineSnapshot(body: JsonObject, actorEmail: string) {
  const leads = await salesLeads({ ...body, page: 1, per_page: 100 }, actorEmail);
  return { ok: true, success: true, rows: leads.leads, pipeline: { hot: leads.leads, cold: [] }, users: await salesUsers() };
}

async function salesSequencesSnapshot(_body: JsonObject, _actorEmail: string) {
  return { ok: true, success: true, rows: [], sequences: [], users: await salesUsers() };
}

async function salesAnalytics(_body: JsonObject, _actorEmail: string) {
  const total = Number(sqliteGet("leads", "SELECT COUNT(*) AS total FROM lead_memberships")?.total ?? 0);
  const calls = Number(sqliteGet("leads", "SELECT COUNT(*) AS total FROM lead_dial_events")?.total ?? 0);
  return { ok: true, success: true, summary: { leads: total, calls }, cards: [], series: [], users: await salesUsers(), rows: [] };
}

async function salesLeadLists(body: JsonObject) {
  const q = String(body.q ?? "").trim();
  const rows = sqliteRows("leads", `SELECT * FROM lead_lists ${q ? "WHERE name LIKE :q" : ""} ORDER BY updated_at DESC LIMIT 500`, { q: `%${q}%` });
  return { ok: true, success: true, lists: rows, lead_lists: rows };
}

async function salesLeadListDetail(listId: string) {
  const list = sqliteGet("leads", "SELECT * FROM lead_lists WHERE id = :id LIMIT 1", { id: listId });
  return { ok: true, success: Boolean(list), list };
}

async function salesListLeads(body: JsonObject) {
  const listId = String(body.list_id ?? body.id ?? "").trim();
  const page = Math.max(1, Number(body.page ?? 1) || 1);
  const perPage = Math.max(1, Math.min(500, Number(body.per_page ?? body.limit ?? 100) || 100));
  const total = Number(sqliteGet("leads", "SELECT COUNT(*) AS total FROM lead_memberships WHERE list_id = :list_id", { list_id: listId })?.total ?? 0);
  const leads = sqliteRows("leads", "SELECT * FROM lead_memberships WHERE list_id = :list_id ORDER BY company ASC LIMIT :limit OFFSET :offset", {
    list_id: listId,
    limit: perPage,
    offset: (page - 1) * perPage
  });
  return { ok: true, success: true, leads, total, total_pages: Math.max(1, Math.ceil(total / perPage)), page };
}

function referralRows(table: string) {
  const allowed = new Set(["referral_partners", "referral_codes", "referral_attributions", "referral_reward_ledger", "referral_events"]);
  if (!allowed.has(table)) return [];
  return sqliteRows("referrals", `SELECT * FROM ${table} ORDER BY updated_at DESC LIMIT 500`);
}

function referralSignupUrl(code: unknown) {
  const value = String(code ?? "").trim();
  return value ? `/referral.php?ref=${encodeURIComponent(value)}` : "";
}

function referralPartners() {
  const partners = sqliteRows("referrals", "SELECT * FROM referral_partners ORDER BY updated_at DESC LIMIT 500");
  return partners.map((partner) => {
    const primaryCode = sqliteGet("referrals", "SELECT * FROM referral_codes WHERE partner_id = :partner_id AND is_primary = 1 LIMIT 1", {
      partner_id: String(partner.id ?? "")
    }) ?? sqliteGet("referrals", "SELECT * FROM referral_codes WHERE partner_id = :partner_id ORDER BY created_at ASC LIMIT 1", {
      partner_id: String(partner.id ?? "")
    });
    return {
      ...partner,
      primary_code: primaryCode,
      signup_url: primaryCode ? referralSignupUrl(primaryCode.code) : ""
    };
  });
}

function referralPartnerDetail(partnerId: string) {
  const partner = sqliteGet("referrals", "SELECT * FROM referral_partners WHERE id = :id LIMIT 1", { id: partnerId });
  if (!partner) return { ok: false, success: false, error: "Referral partner not found." };
  const primaryCode = sqliteGet("referrals", "SELECT * FROM referral_codes WHERE partner_id = :partner_id AND is_primary = 1 LIMIT 1", { partner_id: partnerId })
    ?? sqliteGet("referrals", "SELECT * FROM referral_codes WHERE partner_id = :partner_id ORDER BY created_at ASC LIMIT 1", { partner_id: partnerId });
  return {
    ok: true,
    success: true,
    partner,
    primary_code: primaryCode,
    signup_url: primaryCode ? referralSignupUrl(primaryCode.code) : ""
  };
}

async function referralOrgSearch(query: string, limit: number) {
  const q = query.trim().toLowerCase();
  const organizations = await listOrganizations();
  return organizations
    .filter((organization) => {
      if (!q) return true;
      return [
        organization.id,
        organization.name,
        organization.slug,
        organization.owner_email,
        organization.billing_email
      ].some((value) => String(value ?? "").toLowerCase().includes(q));
    })
    .slice(0, Math.max(1, Math.min(250, limit)))
    .map((organization) => ({
      id: organization.id,
      name: organization.name || organization.slug || organization.id,
      owner_email: organization.owner_email || organization.billing_email || "",
      disabled: false
    }));
}

function referralRewardReport() {
  const rows = sqliteRows("referrals", `
    SELECT
      ra.*,
      rp.display_name AS partner_name,
      rp.linked_user_email AS referrer_email,
      rc.code AS referral_code,
      rc.referrer_reward_policy_id AS policy_id,
      rrl.id AS reward_id,
      rrl.reward_type AS reward_type,
      rrl.amount AS reward_amount,
      rrl.status AS reward_status,
      rrl.created_at AS reward_created_at,
      rrl.applied_at AS reward_applied_at,
      rrl.metadata_json AS reward_metadata_json
    FROM referral_attributions ra
    LEFT JOIN referral_partners rp ON rp.id = ra.partner_id
    LEFT JOIN referral_codes rc ON rc.id = ra.code_id
    LEFT JOIN referral_reward_ledger rrl ON rrl.attribution_id = ra.id
    ORDER BY ra.updated_at DESC
    LIMIT 500
  `);
  return rows.map((row) => {
    const rewardId = String(row.reward_id ?? "");
    return {
      ...row,
      referred_org_name: row.referred_org_id || "",
      policy_label: row.policy_id || "",
      threshold_paid_revenue: 0,
      qualified_paid_revenue: 0,
      progress_percent: rewardId ? 100 : 0,
      reward: rewardId ? {
        id: rewardId,
        reward_type: row.reward_type,
        amount: Number(row.reward_amount ?? 0),
        status: row.reward_status,
        created_at: row.reward_created_at,
        applied_at: row.reward_applied_at,
        metadata: row.reward_metadata
      } : null
    };
  });
}

async function injectJson(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    payload: payload as any,
    headers: payload === undefined ? undefined : { "content-type": "application/json" }
  });
  const parsed = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400) {
    return { ok: false, success: false, status_code: response.statusCode, ...asObject(parsed) };
  }
  return parsed;
}

function parseJsonish(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return value ?? fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function summarizeOrganizations(organizations: JsonObject[]) {
  return organizations.reduce<{ organizations: number; users: number; credits_balance: number; test_organizations: number }>((acc, org) => {
    acc.organizations += 1;
    acc.users += Number(org.user_count || 0);
    acc.credits_balance += Number(org.credits_balance || 0);
    if (org.is_test) acc.test_organizations += 1;
    return acc;
  }, { organizations: 0, users: 0, credits_balance: 0, test_organizations: 0 });
}

function normalizeStatusCounts(counts: unknown) {
  const data = asObject(counts);
  const raw = asObject(data.counts ?? data);
  const labels: Record<string, string> = {
    waiting: "Waiting",
    requeue: "Re-queue",
    queued: "Queued",
    in_progress: "In Progress",
    awaiting_review: "Waiting QA",
    qa: "With QA",
    completed: "Completed",
    rejected: "Rejected",
    cancelled: "Cancelled"
  };
  return Object.entries(labels).map(([key, label]) => ({ key, label, count: Number(raw[key] ?? 0) || 0 }));
}

function couponView(document: JsonObject) {
  const data = asObject(document.data);
  const total = numberValue(data.credits_total ?? data.total ?? 0);
  const redeemed = Array.isArray(data.redemptions) ? data.redemptions : [];
  const used = redeemed.reduce((sum, entry) => sum + numberValue(asObject(entry).credits), 0);
  return {
    ...data,
    code_hash: String(data.code_hash ?? document.id ?? ""),
    status: String(data.status ?? "active"),
    credits_total: total,
    credits_per_redeem: numberValue(data.credits_per_redeem ?? 7),
    credits_remaining: numberValue(data.credits_remaining ?? total - used),
    max_redemptions: numberValue(data.max_redemptions ?? 1),
    once_per_user: data.once_per_user !== false && data.once_per_user !== "0",
    redemptions_count: redeemed.length,
    redemptions: redeemed,
    created_at: document.created_at
  };
}
