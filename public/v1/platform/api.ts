import { createHash, createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { registerPricebookApi } from "../pricebook/api.js";
import { createTelnyxVerifyClient, maskPhoneNumber, normalizeE164Phone, TelnyxVerifyError } from "../sms/telnyx_verify.js";
import { env } from "../src/config/env.js";
import { buildReportExpediteOptions, isExpeditedReportExpediteKey, normalizeReportExpediteKey } from "../firstmeasure/expedite.js";
import {
  firstMeasureReportAmount as sharedFirstMeasureReportAmount,
  firstMeasureReportCharge as sharedFirstMeasureReportCharge
} from "../firstmeasure/pricing.js";
import { acquisitionBonusOfferForCampaignToken, acquisitionBonusOfferForOrganization, acquisitionBonusQuoteForOrganization, completeAcquisitionSignup, customerReferralEvent, customerReferralStatus, publicAcquisitionLookup, publicReferralLookup, trackAcquisitionEvent } from "../internal/crm/referrals.js";
import { publicProposalWorkflow } from "../proposals/storage.js";
import { appFlagState, canManageTestAppFlags, containsAppFlagMutation, effectiveAppFlags, enabledOnlyAppFlags, isAppFlagEnabled, newOrganizationAppFlagDefaults, normalizeAppFlagInput, normalizeAppVariantInput } from "./app_flags.js";
import {
  authContextFromRequest,
  buildAuthContext,
  hashPassword,
  loginPlatformIdentity,
  loginPlatformVerifiedIdentity,
  logoutPlatformSession,
  platformAuthCookieNames,
  publicAuthContext,
  requirePlatformAuth,
  setPlatformAuthCookies
} from "./auth.js";
import { PlatformError } from "./errors.js";
import { verifyGoogleCredential, type GoogleIdTokenVerifier } from "./google_auth.js";
import { formatSignupPhone } from "./identity_phone.js";
import {
  addIdentityMembership,
  createOrganization,
  createIdentity,
  deleteAuthSession,
  deleteIdentity,
  deleteOrganization,
  deleteDocument,
  findIdentityByEmail,
  findIdentityByIdentifier,
  identityEmailExists,
  listBranchModules,
  listIdentityMemberships,
  listDocuments,
  listMedia,
  listOrganizations,
  mediaStorageUsage,
  patchIdentity,
  patchOrganization,
  readMediaMarkupLayer,
  readIdentity,
  readAuthSession,
  readBranchModule,
  readDocument,
  readGlobal,
  readMediaFile,
  readMediaMetadata,
  readOrganization,
  saveBranchModule,
  saveGlobal,
  saveMediaMarkupLayer,
  storeMediaUpload,
  upsertDocument,
  withIdentityRegistrationLock
} from "./storage.js";
import { badRequest, conflict, forbidden } from "./errors.js";

const objectBodySchema = z.object({}).passthrough();
const createOrganizationSchema = objectBodySchema.extend({
  id: z.string().optional(),
  name: z.string().optional(),
  status: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  global: z.record(z.unknown()).optional()
});
const createIdentitySchema = objectBodySchema.extend({
  id: z.string().optional(),
  email: z.string(),
  password_hash: z.string().optional(),
  password_algo: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  status: z.string().optional(),
  memberships: z.array(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional()
});
const registerSchema = objectBodySchema.extend({
  email: z.string(),
  password: z.string().optional(),
  password_hash: z.string().optional(),
  name: z.string().optional(),
  phone: z.string().optional(),
  company: z.string().optional(),
  organization_id: z.string().optional(),
  organization: z.record(z.unknown()).optional(),
  membership: z.record(z.unknown()).optional(),
  identity_metadata: z.record(z.unknown()).optional(),
  global: z.record(z.unknown()).optional()
});
type JsonObject = Record<string, unknown>;
const authResolveSchema = objectBodySchema.extend({
  email: z.string()
});
const loginSchema = objectBodySchema.extend({
  identifier: z.string().optional(),
  email: z.string().optional(),
  password: z.string(),
  organization_id: z.string().optional()
});
const googleAuthSchema = objectBodySchema.extend({
  credential: z.string(),
  name: z.string().optional(),
  company: z.string().optional(),
  phone: z.string().optional(),
  organization_id: z.string().optional(),
  identity_metadata: z.record(z.unknown()).optional(),
  global: z.record(z.unknown()).optional()
});
const PLATFORM_STANDARD_USER_ROLES = ["sales_appointments", "inside_sales"];
const PLATFORM_STAGE_MODULE_ID = "stages";
const PLATFORM_TRIGGER_MODULE_ID = "triggers";

type RegistrationTransaction = {
  createdOrganization: (organization: JsonObject) => void;
  createdIdentity: (identity: JsonObject) => void;
};

async function withNewIdentityRegistration<T>(
  email: string,
  operation: (transaction: RegistrationTransaction) => Promise<T>
) {
  return await withIdentityRegistrationLock(email, async () => {
    if (await identityEmailExists(email)) {
      throw conflict("identity_email_exists", `Identity for '${String(email).trim().toLowerCase()}' already exists.`);
    }
    let organizationId = "";
    let identityId = "";
    try {
      return await operation({
        createdOrganization(organization) {
          organizationId = String(organization.id || "");
        },
        createdIdentity(identity) {
          identityId = String(identity.id || "");
        }
      });
    } catch (error) {
      if (identityId) await deleteIdentity(identityId).catch(() => undefined);
      if (organizationId) await deleteOrganization(organizationId).catch(() => undefined);
      throw error;
    }
  });
}
const PLATFORM_VARIABLE_MAPPING_MODULE_ID = "variable_mappings";
const NEW_LEAD_STAGE_ID = "new_lead";
const DEFAULT_STAGE_ID = "contacting";
const APPOINTMENT_SCHEDULED_STAGE_ID = "appointment_scheduled";
const NEWLY_SOLD_STAGE_ID = "newly_sold";
const PROJECT_STARTED_STAGE_ID = "project_started";
const IN_PROGRESS_STAGE_ID = "in_progress";
const COMPLETED_STAGE_ID = "completed";
const PROJECT_WORK_EVENT_TYPE_ID = "project_work";
const NOTIFICATION_COLLECTION = "notifications";
const ACTION_ITEM_COLLECTION = "action_items";
const CUSTOMER_PORTAL_COLLECTION = "customer_portals";
const MAX_PORTAL_RESIDENTIAL_PINS = 5;
const MAX_PORTAL_STRUCTURE_PINS = 10;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PLATFORM_SEARCH_CACHE_TTL_MS = 15_000;
const PLATFORM_CONTACT_PROJECT_CACHE_TTL_MS = 60_000;
let heartbeatStarted = false;

type PlatformSearchType = "project" | "contact";
type PlatformSearchIndexRow = {
  type: PlatformSearchType;
  id: string;
  project_id: string;
  title: string;
  subtitle: string;
  search_text: string;
  compact_text: string;
  phone_digits: string;
  tokens: string[];
  updated_at: string;
  contact?: JsonObject;
};
type PlatformSearchCacheEntry = {
  builtAt: number;
  rows: PlatformSearchIndexRow[];
};
type ContactProjectSummaryCacheEntry = {
  builtAt: number;
  documents: JsonObject[];
};
const platformSearchCache = new Map<string, PlatformSearchCacheEntry>();
const contactProjectSummaryCache = new Map<string, ContactProjectSummaryCacheEntry>();
const passwordResetSmsRequests = new Map<string, Promise<JsonObject>>();

export type PlatformLeadInput = Record<string, unknown> & {
  branch_id?: string;
  branchId?: string;
  source?: string;
  source_kind?: string;
  address?: string;
  title?: string;
  summary?: string;
  contacts?: unknown[];
  customer?: Record<string, unknown>;
  lead_source?: Record<string, unknown>;
  provider_fields?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  notification?: Record<string, unknown>;
};

export type PlatformApiOptions = {
  googleIdTokenVerifier?: GoogleIdTokenVerifier;
};

export const registerPlatformApi: FastifyPluginAsync<PlatformApiOptions> = async (app, options) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }

    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }

    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }

    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "platform",
    message: "platform API is mounted",
    storage: {
      namespace: "storage/platform",
      globalIdentityShape: {
        identities: "/identities/:identityId",
        authResolve: "/auth/resolve",
        authRegister: "/auth/register",
        authLogin: "/auth/login",
        authSession: "/auth/session",
        authLogout: "/auth/logout"
      },
      organizationShape: {
        users: "/organizations/:orgId/users",
        projects: "/organizations/:orgId/projects",
        notifications: "/organizations/:orgId/notifications",
        branch: "/organizations/:orgId/branch",
        branchModules: "/organizations/:orgId/branch/:branchId/modules/:moduleId",
        global: "/organizations/:orgId/global",
        media: "/organizations/:orgId/media"
      }
    },
    subApis: {
      pricebook: "/pricebook"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "platform",
    route: "/ping",
    method: request.method,
    receivedAt: new Date().toISOString()
  }));

  app.get("/organizations", async (request) => {
    await requirePlatformAuth(request);
    return {
      ok: true,
      organizations: await listOrganizations()
    };
  });

  app.post("/organizations", async (request, reply) => {
    await requirePlatformAuth(request, { csrf: true });
    const body = createOrganizationSchema.parse(request.body ?? {});
    const organization = await createOrganization(body);
    reply.code(201);
    return { ok: true, organization };
  });

  app.post("/identities", async (request, reply) => {
    await requirePlatformAuth(request, { csrf: true });
    const body = createIdentitySchema.parse(request.body ?? {});
    const identity = await createIdentity(body);
    reply.code(201);
    return { ok: true, identity: publicIdentity(identity) };
  });

  app.get("/identities/:identityId", async (request) => {
    const ctx = await requirePlatformAuth(request);
    const identityId = getParam(request.params, "identityId");
    if (identityId !== ctx.identityId) await requirePlatformAuth(request, { permission: "manage_company_users" });
    return {
      ok: true,
      identity: publicIdentity(await readIdentity(identityId))
    };
  });

  app.patch("/identities/:identityId", async (request) => {
    const ctx = await requirePlatformAuth(request, { csrf: true });
    const identityId = getParam(request.params, "identityId");
    if (identityId !== ctx.identityId) await requirePlatformAuth(request, { csrf: true, permission: "manage_company_users" });
    return {
      ok: true,
      identity: publicIdentity(await patchIdentity(identityId, objectBodySchema.parse(request.body ?? {})))
    };
  });

  app.post("/auth/resolve", async (request) => {
    await requirePlatformAuth(request, { csrf: true, permission: "manage_company_users" });
    const body = authResolveSchema.parse(request.body ?? {});
    const identity = await findIdentityByEmail(body.email);
    const memberships = await listIdentityMemberships(String(identity.id ?? ""));
    return { ok: true, identity: publicIdentity(identity), memberships };
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body ?? {});
    const ctx = await loginPlatformIdentity({
      identifier: body.identifier || body.email,
      password: body.password,
      organizationId: body.organization_id,
      metadata: {
        user_agent: String(request.headers["user-agent"] || ""),
        ip: request.ip
      }
    });
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    return { ok: true, ...publicAuthContext(ctx) };
  });

  app.get("/auth/google/config", async () => ({
    ok: true,
    enabled: env.googleAuthClientId.trim() !== "",
    client_id: env.googleAuthClientId.trim()
  }));

  app.post("/auth/google", async (request, reply) => {
    const body = googleAuthSchema.parse(request.body ?? {});
    const google = await verifyGoogleCredential(body.credential, options.googleIdTokenVerifier);
    const now = new Date().toISOString();
    let identity: JsonObject | null = null;
    try {
      identity = await findIdentityByEmail(google.email);
    } catch (error) {
      if (!(error instanceof PlatformError) || error.statusCode !== 404) throw error;
    }

    if (identity) {
      const identityMetadata = asObject(identity.metadata);
      const providers = asObject(identityMetadata.auth_providers);
      const currentGoogle = asObject(providers.google);
      const linkedSub = cleanText(currentGoogle.sub);
      if (linkedSub && linkedSub !== google.sub) {
        throw new PlatformError(
          "google_account_mismatch",
          409,
          "This email is already linked to a different Google account."
        );
      }

      const linkedAt = cleanText(currentGoogle.linked_at) || now;
      const linkedIdentity = await patchIdentity(String(identity.id || ""), {
        name: cleanText(identity.name) || google.name,
        metadata: {
          email_verified: true,
          signup_email_verification: {
            verified: true,
            method: "google",
            verified_at: now
          },
          auth_providers: {
            ...providers,
            google: {
              ...currentGoogle,
              sub: google.sub,
              email: google.email,
              hosted_domain: google.hostedDomain,
              picture: google.picture,
              linked_at: linkedAt,
              last_login_at: now
            }
          }
        }
      });
      const ctx = await loginPlatformVerifiedIdentity({
        identity: linkedIdentity,
        organizationId: body.organization_id,
        metadata: {
          source: "google",
          user_agent: String(request.headers["user-agent"] || ""),
          ip: request.ip
        }
      });
      setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
      return {
        ok: true,
        first_login: false,
        linked_google: !linkedSub,
        ...publicAuthContext(ctx)
      };
    }

    const company = cleanText(body.company) || "Your Company";
    const requestedPhone = cleanText(body.phone);
    const phone = requestedPhone ? formatSignupPhone(requestedPhone) : "";
    if (requestedPhone && !phone) throw badRequest("invalid_phone_number", "Enter a valid ten-digit mobile phone number.");
    const workspaceWebsite = googleWorkspaceWebsite(google.hostedDomain);

    const defaultAppFlags = await newOrganizationAppFlagDefaults();
    const requestedGlobal = asObject(body.global);
    delete requestedGlobal.app_flags;
    delete requestedGlobal.feature_flags;
    delete requestedGlobal.app_variants;
    delete requestedGlobal.feature_variants;
    const attribution = signupAttributionPayload(withAcquisitionRequestMetadata(body, request));
    const registered = await withNewIdentityRegistration(google.email, async (transaction) => {
      const organization = await createOrganization({
        id: body.organization_id,
        name: company,
        global: {
          credits_balance: 0,
          credits_ledger: [],
          billing: {
            auto_topup: { enabled: false, threshold_dollars: 50, topup_dollars: 100, status: "idle" },
            stripe: { has_payment_method: false },
            events: []
          },
          branding: { colors: { primary: "#d93025", secondary: "#202124", accent: "#1a73e8" } },
          ...(workspaceWebsite ? { contact: { website: workspaceWebsite } } : {}),
          report_settings: {},
          ...requestedGlobal,
          app_flags: defaultAppFlags
        }
      });
      transaction.createdOrganization(organization);
      const createdIdentity = await createIdentity({
        email: google.email,
        password_hash: "",
        password_algo: "google",
        name: cleanText(body.name) || google.name,
        phone,
        metadata: {
          ...(body.identity_metadata || {}),
          ...attribution,
          email_verified: true,
          signup_email_verification: {
            verified: true,
            method: "google",
            verified_at: now
          },
          auth_providers: {
            google: {
              sub: google.sub,
              email: google.email,
              hosted_domain: google.hostedDomain,
              picture: google.picture,
              linked_at: now,
              last_login_at: now
            }
          }
        }
      });
      transaction.createdIdentity(createdIdentity);
      const userId = `user_${String(createdIdentity.id).replace(/^identity_/, "")}`;
      const user = await upsertDocument(String(organization.id), "users", {
        id: userId,
        data: {
          identity_id: createdIdentity.id,
          email: createdIdentity.email,
          name: cleanText(body.name) || google.name,
          phone,
          role: "owner",
          roles: PLATFORM_STANDARD_USER_ROLES,
          status: "active",
          permissions: { "*": true },
          profile: google.picture ? { picture: google.picture } : {},
          stats: { projects_ordered: 0, commissions_earned: 0 },
          metadata: {}
        },
        metadata: { kind: "organization_user", identity_id: createdIdentity.id }
      }, { replace: true });
      const nextIdentity = await addIdentityMembership(
        String(createdIdentity.id),
        String(organization.id),
        String(user.id),
        "owner"
      );
      return { organization, nextIdentity };
    });
    const { organization, nextIdentity } = registered;
    await applyAcquisitionSignup(String(organization.id), {
      email: google.email,
      name: cleanText(body.name) || google.name,
      company,
      ...attribution
    }).catch((error) => app.log.warn({ error }, "Google signup attribution failed"));

    const ctx = await loginPlatformVerifiedIdentity({
      identity: nextIdentity,
      organizationId: String(organization.id),
      metadata: {
        source: "google_register",
        user_agent: String(request.headers["user-agent"] || ""),
        ip: request.ip
      }
    });
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    reply.code(201);
    return {
      ok: true,
      first_login: true,
      linked_google: true,
      ...publicAuthContext(ctx)
    };
  });

  app.post("/auth/legacy-action", async (request, reply) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await handleAuthLegacyAction(request, reply, body);
    const status = Number(asObject(result).status_code || 200);
    if (status >= 400) reply.code(status);
    return result;
  });

  app.post("/auth/logout", async (request, reply) => {
    await logoutPlatformSession(request, reply);
    return { ok: true, authenticated: false };
  });

  app.get("/auth/session", async (request) => {
    const ctx = await authContextFromRequest(request);
    if (!ctx) return { ok: true, authenticated: false, cookie_names: platformAuthCookieNames() };
    return { ok: true, ...publicAuthContext(ctx), cookie_names: platformAuthCookieNames() };
  });

  app.get("/statsig/bootstrap", async (request) => {
    const ctx = await authContextFromRequest(request);
    const configured = env.statsigEnabled && env.statsigClientKey.trim() !== "";
    if (!ctx) {
      return {
        ok: true,
        enabled: false,
        configured,
        authenticated: false,
        environmentTier: env.statsigEnvironmentTier
      };
    }

    const [flags, globalDoc] = await Promise.all([
      effectiveAppFlags(ctx.orgId),
      readGlobal(ctx.orgId).catch(() => null)
    ]);
    const enabled = enabledOnlyAppFlags(flags);
    const enabledFlagKeys = Object.entries(enabled).flatMap(([group, names]) => (
      Array.isArray(names) ? names.map((name) => `${group}.${name}`) : []
    ));
    const globalData = asObject(asObject(globalDoc).data);
    const statsigData = asObject(globalData.statsig);
    const experiments = asObject(globalData.experiments || statsigData.experiments);
    const packageTier = cleanText(globalData.package_tier || statsigData.package_tier || globalData.plan || "");
    const identity = asObject(ctx.identity);
    const userData = asObject(ctx.userDocument.data);
    const orgData = asObject(ctx.organization.data);

    return {
      ok: true,
      enabled: configured,
      configured,
      authenticated: true,
      clientKey: configured ? env.statsigClientKey : "",
      environmentTier: env.statsigEnvironmentTier,
      appEnv: env.appEnv,
      user: {
        userID: ctx.identityId || ctx.userId,
        email: cleanText(identity.email || userData.email),
        custom: {
          orgID: ctx.orgId,
          orgName: cleanText(orgData.name || ctx.organization.name),
          branchID: ctx.branchId,
          platformUserID: ctx.userId,
          role: ctx.role,
          appEnv: env.appEnv,
          packageTier,
          enabledAppFlags: enabledFlagKeys,
          manualExperiments: experiments
        }
      },
      context: {
        org_id: ctx.orgId,
        branch_id: ctx.branchId,
        user_id: ctx.userId,
        identity_id: ctx.identityId,
        role: ctx.role,
        app_env: env.appEnv,
        statsig_environment_tier: env.statsigEnvironmentTier,
        package_tier: packageTier,
        enabled_app_flags: enabled,
        enabled_app_flag_keys: enabledFlagKeys,
        manual_experiments: experiments
      }
    };
  });

  app.post("/statsig/debug", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    app.log.info({ statsig_debug: body }, "Statsig browser diagnostic");
    return { ok: true };
  });

  app.get("/me", async (request) => {
    const ctx = await requirePlatformAuth(request);
    const [global, branch] = await Promise.all([
      readGlobal(ctx.orgId),
      readDocument(ctx.orgId, "branch", ctx.branchId).catch(() => null)
    ]);
    return {
      ok: true,
      ...publicAuthContext(ctx),
      global,
      branch
    };
  });

  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body ?? {});
    const passwordHash = body.password_hash || (body.password ? await hashPassword(body.password) : "");
    if (!passwordHash) throw badRequest("password_required", "A password is required.");
    const phone = formatSignupPhone(body.phone);
    if (!phone) throw badRequest("invalid_phone_number", "Enter a valid ten-digit mobile phone number.");
    const orgInput = body.organization && typeof body.organization === "object" ? body.organization : {};
    const orgName = String(body.company ?? orgInput.name ?? "Your Company");
    const defaultAppFlags = await newOrganizationAppFlagDefaults();
    const requestedGlobal = asObject(body.global);
    delete requestedGlobal.app_flags;
    delete requestedGlobal.feature_flags;
    delete requestedGlobal.app_variants;
    delete requestedGlobal.feature_variants;
    const registered = await withNewIdentityRegistration(body.email, async (transaction) => {
      const organization = await createOrganization({
        ...orgInput,
        id: body.organization_id,
        name: orgName,
        global: {
          credits_balance: 0,
          credits_ledger: [],
          billing: {
            auto_topup: { enabled: false, threshold_dollars: 50, topup_dollars: 100, status: "idle" },
            stripe: { has_payment_method: false },
            events: []
          },
          branding: { colors: { primary: "#d93025", secondary: "#202124", accent: "#1a73e8" } },
          report_settings: {},
          ...requestedGlobal,
          app_flags: defaultAppFlags
        }
      });
      transaction.createdOrganization(organization);
      const identity = await createIdentity({
        email: body.email,
        password_hash: passwordHash,
        password_algo: body.password ? "bcrypt" : "php-password-hash",
        name: body.name || "",
        phone,
        metadata: {
          email_verified: false,
          signup_email_verification: {
            verified: false,
            method: "deferred_onboarding",
            created_at: new Date().toISOString()
          },
          ...(body.identity_metadata || {}),
          ...signupAttributionPayload(withAcquisitionRequestMetadata(body, request))
        }
      });
      transaction.createdIdentity(identity);
      const userId = String(body.membership?.id || `user_${String(identity.id).replace(/^identity_/, "")}`);
      const user = await upsertDocument(
        String(organization.id),
        "users",
        {
          id: userId,
          data: {
            identity_id: identity.id,
            email: identity.email,
            name: body.name || "",
            phone,
            role: String(body.membership?.role || "owner"),
            roles: Array.isArray(body.membership?.roles) && body.membership?.roles.length
              ? body.membership.roles
              : PLATFORM_STANDARD_USER_ROLES,
            status: "active",
            permissions: body.membership?.permissions || { "*": true },
            profile: {},
            stats: { projects_ordered: 0, commissions_earned: 0 },
            metadata: body.membership?.metadata || {}
          },
          metadata: {
            kind: "organization_user",
            identity_id: identity.id
          }
        },
        { replace: true }
      );
      const nextIdentity = await addIdentityMembership(String(identity.id), String(organization.id), String(user.id), String(user.data.role || "owner"));
      return { organization, identity, user, nextIdentity };
    });
    const { organization, user, nextIdentity } = registered;
    await applyAcquisitionSignup(String(organization.id), {
      email: body.email,
      name: body.name || "",
      company: orgName,
      ...signupAttributionPayload(withAcquisitionRequestMetadata(body, request))
    }).catch((error) => app.log.warn({ error }, "Acquisition signup attribution failed"));
    if (body.password) {
      const ctx = await loginPlatformIdentity({
        email: body.email,
        password: body.password,
        organizationId: String(organization.id),
        metadata: {
          source: "register",
          user_agent: String(request.headers["user-agent"] || ""),
          ip: request.ip
        }
      });
      setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    }
    reply.code(201);
    return { ok: true, identity: publicIdentity(nextIdentity), organization, user };
  });

  app.post("/auth/touch-login", async (request) => {
    await requirePlatformAuth(request, { csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const identityId = String(body.identity_id || "");
    const identity = await patchIdentity(identityId, { last_login_at: new Date().toISOString() });
    return { ok: true, identity: publicIdentity(identity) };
  });

  app.post("/portal-action", async (request, reply) => {
    const payload = await parsePortalActionRequest(request);
    const action = cleanText(payload.action);
    if (!action) throw badRequest("missing_action", "A portal action is required.");
    const result = await handlePortalAction(app, action, payload, request, reply);
    const status = Number(asObject(result).status_code || 200);
    if (status >= 400) reply.code(status);
    return result;
  });

  app.get("/referrals/public/:code", async (request) => publicReferralLookup(
    getParam(request.params, "code"),
    publicRequestBaseUrl(request)
  ));

  app.post("/acquisition/public/track", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    return publicAcquisitionLookup(withAcquisitionRequestMetadata(body, request), publicRequestBaseUrl(request));
  });

  app.post("/acquisition/event", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    return trackAcquisitionEvent(withAcquisitionRequestMetadata(body, request));
  });

  app.post("/referrals/status", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const actor = portalActor(body);
    if (!actor.email) return { success: false, ok: false, status_code: 401, error: "Authentication required." };
    const orgId = cleanText(body.actor_org_id || body.org_id) || cleanText((await portalContext(actor, body).catch(() => ({ orgId: "" }))).orgId);
    return await customerReferralStatus({
      ...body,
      email: actor.email,
      org_id: orgId,
      name: actor.name,
      base_url: publicRequestBaseUrl(request)
    });
  });

  app.post("/referrals/event", async (request) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const actor = portalActor(body);
    if (!actor.email) return { success: false, ok: false, status_code: 401, error: "Authentication required." };
    const orgId = cleanText(body.actor_org_id || body.org_id) || cleanText((await portalContext(actor, body).catch(() => ({ orgId: "" }))).orgId);
    return customerReferralEvent({
      ...body,
      email: actor.email,
      org_id: orgId,
      name: actor.name,
      base_url: publicRequestBaseUrl(request)
    });
  });

  app.post("/stripe-webhook-proxy", async (request, reply) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const result = await portalStripeWebhookProxy(body);
    const status = Number(asObject(result).status_code || 200);
    if (status >= 400) reply.code(status);
    return result;
  });

  app.get("/organizations/:orgId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      organization: await readOrganization(orgId)
    };
  });

  app.get("/organizations/:orgId/portal-state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId });
    const branchId = ctx.branchId || "default";
    const [organization, global, branch] = await Promise.all([
      readOrganization(orgId),
      readGlobal(orgId),
      readDocument(orgId, "branch", branchId).catch(() => null)
    ]);
    const globalData = asObject(global.data);
    const branchData = asObject(branch?.data);
    return {
      ok: true,
      organization,
      user: platformUserView(ctx.userDocument),
      identity: publicIdentity(ctx.identity),
      membership: {
        organization_id: ctx.orgId,
        user_id: ctx.userId,
        role: ctx.role,
        branch_id: branchId,
        permissions: ctx.permissions
      },
      branch,
      global,
      credits: {
        balance: numericValue(globalData.credits_balance),
        ledger_count: Array.isArray(globalData.credits_ledger) ? globalData.credits_ledger.length : 0
      },
      billing: safeBillingView(globalData.billing),
      branding: asObject(branchData.branding),
      contact: asObject(branchData.contact),
      report_settings: asObject(branchData.report_settings),
      permissions: ctx.permissions
    };
  });

  app.patch("/organizations/:orgId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return {
      ok: true,
      organization: await patchOrganization(orgId, objectBodySchema.parse(request.body ?? {}))
    };
  });

  app.get("/organizations/:orgId/global", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      document: await readGlobal(orgId)
    };
  });

  app.get("/organizations/:orgId/credits", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const limit = Math.max(0, Math.min(500, Math.round(numericValue(query.limit, 100))));
    const global = await readGlobal(orgId);
    const data = asObject(global.data);
    const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger : [];
    const items = limit > 0 ? ledger.slice(-limit).reverse() : [];
    return {
      ok: true,
      balance: numericValue(data.credits_balance),
      free_expedite_uses: Math.max(0, Math.round(numericValue(data.free_expedite_uses))),
      ledger: items,
      ledger_count: ledger.length,
      document_revision: global.revision
    };
  });

  app.post("/organizations/:orgId/credits/adjust", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_billing" });
    const body = objectBodySchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await applyCreditDelta(orgId, body, ctx.identity.email))
    };
  });

  app.post("/organizations/:orgId/credits/charge", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "order_reports" });
    const body = objectBodySchema.parse(request.body ?? {});
    const amount = Math.abs(numericValue(body.amount));
    if (amount <= 0) throw badRequest("invalid_credit_amount", "Charge amount must be greater than zero.");
    const global = await readGlobal(orgId);
    const balance = numericValue(asObject(global.data).credits_balance);
    if (amount > balance) {
      throw new PlatformError(
        "insufficient_credits",
        402,
        "This organization does not have enough credits for this charge.",
        { balance, required: amount }
      );
    }
    const charge = await applyCreditDelta(orgId, { ...body, amount: -amount, reason: body.reason || "order_submitted" }, ctx.identity.email);
    const autoTopup = await stripeMaybeAutoTopup(orgId, String(ctx.identity.email || ""), charge.balance, charge.ledger_entry);
    return {
      ok: true,
      ...charge,
      ...(autoTopup ? { auto_topup: autoTopup } : {})
    };
  });

  app.post("/organizations/:orgId/credits/refund", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_billing" });
    const body = objectBodySchema.parse(request.body ?? {});
    const amount = Math.abs(numericValue(body.amount));
    if (amount <= 0) throw badRequest("invalid_credit_amount", "Refund amount must be greater than zero.");
    return {
      ok: true,
      ...(await applyCreditDelta(orgId, { ...body, amount, reason: body.reason || "refund" }, ctx.identity.email))
    };
  });

  app.post("/organizations/:orgId/credits/order-refund", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "order_reports" });
    const body = objectBodySchema.parse(request.body ?? {});
    const chargeToken = cleanText(body.charge_token || body.chargeToken);
    if (!chargeToken) throw badRequest("missing_charge_token", "A charge token is required.");
    const charged = await creditChargeForToken(orgId, chargeToken);
    if (!charged) throw badRequest("charge_token_not_found", "No refundable charge was found for that token.");
    const requestedAmount = Math.abs(numericValue(body.amount ?? body.refund_amount));
    const amount = requestedAmount > 0 ? Math.min(requestedAmount, charged.amount) : charged.amount;
    if (amount <= 0) throw badRequest("invalid_credit_amount", "Refund amount must be greater than zero.");
    return {
      ok: true,
      charge_token: chargeToken,
      refunded_amount: amount,
      ...(await applyCreditDelta(orgId, {
        ...body,
        amount,
        reason: body.reason || "order_refund",
        meta: {
          ...asObject(body.meta),
          charge_token: chargeToken,
          source_charge: charged.entry
        }
      }, ctx.identity.email))
    };
  });

  app.get("/organizations/:orgId/app-flags", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId });
    const state = await appFlagState(orgId);
    return {
      ok: true,
      ...state,
      test_admin: canManageTestAppFlags(ctx)
    };
  });

  app.put("/organizations/:orgId/app-flags", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    if (!canManageTestAppFlags(ctx)) {
      throw forbidden("app_flags_test_admin_only", "Only configured test admins can edit app rollout flags from Platform.");
    }
    const body = objectBodySchema.parse(request.body ?? {});
    const hasVariantInput = Object.prototype.hasOwnProperty.call(body, "app_variants") || Object.prototype.hasOwnProperty.call(body, "variants");
    const hasExplicitFlagInput = Object.prototype.hasOwnProperty.call(body, "app_flags") || Object.prototype.hasOwnProperty.call(body, "flags");
    const patchData: JsonObject = {};
    if (hasExplicitFlagInput || !hasVariantInput) patchData.app_flags = normalizeAppFlagInput(body);
    if (hasVariantInput) {
      patchData.app_variants = normalizeAppVariantInput(body);
    }
    await saveGlobal(orgId, { data: patchData }, { replace: false });
    return {
      ok: true,
      ...(await appFlagState(orgId)),
      test_admin: true
    };
  });

  app.get("/organizations/:orgId/media", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      media: await listMedia(orgId)
    };
  });

  app.post("/organizations/:orgId/media", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const upload = await parseMediaUploadRequest(request);
    const media = await storeMediaUpload(orgId, upload);
    reply.code(201);
    return { ok: true, media };
  });

  app.get("/organizations/:orgId/media/storage", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    const usage = await mediaStorageUsage(orgId);
    return { ok: true, usage };
  });

  app.post("/organizations/:orgId/media/storage", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const usage = await mediaStorageUsage(orgId);
    return { ok: true, usage };
  });

  app.get("/organizations/:orgId/media/:mediaId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      media: await readMediaMetadata(orgId, getParam(request.params, "mediaId"))
    };
  });

  app.get("/organizations/:orgId/media/:mediaId/logo", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const mediaId = getParam(request.params, "mediaId");
    const metadata = await readMediaMetadata(orgId, mediaId);
    const owner = asObject(metadata.owner);
    const slot = String(metadata.slot || owner.slot || "");
    if (slot !== "logo") {
      throw forbidden("private_media", "Only organization logo media can be fetched publicly.");
    }
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const file = await readMediaFile(orgId, mediaId, String(query.variant || "original"));
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Disposition", `inline; filename="${String(file.fileName).replace(/"/g, "")}"`);
    return reply.send(file.bytes);
  });

  app.get("/organizations/:orgId/media/:mediaId/file", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const mediaId = getParam(request.params, "mediaId");
    const metadata = await readMediaMetadata(orgId, mediaId);
    const owner = asObject(metadata.owner);
    const slot = String(metadata.slot || owner.slot || "");
    const scope = String(metadata.scope || "").toLowerCase();
    const collection = String(metadata.collection || "").toLowerCase();
    const isOrganizationBrandingMedia = String(owner.type || "").toLowerCase() === "organization"
      && (slot === "logo" || scope === "branding" || collection === "branding" || slot.includes("brand") || slot.includes("logo"));
    if (!isOrganizationBrandingMedia) {
      await requirePlatformAuth(request, { orgId });
    }
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const file = await readMediaFile(
      orgId,
      mediaId,
      String(query.variant || "original")
    );
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Disposition", `inline; filename="${String(file.fileName).replace(/"/g, "")}"`);
    return reply.send(file.bytes);
  });

  app.get("/organizations/:orgId/media/:mediaId/markup/:layerId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      layer: await readMediaMarkupLayer(
        orgId,
        getParam(request.params, "mediaId"),
        getParam(request.params, "layerId")
      )
    };
  });

  app.put("/organizations/:orgId/media/:mediaId/markup/:layerId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await saveMediaMarkupLayer(
        orgId,
        getParam(request.params, "mediaId"),
        getParam(request.params, "layerId"),
        extractDataBody(body),
        extractMetadataBody(body)
      ))
    };
  });

  app.patch("/organizations/:orgId/media/:mediaId/markup/:layerId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await saveMediaMarkupLayer(
        orgId,
        getParam(request.params, "mediaId"),
        getParam(request.params, "layerId"),
        extractDataBody(body),
        extractMetadataBody(body)
      ))
    };
  });

  app.put("/organizations/:orgId/global", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_billing" });
    const body = objectBodySchema.parse(request.body ?? {});
    if (containsAppFlagMutation(body)) throw forbidden("app_flags_operator_only", "App rollout flags are operator-controlled and cannot be changed from Platform.");
    return {
      ok: true,
      document: await saveGlobal(orgId, body, { replace: true })
    };
  });

  app.patch("/organizations/:orgId/global", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    if (containsAppFlagMutation(body)) throw forbidden("app_flags_operator_only", "App rollout flags are operator-controlled and cannot be changed from Platform.");
    return {
      ok: true,
      document: await saveGlobal(orgId, body, { replace: false })
    };
  });

  app.get("/organizations/:orgId/branch/:branchId/modules", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      modules: await listBranchModules(
        orgId,
        getParam(request.params, "branchId")
      )
    };
  });

  app.get("/organizations/:orgId/branch/:branchId/modules/:moduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      module: await readBranchModule(
        orgId,
        getParam(request.params, "branchId"),
        getParam(request.params, "moduleId")
      )
    };
  });

  app.put("/organizations/:orgId/branch/:branchId/modules/:moduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: branchModuleWritePermission(getParam(request.params, "moduleId")) });
    return {
      ok: true,
      module: await saveBranchModule(
        orgId,
        getParam(request.params, "branchId"),
        getParam(request.params, "moduleId"),
        objectBodySchema.parse(request.body ?? {}),
        { replace: true }
      )
    };
  });

  app.patch("/organizations/:orgId/branch/:branchId/modules/:moduleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: branchModuleWritePermission(getParam(request.params, "moduleId")) });
    return {
      ok: true,
      module: await saveBranchModule(
        orgId,
        getParam(request.params, "branchId"),
        getParam(request.params, "moduleId"),
        objectBodySchema.parse(request.body ?? {}),
        { replace: false }
      )
    };
  });

  app.get("/organizations/:orgId/branch/:branchId/triggers", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requirePlatformAuth(request, { orgId });
    const modules = await ensureWorkflowModules(orgId, branchId);
    return { ok: true, triggers: modules.triggers, stages: modules.stages, mappings: modules.mappings };
  });

  app.put("/organizations/:orgId/branch/:branchId/triggers", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = objectBodySchema.parse(request.body ?? {});
    const saved = await saveBranchModule(
      orgId,
      branchId,
      PLATFORM_TRIGGER_MODULE_ID,
      { data: extractDataBody(body), metadata: extractMetadataBody(body) },
      { replace: true }
    );
    return { ok: true, triggers: saved };
  });

  app.post("/organizations/:orgId/branch/:branchId/triggers/emit", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const branchId = getParam(request.params, "branchId") || "default";
    await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await emitPlatformTrigger(orgId, branchId, String(body.event || body.event_name || ""), asObject(body.context)))
    };
  });

  app.post("/organizations/:orgId/projects/:projectId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    const body = objectBodySchema.parse(request.body ?? {});
    const branchId = String(body.branch_id || body.branchId || "default");
    const current = await readDocument(orgId, "projects", projectId);
    const currentData = asObject(current.data);
    const event = normalizeProjectEvent(asObject(body.event || body.data || body), currentData);
    const events = Array.isArray(currentData.events) ? [...currentData.events] : [];
    const existingIndex = events.findIndex((item) => asObject(item).id === event.id);
    if (existingIndex >= 0) events[existingIndex] = event;
    else events.push(event);
    const stageId = String(currentData.stage || currentData.stage_id || DEFAULT_STAGE_ID);
    const document = await upsertDocument(
      orgId,
      "projects",
      {
        id: projectId,
        data: {
          ...currentData,
          stage: stageId,
          stage_id: stageId,
          events,
          updated_at: new Date().toISOString()
        },
        metadata: {
          ...asObject(current.metadata),
          last_project_event_id: event.id
        }
      },
      { replace: true }
    );
    const emitted = await emitPlatformTrigger(orgId, branchId, "project.event_scheduled", {
      project_id: projectId,
      project: document.data,
      project_document: document,
      event
    });
    const emittedDocument = asObject(emitted.project_document || document);
    invalidatePlatformSearchCache(orgId);
    return {
      ok: true,
      event,
      document: emitted.project_document || document,
      project: asObject(emittedDocument.data),
      triggers: emitted
    };
  });

  app.get("/organizations/:orgId/projects/:projectId/customer-portal", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, permission: "view_reports" });
    const portal = await ensureCustomerPortalRecord(orgId, projectId, {}, publicRequestBaseUrl(request));
    return { ok: true, ...portal };
  });

  app.post("/organizations/:orgId/projects/:projectId/customer-portal", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    const body = objectBodySchema.parse(request.body ?? {});
    const portal = await ensureCustomerPortalRecord(orgId, projectId, { ...body, actor_user_id: ctx.userId }, publicRequestBaseUrl(request));
    reply.code(201);
    return { ok: true, ...portal };
  });

  app.patch("/organizations/:orgId/projects/:projectId/customer-portal", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    const body = objectBodySchema.parse(request.body ?? {});
    const portal = await updateCustomerPortalRecord(orgId, projectId, { ...body, actor_user_id: ctx.userId }, publicRequestBaseUrl(request));
    return { ok: true, ...portal };
  });

  app.get("/organizations/:orgId/projects/:projectId/customer-portal/activity", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, permission: "view_reports" });
    return { ok: true, events: await listCustomerPortalActivity(orgId, projectId) };
  });

  app.get("/customer-portals/preview/:portalUuid", async (request) => {
    const ctx = await authContextFromRequest(request);
    const result = await publicCustomerPortalPayload(getParam(request.params, "portalUuid"), true, publicRequestBaseUrl(request), ctx?.orgId || "", apiRequestBaseUrl(request));
    return { ok: true, ...result };
  });

  app.get("/customer-portals/:portalUuid", async (request) => {
    const result = await publicCustomerPortalPayload(getParam(request.params, "portalUuid"), false, publicRequestBaseUrl(request), "", apiRequestBaseUrl(request));
    return { ok: true, ...result };
  });

  app.post("/customer-portals/:portalUuid/events", async (request, reply) => {
    const body = objectBodySchema.parse(request.body ?? {});
    const event = await recordCustomerPortalEvent(getParam(request.params, "portalUuid"), body, request);
    reply.code(201);
    return { ok: true, event };
  });

  app.get("/customer-portals/preview/:portalUuid/media/:mediaId/file", async (request, reply) => {
    const ctx = await authContextFromRequest(request);
    await sendCustomerPortalMedia(reply, getParam(request.params, "portalUuid"), getParam(request.params, "mediaId"), true, request, ctx?.orgId || "");
  });

  app.get("/customer-portals/:portalUuid/media/:mediaId/file", async (request, reply) => {
    await sendCustomerPortalMedia(reply, getParam(request.params, "portalUuid"), getParam(request.params, "mediaId"), false, request);
  });

  app.get("/organizations/:orgId/notifications", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const result = await listVisibleNotifications(orgId, ctx.userId, {
      includeDismissed: parseBooleanField(query.include_dismissed),
      branchId: String(query.branch_id || query.branchId || ctx.branchId || "default")
    });
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/notifications", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const notification = await createPlatformNotification(orgId, objectBodySchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, notification };
  });

  app.get("/organizations/:orgId/action-items", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const result = await listVisibleActionItems(orgId, ctx.userId, {
      branchId: cleanText(query.branch_id || query.branchId || ctx.branchId || "default"),
      includeCompleted: parseBooleanField(query.include_completed),
      includeCanceled: parseBooleanField(query.include_canceled),
      includeHidden: parseBooleanField(query.include_hidden),
      includeAll: parseBooleanField(query.include_all),
      projectId: cleanText(query.project_id || query.projectId),
      contact: cleanText(query.contact || query.contact_ref || query.email || query.phone),
      kind: cleanText(query.kind),
      status: cleanText(query.status),
      dueBefore: cleanText(query.due_before || query.dueBefore),
      dueAfter: cleanText(query.due_after || query.dueAfter)
    });
    return { ok: true, ...result };
  });

  app.post("/organizations/:orgId/action-items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const actionItem = await createPlatformActionItem(orgId, objectBodySchema.parse(request.body ?? {}), ctx);
    reply.code(201);
    return { ok: true, action_item: actionItemData(actionItem), document: actionItem };
  });

  app.get("/organizations/:orgId/action-items/:actionItemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId });
    const document = await readDocument(orgId, ACTION_ITEM_COLLECTION, getParam(request.params, "actionItemId"));
    const item = await actionItemViewForUser(orgId, document, ctx.userId);
    if (!item.visible_to_user && !actionItemIsManagedByUser(item, ctx)) {
      throw forbidden("action_item_not_visible", "This action item is not assigned to the current user.");
    }
    return { ok: true, action_item: item, document };
  });

  app.patch("/organizations/:orgId/action-items/:actionItemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const document = await patchPlatformActionItem(orgId, getParam(request.params, "actionItemId"), objectBodySchema.parse(request.body ?? {}), ctx);
    return { ok: true, action_item: actionItemData(document), document };
  });

  app.post("/organizations/:orgId/action-items/:actionItemId/claim", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const document = await transitionPlatformActionItem(orgId, getParam(request.params, "actionItemId"), "claimed", objectBodySchema.parse(request.body ?? {}), ctx);
    return { ok: true, action_item: actionItemData(document), document };
  });

  app.post("/organizations/:orgId/action-items/:actionItemId/complete", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const document = await transitionPlatformActionItem(orgId, getParam(request.params, "actionItemId"), "completed", objectBodySchema.parse(request.body ?? {}), ctx);
    return { ok: true, action_item: actionItemData(document), document };
  });

  app.post("/organizations/:orgId/action-items/:actionItemId/cancel", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const document = await transitionPlatformActionItem(orgId, getParam(request.params, "actionItemId"), "canceled", objectBodySchema.parse(request.body ?? {}), ctx);
    return { ok: true, action_item: actionItemData(document), document };
  });

  app.patch("/organizations/:orgId/action-items/:actionItemId/user-state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const state = await setUserActionItemState(orgId, ctx.userId, getParam(request.params, "actionItemId"), objectBodySchema.parse(request.body ?? {}));
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/tagging/mention-events", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const mentionUsers = Array.isArray(body.mention_users || body.mentionUsers)
      ? (body.mention_users || body.mentionUsers) as unknown[]
      : [];
    const event = {
      id: `mention_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
      type: "tagging.mentioned",
      source: String(body.source || "photo_comment"),
      target_user_ids: normalizeStringArray(body.target_user_ids || body.targetUserIds || body.user_ids || body.userIds),
      mention_users: mentionUsers.map((item) => asObject(item)),
      context: asObject(body.context),
      comment: asObject(body.comment),
      actor_user_id: ctx.userId,
      branch_id: ctx.branchId || "default",
      created_at: new Date().toISOString()
    };
    reply.code(201);
    return { ok: true, event };
  });

  app.get("/organizations/:orgId/notifications/:notificationId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    return {
      ok: true,
      notification: await readDocument(orgId, NOTIFICATION_COLLECTION, getParam(request.params, "notificationId"))
    };
  });

  app.patch("/organizations/:orgId/notifications/:notificationId/user-state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const state = await setUserNotificationState(orgId, ctx.userId, getParam(request.params, "notificationId"), body);
    return { ok: true, state };
  });

  app.post("/organizations/:orgId/users/:documentId/invite", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_users|manage_users|manage_sales_users" });
    const documentId = getParam(request.params, "documentId");
    const userDoc = await readDocument(orgId, "users", documentId);
    const invite = await sendPlatformOrgUserInvite(orgId, userDoc, request, String(ctx.identity.email || ""));
    return { ...invite, ok: invite.ok, success: invite.ok };
  });

  app.post("/organizations/:orgId/leads", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true });
    const body = objectBodySchema.parse(request.body ?? {});
    const created = await createPlatformLead(orgId, body);
    invalidatePlatformSearchCache(orgId);
    reply.code(201);
    return { ok: true, ...created };
  });

  app.get("/organizations/:orgId/search", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const result = await searchPlatformProjectsAndContacts(orgId, {
      query: cleanText(query.q || query.query || query.search),
      types: cleanText(query.types || query.type),
      limit: query.limit
    });
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/projects/:projectId/documents", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: collectionReadPermission("projects") });
    await assertPortalPlatformFlag(orgId, "project_docs", "Project Docs is not enabled for this organization.");
    const project = await readDocument(orgId, "projects", getParam(request.params, "projectId"));
    return {
      ok: true,
      ...(await projectDocumentsPayload(orgId, project))
    };
  });

  app.post("/organizations/:orgId/projects/:projectId/documents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    await assertPortalPlatformFlag(orgId, "project_docs", "Project Docs is not enabled for this organization.");
    const project = await readDocument(orgId, "projects", projectId);
    const upload = await parseMediaUploadRequest(request);
    const bodyMeta = asObject(upload.metadata);
    const media = await storeMediaUpload(orgId, {
      ...upload,
      ownerType: "project",
      ownerId: projectId,
      slot: "documents",
      collection: "projects",
      scope: "documents",
      replaceSlot: false,
      thumbnails: upload.thumbnails ?? false,
      compression: upload.compression ?? false,
      metadata: {
        ...bodyMeta,
        field: "documents",
        document_collection: "projects",
        document_id: projectId,
        source: cleanText(bodyMeta.source) || "project_document_upload",
        uploaded_by_user_id: cleanText(ctx.userId),
        uploaded_by_email: cleanText(asObject(ctx.identity).email),
        uploaded_at: new Date().toISOString()
      }
    });
    const data = asObject(project.data);
    const nextDocument = normalizeProjectDocumentReference(documentReferenceFromMedia(media, {
      title: cleanText(bodyMeta.title || bodyMeta.label) || cleanText(media.file_name) || "Document",
      document_type: cleanText(bodyMeta.document_type || bodyMeta.type || "document") || "document",
      source: cleanText(bodyMeta.source || "project_document_upload") || "project_document_upload"
    }));
    const current = normalizeProjectUploadedDocuments(data.documents);
    const saved = await upsertDocument(orgId, "projects", {
      id: projectId,
      data: {
        ...data,
        documents: [...current.filter((item) => projectDocumentIdentity(item) !== projectDocumentIdentity(nextDocument)), nextDocument],
        updated_at: new Date().toISOString()
      },
      metadata: { source: "project_documents_upload" }
    }, { replace: true });
    reply.code(201);
    return {
      ok: true,
      document: nextDocument,
      media,
      ...(await projectDocumentsPayload(orgId, saved))
    };
  });

  app.patch("/organizations/:orgId/projects/:projectId/documents/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    await assertPortalPlatformFlag(orgId, "project_docs", "Project Docs is not enabled for this organization.");
    const project = await readDocument(orgId, "projects", projectId);
    const body = objectBodySchema.parse(request.body ?? {});
    const data = asObject(project.data);
    const documentId = getParam(request.params, "documentId");
    const updated = normalizeProjectUploadedDocuments(data.documents).map((item) => {
      if (projectDocumentIdentity(item) !== documentId && cleanText(item.media_id) !== documentId) return item;
      return normalizeProjectDocumentReference({
        ...item,
        title: cleanText(body.title) || cleanText(body.label) || item.title,
        label: cleanText(body.label) || cleanText(body.title) || item.label,
        document_type: cleanText(body.document_type || body.type) || item.document_type,
        required: body.required === undefined ? item.required : Boolean(body.required),
        metadata: { ...asObject(item.metadata), ...asObject(body.metadata) }
      });
    });
    const saved = await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...data, documents: updated, updated_at: new Date().toISOString() },
      metadata: { source: "project_documents_patch" }
    }, { replace: true });
    return { ok: true, ...(await projectDocumentsPayload(orgId, saved)) };
  });

  app.delete("/organizations/:orgId/projects/:projectId/documents/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const projectId = getParam(request.params, "projectId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission("projects") });
    await assertPortalPlatformFlag(orgId, "project_docs", "Project Docs is not enabled for this organization.");
    const project = await readDocument(orgId, "projects", projectId);
    const data = asObject(project.data);
    const documentId = getParam(request.params, "documentId");
    const documents = normalizeProjectUploadedDocuments(data.documents)
      .filter((item) => projectDocumentIdentity(item) !== documentId && cleanText(item.media_id) !== documentId);
    const saved = await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { ...data, documents, updated_at: new Date().toISOString() },
      metadata: { source: "project_documents_delete" }
    }, { replace: true });
    return { ok: true, ...(await projectDocumentsPayload(orgId, saved)) };
  });

  app.get("/organizations/:orgId/projects/contact-projects", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: collectionReadPermission("projects") });
    const result = await contactProjectSummaries(orgId, asObject(request.query));
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/:collection", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: collectionReadPermission(getParam(request.params, "collection")) });
    return {
      ok: true,
      documents: await listDocuments(orgId, getParam(request.params, "collection"))
    };
  });

  app.post("/organizations/:orgId/:collection", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const collection = getParam(request.params, "collection");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission(collection) });
    const body = objectBodySchema.parse(request.body ?? {});
    const document = collection === "users"
      ? await createPlatformOrgUser(orgId, body)
      : await upsertDocument(
        orgId,
        collection,
        body,
        { replace: true }
      );
    if (platformSearchCollection(collection)) invalidatePlatformSearchCache(orgId);
    const invite = collection === "users" && asObject(body.data && typeof body.data === "object" ? body.data : body).send_invite !== false
      ? await sendPlatformOrgUserInvite(orgId, document, request, "")
      : { ok: false, skipped: true, activate_url: "" };
    reply.code(201);
    return {
      ok: true,
      document,
      ...(collection === "users" ? {
        emailed: invite.ok,
        email_sent: invite.ok,
        activate_url: invite.activate_url || "",
        invite
      } : {})
    };
  });

  app.get("/organizations/:orgId/:collection/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: collectionReadPermission(getParam(request.params, "collection")) });
    return {
      ok: true,
      document: await readDocument(
        orgId,
        getParam(request.params, "collection"),
        getParam(request.params, "documentId")
      )
    };
  });

  app.put("/organizations/:orgId/:collection/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const collection = getParam(request.params, "collection");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission(collection) });
    const body = objectBodySchema.parse(request.body ?? {});
    const documentId = getParam(request.params, "documentId");
    const document = collection === "users"
      ? await upsertPlatformOrgUserDocument(orgId, documentId, body, true)
      : await upsertDocument(
        orgId,
        collection,
        { ...body, id: documentId },
        { replace: true }
      );
    if (platformSearchCollection(collection)) invalidatePlatformSearchCache(orgId);
    return { ok: true, document };
  });

  app.patch("/organizations/:orgId/:collection/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const collection = getParam(request.params, "collection");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission(collection) });
    const body = objectBodySchema.parse(request.body ?? {});
    const documentId = getParam(request.params, "documentId");
    const document = collection === "users"
      ? await upsertPlatformOrgUserDocument(orgId, documentId, body, false)
      : await upsertDocument(
        orgId,
        collection,
        { ...body, id: documentId },
        { replace: false }
      );
    if (platformSearchCollection(collection)) invalidatePlatformSearchCache(orgId);
    return { ok: true, document };
  });

  app.delete("/organizations/:orgId/:collection/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const collection = getParam(request.params, "collection");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: collectionWritePermission(collection) });
    const deleted = await deleteDocument(
      orgId,
      collection,
      getParam(request.params, "documentId")
    );
    if (platformSearchCollection(collection)) invalidatePlatformSearchCache(orgId);
    return {
      ok: true,
      deleted
    };
  });

  await app.register(registerPricebookApi, { prefix: "/pricebook" });
  startPlatformHeartbeat(app);
};

function defaultStagesData() {
  return {
    schema_version: 1,
    order: [APPOINTMENT_SCHEDULED_STAGE_ID, NEWLY_SOLD_STAGE_ID, PROJECT_STARTED_STAGE_ID, IN_PROGRESS_STAGE_ID, COMPLETED_STAGE_ID],
    stages: {
      [NEW_LEAD_STAGE_ID]: { id: NEW_LEAD_STAGE_ID, status: "active", color: "#0f766e" },
      [DEFAULT_STAGE_ID]: { id: DEFAULT_STAGE_ID, status: "active", color: "#64748b" },
      [APPOINTMENT_SCHEDULED_STAGE_ID]: { id: APPOINTMENT_SCHEDULED_STAGE_ID, status: "active", color: "#2563eb" },
      [NEWLY_SOLD_STAGE_ID]: { id: NEWLY_SOLD_STAGE_ID, status: "active", color: "#16a34a", locked: true },
      [PROJECT_STARTED_STAGE_ID]: { id: PROJECT_STARTED_STAGE_ID, status: "active", color: "#0ea5e9" },
      [IN_PROGRESS_STAGE_ID]: { id: IN_PROGRESS_STAGE_ID, status: "active", color: "#f59e0b" },
      [COMPLETED_STAGE_ID]: { id: COMPLETED_STAGE_ID, status: "active", color: "#15803d" },
      lost: { id: "lost", status: "active", color: "#b42318" }
    }
  };
}

function normalizeDefaultStageOrder(existingStageOrder: string[]) {
  const nextDefault = defaultStagesData().order;
  const legacyDefaults = [
    [NEW_LEAD_STAGE_ID, DEFAULT_STAGE_ID, APPOINTMENT_SCHEDULED_STAGE_ID, NEWLY_SOLD_STAGE_ID, "lost"],
    [DEFAULT_STAGE_ID, APPOINTMENT_SCHEDULED_STAGE_ID, NEWLY_SOLD_STAGE_ID, "lost"]
  ];
  if (!existingStageOrder.length) return nextDefault;
  if (legacyDefaults.some((order) => order.length === existingStageOrder.length && order.every((stage, index) => stage === existingStageOrder[index]))) {
    return nextDefault;
  }
  return [...existingStageOrder, ...nextDefault.filter((stage) => !existingStageOrder.includes(stage))];
}

function defaultVariableMappingsData(existing: Record<string, unknown> = {}) {
  const labels = asObject(existing.labels);
  return {
    schema_version: 1,
    ...existing,
    labels: {
      ...labels,
      event_types: {
        sales_appointment: "Sales Appointment",
        [PROJECT_WORK_EVENT_TYPE_ID]: "Project Work",
        ...asObject(labels.event_types)
      },
      stages: {
        new_lead: "New Lead",
        contacting: "Contacting",
        appointment_scheduled: "Appointment Scheduled",
        newly_sold: "Newly Sold",
        project_started: "Project Started",
        in_progress: "In Progress",
        completed: "Completed",
        lost: "Lost",
        ...asObject(labels.stages)
      }
    }
  };
}

function defaultTriggersData(existing: Record<string, unknown> = {}) {
  const existingTriggers = Array.isArray(existing.triggers) ? existing.triggers : [];
  const defaultTrigger = {
    id: "sales_appointment_scheduled_advances_contacting",
    enabled: true,
    event: "project.event_scheduled",
    action: "project.stage.set",
    conditions: {
      event_type_default_id: "sales_appointment",
      project_stage: DEFAULT_STAGE_ID
    },
    params: {
      stage: APPOINTMENT_SCHEDULED_STAGE_ID
    }
  };
  const completedAppointmentTrigger = {
    id: "sales_appointment_completed_needs_followup",
    enabled: true,
    event: "project.event.completed",
    action: "notification.create",
    conditions: {
      event_type_default_id: "sales_appointment"
    },
    params: {
      id: "notification_appointment_completed_{{project.id}}_{{event.id}}",
      title: "Appointment completed",
      body: "How did the appointment go for {{project.address}}?",
      source: "heartbeat.appointment_completed",
      manual_dismissible: true,
      push: false,
      passive: true,
      target_user_ids_from: "event.assigned_user_ids",
      target_role_ids: ["sales_appointments"]
    }
  };
  const newlySoldCelebrationTrigger = {
    id: "newly_sold_large_celebration",
    enabled: true,
    event: `project.stage.entered.${NEWLY_SOLD_STAGE_ID}`,
    action: "notification.create",
    params: {
      id: "celebration_newly_sold_{{project.id}}_{{project.stage_updated_at}}",
      title: "Project sold",
      body: "{{project.title}} was just sold.",
      source: "trigger.newly_sold",
      kind: "celebration",
      channel: "celebration",
      manual_dismissible: false,
      push: false,
      passive: true,
      celebration: {
        size: "large",
        reason: "newly_sold",
        text: "{{project.title}} was just sold."
      },
      context: {
        celebration: {
          size: "large",
          reason: "newly_sold",
          text: "{{project.title}} was just sold."
        }
      }
    }
  };
  const newlySoldSchedulingActionItemTrigger = {
    id: "newly_sold_needs_scheduling_action_item",
    enabled: true,
    event: `project.stage.entered.${NEWLY_SOLD_STAGE_ID}`,
    action: "action_item.create",
    params: {
      id: "action_item_schedule_sold_project_{{project_id}}",
      kind: "schedule_sold_project",
      title: "Schedule sold project",
      body: "Schedule {{project.title}}.",
      source: "trigger.newly_sold",
      assigned_role_ids: ["sales_appointments"],
      project_ids_from: "project_id",
      frontend_action: {
        kind: "open_project_scheduling",
        project_id_from: "project_id",
        tab: "scheduling"
      },
      completion_events: [
        {
          event: "project.event_scheduled",
          conditions: {
            project_id_from: "project_id",
            event_type_default_id: PROJECT_WORK_EVENT_TYPE_ID
          }
        }
      ]
    }
  };
  const defaults = [defaultTrigger, completedAppointmentTrigger, newlySoldCelebrationTrigger, newlySoldSchedulingActionItemTrigger];
  const existingIds = new Set(existingTriggers.map((trigger) => String(asObject(trigger).id || "")));
  return {
    schema_version: 1,
    ...existing,
    triggers: [...existingTriggers, ...defaults.filter((trigger) => !existingIds.has(trigger.id))]
  };
}

async function readBranchModuleDataOrNull(orgId: string, branchId: string, moduleId: string) {
  try {
    const module = await readBranchModule(orgId, branchId, moduleId);
    return asObject(module.data);
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 404) return null;
    return null;
  }
}

async function ensureWorkflowModules(orgId: string, branchId: string) {
  const [stagesRaw, mappingsRaw, triggersRaw] = await Promise.all([
    readBranchModuleDataOrNull(orgId, branchId, PLATFORM_STAGE_MODULE_ID),
    readBranchModuleDataOrNull(orgId, branchId, PLATFORM_VARIABLE_MAPPING_MODULE_ID),
    readBranchModuleDataOrNull(orgId, branchId, PLATFORM_TRIGGER_MODULE_ID)
  ]);
  const stages: Record<string, unknown> = { ...defaultStagesData(), ...asObject(stagesRaw) };
  stages.stages = { ...asObject(defaultStagesData().stages), ...asObject(asObject(stagesRaw).stages) };
  const existingStageOrder = Array.isArray(stages.order) ? stages.order.map((stage) => String(stage || "").trim()).filter(Boolean) : [];
  stages.order = normalizeDefaultStageOrder(existingStageOrder);
  const mappings = defaultVariableMappingsData(asObject(mappingsRaw));
  const triggers = defaultTriggersData(asObject(triggersRaw));

  if (JSON.stringify(stagesRaw || {}) !== JSON.stringify(stages)) {
    await saveBranchModule(orgId, branchId, PLATFORM_STAGE_MODULE_ID, { data: stages, metadata: { kind: "branch_stages" } }, { replace: true });
  }
  if (JSON.stringify(mappingsRaw || {}) !== JSON.stringify(mappings)) {
    await saveBranchModule(orgId, branchId, PLATFORM_VARIABLE_MAPPING_MODULE_ID, { data: mappings, metadata: { kind: "branch_variable_mappings" } }, { replace: true });
  }
  if (JSON.stringify(triggersRaw || {}) !== JSON.stringify(triggers)) {
    await saveBranchModule(orgId, branchId, PLATFORM_TRIGGER_MODULE_ID, { data: triggers, metadata: { kind: "branch_triggers" } }, { replace: true });
  }
  return { stages, mappings, triggers };
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function truthy(value: unknown) {
  return /^(1|true|yes|on)$/i.test(cleanText(value));
}

function isLocalPortalRequest(request?: FastifyRequest) {
  const candidates = [
    cleanText(request?.hostname),
    cleanText(request?.headers?.host),
    cleanText(request?.headers?.origin),
    cleanText(request?.headers?.referer)
  ].join(" ").toLowerCase();
  return candidates.includes("127.0.0.1")
    || candidates.includes("localhost")
    || candidates.includes("[::1]")
    || candidates.includes("::1");
}

function normalizeLeadContacts(input: unknown) {
  return (Array.isArray(input) ? input : []).map((entry) => {
    const contact = asObject(entry);
    const phones = normalizeStringArray(contact.phones || (contact.phone ? [contact.phone] : []));
    return {
      name: cleanText(contact.name),
      email: cleanText(contact.email).toLowerCase(),
      phone: cleanText(contact.phone || phones[0] || ""),
      phones,
      role: cleanText(contact.role || "primary")
    };
  }).filter((contact) => contact.name || contact.email || contact.phone || contact.phones.length);
}

function defaultLeadNotificationRoles(sourceKind: string) {
  if (sourceKind === "canvassing") return ["inside_sales", "sales_appointments"];
  return ["inside_sales", "sales_appointments"];
}

export async function createPlatformLead(orgId: string, input: PlatformLeadInput = {}) {
  const branchId = cleanText(input.branch_id || input.branchId || "default") || "default";
  await ensureWorkflowModules(orgId, branchId);
  const now = new Date().toISOString();
  const leadSource = asObject(input.lead_source);
  const sourceKind = cleanText(input.source_kind || leadSource.kind || input.source || "manual_lead") || "manual_lead";
  const address = cleanText(input.address);
  const contacts = normalizeLeadContacts(input.contacts);
  const customerInput = asObject(input.customer);
  if (!contacts.length && (customerInput.name || customerInput.email || customerInput.phone || customerInput.phones)) {
    contacts.push(...normalizeLeadContacts([customerInput]));
  }
  if (!address && !contacts.length && !cleanText(input.summary || input.title)) {
    throw badRequest("lead_missing_contact_data", "A lead needs at least an address, contact, title, or summary.");
  }

  const stageId = cleanText(input.stage_id || input.stage || NEW_LEAD_STAGE_ID) || NEW_LEAD_STAGE_ID;
  const projectId = cleanText(input.project_id || input.id);
  const projectData = asObject(input.project_data);
  delete projectData.customers;
  delete projectData.customer_ids;
  delete projectData.primary_customer_id;
  delete projectData.customer_id;
  const project = await upsertDocument(orgId, "projects", {
    ...(projectId ? { id: projectId } : {}),
    data: {
      branch_id: branchId,
      stage: stageId,
      stage_id: stageId,
      lead_status: cleanText(input.lead_status || "new") || "new",
      project_type: cleanText(input.project_type || "lead") || "lead",
      address,
      title: cleanText(input.title || address || input.summary || "New lead"),
      summary: cleanText(input.summary),
      contacts,
      events: Array.isArray(input.events) ? input.events : [],
      source: sourceKind,
      lead_source: {
        kind: sourceKind,
        provider: cleanText(input.provider || leadSource.provider),
        confidence: Number(input.confidence ?? leadSource.confidence ?? 0),
        provider_fields: asObject(input.provider_fields || leadSource.provider_fields),
        raw: asObject(input.raw || leadSource.raw),
        ...leadSource
      },
      stage_history: Array.isArray(input.stage_history) ? input.stage_history : [],
      created_at: cleanText(input.created_at) || now,
      updated_at: now,
      ...projectData
    },
    metadata: {
      kind: "platform_project",
      source: sourceKind,
      branch_id: branchId,
      ...asObject(input.metadata)
    }
  });

  let notification = null;
  const rawNotification = input.notification as unknown;
  const notificationInput = asObject(rawNotification);
  if (rawNotification !== false) {
    const primaryContact = asObject(contacts[0]);
    const leadBody = cleanText(notificationInput.body)
      || [
        address,
        cleanText(primaryContact.name),
        cleanText(primaryContact.phone || (Array.isArray(primaryContact.phones) ? primaryContact.phones[0] : "")),
        cleanText(primaryContact.email)
      ].filter(Boolean).join(" · ")
      || cleanText(input.summary || input.title)
      || "A new lead came in.";
    notification = await createPlatformNotification(orgId, {
      id: cleanText(notificationInput.id) || `notification_new_lead_${project.id}`,
      title: cleanText(notificationInput.title || "Contact new lead"),
      body: leadBody,
      status: "active",
      channel: "passive",
      kind: "passive",
      push: notificationInput.push === true,
      passive: notificationInput.passive !== false,
      manual_dismissible: notificationInput.manual_dismissible === true,
      target_user_ids: normalizeStringArray(notificationInput.target_user_ids),
      target_role_ids: normalizeStringArray(notificationInput.target_role_ids).length
        ? normalizeStringArray(notificationInput.target_role_ids)
        : defaultLeadNotificationRoles(sourceKind),
      branch_id: branchId,
      expires_at: cleanText(notificationInput.expires_at),
      source: cleanText(notificationInput.source || `${sourceKind}_lead_import`),
      context: {
        project_id: project.id,
        branch_id: branchId,
        lead_source: sourceKind,
        action: "contact_lead",
        ...asObject(notificationInput.context)
      }
    });
  }

  invalidatePlatformSearchCache(orgId);
  return { project, contacts, notification };
}

function platformSearchCollection(collection: string) {
  return collection === "projects" || collection === "customers";
}

function invalidatePlatformSearchCache(orgId: string) {
  const key = cleanText(orgId);
  platformSearchCache.delete(key);
  contactProjectSummaryCache.delete(key);
}

function queryStringList(...values: unknown[]) {
  return Array.from(new Set(values.flatMap((value) => {
    if (Array.isArray(value)) return value.flatMap((entry) => cleanText(entry).split(","));
    return cleanText(value).split(",");
  }).map((value) => cleanText(value)).filter(Boolean)));
}

function isGeneratedProjectTitle(value: unknown) {
  const text = cleanText(value).toLowerCase();
  return !text
    || text === "project"
    || text === "new project"
    || /^\d+$/.test(text)
    || /^(project|base|platform_project)_[a-z0-9_-]+$/i.test(text);
}

function firstProjectDisplayText(...values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (text && !isGeneratedProjectTitle(text)) return text;
  }
  return "";
}

function projectContactIdentity(contact: JsonObject) {
  const email = cleanText(contact.email).toLowerCase();
  if (email) return `email:${email}`;
  const phone = phoneDigits(contact.phone);
  if (phone.length >= 7) return `phone:${phone}`;
  const id = cleanText(contact.id || contact.contact_id);
  if (id) return `id:${id}`;
  const name = cleanText(contact.name).toLowerCase();
  return name ? `name:${name}` : "";
}

function dedupeProjectContacts(contacts: JsonObject[]) {
  const byKey = new Map<string, JsonObject>();
  const order: string[] = [];
  for (const contact of contacts) {
    const key = projectContactIdentity(contact);
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, contact);
      order.push(key);
      continue;
    }
    byKey.set(key, compactObject({
      id: cleanText(existing.id || contact.id),
      contact_id: cleanText(existing.contact_id || existing.id || contact.contact_id || contact.id),
      name: cleanText(existing.name || contact.name),
      email: cleanText(existing.email || contact.email).toLowerCase(),
      phone: cleanText(existing.phone || contact.phone),
      address: cleanText(existing.address || contact.address),
      default_address: cleanText(existing.default_address || contact.default_address || existing.address || contact.address),
      role: cleanText(existing.role || contact.role),
      primary: existing.primary === true || contact.primary === true
    }));
  }
  return order.map((key) => byKey.get(key)).filter((contact): contact is JsonObject => !!contact);
}

function summarizedProjectContacts(value: unknown) {
  return Array.isArray(value)
    ? dedupeProjectContacts(value.map((entry) => {
      const contact = asObject(entry);
      return compactObject({
        id: cleanText(contact.id),
        contact_id: cleanText(contact.contact_id || contact.id),
        name: cleanText(contact.name || contact.full_name || contact.display_name),
        email: cleanText(contact.email || contact.email_address).toLowerCase(),
        phone: cleanText(contact.phone || contact.phone_number || (Array.isArray(contact.phones) ? contact.phones[0] : "")),
        address: cleanText(contact.address || contact.default_address),
        default_address: cleanText(contact.default_address || contact.address),
        role: cleanText(contact.role),
        primary: contact.primary === true
      });
    }).filter((contact) => cleanText(contact.id || contact.contact_id || contact.name || contact.email || contact.phone)))
    : [];
}

function projectDisplayTitle(project: JsonObject, fallback = "New Project") {
  const contacts = summarizedProjectContacts(project.contacts);
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary") || contacts[0] || {};
  return firstProjectDisplayText(
    project.title,
    project.project_title,
    project.project_name,
    project.projectName,
    project.name,
    project.address,
    project.project_address,
    project.property_address,
    project.customer_name,
    project.customerName,
    project.primary_contact_name,
    primary.name,
    project.resident_name,
    project.residentName,
    typeof project.resident === "string" ? project.resident : ""
  ) || fallback;
}

function summarizedMeasurementProject(value: unknown) {
  const measurement = asObject(value);
  const raw = asObject(measurement.raw);
  const manifest = asObject(measurement.manifest || raw.manifest);
  const pins = normalizeReportRequestPins(measurement.pins || manifest.pins || raw.pins);
  return compactObject({
    id: cleanText(measurement.id || measurement.project_id || measurement.folder),
    project_id: cleanText(measurement.project_id || measurement.id || measurement.folder),
    folder: cleanText(measurement.folder || measurement.project_id || measurement.id),
    status: cleanText(measurement.status),
    report_mode: cleanText(measurement.report_mode),
    pins,
    submitted_at: cleanText(measurement.submitted_at || measurement.created_at),
    completed_at: cleanText(measurement.completed_at),
    report_due_window_label: cleanText(measurement.report_due_window_label)
  });
}
function summarizedProjectDocument(document: JsonObject) {
  const data = asObject(document.data);
  const id = cleanText(document.id || data.id || data.platform_project_id || data.base_project_id);
  const measurement = summarizedMeasurementProject(data.measurement_project || data.measurement);
  const pins = normalizeReportRequestPins(data.pins || measurement.pins);
  const title = projectDisplayTitle(data, "New Project");
  return {
    ...compactObject({
      id,
      platform_project_id: cleanText(data.platform_project_id || id),
      base_project_id: cleanText(data.base_project_id || id),
      title,
      project_title: title,
      project_name: cleanText(data.project_name),
      projectName: cleanText(data.projectName),
      name: cleanText(data.name),
      address: cleanText(data.address || data.project_address || data.property_address),
      project_address: cleanText(data.project_address),
      property_address: cleanText(data.property_address),
      project_type: cleanText(data.project_type),
      stage: cleanText(data.stage || data.stage_id),
      stage_id: cleanText(data.stage_id || data.stage),
      stage_label: cleanText(data.stage_label),
      project_stage: cleanText(data.project_stage),
      project_stage_id: cleanText(data.project_stage_id),
      status: cleanText(data.status),
      workflow_state: cleanText(data.workflow_state),
      contact_id: cleanText(data.contact_id || data.primary_contact_id),
      primary_contact_id: cleanText(data.primary_contact_id || data.contact_id),
      customer_name: cleanText(data.customer_name || data.customerName || data.primary_contact_name),
      customerName: cleanText(data.customerName || data.customer_name),
      primary_contact_name: cleanText(data.primary_contact_name || data.customer_name || data.customerName),
      customer_email: cleanText(data.customer_email || data.primary_contact_email),
      primary_contact_email: cleanText(data.primary_contact_email || data.customer_email),
      customer_phone: cleanText(data.customer_phone || data.primary_contact_phone),
      primary_contact_phone: cleanText(data.primary_contact_phone || data.customer_phone),
      contact_address: cleanText(data.contact_address || data.customer_address || data.primary_contact_address),
      customer_address: cleanText(data.customer_address || data.contact_address || data.primary_contact_address),
      primary_contact_address: cleanText(data.primary_contact_address || data.contact_address || data.customer_address),
      created_at: cleanText(data.created_at || document.created_at),
      updated_at: cleanText(data.updated_at || document.updated_at),
      completed_at: cleanText(data.completed_at),
      appointment_at: cleanText(data.appointment_at),
      scheduled_at: cleanText(data.scheduled_at),
      thumbnail: cleanText(data.thumbnail),
      thumbnail_source: cleanText(data.thumbnail_source || data.thumbnail_artifact_name),
      thumbnail_artifact_name: cleanText(data.thumbnail_artifact_name || data.thumbnail_source)
    }),
    ...(pins.length ? { pins } : {}),
    contacts: summarizedProjectContacts(data.contacts),
    contact_ids: queryStringList(data.contact_id, data.primary_contact_id, data.contact_ids),
    thumbnail_candidates: Array.isArray(data.thumbnail_candidates) ? data.thumbnail_candidates.map(cleanText).filter(Boolean).slice(0, 4) : [],
    ...(Object.keys(measurement).length ? { measurement_project: measurement, measurement } : {}),
    _summary: true
  };
}

function projectContactRefs(project: JsonObject) {
  const customer = asObject(project.customer);
  const resident = typeof project.resident === "object" && project.resident && !Array.isArray(project.resident) ? asObject(project.resident) : {};
  const alias = {
    id: cleanText(project.contact_id || project.primary_contact_id || customer.id || customer.contact_id || resident.id || resident.contact_id),
    contact_id: cleanText(project.contact_id || project.primary_contact_id || customer.id || customer.contact_id || resident.id || resident.contact_id),
    name: firstSearchText(project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === "string" ? project.resident : "", customer.name, resident.name),
    email: firstSearchText(project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail, customer.email, resident.email).toLowerCase(),
    phone: firstSearchText(project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone, customer.phone, resident.phone),
    address: firstSearchText(project.contact_address, project.customer_address, project.primary_contact_address, customer.address, resident.address)
  };
  return summarizedProjectContacts([
    ...summarizedProjectContacts(project.contacts),
    compactObject(alias)
  ]);
}

function projectMatchesContactSummaryRequest(document: JsonObject, query: JsonObject) {
  const data = asObject(document.data);
  const projectId = cleanText(document.id || data.id || data.platform_project_id || data.base_project_id);
  const projectIds = new Set(queryStringList(query.project_id, query.primary_project_id, query.project_ids));
  if (projectId && projectIds.has(projectId)) return true;

  const contactId = cleanText(query.contact_id || query.contactId || query.id);
  const email = cleanText(query.email).toLowerCase();
  const phone = phoneDigits(query.phone);
  const name = normalizeSearchText(query.name);
  const projectContactIds = new Set(queryStringList(data.contact_id, data.primary_contact_id, data.contact_ids));
  if (contactId && projectContactIds.has(contactId)) return true;

  return projectContactRefs(data).some((contact) => {
    const ids = queryStringList(contact.id, contact.contact_id);
    if (contactId && ids.includes(contactId)) return true;
    if (email && cleanText(contact.email).toLowerCase() === email) return true;
    const contactPhone = phoneDigits(contact.phone);
    if (phone.length >= 7 && contactPhone && contactPhone === phone) return true;
    return !!(name && normalizeSearchText(contact.name) === name);
  });
}

async function contactProjectSummaries(orgId: string, query: JsonObject) {
  const requestedIds = queryStringList(query.project_id, query.primary_project_id, query.project_ids);
  const byId = new Map<string, JsonObject>();
  const readSummariesById = async (ids: string[]) => {
    await Promise.all(Array.from(new Set(ids)).map(async (id) => {
      const document = await readDocument(orgId, "projects", id).catch(() => null);
      if (document) {
        byId.set(cleanText(document.id || id), {
          ...document,
          data: summarizedProjectDocument(document)
        });
      }
    }));
  };
  await readSummariesById(requestedIds);

  const hasContactNeedle = !!cleanText(query.contact_id || query.contactId || query.id || query.email || query.phone || query.name);
  let matchedFromSearchCache = false;
  if (hasContactNeedle) {
    const cachedIds = cachedContactProjectIdsFromSearch(orgId, query);
    if (cachedIds.length) {
      matchedFromSearchCache = true;
      await readSummariesById(cachedIds);
    }
  }

  if ((!requestedIds.length || hasContactNeedle) && !matchedFromSearchCache) {
    const docs = await cachedContactProjectSummaryDocuments(orgId).catch(() => []);
    docs.forEach((document) => {
      if (!projectMatchesContactSummaryRequest(document, query)) return;
      const id = cleanText(document.id || asObject(document.data).id);
      if (id) byId.set(id, document);
    });
  }

  const documents = Array.from(byId.values())
    .sort((a, b) => cleanText(b.updated_at || asObject(b.data).updated_at).localeCompare(cleanText(a.updated_at || asObject(a.data).updated_at)))
    .map((document) => asObject(document.data)._summary ? document : ({
      ...document,
      data: summarizedProjectDocument(document)
    }));
  return {
    count: documents.length,
    documents,
    projects: documents.map((document) => document.data)
  };
}

function cachedContactProjectIdsFromSearch(orgId: string, query: JsonObject) {
  const key = cleanText(orgId);
  const cached = platformSearchCache.get(key);
  if (!cached || Date.now() - cached.builtAt >= PLATFORM_SEARCH_CACHE_TTL_MS) return [];
  const contactId = cleanText(query.contact_id || query.contactId || query.id);
  const email = cleanText(query.email).toLowerCase();
  const phone = phoneDigits(query.phone);
  const name = normalizeSearchText(query.name);
  return Array.from(new Set(cached.rows.filter((row) => {
    if (row.type !== "contact" || !row.project_id) return false;
    const contact = asObject(row.contact);
    if (contactId && queryStringList(row.id, contact.id, contact.contact_id).includes(contactId)) return true;
    if (email && cleanText(contact.email).toLowerCase() === email) return true;
    const contactPhone = phoneDigits(contact.phone);
    if (phone.length >= 7 && contactPhone && contactPhone === phone) return true;
    return !!(name && normalizeSearchText(contact.name || row.title) === name);
  }).map((row) => row.project_id).filter(Boolean)));
}

async function cachedContactProjectSummaryDocuments(orgId: string) {
  const key = cleanText(orgId);
  const cached = contactProjectSummaryCache.get(key);
  if (cached && Date.now() - cached.builtAt < PLATFORM_CONTACT_PROJECT_CACHE_TTL_MS) return cached.documents;
  const documents = (await listDocuments(key, "projects").catch(() => []))
    .map((document) => ({
      ...document,
      data: summarizedProjectDocument(document)
    }));
  contactProjectSummaryCache.set(key, { builtAt: Date.now(), documents });
  return documents;
}

function firstSearchText(...values: unknown[]) {
  for (const value of values) {
    if (value && typeof value === "object") continue;
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function normalizeSearchText(value: unknown) {
  return cleanText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.+#_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(value: unknown) {
  return normalizeSearchText(value).replace(/[^a-z0-9]+/g, "");
}

function phoneDigits(value: unknown) {
  return cleanText(value).replace(/\D+/g, "");
}

function searchTokens(value: unknown) {
  return Array.from(new Set(normalizeSearchText(value).split(" ").map((part) => part.trim()).filter(Boolean)));
}

function projectSearchTitle(project: JsonObject) {
  return projectDisplayTitle(project, "Project");
}

function projectSearchSubtitle(project: JsonObject) {
  return firstSearchText(project.address, project.project_address, project.property_address, project.project_type, project.stage, project.status);
}

function projectContactNeedles(project: JsonObject) {
  const resident = typeof project.resident === "string" ? project.resident : "";
  const contacts = Array.isArray(project.contacts) ? project.contacts.map((entry) => asObject(entry)) : [];
  return [
    project.customer_name,
    project.customerName,
    project.primary_contact_name,
    project.customer_email,
    project.primary_contact_email,
    project.customer_phone,
    project.primary_contact_phone,
    project.resident_name,
    project.residentName,
    project.resident_email,
    project.residentEmail,
    project.resident_phone,
    project.residentPhone,
    resident,
    ...contacts.flatMap((contact) => [contact.name, contact.email, contact.phone])
  ];
}

function projectSearchFields(projectId: string, project: JsonObject) {
  return [
    projectId,
    project.id,
    project.platform_project_id,
    project.base_project_id,
    project.address,
    project.project_address,
    project.property_address,
    project.title,
    project.project_title,
    project.project_name,
    project.projectName,
    project.name,
    project.project_type,
    project.stage,
    project.stage_id,
    project.status,
    project.workflow_state,
    ...projectContactNeedles(project)
  ];
}

function makeSearchRow(input: {
  type: PlatformSearchType;
  id: string;
  projectId?: string;
  title: string;
  subtitle?: string;
  updatedAt?: string;
  fields: unknown[];
  contact?: JsonObject;
}) {
  const fieldText = input.fields.map((value) => cleanText(value)).filter(Boolean).join(" ");
  const searchText = normalizeSearchText([input.title, input.subtitle, fieldText].filter(Boolean).join(" "));
  return {
    type: input.type,
    id: input.id,
    project_id: cleanText(input.projectId),
    title: cleanText(input.title) || (input.type === "contact" ? "Contact" : "Project"),
    subtitle: cleanText(input.subtitle),
    search_text: searchText,
    compact_text: compactSearchText(searchText),
    phone_digits: phoneDigits(fieldText),
    tokens: searchTokens(searchText),
    updated_at: cleanText(input.updatedAt),
    ...(input.contact ? { contact: input.contact } : {})
  } satisfies PlatformSearchIndexRow;
}

function contactSearchSubtitle(contact: JsonObject, project: JsonObject = {}) {
  return [
    firstSearchText(contact.email, contact.phone),
    firstSearchText(project.address, project.project_address, project.property_address)
  ].filter(Boolean).join(" - ");
}

function addProjectContactRows(rows: PlatformSearchIndexRow[], seenContacts: Set<string>, projectId: string, project: JsonObject, updatedAt: string) {
  const contacts = Array.isArray(project.contacts) ? project.contacts.map((entry) => asObject(entry)) : [];
  const aliases = [{
    name: firstSearchText(project.customer_name, project.customerName, project.primary_contact_name, project.resident_name, project.residentName, typeof project.resident === "string" ? project.resident : ""),
    email: firstSearchText(project.customer_email, project.primary_contact_email, project.resident_email, project.residentEmail),
    phone: firstSearchText(project.customer_phone, project.primary_contact_phone, project.resident_phone, project.residentPhone),
    role: "primary"
  }];
  [...contacts, ...aliases].forEach((rawContact, index) => {
    const contact = asObject(rawContact);
    const name = firstSearchText(contact.name);
    const email = firstSearchText(contact.email).toLowerCase();
    const phone = firstSearchText(contact.phone);
    if (!name && !email && !phone) return;
    const identity = [
      projectId,
      email,
      phoneDigits(phone),
      normalizeSearchText(name)
    ].filter(Boolean).join("|");
    if (seenContacts.has(identity)) return;
    seenContacts.add(identity);
    rows.push(makeSearchRow({
      type: "contact",
      id: `${projectId}:contact:${index}`,
      projectId,
      title: firstSearchText(name, email, phone, "Contact"),
      subtitle: contactSearchSubtitle(contact, project),
      updatedAt,
      contact: { ...contact, name, email, phone, project_id: projectId },
      fields: [
        name,
        email,
        phone,
        projectId,
        contact.role,
        project.title,
        project.project_title,
        project.project_name,
        project.address,
        project.project_address,
        project.property_address
      ]
    }));
  });
}

function addCustomerContactRows(rows: PlatformSearchIndexRow[], seenContacts: Set<string>, customerDocs: JsonObject[]) {
  customerDocs.forEach((doc) => {
    const customer = asObject(doc.data);
    const id = cleanText(doc.id || customer.id);
    const projectIds = [
      firstSearchText(customer.primary_project_id, customer.project_id),
      ...(Array.isArray(customer.project_ids) ? customer.project_ids.map((value) => cleanText(value)) : [])
    ].filter(Boolean);
    const projectId = projectIds[0] || "";
    const name = firstSearchText(customer.name);
    const email = firstSearchText(customer.email).toLowerCase();
    const phone = firstSearchText(customer.phone);
    if (!name && !email && !phone) return;
    const identity = [
      projectId || `customer:${id}`,
      email,
      phoneDigits(phone),
      normalizeSearchText(name)
    ].filter(Boolean).join("|");
    if (seenContacts.has(identity)) return;
    seenContacts.add(identity);
    rows.push(makeSearchRow({
      type: "contact",
      id: `customer:${id}`,
      projectId,
      title: firstSearchText(name, email, phone, "Contact"),
      subtitle: [firstSearchText(email, phone), firstSearchText(customer.address, customer.default_address)].filter(Boolean).join(" - "),
      updatedAt: cleanText(doc.updated_at || customer.updated_at),
      contact: { ...customer, id, name, email, phone, project_id: projectId, project_ids: projectIds },
      fields: [
        id,
        name,
        email,
        phone,
        customer.address,
        customer.default_address,
        projectIds.join(" ")
      ]
    }));
  });
}

async function buildPlatformSearchIndex(orgId: string) {
  const [projectDocs, customerDocs] = await Promise.all([
    listDocuments(orgId, "projects").catch(() => []),
    listDocuments(orgId, "customers").catch(() => [])
  ]);
  const rows: PlatformSearchIndexRow[] = [];
  const seenContacts = new Set<string>();
  projectDocs.forEach((doc) => {
    const project = asObject(doc.data);
    const projectId = cleanText(doc.id || project.id || project.platform_project_id || project.base_project_id);
    if (!projectId) return;
    const updatedAt = cleanText(doc.updated_at || project.updated_at);
    rows.push(makeSearchRow({
      type: "project",
      id: projectId,
      projectId,
      title: projectSearchTitle(project),
      subtitle: projectSearchSubtitle(project),
      updatedAt,
      fields: projectSearchFields(projectId, project)
    }));
    addProjectContactRows(rows, seenContacts, projectId, project, updatedAt);
  });
  addCustomerContactRows(rows, seenContacts, customerDocs);
  return rows;
}

async function platformSearchRows(orgId: string) {
  const key = cleanText(orgId);
  const cached = platformSearchCache.get(key);
  if (cached && Date.now() - cached.builtAt < PLATFORM_SEARCH_CACHE_TTL_MS) return cached.rows;
  const rows = await buildPlatformSearchIndex(key);
  platformSearchCache.set(key, { builtAt: Date.now(), rows });
  return rows;
}

function platformSearchTypes(value: string) {
  const requested = new Set(value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean));
  if (!requested.size) return new Set<PlatformSearchType>(["project", "contact"]);
  return new Set<PlatformSearchType>([
    ...(requested.has("project") || requested.has("projects") ? ["project" as const] : []),
    ...(requested.has("contact") || requested.has("contacts") ? ["contact" as const] : [])
  ]);
}

function platformSearchLimit(value: unknown) {
  const limit = Math.floor(Number(value || 40));
  if (!Number.isFinite(limit) || limit <= 0) return 40;
  return Math.min(100, Math.max(1, limit));
}

function rowMatchesSearch(row: PlatformSearchIndexRow, queryText: string, queryTokens: string[], queryCompact: string, queryPhone: string) {
  if (!queryText) return true;
  if (queryPhone.length >= 3 && row.phone_digits.includes(queryPhone)) return true;
  if (row.search_text.includes(queryText) || (queryCompact.length >= 3 && row.compact_text.includes(queryCompact))) return true;
  return queryTokens.length > 0 && queryTokens.every((token) => (
    row.tokens.some((rowToken) => rowToken === token || rowToken.startsWith(token))
    || row.search_text.includes(token)
  ));
}

function rowSearchScore(row: PlatformSearchIndexRow, queryText: string, queryTokens: string[], queryCompact: string, queryPhone: string) {
  const title = normalizeSearchText(row.title);
  let score = row.type === "project" ? 8 : 12;
  if (!queryText) score += 20;
  if (queryText && title === queryText) score += 700;
  if (queryText && title.startsWith(queryText)) score += 420;
  if (queryText && row.search_text.startsWith(queryText)) score += 260;
  if (queryText && row.search_text.includes(queryText)) score += 150;
  if (queryCompact.length >= 3 && row.compact_text.includes(queryCompact)) score += 80;
  if (queryPhone.length >= 3 && row.phone_digits.includes(queryPhone)) score += row.phone_digits.startsWith(queryPhone) ? 420 : 260;
  queryTokens.forEach((token) => {
    if (row.tokens.includes(token)) score += 130;
    else if (row.tokens.some((rowToken) => rowToken.startsWith(token))) score += 90;
    else if (row.search_text.includes(token)) score += 35;
  });
  const updatedMs = Date.parse(row.updated_at);
  if (Number.isFinite(updatedMs)) score += Math.min(35, Math.max(0, (updatedMs / 1000) / 100000000));
  return score;
}

async function searchPlatformProjectsAndContacts(orgId: string, input: { query?: string; types?: string; limit?: unknown }) {
  const queryText = normalizeSearchText(input.query);
  const queryTokens = searchTokens(queryText);
  const queryCompact = compactSearchText(queryText);
  const queryPhone = phoneDigits(input.query);
  const types = platformSearchTypes(cleanText(input.types));
  const limit = platformSearchLimit(input.limit);
  const rows = await platformSearchRows(orgId);
  const results = rows
    .filter((row) => types.has(row.type))
    .filter((row) => rowMatchesSearch(row, queryText, queryTokens, queryCompact, queryPhone))
    .map((row) => ({
      type: row.type,
      id: row.id,
      project_id: row.project_id,
      title: row.title,
      subtitle: row.subtitle,
      score: rowSearchScore(row, queryText, queryTokens, queryCompact, queryPhone),
      contact: row.contact || null,
      updated_at: row.updated_at
    }))
    .sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)) || a.title.localeCompare(b.title))
    .slice(0, limit);
  return {
    query: cleanText(input.query),
    count: results.length,
    index_count: rows.length,
    results
  };
}

function notificationIdFromParts(...parts: unknown[]) {
  const raw = parts.map((part) => String(part ?? "").trim()).filter(Boolean).join("_");
  return `notification_${raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || Date.now().toString(36)}`;
}

function triggerToken(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

function stageChangeTriggerEvents(fromStage: string, toStage: string) {
  const from = triggerToken(fromStage);
  const to = triggerToken(toStage);
  return [
    "project.stage_changed",
    `project.stage.entered.${to}`,
    `project.stage.changed.to.${to}`,
    `project.stage.changed.${from}.to.${to}`
  ];
}

function notificationExpired(notification: Record<string, unknown>) {
  const expiresAt = String(notification.expires_at || notification.expiresAt || "");
  if (!expiresAt) return false;
  const date = new Date(expiresAt);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now();
}

function normalizeNotification(input: Record<string, unknown>) {
  const now = new Date().toISOString();
  const id = String(input.id || notificationIdFromParts(input.source || "manual", input.project_id || input.projectId || "", input.event_id || input.eventId || input.title || ""));
  const targetUserIds = normalizeStringArray(input.target_user_ids || input.targetUserIds || input.user_ids || input.userIds);
  const targetRoleIds = normalizeStringArray(input.target_role_ids || input.targetRoleIds || input.role_ids || input.roleIds);
  return {
    id,
    title: String(input.title || "Notification"),
    body: String(input.body || input.message || ""),
    status: String(input.status || "active"),
    channel: String(input.channel || "passive"),
    kind: String(input.kind || "passive"),
    push: input.push === true,
    passive: input.passive !== false,
    manual_dismissible: input.manual_dismissible !== false && input.manualDismissible !== false,
    target_user_ids: targetUserIds,
    target_role_ids: targetRoleIds,
    branch_id: String(input.branch_id || input.branchId || "default"),
    expires_at: String(input.expires_at || input.expiresAt || ""),
    source: String(input.source || "platform"),
    celebration: asObject(input.celebration),
    celebration_size: String(input.celebration_size || input.celebrationSize || asObject(input.celebration).size || ""),
    context: asObject(input.context),
    push_log: Array.isArray(input.push_log) ? input.push_log : [],
    created_at: String(input.created_at || now),
    updated_at: now
  };
}

function userRoleIds(user: Record<string, unknown>) {
  const roles = normalizeStringArray(user.roles);
  const role = String(user.role || "").trim();
  if (!roles.length && ["owner", "admin", "super_admin"].includes(role)) return PLATFORM_STANDARD_USER_ROLES;
  return roles;
}

async function resolveNotificationRecipients(orgId: string, notification: Record<string, unknown>) {
  const targetUserIds = new Set(normalizeStringArray(notification.target_user_ids));
  const targetRoleIds = new Set(normalizeStringArray(notification.target_role_ids));
  const docs = await listDocuments(orgId, "users");
  const users = docs.map((doc) => ({ id: String(doc.id || ""), ...asObject(doc.data) }));
  return users.filter((user) => {
    if (targetUserIds.has(String(user.id))) return true;
    if ([...targetRoleIds].some((roleId) => userRoleIds(user).includes(roleId))) return true;
    return !targetUserIds.size && !targetRoleIds.size;
  });
}

async function createPlatformNotification(orgId: string, input: Record<string, unknown>) {
  const notification = normalizeNotification(input);
  if (notification.push) {
    const recipients = await resolveNotificationRecipients(orgId, notification);
    notification.push_log = recipients.map((user) => ({
      user_id: user.id,
      at: new Date().toISOString(),
      status: "logged_only"
    }));
  }
  const saved = await upsertDocument(orgId, NOTIFICATION_COLLECTION, {
    id: notification.id,
    data: notification,
    metadata: { kind: "platform_notification", source: notification.source }
  }, { replace: true });
  return saved;
}

async function setUserNotificationState(orgId: string, userId: string, notificationId: string, patch: Record<string, unknown>) {
  const userDoc = await readDocument(orgId, "users", userId);
  const data = asObject(userDoc.data);
  const states = asObject(data.notification_state);
  const current = asObject(states[notificationId]);
  const now = new Date().toISOString();
  const next = {
    ...current,
    seen_at: patch.seen || patch.seen_at ? String(patch.seen_at || current.seen_at || now) : current.seen_at,
    dismissed_at: patch.dismissed || patch.dismissed_at ? String(patch.dismissed_at || current.dismissed_at || now) : current.dismissed_at,
    completed_at: patch.completed || patch.completed_at ? String(patch.completed_at || current.completed_at || now) : current.completed_at,
    updated_at: now
  };
  await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      ...data,
      notification_state: {
        ...states,
        [notificationId]: next
      }
    },
    metadata: userDoc.metadata
  }, { replace: true });
  return next;
}

async function listVisibleNotifications(orgId: string, userId: string, options: { includeDismissed?: boolean; branchId?: string } = {}) {
  const [userDoc, notificationDocs] = await Promise.all([
    readDocument(orgId, "users", userId),
    listDocuments(orgId, NOTIFICATION_COLLECTION)
  ]);
  const user = { id: userId, ...asObject(userDoc.data) };
  const states = asObject(asObject(userDoc.data).notification_state);
  const roles = new Set(userRoleIds(user));
  const notifications = notificationDocs
    .map((doc) => ({ document: doc, data: asObject(doc.data) }))
    .filter(({ data }) => String(data.status || "active") === "active")
    .filter(({ data }) => data.passive !== false)
    .filter(({ data }) => !notificationExpired(data))
    .filter(({ data }) => !data.branch_id || String(data.branch_id) === String(options.branchId || "default"))
    .filter(({ data }) => {
      const targetUserIds = normalizeStringArray(data.target_user_ids);
      const targetRoleIds = normalizeStringArray(data.target_role_ids);
      if (!targetUserIds.length && !targetRoleIds.length) return true;
      if (targetUserIds.includes(userId)) return true;
      return targetRoleIds.some((roleId) => roles.has(roleId));
    })
    .map(({ document, data }) => {
      const state = asObject(states[String(data.id || document.id)]);
      return { ...data, id: String(data.id || document.id), user_state: state, document_revision: document.revision };
    })
    .filter((item) => options.includeDismissed || !item.user_state.dismissed_at && !item.user_state.completed_at)
    .sort((a, b) => String((b as Record<string, unknown>).created_at).localeCompare(String((a as Record<string, unknown>).created_at)));
  return {
    notifications,
    unread_count: notifications.filter((item) => !item.user_state.seen_at).length,
    active_count: notifications.length
  };
}

function normalizeLooseStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((entry) => Array.isArray(entry) ? entry : [entry])
    .map((entry) => cleanText(entry))
    .filter(Boolean);
}

function actionItemIdFromParts(...parts: unknown[]) {
  const raw = parts.map((part) => cleanText(part)).filter(Boolean).join("_");
  return `action_item_${raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || Date.now().toString(36)}`;
}

function uniqueActionItemId(kind: string) {
  const normalizedKind = cleanText(kind).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "manual";
  return `action_item_${normalizedKind}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function normalizeActionItemStatus(value: unknown, fallback = "open") {
  const status = cleanText(value || fallback).toLowerCase();
  return ["open", "ready", "claimed", "blocked", "completed", "canceled"].includes(status) ? status : fallback;
}

function normalizeContactRefs(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => {
      const contact = asObject(entry);
      return {
        project_id: cleanText(contact.project_id || contact.projectId),
        contact_id: cleanText(contact.contact_id || contact.contactId || contact.id),
        name: cleanText(contact.name || contact.full_name),
        email: cleanText(contact.email).toLowerCase(),
        phone: cleanText(contact.phone || (Array.isArray(contact.phones) ? contact.phones[0] : "")),
        role: cleanText(contact.role),
        snapshot: asObject(contact.snapshot)
      };
    })
    .filter((contact) => contact.project_id || contact.contact_id || contact.name || contact.email || contact.phone);
}

function actionItemHistoryEntry(type: string, input: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) {
  return {
    type,
    at: new Date().toISOString(),
    actor_user_id: cleanText(ctx.userId || input.actor_user_id || input.actorUserId),
    actor_email: cleanText(asObject(ctx.identity).email || input.actor_email || input.actorEmail),
    message: cleanText(input.message || input.reason),
    data: asObject(input.data)
  };
}

function normalizeActionItem(input: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const kind = cleanText(input.kind || input.type || "manual") || "manual";
  const source = cleanText(input.source || "manual") || "manual";
  const projectIds = normalizeLooseStringArray(input.project_ids || input.projectIds || input.project_id || input.projectId);
  const id = cleanText(input.id) || (
    projectIds.length
      ? actionItemIdFromParts(kind, projectIds[0])
      : uniqueActionItemId(kind)
  );
  const assignedUserIds = normalizeLooseStringArray(input.assigned_user_ids || input.assignedUserIds || input.assignee_user_ids || input.user_ids || input.userIds);
  const assignedRoleIds = normalizeLooseStringArray(input.assigned_role_ids || input.assignedRoleIds || input.assignee_role_ids || input.role_ids || input.roleIds);
  const history = Array.isArray(input.history) ? input.history.map((entry) => asObject(entry)) : [];
  return {
    schema_version: 1,
    id,
    kind,
    title: cleanText(input.title || kind.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())),
    body: cleanText(input.body || input.description || input.summary),
    status: normalizeActionItemStatus(input.status || "open"),
    priority: cleanText(input.priority || "normal") || "normal",
    branch_id: cleanText(input.branch_id || input.branchId || ctx.branchId || "default") || "default",
    due_at: cleanText(input.due_at || input.dueAt),
    issued_at: cleanText(input.issued_at || input.issuedAt || input.created_at) || now,
    issued_by_user_id: cleanText(input.issued_by_user_id || input.issuedByUserId || ctx.userId),
    issued_by_email: cleanText(input.issued_by_email || input.issuedByEmail || asObject(ctx.identity).email),
    assigned_user_ids: assignedUserIds,
    assigned_role_ids: assignedRoleIds,
    assignment_mode: cleanText(input.assignment_mode || input.assignmentMode || (assignedUserIds.length || assignedRoleIds.length ? "any_capable" : "org_wide")) || "org_wide",
    claimed_by_user_id: cleanText(input.claimed_by_user_id || input.claimedByUserId),
    claimed_at: cleanText(input.claimed_at || input.claimedAt),
    completed_at: cleanText(input.completed_at || input.completedAt),
    completed_by_user_id: cleanText(input.completed_by_user_id || input.completedByUserId),
    completion_reason: cleanText(input.completion_reason || input.completionReason),
    canceled_at: cleanText(input.canceled_at || input.canceledAt),
    canceled_by_user_id: cleanText(input.canceled_by_user_id || input.canceledByUserId),
    cancel_reason: cleanText(input.cancel_reason || input.cancelReason),
    project_ids: projectIds,
    contact_refs: normalizeContactRefs(input.contact_refs || input.contactRefs || input.contacts),
    payload: asObject(input.payload),
    frontend_action: asObject(input.frontend_action || input.frontendAction || input.action),
    completion_events: Array.isArray(input.completion_events || input.completionEvents)
      ? ((input.completion_events || input.completionEvents) as unknown[]).map((entry) => asObject(entry))
      : [],
    source,
    metadata: asObject(input.metadata),
    history: history.length ? history : [actionItemHistoryEntry("created", input, ctx)],
    created_at: cleanText(input.created_at) || now,
    updated_at: now
  };
}

function actionItemData(document: Record<string, unknown>) {
  const data = asObject(document.data);
  return { ...data, id: cleanText(data.id || document.id), document_revision: document.revision };
}

function userCanSeeActionItem(item: Record<string, unknown>, userId: string, roles: Set<string>) {
  const assignedUserIds = normalizeLooseStringArray(item.assigned_user_ids);
  const assignedRoleIds = normalizeLooseStringArray(item.assigned_role_ids);
  if (!assignedUserIds.length && !assignedRoleIds.length) return true;
  if (assignedUserIds.includes(userId)) return true;
  return assignedRoleIds.some((roleId) => roles.has(roleId));
}

function actionItemIsManagedByUser(_item: Record<string, unknown>, ctx: Record<string, unknown>) {
  const permissions = asObject(ctx.permissions);
  return permissions["*"] === true
    || permissions.manage_projects === true
    || permissions.manage_company_settings === true
    || ["owner", "admin", "super_admin"].includes(cleanText(ctx.role).toLowerCase());
}

function actionItemHiddenByStatus(item: Record<string, unknown>, options: Record<string, unknown>) {
  const status = normalizeActionItemStatus(item.status || "open");
  if (status === "completed" && !options.includeCompleted) return true;
  if (status === "canceled" && !options.includeCanceled) return true;
  return false;
}

function dateMatchesFilter(value: unknown, dueAfter = "", dueBefore = "") {
  const raw = cleanText(value);
  if (!raw) return true;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return true;
  const afterMs = dueAfter ? Date.parse(dueAfter) : NaN;
  const beforeMs = dueBefore ? Date.parse(dueBefore) : NaN;
  if (Number.isFinite(afterMs) && ms < afterMs) return false;
  if (Number.isFinite(beforeMs) && ms > beforeMs) return false;
  return true;
}

async function actionItemViewForUser(orgId: string, document: Record<string, unknown>, userId: string) {
  const [userDoc] = await Promise.all([readDocument(orgId, "users", userId)]);
  const user = { id: userId, ...asObject(userDoc.data) };
  const state = asObject(asObject(userDoc.data).action_item_state)[String(document.id || asObject(document.data).id || "")];
  const roles = new Set(userRoleIds(user));
  const item = { ...asObject(document.data), id: cleanText(asObject(document.data).id || document.id), document_revision: document.revision };
  return {
    ...item,
    user_state: asObject(state),
    visible_to_user: userCanSeeActionItem(item, userId, roles)
  };
}

async function listVisibleActionItems(orgId: string, userId: string, options: Record<string, unknown> = {}) {
  const [userDoc, actionItemDocs] = await Promise.all([
    readDocument(orgId, "users", userId),
    listDocuments(orgId, ACTION_ITEM_COLLECTION)
  ]);
  const user = { id: userId, ...asObject(userDoc.data) };
  const roles = new Set(userRoleIds(user));
  const states = asObject(asObject(userDoc.data).action_item_state);
  const projectId = cleanText(options.projectId);
  const contact = cleanText(options.contact).toLowerCase();
  const kind = cleanText(options.kind);
  const status = cleanText(options.status);
  const branchId = cleanText(options.branchId || "default") || "default";
  const action_items = actionItemDocs
    .map((doc) => {
      const data: Record<string, unknown> = actionItemData(doc);
      const userState = asObject(states[String(data.id || doc.id)]);
      return { document: doc, data, user_state: userState };
    })
    .filter(({ data }) => options.includeAll || userCanSeeActionItem(data, userId, roles))
    .filter(({ data }) => !actionItemHiddenByStatus(data, options))
    .filter(({ data, user_state }) => options.includeHidden || !user_state.hidden_at && !user_state.dismissed_at)
    .filter(({ data }) => !data.branch_id || cleanText(data.branch_id) === branchId)
    .filter(({ data }) => !projectId || normalizeLooseStringArray(data.project_ids).includes(projectId))
    .filter(({ data }) => !kind || cleanText(data.kind) === kind)
    .filter(({ data }) => !status || cleanText(data.status) === status)
    .filter(({ data }) => dateMatchesFilter(data.due_at, cleanText(options.dueAfter), cleanText(options.dueBefore)))
    .filter(({ data }) => {
      if (!contact) return true;
      return normalizeContactRefs(data.contact_refs).some((ref) => {
        const values = [ref.contact_id, ref.name, ref.email, ref.phone].map((value) => cleanText(value).toLowerCase());
        return values.some((value) => value.includes(contact));
      });
    })
    .map(({ data, user_state }) => ({ ...data, user_state, visible_to_user: true } as Record<string, unknown>))
    .sort((a, b) => {
      const dueA = Date.parse(cleanText(a.due_at)) || Number.MAX_SAFE_INTEGER;
      const dueB = Date.parse(cleanText(b.due_at)) || Number.MAX_SAFE_INTEGER;
      if (dueA !== dueB) return dueA - dueB;
      return cleanText(b.issued_at || b.created_at).localeCompare(cleanText(a.issued_at || a.created_at));
    });
  return {
    action_items,
    items: action_items,
    active_count: action_items.length,
    overdue_count: action_items.filter((item) => item.due_at && Date.parse(cleanText(item.due_at)) < Date.now()).length,
    unread_count: action_items.filter((item) => !asObject(item.user_state).seen_at).length
  };
}

async function createPlatformActionItem(orgId: string, input: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const item = normalizeActionItem(input, ctx);
  return await upsertDocument(orgId, ACTION_ITEM_COLLECTION, {
    id: item.id,
    data: item,
    metadata: { kind: "platform_action_item", source: item.source, ...asObject(item.metadata) }
  }, { replace: true });
}

async function patchPlatformActionItem(orgId: string, actionItemId: string, patch: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const currentDoc = await readDocument(orgId, ACTION_ITEM_COLLECTION, actionItemId);
  const current = asObject(currentDoc.data);
  const nextInput = {
    ...current,
    ...patch,
    id: current.id || currentDoc.id,
    history: [
      ...(Array.isArray(current.history) ? current.history.map((entry) => asObject(entry)) : []),
      actionItemHistoryEntry("updated", patch, ctx)
    ],
    updated_at: new Date().toISOString()
  };
  const normalized = normalizeActionItem(nextInput, ctx);
  return await upsertDocument(orgId, ACTION_ITEM_COLLECTION, {
    id: actionItemId,
    data: normalized,
    metadata: { ...asObject(currentDoc.metadata), ...asObject(patch.metadata) }
  }, { replace: true });
}

async function transitionPlatformActionItem(orgId: string, actionItemId: string, status: string, input: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  const currentDoc = await readDocument(orgId, ACTION_ITEM_COLLECTION, actionItemId);
  const current = asObject(currentDoc.data);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    ...input,
    status,
    updated_at: now,
    history: [
      ...(Array.isArray(current.history) ? current.history.map((entry) => asObject(entry)) : []),
      actionItemHistoryEntry(status, input, ctx)
    ]
  };
  if (status === "claimed") {
    patch.claimed_by_user_id = cleanText(input.claimed_by_user_id || ctx.userId);
    patch.claimed_at = cleanText(input.claimed_at) || now;
  }
  if (status === "completed") {
    patch.completed_by_user_id = cleanText(input.completed_by_user_id || ctx.userId);
    patch.completed_at = cleanText(input.completed_at) || now;
    patch.completion_reason = cleanText(input.reason || input.completion_reason || "manual");
  }
  if (status === "canceled") {
    patch.canceled_by_user_id = cleanText(input.canceled_by_user_id || ctx.userId);
    patch.canceled_at = cleanText(input.canceled_at) || now;
    patch.cancel_reason = cleanText(input.reason || input.cancel_reason || "manual");
  }
  const normalized = normalizeActionItem({ ...current, ...patch, id: current.id || actionItemId }, ctx);
  return await upsertDocument(orgId, ACTION_ITEM_COLLECTION, {
    id: actionItemId,
    data: normalized,
    metadata: currentDoc.metadata
  }, { replace: true });
}

async function setUserActionItemState(orgId: string, userId: string, actionItemId: string, patch: Record<string, unknown>) {
  const userDoc = await readDocument(orgId, "users", userId);
  const data = asObject(userDoc.data);
  const states = asObject(data.action_item_state);
  const current = asObject(states[actionItemId]);
  const now = new Date().toISOString();
  const next = {
    ...current,
    seen_at: patch.seen || patch.seen_at ? cleanText(patch.seen_at || current.seen_at || now) : current.seen_at,
    hidden_at: patch.hidden || patch.hidden_at ? cleanText(patch.hidden_at || current.hidden_at || now) : current.hidden_at,
    dismissed_at: patch.dismissed || patch.dismissed_at ? cleanText(patch.dismissed_at || current.dismissed_at || now) : current.dismissed_at,
    pinned: patch.pinned === undefined ? current.pinned === true : patch.pinned === true,
    snoozed_until: Object.prototype.hasOwnProperty.call(patch, "snoozed_until") || Object.prototype.hasOwnProperty.call(patch, "snoozedUntil")
      ? cleanText(patch.snoozed_until || patch.snoozedUntil)
      : cleanText(current.snoozed_until),
    updated_at: now
  };
  await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      ...data,
      action_item_state: {
        ...states,
        [actionItemId]: next
      }
    },
    metadata: userDoc.metadata
  }, { replace: true });
  return next;
}

function normalizeProjectEvent(input: Record<string, unknown>, project: Record<string, unknown>) {
  const now = new Date().toISOString();
  const eventTypeDefaultId = String(input.event_type_default_id || input.type_id || input.event_type_id || input.type || "custom");
  const requiredRoleIds = normalizeStringArray(input.required_role_ids || input.requiredRoleIds);
  const allowedRoleIds = normalizeStringArray(input.allowed_role_ids || input.allowedRoleIds);
  const roleIds = normalizeStringArray(input.role_ids || input.roles || [...requiredRoleIds, ...allowedRoleIds]);
  const assignedUserIds = normalizeStringArray(input.assigned_user_ids || input.assignedUserIds || input.user_ids || [input.assigned_user_id, input.user_id]);
  const assignedUsers = Array.isArray(input.assigned_users || input.assignedUsers)
    ? (input.assigned_users || input.assignedUsers) as unknown[]
    : [];
  const startAt = new Date(String(input.start_at || input.start || now));
  const safeStartAt = Number.isFinite(startAt.getTime()) ? startAt : new Date();
  const explicitEndAt = input.end_at || input.end;
  const parsedEndAt = explicitEndAt ? new Date(String(explicitEndAt)) : null;
  const safeEndAt = parsedEndAt && Number.isFinite(parsedEndAt.getTime()) && parsedEndAt > safeStartAt ? parsedEndAt : null;
  const derivedDurationMinutes = safeEndAt ? Math.max(1, Math.round((safeEndAt.getTime() - safeStartAt.getTime()) / 60000)) : 0;
  const durationMinutes = Math.max(1, Number(input.duration_minutes || input.durationMinutes || derivedDurationMinutes || 60));
  return {
    ...input,
    id: String(input.id || `event_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`),
    type_id: eventTypeDefaultId,
    event_type_id: eventTypeDefaultId,
    event_type_default_id: eventTypeDefaultId,
    title: String(input.title || eventTypeDefaultId.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())),
    start_at: safeStartAt.toISOString(),
    duration_minutes: durationMinutes,
    end_at: (safeEndAt || new Date(safeStartAt.getTime() + durationMinutes * 60000)).toISOString(),
    required_role_ids: requiredRoleIds.length ? requiredRoleIds : roleIds,
    allowed_role_ids: allowedRoleIds.length ? allowedRoleIds : roleIds,
    role_ids: [...new Set([...roleIds, ...requiredRoleIds, ...allowedRoleIds])],
    assigned_user_ids: assignedUserIds,
    assigned_users: assignedUsers,
    assigned_user_id: assignedUserIds[0] || "",
    project_id: String(project.id || input.project_id || ""),
    project_address: String(project.address || input.project_address || ""),
    status: String(input.status || "scheduled"),
    created_at: String(input.created_at || now),
    updated_at: now
  };
}

function triggerMatches(trigger: Record<string, unknown>, eventName: string, context: Record<string, unknown>) {
  if (trigger.enabled === false) return false;
  if (String(trigger.event || "") !== eventName) return false;
  const conditions = asObject(trigger.conditions);
  const event = asObject(context.event);
  const project = asObject(context.project);
  const eventType = String(event.event_type_default_id || event.type_id || event.event_type_id || "");
  const projectStage = String(project.stage || project.stage_id || DEFAULT_STAGE_ID);
  const fromStage = String(context.from_stage || "");
  const toStage = String(context.to_stage || "");
  if (conditions.event_type_default_id && String(conditions.event_type_default_id) !== eventType) return false;
  if (conditions.event_type_id && String(conditions.event_type_id) !== eventType) return false;
  if (conditions.project_stage && String(conditions.project_stage) !== projectStage) return false;
  if (conditions.stage && String(conditions.stage) !== projectStage) return false;
  if (conditions.from_stage && String(conditions.from_stage) !== fromStage) return false;
  if (conditions.to_stage && String(conditions.to_stage) !== toStage) return false;
  return true;
}

function completionConditionContextValue(key: string, context: Record<string, unknown>) {
  const event = asObject(context.event);
  const project = asObject(context.project);
  if (key === "project_id") return context.project_id || project.id;
  if (key === "event_id") return context.event_id || event.id;
  if (key === "event_type_default_id" || key === "event_type_id") return event.event_type_default_id || event.type_id || event.event_type_id;
  if (key === "from_stage") return context.from_stage;
  if (key === "to_stage" || key === "stage") return context.to_stage || project.stage || project.stage_id;
  return contextPath(context, key) ?? event[key] ?? project[key] ?? context[key];
}

function completionConditionMatches(key: string, expected: unknown, context: Record<string, unknown>) {
  if (expected === undefined || expected === null || expected === "") return true;
  const actual = completionConditionContextValue(key, context);
  if (Array.isArray(expected)) {
    const expectedValues = normalizeLooseStringArray(expected);
    return expectedValues.includes(cleanText(actual));
  }
  return cleanText(actual) === cleanText(expected);
}

function actionItemCompletionMatches(item: Record<string, unknown>, eventName: string, context: Record<string, unknown>) {
  const status = normalizeActionItemStatus(item.status || "open");
  if (status === "completed" || status === "canceled") return false;
  const targetId = cleanText(context.action_item_id);
  if (targetId && cleanText(item.id) !== targetId) return false;
  const targetKind = cleanText(context.action_item_kind);
  if (targetKind && cleanText(item.kind) !== targetKind) return false;
  const completions = Array.isArray(item.completion_events) ? item.completion_events.map((entry) => asObject(entry)) : [];
  return completions.some((completion) => {
    if (cleanText(completion.event || completion.event_name) !== eventName) return false;
    const conditions = asObject(completion.conditions);
    return Object.entries(conditions).every(([key, expected]) => completionConditionMatches(key, expected, context));
  });
}

async function completeMatchingActionItemsForEvent(orgId: string, eventName: string, context: Record<string, unknown>) {
  if (!eventName) return { completed: [], completed_count: 0 };
  const docs = await listDocuments(orgId, ACTION_ITEM_COLLECTION).catch(() => []);
  const completed = [];
  for (const doc of docs) {
    const item = { ...asObject(doc.data), id: cleanText(asObject(doc.data).id || doc.id) };
    if (!actionItemCompletionMatches(item, eventName, context)) continue;
    const document = await transitionPlatformActionItem(orgId, cleanText(doc.id), "completed", {
      reason: cleanText(context.completion_reason || "event_match"),
      data: {
        event: eventName,
        project_id: context.project_id || asObject(context.project).id,
        event_id: asObject(context.event).id
      }
    }, {
      userId: cleanText(context.actor_user_id),
      identity: { email: cleanText(context.actor_email) }
    });
    completed.push(actionItemData(document));
  }
  return { completed, completed_count: completed.length };
}

function contextPath(context: Record<string, unknown>, pathValue: unknown) {
  const path = String(pathValue || "").trim();
  if (!path) return undefined;
  return path.split(".").reduce<unknown>((value, key) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>)[key];
    return undefined;
  }, context);
}

function renderTemplate(value: unknown, context: Record<string, unknown>) {
  if (typeof value !== "string") return value;
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path) => String(contextPath(context, path) ?? ""));
}

function resolveTriggerParams(params: Record<string, unknown>, context: Record<string, unknown>) {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key.endsWith("_from")) continue;
    resolved[key] = Array.isArray(value)
      ? value.map((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
        ? resolveTriggerParams(entry as Record<string, unknown>, context)
        : renderTemplate(entry, context))
      : value && typeof value === "object"
        ? resolveTriggerParams(value as Record<string, unknown>, context)
        : renderTemplate(value, context);
  }
  for (const [key, value] of Object.entries(params)) {
    if (!key.endsWith("_from")) continue;
    const targetKey = key.slice(0, -5);
    resolved[targetKey] = contextPath(context, value);
  }
  return resolved;
}

async function applyTriggerAction(orgId: string, branchId: string, trigger: Record<string, unknown>, context: Record<string, unknown>) {
  const action = String(trigger.action || "");
  if (action === "action_item.create") {
    const params = asObject(trigger.params);
    const event = asObject(context.event);
    const project = asObject(context.project);
    const resolvedParams = resolveTriggerParams(params, { ...context, event, project });
    const actionItem = await createPlatformActionItem(orgId, {
      ...resolvedParams,
      branch_id: resolvedParams.branch_id || branchId,
      metadata: {
        ...asObject(resolvedParams.metadata),
        trigger_id: trigger.id,
        trigger_event: trigger.event
      },
      payload: {
        ...asObject(resolvedParams.payload),
        trigger_id: trigger.id,
        trigger_event: trigger.event,
        project_id: context.project_id || project.id
      }
    }, {
      branchId,
      userId: cleanText(context.actor_user_id),
      identity: { email: cleanText(context.actor_email) }
    });
    return { ok: true, action_item: actionItem };
  }
  if (action === "action_item.complete") {
    const params = resolveTriggerParams(asObject(trigger.params), context);
    const result = await completeMatchingActionItemsForEvent(orgId, String(trigger.event || ""), {
      ...context,
      action_item_id: params.action_item_id || params.id,
      action_item_kind: params.kind,
      completion_reason: params.reason || "trigger_action"
    });
    return { ok: true, ...result };
  }
  if (action === "notification.create") {
    const params = asObject(trigger.params);
    const event = asObject(context.event);
    const project = asObject(context.project);
    const resolvedParams = resolveTriggerParams(params, { ...context, event, project });
    const celebration = asObject(resolvedParams.celebration);
    const celebrationText = String(celebration.text || "");
    if (String(resolvedParams.kind || "") === "celebration" && (!celebrationText.trim() || /^\s*was\s+just\s+sold/i.test(celebrationText))) {
      const projectName = String(project.title || project.name || project.address || "Project").trim();
      celebration.text = `${projectName} was just sold.`;
      resolvedParams.celebration = celebration;
      resolvedParams.body = celebration.text;
      const contextParam = asObject(resolvedParams.context);
      resolvedParams.context = {
        ...contextParam,
        celebration: {
          ...asObject(contextParam.celebration),
          text: celebration.text
        }
      };
    }
    const notification = await createPlatformNotification(orgId, {
      ...resolvedParams,
      id: resolvedParams.id || notificationIdFromParts(trigger.id, project.id, event.id),
      branch_id: resolvedParams.branch_id || branchId,
      context: {
        ...asObject(resolvedParams.context),
        trigger_id: trigger.id,
        trigger_event: trigger.event,
        project_id: project.id,
        event_id: event.id
      }
    });
    return { ok: true, notification };
  }
  if (action !== "project.stage.set") return { ok: false, skipped: true, reason: "unsupported_action" };
  const params = asObject(trigger.params);
  const projectId = String(context.project_id || asObject(context.project).id || "");
  const nextStage = String(params.stage || params.stage_id || "");
  if (!projectId || !nextStage) return { ok: false, skipped: true, reason: "missing_project_or_stage" };
  const currentDoc = await readDocument(orgId, "projects", projectId);
  const data = asObject(currentDoc.data);
  const fromStage = String(data.stage || data.stage_id || DEFAULT_STAGE_ID);
  if (fromStage === nextStage) return { ok: true, skipped: true, reason: "already_in_stage", project_document: currentDoc };
  const history = Array.isArray(data.stage_history) ? data.stage_history : [];
  const document = await upsertDocument(orgId, "projects", {
    id: projectId,
    data: {
      ...data,
      stage: nextStage,
      stage_id: nextStage,
      stage_updated_at: new Date().toISOString(),
      stage_history: [
        ...history,
        {
          from: fromStage,
          to: nextStage,
          trigger_id: String(trigger.id || ""),
          event: String(trigger.event || ""),
          at: new Date().toISOString()
        }
      ]
    },
    metadata: currentDoc.metadata
  }, { replace: true });
  for (const eventName of stageChangeTriggerEvents(fromStage, nextStage)) {
    await emitPlatformTrigger(orgId, branchId, eventName, {
      project_id: projectId,
      project: document.data,
      project_document: document,
      from_stage: fromStage,
      to_stage: nextStage,
      trigger_id: String(trigger.id || ""),
      stage_event_names: stageChangeTriggerEvents(fromStage, nextStage)
    });
  }
  return { ok: true, project_document: document, from_stage: fromStage, to_stage: nextStage };
}

async function emitPlatformTrigger(orgId: string, branchId: string, eventName: string, context: Record<string, unknown>) {
  if (!eventName) throw badRequest("missing_trigger_event", "A trigger event name is required.");
  const modules = await ensureWorkflowModules(orgId, branchId || "default");
  const triggers = Array.isArray(modules.triggers.triggers) ? modules.triggers.triggers.map((trigger) => asObject(trigger)) : [];
  const fired = [];
  let projectDocument = context.project_document;
  const mutableContext = { ...context };
  for (const trigger of triggers) {
    if (!triggerMatches(trigger, eventName, mutableContext)) continue;
    const result = await applyTriggerAction(orgId, branchId || "default", trigger, mutableContext);
    fired.push({ id: trigger.id, action: trigger.action, result });
    if (asObject(result).project_document) {
      projectDocument = asObject(result).project_document;
      mutableContext.project_document = projectDocument;
      mutableContext.project = asObject(asObject(projectDocument).data);
    }
  }
  const actionItems = await completeMatchingActionItemsForEvent(orgId, eventName, mutableContext);
  return {
    event: eventName,
    branch_id: branchId || "default",
    fired,
    action_items: actionItems,
    project_document: projectDocument
  };
}

function eventHasCompleted(event: Record<string, unknown>, now = Date.now()) {
  if (event.completed_emitted_at || event.completed_at) return false;
  const start = new Date(String(event.start_at || event.start || ""));
  if (!Number.isFinite(start.getTime())) return false;
  const durationMinutes = Math.max(1, Number(event.duration_minutes || event.duration || 60));
  return start.getTime() + durationMinutes * 60000 <= now;
}

async function processCompletedProjectEventsForOrg(orgId: string) {
  const projects = await listDocuments(orgId, "projects");
  for (const document of projects) {
    const project = asObject(document.data);
    const events = Array.isArray(project.events) ? project.events.map((event) => asObject(event)) : [];
    let changed = false;
    const now = Date.now();
    for (const event of events) {
      if (!eventHasCompleted(event, now)) continue;
      event.completed_emitted_at = new Date().toISOString();
      event.status = String(event.status || "scheduled");
      changed = true;
      await emitPlatformTrigger(orgId, String(project.branch_id || "default"), "project.event.completed", {
        project_id: document.id,
        project: { ...project, id: document.id },
        project_document: document,
        event
      });
    }
    if (changed) {
      const latest = await readDocument(orgId, "projects", String(document.id));
      const latestData = asObject(latest.data);
      await upsertDocument(orgId, "projects", {
        id: String(document.id),
        data: {
          ...latestData,
          events,
          updated_at: new Date().toISOString()
        },
        metadata: latest.metadata
      }, { replace: true });
    }
  }
}

let heartbeatRunning = false;

async function runPlatformHeartbeat(app: { log?: { warn: (value: unknown, message?: string) => void } }) {
  if (heartbeatRunning) return;
  heartbeatRunning = true;
  try {
    const organizations = await listOrganizations();
    for (const org of organizations) {
      const orgId = String(asObject(org).id || "");
      if (!orgId) continue;
      try {
        await processCompletedProjectEventsForOrg(orgId);
      } catch (error) {
        app.log?.warn({ err: error, orgId }, "Platform heartbeat failed for organization.");
      }
    }
  } catch (error) {
    app.log?.warn({ err: error }, "Platform heartbeat failed.");
  } finally {
    heartbeatRunning = false;
  }
}

function startPlatformHeartbeat(app: { log?: { warn: (value: unknown, message?: string) => void } }) {
  if (process.env.PLATFORM_HEARTBEAT_DISABLED === "1") return;
  if (heartbeatStarted) return;
  heartbeatStarted = true;
  const timer = setInterval(() => {
    void runPlatformHeartbeat(app);
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
}

function getParam(params: unknown, key: string) {
  const value = (params && typeof params === "object") ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "");
}

function publicIdentity(identity: unknown) {
  const value = identity && typeof identity === "object" ? { ...(identity as Record<string, unknown>) } : {};
  delete value.password_hash;
  delete value.password_reset;
  delete value.otp;
  const metadata = asObject(value.metadata);
  const signupVerification = asObject(metadata.signup_email_verification);
  if (Object.keys(signupVerification).length) {
    const safeVerification = { ...signupVerification };
    delete (safeVerification as JsonObject).code_hash;
    delete (safeVerification as JsonObject).expires_at;
    value.metadata = { ...metadata, signup_email_verification: safeVerification };
  }
  return value;
}

function platformUserView(userDoc: unknown) {
  const doc = asObject(userDoc);
  const data = asObject(doc.data);
  return {
    id: doc.id,
    ...data,
    org_permissions: {
      level: String(data.role || "member"),
      items: asObject(data.permissions)
    },
    disabled: String(data.status || "active") === "disabled"
  };
}

function numericValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeBillingView(value: unknown) {
  const billing = asObject(value);
  const autoTopup = asObject(billing.auto_topup);
  const stripe = asObject(billing.stripe);
  return {
    auto_topup: {
      enabled: autoTopup.enabled === true,
      threshold_dollars: numericValue(autoTopup.threshold_dollars),
      topup_dollars: numericValue(autoTopup.topup_dollars),
      cooldown_minutes: numericValue(autoTopup.cooldown_minutes),
      status: String(autoTopup.status || "idle"),
      last_attempt_utc: autoTopup.last_attempt_utc ?? null,
      last_success_utc: autoTopup.last_success_utc ?? null,
      last_error: autoTopup.last_error ?? null
    },
    stripe: {
      has_payment_method: stripe.has_payment_method === true,
      customer_id: stripe.customer_id ?? null,
      payment_method_id: stripe.payment_method_id ?? null,
      brand: stripe.brand ?? null,
      last4: stripe.last4 ?? null,
      exp_month: stripe.exp_month ?? null,
      exp_year: stripe.exp_year ?? null
    }
  };
}

function stableHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeDocumentId(value: unknown, fallback: string) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function cleanEmail(value: unknown) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("invalid_email", "A valid email address is required.");
  return email;
}

function identityStatusForOrgUserInput(dataInput: JsonObject) {
  const rawStatus = cleanText(dataInput.identity_status || dataInput.identityStatus || dataInput.status).toLowerCase();
  if (["disabled", "inactive", "deleted", "suspended"].includes(rawStatus)) return "disabled";
  return "active";
}

function shouldRepairIdentityStatus(identity: JsonObject, nextStatus: string) {
  if (nextStatus !== "active") return false;
  const current = cleanText(identity.status || "active").toLowerCase();
  return ["invited", "pending"].includes(current);
}

async function applyCreditDelta(orgId: string, body: Record<string, unknown>, actorEmail: unknown) {
  const amount = numericValue(body.amount ?? body.delta);
  if (amount === 0) throw badRequest("invalid_credit_amount", "Credit amount must be non-zero.");
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const balance = numericValue(data.credits_balance);
  const ledger = Array.isArray(data.credits_ledger) ? [...data.credits_ledger] : [];
  const entry = {
    ts: new Date().toISOString(),
    delta: amount,
    reason: String(body.reason || "adjustment"),
    by_email: String(actorEmail || ""),
    applied_for_user_email: body.applied_for_user_email ?? body.appliedForUserEmail ?? null,
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
  return {
    balance: entry.balance_after,
    ledger_entry: entry,
    ledger_count: ledger.length,
    document
  };
}

async function applyFreeExpediteDelta(orgId: string, body: Record<string, unknown>, actorEmail: unknown) {
  const amount = Math.round(numericValue(body.amount ?? body.delta));
  if (amount === 0) throw badRequest("invalid_free_expedite_amount", "Free expedite uses amount must be non-zero.");
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const current = Math.max(0, Math.round(numericValue(data.free_expedite_uses)));
  const next = current + amount;
  if (next < 0) throw badRequest("insufficient_free_expedite_uses", "This organization does not have enough free expedite uses.");
  const ledger = Array.isArray(data.free_expedite_ledger) ? [...data.free_expedite_ledger] : [];
  const entry = {
    ts: new Date().toISOString(),
    delta: amount,
    reason: String(body.reason || "free_expedite_adjustment"),
    by_email: String(actorEmail || ""),
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
    free_expedite_uses: next,
    free_expedite_ledger_entry: entry,
    free_expedite_ledger_count: ledger.length,
    document
  };
}

async function creditChargeForToken(orgId: string, chargeToken: string) {
  const global = await readGlobal(orgId);
  const ledger = Array.isArray(asObject(global.data).credits_ledger) ? asObject(global.data).credits_ledger as unknown[] : [];
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = asObject(ledger[index]);
    const meta = asObject(entry.meta);
    if (String(meta.charge_token || "") !== chargeToken) continue;
    const delta = numericValue(entry.delta);
    if (delta < 0) return { amount: Math.abs(delta), entry };
  }
  return null;
}

async function createPlatformOrgUser(orgId: string, body: Record<string, unknown>) {
  const dataInput = asObject(body.data && typeof body.data === "object" ? body.data : body);
  const email = cleanEmail(dataInput.email);
  const userId = normalizeDocumentId(body.id || dataInput.id, `user_${stableHash(email).slice(0, 16)}`);
  let identityId = String(dataInput.identity_id || "");
  const identityStatus = identityStatusForOrgUserInput(dataInput);
  if (!identityId) {
    try {
      const identity = await findIdentityByEmail(email);
      identityId = String(identity.id || "");
      if (shouldRepairIdentityStatus(identity, identityStatus)) {
        await patchIdentity(identityId, {
          status: "active",
          metadata: {
            ...asObject(identity.metadata),
            status_repaired_at: new Date().toISOString(),
            status_repair_reason: "platform_org_user_create"
          }
        });
      }
    } catch (error) {
      if (!(error instanceof PlatformError) || error.statusCode !== 404) throw error;
      const passwordHash = dataInput.password_hash
        ? String(dataInput.password_hash)
        : dataInput.password
          ? await hashPassword(String(dataInput.password))
          : "";
      const identity = await createIdentity({
        email,
        password_hash: passwordHash,
        password_algo: dataInput.password ? "bcrypt" : "php-password-hash",
        name: String(dataInput.name || ""),
        phone: String(dataInput.phone || ""),
        status: identityStatus,
        metadata: {
          source: "platform_user_create",
          ...(asObject(dataInput.identity_metadata))
        }
      });
      identityId = String(identity.id || "");
    }
  }

  const permissionState = platformOrgUserPermissionState(dataInput);
  const role = permissionState.level;
  const userData = {
    identity_id: identityId,
    email,
    name: String(dataInput.name || ""),
    phone: String(dataInput.phone || ""),
    company: String(dataInput.company || ""),
    role,
    roles: Array.isArray(dataInput.roles) ? dataInput.roles : [],
    status: String(dataInput.status || "invited"),
    org_permissions: { level: role, items: permissionState.items },
    org_permission_level: role,
    permissions: permissionState.permissions,
    account_type: String(dataInput.account_type || "customer"),
    team_id: String(dataInput.team_id || "default"),
    branch_id: String(dataInput.branch_id || "default"),
    queue_mode: String(dataInput.queue_mode || "disabled"),
    shift_schedule: asObject(dataInput.shift_schedule),
    profile: asObject(dataInput.profile),
    stats: asObject(dataInput.stats),
    metadata: asObject(dataInput.metadata)
  };

  const document = await upsertDocument(
    orgId,
    "users",
    {
      id: userId,
      data: userData,
      metadata: {
        kind: "organization_user",
        identity_id: identityId,
        source: "platform_api"
      }
    },
    { replace: true }
  );
  if (identityId) await addIdentityMembership(identityId, orgId, userId, role);
  return document;
}

async function upsertPlatformOrgUserDocument(orgId: string, documentId: string, body: JsonObject, replace: boolean) {
  const dataInput = asObject(body.data && typeof body.data === "object" ? body.data : body);
  const metadata = asObject(body.metadata);
  const current = replace ? null : await readDocument(orgId, "users", documentId).catch(() => null);
  const data = {
    ...(replace ? {} : asObject(current?.data)),
    ...dataInput
  };
  const permissionState = platformOrgUserPermissionState(data);
  return await upsertDocument(
    orgId,
    "users",
    {
      id: documentId,
      data: {
        ...data,
        role: permissionState.level,
        org_permissions: { level: permissionState.level, items: permissionState.items },
        org_permission_level: permissionState.level,
        permissions: permissionState.permissions
      },
      metadata
    },
    { replace }
  );
}

function platformOrgUserPermissionState(data: JsonObject) {
  const orgPermissions = asObject(data.org_permissions);
  const level = cleanText(
    orgPermissions.level ||
    data.org_permission_level ||
    data.permission_level ||
    data.perm_level ||
    data.role ||
    "viewer"
  ).toLowerCase() || "viewer";
  const parsedItems = asObject(tryParseJsonField(data.perm_items_json, {}));
  const explicitItems = Object.keys(parsedItems).length
    ? parsedItems
    : asObject(orgPermissions.items ?? data.perm_items ?? data.permissions);
  return {
    level,
    items: explicitItems,
    permissions: effectivePortalPermissions(level, explicitItems)
  };
}

function customerPortalDocumentId(projectId: string) {
  const id = cleanText(projectId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest("invalid_project_id", "Project id is required.");
  return `customer_portal_${id}`;
}

async function readOptionalDocument(orgId: string, collection: string, documentId: string) {
  try {
    return await readDocument(orgId, collection, documentId);
  } catch (error) {
    return null;
  }
}

function portalPublicUrl(baseUrl: string, pathValue: string) {
  const base = cleanText(baseUrl).replace(/\/+$/, "");
  const pathPart = cleanText(pathValue).replace(/^\/+/, "");
  return base ? `${base}/${pathPart}` : `/${pathPart}`;
}

function mediaReferenceId(item: unknown) {
  const media = asObject(item);
  return cleanText(media.media_id || media.mediaId || media.id || media.photo_id || media.photoId);
}

function projectPrimaryContact(project: JsonObject) {
  const contacts = Array.isArray(project.contacts) ? project.contacts.map((entry) => asObject(entry)) : [];
  const primary = contacts.find((entry) => entry.primary === true || cleanText(entry.role).toLowerCase() === "primary") || contacts[0] || {};
  const customer = asObject(project.customer);
  const id = cleanText(primary.id || primary.contact_id || customer.id || customer.contact_id || project.contact_id || project.primary_contact_id);
  return {
    id,
    contact_id: id,
    name: cleanText(primary.name || customer.name || project.customer_name || project.customerName || project.resident || project.resident_name || project.residentName || project.primary_contact_name),
    email: cleanText(primary.email || customer.email || project.customer_email || project.customerEmail || project.resident_email || project.residentEmail || project.primary_contact_email).toLowerCase(),
    phone: cleanText(primary.phone || (Array.isArray(primary.phones) ? primary.phones[0] : "") || customer.phone || project.customer_phone || project.customerPhone || project.resident_phone || project.residentPhone || project.primary_contact_phone),
    address: cleanText(primary.address || primary.default_address || customer.address || project.contact_address || project.customer_address || project.primary_contact_address)
  };
}

function isGeneratedCustomerName(value: unknown) {
  const text = cleanText(value).toLowerCase();
  return text === "customer" || text === "project" || text === "new project";
}

function portalDisplayName(...values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (text && !isGeneratedCustomerName(text)) return text;
  }
  return "Customer Portal";
}

function mergeCustomerContact(...values: unknown[]) {
  const result: JsonObject = {};
  for (const value of values) {
    const contact = asObject(value);
    const id = cleanText(contact.id || contact.contact_id);
    const name = cleanText(contact.name);
    const email = cleanText(contact.email).toLowerCase();
    const phone = cleanText(contact.phone);
    const address = cleanText(contact.address || contact.default_address);
    if (id) {
      result.id = id;
      result.contact_id = id;
    }
    if (name) result.name = name;
    if (email) result.email = email;
    if (phone) result.phone = phone;
    if (address) result.address = address;
  }
  return result;
}

function publicPortalUrl(uuid: string, baseUrl: string, preview: boolean) {
  return portalPublicUrl(baseUrl, preview ? `customer_portal/preview.php?id=${encodeURIComponent(uuid)}` : `customer_portal/?id=${encodeURIComponent(uuid)}`);
}

function customerPortalView(document: JsonObject, baseUrl: string): JsonObject {
  const data = asObject(document.data);
  const publicUuid = cleanText(data.public_uuid);
  const previewUuid = cleanText(data.preview_uuid);
  return {
    id: document.id,
    ...data,
    public_uuid: publicUuid,
    preview_uuid: previewUuid,
    live_url: publicPortalUrl(publicUuid, baseUrl, false),
    preview_url: publicPortalUrl(previewUuid, baseUrl, true),
    revision: document.revision,
    updated_at: document.updated_at,
    created_at: document.created_at
  };
}

function normalizeSharedItems(items: unknown): Array<{ type: string; item_id: string; shared_at: string; shared_by: string }> {
  const seen = new Set<string>();
  const shared = Array.isArray(items) ? items : [];
  return shared
    .map((entry) => asObject(entry))
    .map((entry) => ({
      type: cleanText(entry.type || "media") || "media",
      item_id: cleanText(entry.item_id || entry.itemId || entry.media_id || entry.mediaId || entry.id),
      shared_at: cleanText(entry.shared_at || entry.sharedAt),
      shared_by: cleanText(entry.shared_by || entry.sharedBy || entry.actor_user_id || entry.actorUserId)
    }))
    .filter((entry) => {
      if (!entry.item_id) return false;
      const key = `${entry.type}:${entry.item_id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function ensureCustomerPortalRecord(orgId: string, projectId: string, input: JsonObject = {}, baseUrl = "") {
  const projectDoc = await readDocument(orgId, "projects", projectId);
  const project = asObject(projectDoc.data);
  const documentId = customerPortalDocumentId(projectId);
  const existing = await readOptionalDocument(orgId, CUSTOMER_PORTAL_COLLECTION, documentId);
  const currentData = asObject(existing?.data);
  const now = new Date().toISOString();
  const customer = projectPrimaryContact(project);
  const inputCustomer = asObject(input.customer);
  const contactId = cleanText(input.contact_id || input.contactId || inputCustomer.id || inputCustomer.contact_id || currentData.contact_id || currentData.contactId || customer.id || customer.contact_id);
  const data = {
    project_id: projectId,
    contact_id: contactId,
    public_uuid: cleanText(currentData.public_uuid) || randomUUID(),
    preview_uuid: cleanText(currentData.preview_uuid) || randomUUID(),
    status: cleanText(currentData.status || input.status || "active") || "active",
    customer: { ...asObject(currentData.customer), ...customer, ...inputCustomer, ...(contactId ? { id: contactId, contact_id: contactId } : {}) },
    shared_items: normalizeSharedItems(currentData.shared_items),
    settings: { ...asObject(currentData.settings), ...asObject(input.settings) },
    created_at: cleanText(currentData.created_at) || now,
    updated_at: now
  };
  const document = await upsertDocument(
    orgId,
    CUSTOMER_PORTAL_COLLECTION,
    {
      id: documentId,
      data,
      metadata: {
        ...asObject(existing?.metadata),
        kind: "customer_portal_access",
        project_id: projectId,
        contact_id: data.contact_id,
        public_uuid: data.public_uuid,
        preview_uuid: data.preview_uuid
      }
    },
    { replace: true }
  );
  return {
    portal: customerPortalView(document, baseUrl),
    project: { id: projectDoc.id, ...project }
  };
}

async function updateCustomerPortalRecord(orgId: string, projectId: string, input: JsonObject = {}, baseUrl = "") {
  const ensured = await ensureCustomerPortalRecord(orgId, projectId, input, baseUrl);
  const portal = ensured.portal;
  const now = new Date().toISOString();
  let sharedItems = normalizeSharedItems(portal.shared_items);
  const actorUserId = cleanText(input.actor_user_id || input.actorUserId);
  const shareMedia = normalizeStringArray(input.share_media_ids || input.shareMediaIds || input.add_media_ids || input.addMediaIds);
  const unshareMedia = new Set(normalizeStringArray(input.unshare_media_ids || input.unshareMediaIds || input.remove_media_ids || input.removeMediaIds));
  for (const mediaId of shareMedia) {
    if (!sharedItems.some((item) => item.type === "media" && item.item_id === mediaId)) {
      sharedItems.push({ type: "media", item_id: mediaId, shared_at: now, shared_by: actorUserId });
    }
  }
  if (unshareMedia.size) {
    sharedItems = sharedItems.filter((item) => !(item.type === "media" && unshareMedia.has(item.item_id)));
  }
  if (Array.isArray(input.shared_items || input.sharedItems)) {
    sharedItems = normalizeSharedItems(input.shared_items || input.sharedItems);
  }
  const document = await upsertDocument(
    orgId,
    CUSTOMER_PORTAL_COLLECTION,
    {
      id: cleanText(portal.id),
      data: {
        ...asObject(portal),
        shared_items: sharedItems,
        status: cleanText(input.status || portal.status || "active") || "active",
        settings: { ...asObject(portal.settings), ...asObject(input.settings) },
        updated_at: now
      },
      metadata: {
        kind: "customer_portal_access",
        project_id: projectId,
        contact_id: cleanText(portal.contact_id),
        public_uuid: portal.public_uuid,
        preview_uuid: portal.preview_uuid
      }
    },
    { replace: true }
  );
  return {
    portal: customerPortalView(document, baseUrl),
    project: ensured.project
  };
}

async function findCustomerPortalByUuid(uuid: string, preview: boolean) {
  const target = cleanText(uuid);
  if (!target) throw badRequest("invalid_portal", "A portal id is required.");
  const orgs = await listOrganizations();
  for (const org of orgs) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    const portals = await listDocuments(orgId, CUSTOMER_PORTAL_COLLECTION).catch(() => []);
    for (const doc of portals) {
      const data = asObject(doc.data);
      const match = preview ? cleanText(data.preview_uuid) : cleanText(data.public_uuid);
      if (match === target) return { orgId, document: doc, data };
    }
  }
  throw forbidden("portal_not_found", "The requested customer portal could not be found.");
}

function publicProjectFirstMeasureId(project: JsonObject) {
  const measurement = asObject(project.measurement_project ?? project.measurement);
  const raw = asObject(measurement.raw);
  return cleanText(measurement.id || measurement.project_id || raw.id || raw.project_id || project.measurement_project_id || project.folder);
}

function publicProjectTopDownSource(project: JsonObject) {
  const measurement = asObject(project.measurement_project ?? project.measurement);
  const raw = asObject(measurement.raw);
  const artifacts = asObject(raw.artifacts);
  const assets = asObject(raw.assets);
  const direct = cleanText(raw.thumbnail_source || raw.thumbnail_artifact_name || project.thumbnail_source || project.thumbnail_artifact_name);
  if (direct) return direct;
  if (artifacts.has_azure_image || assets.azure) return "azure.png";
  if (artifacts.has_apple_image || assets.apple) return "apple.png";
  return "google.png";
}

function publicProjectTopDownThumbnail(project: JsonObject, apiBaseUrl = "") {
  const firstMeasureId = publicProjectFirstMeasureId(project);
  if (!firstMeasureId) return null;
  const source = publicProjectTopDownSource(project);
  const base = cleanText(apiBaseUrl).replace(/\/+$/, "");
  if (!base) return null;
  const params = new URLSearchParams({ w: "640", source });
  const src = `${base}/v1/firstmeasure/projects/${encodeURIComponent(firstMeasureId)}/thumbnail?${params.toString()}`;
  return {
    id: "top_down_thumbnail",
    photo_id: "top_down_thumbnail",
    designator: "top_down_thumbnail",
    kind: "external_image",
    source: "firstmeasure",
    src,
    thumb: src,
    alt: "Top-down satellite image",
    label: "Top-down satellite",
    is_thumbnail: true,
    is_default_thumbnail: true,
    is_top_down_thumbnail: true
  };
}

function publicProjectView(project: JsonObject, apiBaseUrl = "") {
  const contact = projectPrimaryContact(project);
  const address = cleanText(project.address);
  const title = projectDisplayTitle(project, "");
  const displayName = portalDisplayName(contact.name, title && title !== address ? title : "");
  const thumbnail = publicProjectTopDownThumbnail(project, apiBaseUrl);
  return {
    id: cleanText(project.id),
    display_name: displayName,
    title: displayName,
    project_title: title,
    name: displayName,
    address,
    summary: cleanText(project.summary),
    ...(thumbnail ? { thumbnail_photo: thumbnail, top_down_thumbnail: thumbnail, photos: [thumbnail] } : {})
  };
}

function publicProjectAppointment(project: JsonObject) {
  const events = Array.isArray(project.events) ? project.events.map((event) => asObject(event)) : [];
  const appointment = events
    .filter((event) => {
      const type = cleanText(event.event_type_default_id || event.type_id || event.event_type_id || event.kind || event.type).toLowerCase();
      return type === "sales_appointment" || type.includes("sales_appointment") || type.includes("appointment");
    })
    .sort((a, b) => {
      const aTime = Date.parse(cleanText(a.start_at || a.start || a.starts_at)) || 0;
      const bTime = Date.parse(cleanText(b.start_at || b.start || b.starts_at)) || 0;
      return aTime - bTime;
    })[0];
  if (!appointment) return null;
  const assignedUsers = Array.isArray(appointment.assigned_users) ? appointment.assigned_users.map((user) => asObject(user)) : [];
  return {
    id: cleanText(appointment.id),
    title: cleanText(appointment.title || appointment.label || "On-site Appointment"),
    status: cleanText(appointment.status),
    start_at: cleanText(appointment.start_at || appointment.start || appointment.starts_at),
    end_at: cleanText(appointment.end_at || appointment.end),
    duration_minutes: Math.max(0, Math.round(numericValue(appointment.duration_minutes || appointment.duration || 60))),
    assigned_to: assignedUsers
      .map((user) => cleanText(user.name || user.email || user.id))
      .filter(Boolean)
      .slice(0, 4)
  };
}

function proposalPlainText(value: unknown) {
  return cleanText(value)
    .replace(/&lt;br\s*\/?&gt;/gi, "\n")
    .replace(/&lt;\/(div|p|li|h[1-6])&gt;/gi, "\n")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function proposalNumber(value: unknown) {
  const cleaned = cleanText(value).replace(/[^0-9.]/g, "");
  const parts = cleaned.split(".");
  return Number(`${parts[0] || ""}${parts.length > 1 ? "." + parts.slice(1).join("").replaceAll(".", "") : ""}`) || 0;
}

function proposalCurrencyDisplay(value: unknown) {
  const num = proposalNumber(value);
  return `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function publicProposalLineItems(page: JsonObject) {
  return (Array.isArray(page.lineItems) ? page.lineItems : Array.isArray(page.line_items) ? page.line_items : [])
    .map((item) => asObject(item))
    .map((item) => ({
      label: proposalPlainText(item.label),
      quantity: cleanText(item.quantity || "1"),
      unit: cleanText(item.unit),
      unit_price: proposalCurrencyDisplay(item.unitPrice || item.unit_price || 0),
      amount: proposalCurrencyDisplay(item.amount || 0)
    }))
    .filter((item) => item.label || proposalNumber(item.amount));
}

function publicProposalTotals(proposal: JsonObject) {
  const pages = Array.isArray(proposal.pages) ? proposal.pages.map((page) => asObject(page)) : [];
  const subtotal = pages
    .filter((page) => cleanText(page.kind).toLowerCase() === "pricing")
    .reduce((sum, page) => sum + publicProposalLineItems(page).reduce((lineSum, item) => lineSum + proposalNumber(item.amount), 0), 0);
  const signaturePage = pages.find((page) => cleanText(page.kind).toLowerCase() === "signature");
  const tax = signaturePage && signaturePage.showTax !== false ? proposalNumber(signaturePage.taxAmount) : 0;
  return {
    subtotal: proposalCurrencyDisplay(subtotal),
    tax: proposalCurrencyDisplay(tax),
    total: proposalCurrencyDisplay(subtotal + tax)
  };
}

function publicProposalBlocks(page: JsonObject) {
  return (Array.isArray(page.blocks) ? page.blocks : [])
    .map((block) => asObject(block))
    .map((block) => ({
      type: cleanText(block.type || "image_text") || "image_text",
      text: proposalPlainText(block.text),
      image_ids: normalizeStringArray(block.imageIds || block.image_ids)
    }))
    .filter((block) => block.text || block.image_ids.length);
}

function publicProposalPage(pageValue: unknown) {
  const page = asObject(pageValue);
  const kind = cleanText(page.kind || "scope").toLowerCase() || "scope";
  const base: JsonObject = {
    id: cleanText(page.id),
    kind,
    title: proposalPlainText(page.title),
    kicker: proposalPlainText(page.kicker)
  };
  if (kind === "cover") {
    return {
      ...base,
      heading: proposalPlainText(page.heading),
      prepared_for: proposalPlainText(page.preparedFor || page.prepared_for),
      prepared_by: proposalPlainText(page.preparedBy || page.prepared_by),
      date: proposalPlainText(page.date),
      cover_image_ids: normalizeStringArray(page.coverImageIds || page.cover_image_ids)
    };
  }
  if (kind === "pricing") {
    const lineItems = publicProposalLineItems(page);
    return {
      ...base,
      notes: proposalPlainText(page.notes),
      line_items: lineItems,
      total: proposalCurrencyDisplay(page.total || lineItems.reduce((sum, item) => sum + proposalNumber(item.amount), 0))
    };
  }
  if (kind === "signature") {
    return {
      ...base,
      summary: proposalPlainText(page.summary),
      pricing_summary_title: proposalPlainText(page.pricingSummaryTitle || "Contract Amount"),
      payment_schedule_title: proposalPlainText(page.paymentScheduleTitle || "Payment Schedule"),
      customer_signature_label: proposalPlainText(page.customerSignatureLabel || "Customer Signature"),
      customer_printed_name: proposalPlainText(page.customerPrintedNameValue || page.customer_printed_name),
      company_signature_label: proposalPlainText(page.companySignatureLabel || "Company Representative Signature"),
      company_representative: proposalPlainText(page.companyRepresentativeValue || page.company_representative),
      date_label: proposalPlainText(page.dateLabel || "Date"),
      date_value: proposalPlainText(page.dateValue || page.date_value),
      deposit_label: proposalPlainText(page.depositLabel || "Deposit Amount"),
      deposit_amount: cleanText(page.deposit_amount) || proposalCurrencyDisplay(page.depositAmount || 0),
      completion_label: proposalPlainText(page.completionLabel || "Balance During Completion"),
      completion_amount: cleanText(page.completion_amount) || proposalCurrencyDisplay(page.completionAmount || 0),
      financed_label: proposalPlainText(page.financedLabel || "Amount Financed"),
      financed_amount: cleanText(page.financed_amount) || proposalCurrencyDisplay(page.financedAmount || 0),
      show_tax: page.showTax !== false,
      tax_amount: cleanText(page.tax_amount) || proposalCurrencyDisplay(page.taxAmount || 0),
      signed: Object.keys(asObject(page.signedSlots)).length > 0
    };
  }
  if (kind === "fine_print") {
    return {
      ...base,
      summary: proposalPlainText(page.summary),
      body: proposalPlainText(page.body),
      customer_signature_label: proposalPlainText(page.customerSignatureLabel || "Customer Signature"),
      customer_printed_name: proposalPlainText(page.customerPrintedNameValue),
      require_customer_signature: page.requireCustomerSignature !== false,
      signed: Object.keys(asObject(page.signedSlots)).length > 0
    };
  }
  return {
    ...base,
    summary: proposalPlainText(page.summary),
    body: proposalPlainText(page.body),
    blocks: publicProposalBlocks(page)
  };
}

function publicProposalView(proposalValue: unknown, index = 0) {
  const proposal = asObject(proposalValue);
  const status = cleanText(proposal.status || "draft").toLowerCase() || "draft";
  const pages = (Array.isArray(proposal.pages) ? proposal.pages : [])
    .filter((page) => asObject(page).enabled !== false)
    .map(publicProposalPage)
    .filter((page) => asObject(page).kind);
  const totals = Object.keys(asObject(proposal.totals)).length ? asObject(proposal.totals) : publicProposalTotals(proposal);
  return {
    id: cleanText(proposal.id) || `proposal_${index + 1}`,
    proposal_id: cleanText(proposal.proposal_id || proposal.proposalId),
    snapshot_id: cleanText(proposal.snapshot_id || proposal.snapshotId || proposal.id),
    public_token: cleanText(proposal.public_token || proposal.publicToken),
    app_url: cleanText(proposal.app_url || proposal.appUrl),
    title: proposalPlainText(proposal.title) || `Proposal ${index + 1}`,
    status,
    created_at: cleanText(proposal.created_at || proposal.createdAt),
    sent_at: cleanText(proposal.sent_at || proposal.sentAt),
    pdf_url: cleanText(proposal.pdf_url || proposal.pdfUrl || proposal.download_url || proposal.downloadUrl || asObject(proposal.pdf).url || asObject(proposal.pdf).pdf_url),
    pdf: asObject(proposal.pdf),
    document_html: cleanText(proposal.document_html || proposal.documentHtml),
    address: proposalPlainText(proposal.address),
    notes: proposalPlainText(proposal.notes),
    theme: cleanText(proposal.theme || "margin") || "margin",
    totals,
    workflow: asObject(proposal.workflow),
    pages
  };
}

async function publicProjectProposals(project: JsonObject, preview = false) {
  const proposals = Array.isArray(project.proposals) ? project.proposals.map(publicProposalView) : [];
  const visible = proposals.filter((proposal) => cleanText(asObject(proposal).status).toLowerCase() !== "discarded");
  const sent = visible.filter((proposal) => ["sent", "viewed", "signed"].includes(cleanText(asObject(proposal).status).toLowerCase()));
  const selected = sent.slice(0, 12);
  return Promise.all(selected.map(async (proposal) => {
    const token = cleanText(asObject(proposal).public_token);
    if (!token) return proposal;
    const workflow = await publicProposalWorkflow(token).catch(() => null);
    const snapshotProposal = asObject(asObject(workflow?.workflow).proposal);
    if (!Object.keys(snapshotProposal).length) return proposal;
    return {
      ...proposal,
      ...snapshotProposal,
      workflow: {
        ...asObject(asObject(proposal).workflow),
        ...asObject(snapshotProposal.workflow),
        payment: {
          ...asObject(asObject(asObject(proposal).workflow).payment),
          ...asObject(asObject(snapshotProposal.workflow).payment),
          ...asObject(asObject(workflow?.workflow).payment)
        }
      }
    };
  }));
}

function absoluteApiAssetUrl(value: unknown, apiBaseUrl: string) {
  const text = cleanText(value);
  if (!text || /^(https?:|data:)/i.test(text)) return text;
  const base = cleanText(apiBaseUrl).replace(/\/v1\/platform\/?$/, "").replace(/\/+$/, "");
  if (text.startsWith("/")) return base ? `${base}${text}` : text;
  return text;
}

function publicPortalLogoAssetUrl(value: unknown, apiBaseUrl: string): string {
  if (value && typeof value === "object") {
    const item = asObject(value);
    return publicPortalLogoAssetUrl(item.logo || item.logo_node_url || item.logoNodeUrl || item.logo_url || item.logoUrl || item.url || item.src, apiBaseUrl);
  }
  const text = cleanText(value);
  if (!text || text === "[object Object]") return "";
  const logo = text.replace(/\/file(\?|$)/, "/logo$1");
  if (/^data:/i.test(logo)) return logo;
  if (/^https?:\/\//i.test(logo)) {
    try {
      const parsed = new URL(logo);
      if (parsed.pathname.startsWith("/v1/platform/")) return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return logo;
    }
    return logo;
  }
  if (logo.startsWith("/v1/platform/")) return logo;
  return absoluteApiAssetUrl(logo, apiBaseUrl);
}

function publicPortalLogoMediaId(value: unknown): string {
  if (value && typeof value === "object") {
    const item = asObject(value);
    return cleanText(item.media_id || item.mediaId || item.id || item._id);
  }
  return cleanText(value);
}

function publicPortalBrandingLogoUrl(branding: JsonObject, orgId: string, apiBaseUrl: string) {
  for (const value of [
    branding.logo,
    branding.logo_node_url,
    branding.logoNodeUrl,
    branding.logo_url,
    branding.logoUrl,
    branding.companyLogo,
    branding.brandLogo
  ]) {
    const logo = publicPortalLogoAssetUrl(value, apiBaseUrl);
    if (logo) return logo;
  }
  for (const value of [branding.logo_media_id, branding.logoMediaId, branding.logo_media, branding.logoMedia]) {
    const mediaId = publicPortalLogoMediaId(value);
    if (mediaId) {
      return `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(mediaId)}/logo`;
    }
  }
  return "";
}

function isLegacyImportedLogoUrl(value: unknown) {
  const text = cleanText(value).replace(/^\/+/, "");
  if (!text) return false;
  return text.startsWith("organizations/") && /\/logo(?:\.png)?(?:$|\?)/i.test(text);
}

function publicPortalBrandColor(fallback: string, ...values: unknown[]) {
  for (const value of values) {
    let text = cleanText(value);
    if (!text) continue;
    if (!text.startsWith("#")) text = `#${text}`;
    if (/^#[0-9A-Fa-f]{6}$/.test(text)) return text.toUpperCase();
  }
  return fallback;
}

function portalMediaUrl(baseUrl: string, uuid: string, mediaId: string, preview: boolean, variant = "original") {
  const prefix = preview ? "customer-portals/preview" : "customer-portals";
  return portalPublicUrl(baseUrl, `v1/platform/${prefix}/${encodeURIComponent(uuid)}/media/${encodeURIComponent(mediaId)}/file?variant=${encodeURIComponent(variant)}`);
}

function customerPortalContactId(data: JsonObject, project: JsonObject = {}) {
  const customer = asObject(data.customer);
  const projectContact = projectPrimaryContact(project);
  return cleanText(data.contact_id || data.contactId || customer.id || customer.contact_id || projectContact.id || projectContact.contact_id);
}

function publicPortalMedia(projectData: JsonObject, portalData: JsonObject, portalUuid: string, preview: boolean, apiBaseUrl: string) {
  const sharedMediaIds = new Set(normalizeSharedItems(portalData.shared_items).filter((item) => item.type === "media").map((item) => item.item_id));
  const photos: JsonObject[] = Array.isArray(projectData.photos) ? projectData.photos.map((item: unknown) => asObject(item)) : [];
  return photos
    .filter((item) => sharedMediaIds.has(mediaReferenceId(item)))
    .map((item) => {
      const mediaId = mediaReferenceId(item);
      const kind = cleanText(item.media_type || item.kind || item.type || (cleanText(item.mime_type).startsWith("video/") ? "video" : "image")) || "image";
      return {
        id: mediaId,
        media_id: mediaId,
        kind,
        media_type: kind,
        label: cleanText(item.label || item.alt || item.file_name || (kind === "video" ? "Video" : "Photo")),
        uploaded_at: cleanText(item.uploaded_at || asObject(item.metadata).uploaded_at),
        thumb: portalMediaUrl(apiBaseUrl, portalUuid, mediaId, preview, cleanText(item.thumbnail_variant || "thumb_320") || "thumb_320"),
        src: portalMediaUrl(apiBaseUrl, portalUuid, mediaId, preview, "original")
      };
    });
}

async function publicPortalResources(project: JsonObject, preview: boolean) {
  return {
    // Keep public serializers narrow: never expose raw project documents or private internal project fields.
    proposals: await publicProjectProposals(project, preview),
    appointment: publicProjectAppointment(project),
    documents: [],
    payments: [],
    signatures: []
  };
}

async function publicPortalProjectBundle(document: JsonObject, portalData: JsonObject, project: JsonObject, preview: boolean, baseUrl: string, apiBaseUrl: string) {
  const portalUuid = cleanText(preview ? portalData.preview_uuid : portalData.public_uuid);
  return {
    portal: {
      id: cleanText(document.id),
      project_id: cleanText(portalData.project_id),
      status: cleanText(portalData.status || "active"),
      public_uuid: preview ? "" : cleanText(portalData.public_uuid),
      preview_uuid: preview ? cleanText(portalData.preview_uuid) : "",
      live_url: publicPortalUrl(cleanText(portalData.public_uuid), baseUrl, false),
      preview_url: publicPortalUrl(cleanText(portalData.preview_uuid), baseUrl, true)
    },
    project: publicProjectView(project, apiBaseUrl),
    media: publicPortalMedia(project, portalData, portalUuid, preview, apiBaseUrl),
    resources: await publicPortalResources(project, preview)
  };
}

async function publicCustomerPortalBranding(orgId: string, project: JsonObject, org: JsonObject, apiBaseUrl: string) {
  const organizationBranding = asObject(org.branding);
  let branding = organizationBranding;
  const branchId = cleanText(project.branch_id || project.branchId || "default") || "default";
  try {
    const branch = await readDocument(orgId, "branch", branchId);
    const branchBranding = asObject(asObject(branch.data).branding);
    if (Object.keys(branchBranding).length) {
      branding = {
        ...branding,
        ...branchBranding,
        colors: { ...asObject(branding.colors), ...asObject(branchBranding.colors) }
      };
    }
  } catch {
    // Branch branding is optional; organization branding remains the fallback.
  }
  try {
    const style = await readBranchModule(orgId, branchId, "presentation_style");
    const styleBranding = asObject(asObject(style.data).branding);
    if (Object.keys(styleBranding).length) {
      branding = {
        ...branding,
        ...styleBranding,
        colors: { ...asObject(branding.colors), ...asObject(styleBranding.colors) }
      };
    }
  } catch {
    // Presentation style is optional and may not exist for older organizations.
  }
  const colors = asObject(branding.colors);
  const mergedLogo = publicPortalBrandingLogoUrl(branding, orgId, apiBaseUrl);
  const organizationLogo = publicPortalBrandingLogoUrl(organizationBranding, orgId, apiBaseUrl);
  const logo = isLegacyImportedLogoUrl(mergedLogo) && organizationLogo && !isLegacyImportedLogoUrl(organizationLogo)
    ? organizationLogo
    : mergedLogo;
  return {
    ...branding,
    logo,
    logo_node_url: logo,
    colors: {
      primary: publicPortalBrandColor("#2563EB", colors.primary, branding.primary, colors.brand, branding.brand, colors.accent, branding.accent),
      secondary: publicPortalBrandColor("#111111", colors.secondary, branding.secondary),
      accent: publicPortalBrandColor("#2563EB", colors.accent, branding.accent, colors.primary, branding.primary)
    }
  };
}

async function publicCustomerPortalPayload(uuid: string, preview: boolean, baseUrl: string, authOrgId = "", apiBaseUrl = baseUrl) {
  const found = await findCustomerPortalByUuid(uuid, preview);
  if (preview && authOrgId !== found.orgId) {
    throw forbidden("preview_requires_staff_session", "Preview links require a staff session for the same organization.");
  }
  const data = asObject(found.document.data);
  if (!preview && cleanText(data.status || "active") !== "active") {
    throw forbidden("portal_inactive", "This customer portal is not active.");
  }
  const projectDoc = await readDocument(found.orgId, "projects", cleanText(data.project_id));
  const projectData = asObject(projectDoc.data);
  const project = { id: projectDoc.id, ...projectData };
  const org = await portalOrgView(found.orgId);
  const branding = await publicCustomerPortalBranding(found.orgId, project, org, apiBaseUrl);
  const customer = mergeCustomerContact(asObject(data.customer), projectPrimaryContact(project));
  const activeBundle = await publicPortalProjectBundle(found.document, data, project, preview, baseUrl, apiBaseUrl);
  const contactId = customerPortalContactId(data, project);
  const projectBundles: JsonObject[] = [];
  const seenProjectIds = new Set<string>();
  if (contactId) {
    const portals = await listDocuments(found.orgId, CUSTOMER_PORTAL_COLLECTION).catch(() => []);
    for (const portalDoc of portals) {
      const portalData = asObject(portalDoc.data);
      if (customerPortalContactId(portalData) !== contactId) continue;
      if (!preview && cleanText(portalData.status || "active") !== "active") continue;
      const siblingProjectId = cleanText(portalData.project_id);
      if (!siblingProjectId || seenProjectIds.has(siblingProjectId)) continue;
      try {
        const siblingProjectDoc = await readDocument(found.orgId, "projects", siblingProjectId);
        const siblingProjectData = asObject(siblingProjectDoc.data);
        const siblingProject = { id: siblingProjectDoc.id, ...siblingProjectData };
        projectBundles.push(await publicPortalProjectBundle(portalDoc, portalData, siblingProject, preview, baseUrl, apiBaseUrl));
        seenProjectIds.add(siblingProjectId);
      } catch {
        // Ignore stale portal records that point at projects that no longer exist.
      }
    }
  }
  if (!seenProjectIds.has(project.id)) {
    projectBundles.unshift(activeBundle);
    seenProjectIds.add(project.id);
  }
  projectBundles.sort((a, b) => {
    const aActive = cleanText(asObject(asObject(a).project).id) === project.id;
    const bActive = cleanText(asObject(asObject(b).project).id) === project.id;
    return Number(bActive) - Number(aActive);
  });
  return {
    preview,
    portal: {
      id: found.document.id,
      status: cleanText(data.status || "active"),
      public_uuid: preview ? "" : cleanText(data.public_uuid),
      preview_uuid: preview ? cleanText(data.preview_uuid) : "",
      customer,
      contact_id: contactId,
      active_project_id: project.id
    },
    organization: {
      id: found.orgId,
      name: cleanText(org.name),
      branding,
      contact: asObject(org.contact)
    },
    project: activeBundle.project,
    media: activeBundle.media,
    resources: activeBundle.resources,
    projects: projectBundles,
    contact_portal: {
      contact_id: contactId,
      customer,
      active_project_id: project.id,
      projects: projectBundles
    }
  };
}

async function recordCustomerPortalEvent(uuid: string, body: JsonObject, request: FastifyRequest) {
  const found = await findCustomerPortalByUuid(uuid, false);
  const data = asObject(found.document.data);
  if (cleanText(data.status || "active") !== "active") throw forbidden("portal_inactive", "This customer portal is not active.");
  const type = cleanText(body.type || body.event || "portal.event") || "portal.event";
  const now = new Date().toISOString();
  const requestMetadata = acquisitionRequestMetadata(request);
  const visitorIp = cleanText(requestMetadata.client_ip || request.ip);
  const userAgent = cleanText(request.headers["user-agent"]);
  const event = {
    type: `customer_portal.${type.replace(/^customer_portal\./, "")}`,
    project_id: cleanText(data.project_id),
    portal_id: found.document.id,
    portal_uuid: cleanText(data.public_uuid),
    preview: false,
    media_id: cleanText(body.media_id || body.mediaId),
    proposal_id: cleanText(body.proposal_id || body.proposalId),
    project_switch_id: cleanText(body.project_id || body.projectId),
    step: cleanText(body.step),
    tab: cleanText(body.tab),
    path: cleanText(body.path),
    href: cleanText(body.href),
    referrer: requestHeaderText(request, "referer"),
    visitor_session_id: cleanText(body.visitor_session_id || body.visitorSessionId),
    visitor_ip: visitorIp,
    ip_address: visitorIp,
    user_agent: userAgent,
    user_agent_hash: createHash("sha256").update(userAgent).digest("hex").slice(0, 16),
    accept_language: requestHeaderText(request, "accept-language"),
    request_host: cleanText(requestMetadata.host || requestMetadata.request_host),
    forwarded_host: cleanText(requestMetadata.forwarded_host),
    country: cleanText(requestMetadata.cf_ipcountry || requestMetadata.x_vercel_ip_country || requestMetadata.x_appengine_country),
    region: cleanText(requestMetadata.cf_region || requestMetadata.x_vercel_ip_country_region || requestMetadata.x_appengine_region),
    city: cleanText(requestMetadata.cf_city || requestMetadata.x_vercel_ip_city || requestMetadata.x_appengine_city),
    metadata: { ...asObject(body.metadata), request: requestMetadata },
    created_at: now
  };
  await upsertDocument(
    found.orgId,
    "activity",
    {
      data: event,
      metadata: {
        kind: "customer_portal_event",
        project_id: event.project_id,
        portal_id: event.portal_id,
        media_id: event.media_id,
        source: "customer_portal"
      }
    },
    { replace: true }
  );
  return event;
}

async function listCustomerPortalActivity(orgId: string, projectId: string) {
  const documents = await listDocuments(orgId, "activity").catch(() => []);
  return documents
    .map((document) => {
      const data = asObject(document.data);
      const metadata = asObject(document.metadata);
      return { id: document.id, ...data, metadata, created_at: cleanText(data.created_at || document.created_at) };
    })
    .filter((event) => {
      const eventData = asObject(event);
      const metadata = asObject(event.metadata);
      return cleanText(eventData.project_id || metadata.project_id) === projectId && cleanText(metadata.kind) === "customer_portal_event";
    })
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

async function sendCustomerPortalMedia(reply: FastifyReply, uuid: string, mediaId: string, preview: boolean, request: FastifyRequest, authOrgId = "") {
  const found = await findCustomerPortalByUuid(uuid, preview);
  if (preview && authOrgId !== found.orgId) {
    throw forbidden("preview_requires_staff_session", "Preview links require a staff session for the same organization.");
  }
  const data = asObject(found.document.data);
  if (!preview && cleanText(data.status || "active") !== "active") throw forbidden("portal_inactive", "This customer portal is not active.");
  const shared = new Set(normalizeSharedItems(data.shared_items).filter((item) => item.type === "media").map((item) => item.item_id));
  const normalizedMediaId = cleanText(mediaId);
  if (!shared.has(normalizedMediaId)) throw forbidden("media_not_shared", "This media item is not shared with the customer portal.");
  const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
  const variant = cleanText(query.variant || "original") || "original";
  let file;
  try {
    file = await readMediaFile(found.orgId, normalizedMediaId, variant);
  } catch (error) {
    if (variant === "original") throw error;
    file = await readMediaFile(found.orgId, normalizedMediaId, "original");
  }
  reply.header("Content-Type", file.contentType);
  reply.header("Content-Disposition", `inline; filename="${String(file.fileName).replace(/"/g, "")}"`);
  return reply.send(file.bytes);
}

function docFirstText(...values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (text) return text;
  }
  return "";
}

function projectDocumentIdentity(item: JsonObject = {}) {
  return docFirstText(item.id, item.document_id, item.media_id, item.mediaId, item.url, item.href);
}

function documentTypeMeta(typeValue: unknown) {
  const type = cleanText(typeValue || "document").toLowerCase().replace(/[\s-]+/g, "_");
  if (type === "proposal") return { type, label: "Proposal", icon: "fa-file-signature", color: "#2563eb" };
  if (type === "change_order" || type === "changeorder") return { type: "change_order", label: "Change Order", icon: "fa-file-contract", color: "#7c3aed" };
  if (type === "roof_report" || type === "report" || type === "measurement_report") return { type: "roof_report", label: "Roof Report", icon: "fa-ruler-combined", color: "#059669" };
  if (type === "customer_report" || type === "summary") return { type: "customer_report", label: "Customer Report", icon: "fa-file-lines", color: "#0891b2" };
  if (type === "instant_report") return { type, label: "Instant Report", icon: "fa-bolt", color: "#ca8a04" };
  if (type === "weather_report") return { type, label: "Weather Report", icon: "fa-cloud-sun-rain", color: "#0d9488" };
  if (type === "required") return { type, label: "Required", icon: "fa-clipboard-check", color: "#dc2626" };
  return { type: type || "document", label: "Document", icon: "fa-file-lines", color: "#64748b" };
}

function documentReferenceFromMedia(media: JsonObject = {}, extra: JsonObject = {}) {
  const mediaId = cleanText(media.id || media.media_id);
  const meta = asObject(media.metadata);
  return {
    id: mediaId || cleanText(extra.id),
    document_id: mediaId || cleanText(extra.id),
    media_id: mediaId,
    kind: "media_reference",
    title: docFirstText(extra.title, meta.title, media.file_name, "Document"),
    label: docFirstText(extra.label, extra.title, meta.label, meta.title, media.file_name, "Document"),
    document_type: docFirstText(extra.document_type, meta.document_type, meta.type, "document"),
    source: docFirstText(extra.source, meta.source, "project_document_upload"),
    file_name: docFirstText(media.file_name, extra.file_name),
    content_type: docFirstText(media.content_type, extra.content_type),
    mime_type: docFirstText(media.content_type, extra.mime_type),
    size_bytes: Number(media.size_bytes || extra.size_bytes || 0) || 0,
    variant: "original",
    uploaded_at: docFirstText(meta.uploaded_at, media.created_at),
    updated_at: docFirstText(media.updated_at, media.created_at),
    metadata: { ...meta, ...asObject(extra.metadata) }
  };
}

function normalizeProjectDocumentReference(input: unknown) {
  const doc = asObject(input);
  const metadata = asObject(doc.metadata);
  const meta = documentTypeMeta(doc.document_type || doc.type || metadata.document_type || metadata.type);
  const id = projectDocumentIdentity(doc) || `doc_${Date.now()}`;
  return {
    ...doc,
    id,
    document_id: docFirstText(doc.document_id, id),
    title: docFirstText(doc.title, doc.label, metadata.title, metadata.label, "Document"),
    label: docFirstText(doc.label, doc.title, metadata.label, metadata.title, "Document"),
    document_type: meta.type,
    type: meta.type,
    type_label: meta.label,
    icon: docFirstText(doc.icon, meta.icon),
    color: docFirstText(doc.color, meta.color),
    media_id: docFirstText(doc.media_id, doc.mediaId),
    url: docFirstText(doc.url, doc.href, doc.src),
    file_name: docFirstText(doc.file_name, doc.fileName, metadata.file_name),
    content_type: docFirstText(doc.content_type, doc.contentType, doc.mime_type, doc.mimeType, metadata.content_type),
    mime_type: docFirstText(doc.mime_type, doc.mimeType, doc.content_type, doc.contentType, metadata.mime_type),
    size_bytes: Number(doc.size_bytes || doc.sizeBytes || metadata.size_bytes || 0) || 0,
    special: Boolean(doc.special),
    required: Boolean(doc.required),
    interactive: doc.interactive !== false,
    metadata
  } as JsonObject;
}

function normalizeProjectUploadedDocuments(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map(normalizeProjectDocumentReference)
    .filter((item) => projectDocumentIdentity(item));
}

function proposalIsSigned(proposal: JsonObject = {}) {
  const delivery = asObject(proposal.delivery);
  return cleanText(proposal.status).toLowerCase() === "signed"
    || cleanText(delivery.state).toLowerCase() === "signed"
    || !!docFirstText(proposal.signed_at, proposal.customer_signed_at, delivery.signed_at);
}

function proposalDocumentType(proposal: JsonObject = {}) {
  const text = docFirstText(proposal.document_type, proposal.type, proposal.kind, proposal.title, proposal.name).toLowerCase();
  return text.includes("change") && text.includes("order") ? "change_order" : "proposal";
}

function proposalPdfMediaRef(proposal: JsonObject = {}) {
  const pdf = asObject(proposal.pdf);
  const latest = asObject(pdf.latest_media_ref);
  const signed = asObject(pdf.signed_media_ref);
  const ref = cleanText(signed.media_id || signed.id) ? signed : latest;
  return cleanText(ref.media_id || ref.id) ? ref : {};
}

function proposalDocument(orgId: string, proposal: JsonObject = {}) {
  const proposalId = docFirstText(proposal.proposal_id, proposal.proposalId, proposal.id);
  if (!proposalId || !proposalIsSigned(proposal)) return null;
  const type = proposalDocumentType(proposal);
  const ref = proposalPdfMediaRef(proposal);
  const pdf = asObject(proposal.pdf);
  const signedRef = asObject(pdf.signed_media_ref);
  const signedMediaId = docFirstText(signedRef.media_id, signedRef.id, pdf.signed_media_id);
  const snapshotId = docFirstText(proposal.snapshot_id, pdf.latest_snapshot_id, asObject(proposal.delivery).current_snapshot_id);
  const url = snapshotId
    ? `/v1/proposals/organizations/${encodeURIComponent(orgId)}/proposals/${encodeURIComponent(proposalId)}/pdf?snapshot_id=${encodeURIComponent(snapshotId)}`
    : signedMediaId
      ? `/v1/proposals/organizations/${encodeURIComponent(orgId)}/proposals/${encodeURIComponent(proposalId)}/pdf?media_id=${encodeURIComponent(signedMediaId)}`
      : `/v1/proposals/organizations/${encodeURIComponent(orgId)}/proposals/${encodeURIComponent(proposalId)}/pdf`;
  return normalizeProjectDocumentReference({
    id: `${type}_${proposalId}`,
    proposal_id: proposalId,
    title: docFirstText(proposal.title, proposal.name, type === "change_order" ? "Signed Change Order" : "Signed Proposal"),
    document_type: type,
    media_id: "",
    url,
    file_name: docFirstText(ref.file_name, `${type === "change_order" ? "change-order" : "proposal"}.pdf`),
    content_type: "application/pdf",
    size_bytes: Number(ref.size_bytes || 0) || 0,
    special: true,
    source: "proposal",
    related: { tab: "proposal", label: type === "change_order" ? "View Change Order" : "View Proposal", proposal_id: proposalId },
    updated_at: docFirstText(proposal.updated_at, proposal.signed_at, proposal.created_at),
    metadata: { source: "proposal", proposal_id: proposalId, signed_media_id: signedMediaId, snapshot_id: snapshotId }
  });
}

function addReportDocument(docs: JsonObject[], input: JsonObject) {
  const url = docFirstText(input.url);
  if (!url) return;
  const documentType = docFirstText(input.document_type, "report");
  const relatedLabel = documentType === "roof_report" || documentType === "measurement_report"
    ? "View Roof Report"
    : documentType === "customer_report"
      ? "View Customer Report"
      : documentType === "instant_report"
        ? "View Instant Report"
        : documentType === "weather_report"
          ? "View Weather Report"
          : "View Report";
  docs.push(normalizeProjectDocumentReference({
    ...input,
    id: docFirstText(input.id) || `${documentType}_${docs.length + 1}`,
    special: true,
    source: docFirstText(input.source, "report"),
    content_type: docFirstText(input.content_type, "application/pdf"),
    related: { tab: "measurements", label: relatedLabel, ...(asObject(input.related)) },
    metadata: { source: docFirstText(input.source, "report"), ...(asObject(input.metadata)) }
  }));
}

function projectReportDocuments(projectData: JsonObject = {}) {
  const docs: JsonObject[] = [];
  const measurement = asObject(projectData.measurement_project || projectData.measurement);
  const raw = asObject(measurement.raw);
  addReportDocument(docs, {
    id: "roof_report_pdf",
    title: "Roof Measurement Report",
    document_type: "roof_report",
    url: docFirstText(projectData.report_url, projectData.pdf_url, measurement.report_url, measurement.pdf_url, raw.report_url, raw.pdf_url)
  });
  addReportDocument(docs, {
    id: "customer_report_pdf",
    title: "Customer Report",
    document_type: "customer_report",
    url: docFirstText(projectData.summary_url, measurement.summary_url, raw.summary_url)
  });
  addReportDocument(docs, {
    id: "instant_report_pdf",
    title: "Instant Report",
    document_type: "instant_report",
    url: docFirstText(projectData.instant_pdf_url, measurement.instant_pdf_url, raw.instant_pdf_url, asObject(projectData.assets).instant_pdf_url, asObject(asObject(projectData.instant).assets).instant_pdf_url)
  });
  addReportDocument(docs, {
    id: "weather_report_pdf",
    title: "Weather Report",
    document_type: "weather_report",
    url: docFirstText(projectData.weather_report_pdf_url, measurement.weather_report_pdf_url, raw.weather_report_pdf_url)
  });
  return docs;
}

async function projectProposalDocuments(orgId: string, projectData: JsonObject = {}) {
  const projectId = docFirstText(projectData.id, projectData.platform_project_id, projectData.base_project_id);
  const candidates: JsonObject[] = [];
  for (const proposal of Array.isArray(projectData.proposals) ? projectData.proposals : []) candidates.push(asObject(proposal));
  const linkedIds = new Set((Array.isArray(projectData.proposal_ids) ? projectData.proposal_ids : [])
    .map((value) => cleanText(value))
    .filter(Boolean));
  const activeProposalId = cleanText(projectData.active_proposal_id || projectData.proposal_id);
  if (activeProposalId) linkedIds.add(activeProposalId);
  try {
    const documents = await listDocuments(orgId, "proposals");
    documents.forEach((document) => {
      const data = asObject(document.data);
      const id = docFirstText(data.id, document.id);
      if (projectId && docFirstText(data.project_id) === projectId) candidates.push({ ...data, id });
      else if (id && linkedIds.has(id)) candidates.push({ ...data, id });
    });
  } catch {
    // Proposal docs are opportunistic here; local project proposals still render.
  }
  const seen = new Set<string>();
  const docs: JsonObject[] = [];
  for (const candidate of candidates) {
    const item = proposalDocument(orgId, candidate);
    if (!item) continue;
    const id = projectDocumentIdentity(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    docs.push(item);
  }
  return docs;
}

async function projectDocumentsPayload(orgId: string, projectDocument: JsonObject) {
  const project = asObject(projectDocument.data);
  const uploaded = normalizeProjectUploadedDocuments(project.documents);
  const special = [
    ...(await projectProposalDocuments(orgId, project)),
    ...projectReportDocuments(project)
  ];
  const seen = new Set<string>();
  const documents = [...special, ...uploaded].filter((item) => {
    const id = projectDocumentIdentity(item);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return {
    project_id: docFirstText(project.id, projectDocument.id),
    documents,
    special_documents: special,
    uploaded_documents: uploaded
  };
}

function collectionReadPermission(collection: string) {
  if (collection === "users") return "manage_company_users|manage_users|manage_sales_users";
  if (collection === CUSTOMER_PORTAL_COLLECTION) return "view_reports";
  return undefined;
}

function collectionWritePermission(collection: string) {
  if (collection === "users") return "manage_company_users|manage_users|manage_sales_users";
  if (collection === "branch") return "manage_company_settings";
  if (collection === CUSTOMER_PORTAL_COLLECTION) return "manage_projects|order_reports|view_reports";
  return undefined;
}

function branchModuleWritePermission(moduleId: string) {
  if (moduleId === "pricebook" || moduleId === "presentation_style") return "manage_company_settings";
  return undefined;
}

function asObject(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function parseJsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return asObject(value);
  const text = cleanText(value);
  if (!text || !text.startsWith("{")) return {};
  try {
    return asObject(JSON.parse(text));
  } catch {
    return {};
  }
}

function compactObject(input: JsonObject) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value == null) return false;
    if (typeof value === "string") return cleanText(value) !== "";
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "boolean") return true;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(asObject(value)).length > 0;
    return true;
  }));
}

function requestHeaderText(request: FastifyRequest, name: string) {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.map((entry) => cleanText(entry)).filter(Boolean).join(", ");
  return cleanText(value);
}

function firstForwardedIp(value: string) {
  return cleanText(value.split(",")[0]);
}

function acquisitionRequestMetadata(request: FastifyRequest) {
  const forwardedFor = requestHeaderText(request, "x-forwarded-for");
  const selectedHeaders = [
    "user-agent",
    "accept-language",
    "referer",
    "origin",
    "host",
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-real-ip",
    "true-client-ip",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-region",
    "cf-ipcity",
    "cf-postal-code",
    "cf-timezone",
    "x-vercel-ip-country",
    "x-vercel-ip-country-region",
    "x-vercel-ip-city",
    "x-vercel-ip-latitude",
    "x-vercel-ip-longitude",
    "x-appengine-country",
    "x-appengine-region",
    "x-appengine-city",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-ch-ua-platform-version",
    "sec-ch-ua-model"
  ];
  const headers: JsonObject = {};
  for (const header of selectedHeaders) {
    const value = requestHeaderText(request, header);
    if (value) headers[header] = value;
  }
  const metadata = compactObject({
    request_received_at: new Date().toISOString(),
    request_ip: cleanText(request.ip),
    client_ip: requestHeaderText(request, "cf-connecting-ip")
      || requestHeaderText(request, "true-client-ip")
      || requestHeaderText(request, "x-real-ip")
      || firstForwardedIp(forwardedFor)
      || cleanText(request.ip),
    forwarded_for: forwardedFor,
    forwarded_proto: requestHeaderText(request, "x-forwarded-proto"),
    forwarded_host: requestHeaderText(request, "x-forwarded-host"),
    real_ip: requestHeaderText(request, "x-real-ip"),
    remote_address: cleanText(request.raw.socket?.remoteAddress),
    user_agent: requestHeaderText(request, "user-agent"),
    accept_language: requestHeaderText(request, "accept-language"),
    request_referrer: requestHeaderText(request, "referer"),
    origin: requestHeaderText(request, "origin"),
    host: requestHeaderText(request, "host"),
    request_host: request.hostname,
    request_protocol: request.protocol,
    request_url: request.url,
    cf_connecting_ip: requestHeaderText(request, "cf-connecting-ip"),
    cf_ipcountry: requestHeaderText(request, "cf-ipcountry"),
    cf_region: requestHeaderText(request, "cf-region"),
    cf_city: requestHeaderText(request, "cf-ipcity"),
    cf_postal_code: requestHeaderText(request, "cf-postal-code"),
    cf_timezone: requestHeaderText(request, "cf-timezone"),
    x_vercel_ip_country: requestHeaderText(request, "x-vercel-ip-country"),
    x_vercel_ip_country_region: requestHeaderText(request, "x-vercel-ip-country-region"),
    x_vercel_ip_city: requestHeaderText(request, "x-vercel-ip-city"),
    x_vercel_ip_latitude: requestHeaderText(request, "x-vercel-ip-latitude"),
    x_vercel_ip_longitude: requestHeaderText(request, "x-vercel-ip-longitude"),
    x_appengine_country: requestHeaderText(request, "x-appengine-country"),
    x_appengine_region: requestHeaderText(request, "x-appengine-region"),
    x_appengine_city: requestHeaderText(request, "x-appengine-city"),
    headers
  });
  return metadata;
}

function withAcquisitionRequestMetadata(input: JsonObject, request?: FastifyRequest) {
  if (!request) return input;
  const requestMetadata = acquisitionRequestMetadata(request);
  return {
    ...input,
    ...Object.fromEntries(Object.entries(requestMetadata).filter(([, value]) => typeof value !== "object")),
    metadata: compactObject({
      ...parseJsonObject(input.metadata),
      request: requestMetadata
    })
  };
}

function extractDataBody(body: Record<string, unknown>) {
  if (body.data && typeof body.data === "object" && !Array.isArray(body.data)) return body.data as Record<string, unknown>;
  return body;
}

function extractMetadataBody(body: Record<string, unknown>) {
  return body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? body.metadata as Record<string, unknown>
    : {};
}

function tryParseJsonField(value: unknown, fallback: unknown = undefined) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (!/^[\[{"]/u.test(trimmed) && !/^(true|false|null|-?\d)/u.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    return fallback;
  }
}

function parseBooleanField(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  return ["1", "true", "yes", "on"].includes(normalized);
}

async function parsePortalActionRequest(request: unknown) {
  const typed = request as {
    headers?: Record<string, unknown>;
    body?: unknown;
    parts?: () => AsyncIterable<{
      type: "file" | "field";
      fieldname: string;
      value?: unknown;
      filename?: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
    }>;
  };
  const contentType = String(typed.headers?.["content-type"] ?? "");
  if (!contentType.includes("multipart/form-data")) return objectBodySchema.parse(typed.body ?? {});

  const fields: JsonObject = {};
  let file: JsonObject | null = null;
  const parts = typed.parts?.();
  if (!parts) throw badRequest("multipart_unavailable", "Multipart uploads are unavailable on this route.");
  for await (const part of parts) {
    if (part.type === "file") {
      const bytes = await part.toBuffer?.();
      if (!bytes || !bytes.length) continue;
      file = {
        fieldname: part.fieldname,
        filename: String(part.filename || part.fieldname || "upload"),
        mimetype: String(part.mimetype || "application/octet-stream"),
        bytes_base64: bytes.toString("base64")
      };
      continue;
    }
    fields[part.fieldname] = part.value;
  }
  if (file) fields.__file = file;
  return fields;
}

async function handlePortalAction(app: FastifyInstance, action: string, body: JsonObject, request?: FastifyRequest, reply?: FastifyReply) {
  const actor = portalActor(body);
  if (action === "auth_status") return { success: true, authenticated: Boolean(actor.email), user_email: actor.email || null };
  if (action === "referral_public_lookup") return publicReferralLookup(cleanText(body.referral_code || body.code || body.ref), request ? publicRequestBaseUrl(request) : "");
  if (action === "acquisition_public_track") return publicAcquisitionLookup(withAcquisitionRequestMetadata(body, request), request ? publicRequestBaseUrl(request) : "");
  if (!actor.email) return { success: false, status_code: 401, error: "Authentication required." };
  const ctx = await portalContext(actor, body);
  switch (action) {
    case "org_get_my":
      return await portalGetOrg(ctx.orgId, ctx.userDoc);
    case "get_credits":
      return await portalCredits(ctx.orgId, ctx.userDoc);
    case "org_update_my":
      return await portalUpdateOrg(ctx.orgId, body, ctx.userDoc);
    case "org_update_my_report_settings":
      return await portalUpdateReportSettings(ctx.orgId, body);
    case "org_update_my_billing":
      return await portalUpdateBilling(ctx.orgId, body);
    case "org_billing_history_my":
      return await portalBillingHistory(ctx.orgId, body);
    case "org_monthly_statement":
      return await portalMonthlyStatement(ctx.orgId, body);
    case "org_users_list_my":
      return { success: true, users: await portalOrgUsers(ctx.orgId) };
    case "org_users_add_my":
      return await portalAddOrgUser(ctx.orgId, body, request);
    case "org_users_update_my":
      return await portalUpdateOrgUser(ctx.orgId, body);
    case "org_users_set_disabled_my":
      return await portalSetOrgUserDisabled(ctx.orgId, body);
    case "org_users_delete_my":
      return await portalSetOrgUserDisabled(ctx.orgId, { ...body, disabled: "true", delete_user: "true" });
    case "org_users_set_perms_my":
      return await portalSetOrgUserPermissions(ctx.orgId, body);
    case "org_upload_logo_my":
      return await portalUploadLogo(ctx.orgId, body);
    case "org_users_upload_avatar_my":
      return await portalUploadAvatar(ctx.orgId, body);
    case "onboarding_track":
      return await portalOnboardingTrack(ctx.orgId, actor.email, body, request);
    case "onboarding_signup_verification_start":
      return await portalOnboardingSignupVerificationStart(ctx.orgId, asObject(ctx.userDoc), actor.email, body);
    case "onboarding_signup_verification_confirm":
      return await portalOnboardingSignupVerificationConfirm(ctx.orgId, asObject(ctx.userDoc), actor.email, body);
    case "onboarding_complete":
      return await portalOnboardingComplete(ctx.orgId, actor.email, body);
    case "portal_customer_referral_status":
      return await customerReferralStatus({ ...body, email: actor.email, org_id: ctx.orgId, name: actor.name });
    case "portal_customer_referral_event":
      return customerReferralEvent({ ...body, email: actor.email, org_id: ctx.orgId, name: actor.name });
    case "portal_bonus_upfront_match_status":
      return await portalBonusStatus(ctx.orgId);
    case "portal_acquisition_bonus_offer_status":
      if (isLocalPortalRequest(request) && truthy(body.bonus_test)) {
        const campaign = cleanText(body.cid || body.campaign || body.campaign_code || body.acquisition_code || body.campaign_id);
        const token = cleanText(body.xid || body.acquisition_bonus_token || body.bonus_token);
        if (campaign && token) return await acquisitionBonusOfferForCampaignToken(ctx.orgId, campaign, token, true, withAcquisitionRequestMetadata(body, request));
      }
      return await acquisitionBonusOfferForOrganization(ctx.orgId);
    case "fetch_image":
      return await portalFetchImage(body);
    case "scrape_logos":
      return await portalScrapeLogos(body);
    case "stripe_create_checkout":
      return await portalStripeCreateCheckout(ctx.orgId, actor.email, body);
    case "stripe_fulfill_session":
      return await portalStripeFulfillSession(cleanText(body.session_id), "stripe_manual_fulfill");
    case "billing_autotopup_setup_finish":
      return await portalStripeFinishSetup(cleanText(body.session_id));
    case "billing_autotopup_setup_start":
      return await portalStripeStartSetup(ctx.orgId, body);
    case "pj_search":
      return await portalFirstMeasure(app, "projects/list", { actor, page: 1, limit: Number(body.limit || 1), filter: "org" });
    case "queue":
      return await portalQueueProject(app, ctx.orgId, actor, body);
    case "expedite_queued_report":
      return await portalExpediteQueuedProject(app, ctx.orgId, actor, body);
    case "cancel_queued_report":
      return await portalCancelQueuedProject(app, ctx.orgId, actor, body);
    case "submit_report_rework_request":
      return await portalSubmitReportReworkRequest(app, ctx.orgId, actor, body);
    case "refund_instant_rejection":
      return await portalRefundInstant(app, ctx.orgId, actor.email, body);
    case "admin_stop_impersonation":
      return await stopPortalImpersonation(app, request, reply);
    default:
      return { success: false, status_code: 404, error: `Unsupported portal action: ${action}` };
  }
}

async function stopPortalImpersonation(app: FastifyInstance, request?: FastifyRequest, reply?: FastifyReply) {
  if (!request || !reply) return { success: false, status_code: 500, error: "missing_response_context" };
  const ctx = await authContextFromRequest(request);
  if (!ctx) return { success: false, status_code: 401, error: "authentication_required" };
  const metadata = asObject(ctx.session.metadata);
  const restoreSessionId = cleanText(metadata.restore_session_id);
  const currentSessionId = cleanText(ctx.sessionId);
  if (restoreSessionId) {
    try {
      const restoreSession = await readAuthSession(restoreSessionId);
      const restoreCtx = await buildAuthContext(restoreSessionId, restoreSession);
      if (currentSessionId && currentSessionId !== restoreSessionId) await deleteAuthSession(currentSessionId);
      setPlatformAuthCookies(request, reply, restoreCtx.sessionId, restoreCtx.csrfToken);
      return {
        success: true,
        stopped: true,
        restored: true,
        user_email: cleanText(restoreCtx.identity.email),
        org_id: restoreCtx.orgId,
        node_bridge: true
      };
    } catch (error) {
      app.log.warn({ err: error, restoreSessionId }, "Failed to restore platform impersonation session");
    }
  }
  await logoutPlatformSession(request, reply);
  return { success: true, stopped: true, restored: false, node_bridge: true };
}

async function handleAuthLegacyAction(request: FastifyRequest, reply: FastifyReply, body: JsonObject) {
  const action = cleanText(body.action);
  if (action === "auth_status") {
    const ctx = await authContextFromRequest(request);
    return {
      success: true,
      ok: true,
      authenticated: Boolean(ctx),
      user_email: ctx ? String(ctx.identity.email || "") : null,
      user_name: ctx ? String(ctx.identity.name || "") : null,
      org_id: ctx ? ctx.orgId : null
    };
  }

  if (action === "login") {
    const ctx = await loginPlatformIdentity({
      identifier: cleanText(body.identifier || body.email || body.phone),
      password: String(body.password || ""),
      organizationId: cleanText(body.organization_id || body.org_id),
      metadata: {
        source: "node_legacy_auth",
        user_agent: String(request.headers["user-agent"] || ""),
        ip: request.ip
      }
    });
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    return {
      success: true,
      ok: true,
      first_login: false,
      is_admin: ["owner", "admin", "super_admin"].includes(ctx.role),
      ...publicAuthContext(ctx)
    };
  }

  if (action === "register") {
    const password = String(body.password || "");
    const company = cleanText(body.company || body.company_name || body.organization_name) || "Your Company";
    const phone = formatSignupPhone(body.phone);
    if (!password || !cleanText(body.email)) {
      return { success: false, ok: false, status_code: 400, error: "Missing required account fields." };
    }
    if (!phone) {
      return { success: false, ok: false, status_code: 400, error: "Enter a valid ten-digit mobile phone number." };
    }
    const defaultAppFlags = await newOrganizationAppFlagDefaults();
    const registered = await withNewIdentityRegistration(cleanText(body.email), async (transaction) => {
      const organization = await createOrganization({
        name: company,
        global: {
          app_flags: defaultAppFlags,
          credits_balance: 0,
          credits_ledger: [],
          billing: {
            auto_topup: { enabled: false, threshold_dollars: 50, topup_dollars: 100, status: "idle" },
            stripe: { has_payment_method: false },
            events: []
          },
          branding: { colors: { primary: "#d93025", secondary: "#202124", accent: "#1a73e8" } },
          report_settings: {}
        }
      });
      transaction.createdOrganization(organization);
      const identity = await createIdentity({
        email: cleanText(body.email),
        password_hash: await hashPassword(password),
        password_algo: "bcrypt",
        name: cleanText(body.name),
        phone,
        metadata: {
          email_verified: false,
          signup_email_verification: {
            verified: false,
            method: "deferred_onboarding",
            created_at: new Date().toISOString()
          },
          referral_code: cleanText(body.referral_code),
          referral_attribution_id: cleanText(body.referral_attribution_id),
          ...signupAttributionPayload(withAcquisitionRequestMetadata(body, request))
        }
      });
      transaction.createdIdentity(identity);
      const userId = `user_${String(identity.id).replace(/^identity_/, "")}`;
      const user = await upsertDocument(
        String(organization.id),
        "users",
        {
          id: userId,
          data: {
            identity_id: identity.id,
            email: identity.email,
            name: cleanText(body.name),
            phone,
            role: "owner",
            roles: PLATFORM_STANDARD_USER_ROLES,
            status: "active",
            permissions: { "*": true },
            profile: {},
            stats: { projects_ordered: 0, commissions_earned: 0 },
            metadata: {}
          },
          metadata: { kind: "organization_user", identity_id: identity.id }
        },
        { replace: true }
      );
      await addIdentityMembership(String(identity.id), String(organization.id), String(user.id), "owner");
      return { organization };
    });
    const { organization } = registered;
    await applyAcquisitionSignup(String(organization.id), {
      email: cleanText(body.email),
      name: cleanText(body.name),
      company,
      ...signupAttributionPayload(withAcquisitionRequestMetadata(body, request))
    }).catch(() => null);
    const ctx = await loginPlatformIdentity({
      email: cleanText(body.email),
      password,
      organizationId: String(organization.id),
      metadata: {
        source: "node_legacy_register",
        user_agent: String(request.headers["user-agent"] || ""),
        ip: request.ip
      }
    });
    setPlatformAuthCookies(request, reply, ctx.sessionId, ctx.csrfToken);
    return { success: true, ok: true, first_login: true, ...publicAuthContext(ctx) };
  }

  if (action === "forgot_password" || action === "forgot_password_sms") {
    const identifier = cleanText(body.identifier || body.email || body.phone);
    const identity = await findIdentityByIdentifier(identifier);
    const email = cleanText(identity.email).toLowerCase();
    const requestedChannel = cleanText(body.delivery_channel).toLowerCase();
    const wantsSms = action === "forgot_password_sms" || requestedChannel === "sms" || requestedChannel === "phone";
    if (wantsSms) {
      const phone = normalizeE164Phone(identity.phone);
      if (!phone) {
        return {
          success: false,
          ok: false,
          status_code: 400,
          error: "sms_phone_unavailable",
          message: "This account does not have a valid mobile phone number. Contact support to recover the account."
        };
      }
      const previousReset = asObject(asObject(identity.metadata).password_reset);
      const previousRequestMs = Date.parse(cleanText(previousReset.requested_at));
      if (
        cleanText(previousReset.channel).toLowerCase() === "sms"
        && normalizeE164Phone(previousReset.phone_e164) === phone
        && Number(previousReset.expires_at || 0) > Date.now()
        && cleanText(previousReset.request_id)
        && Number.isFinite(previousRequestMs)
        && Date.now() - previousRequestMs < 60_000
      ) {
        const requestId = cleanText(previousReset.request_id);
        return {
          success: true,
          ok: true,
          require_otp: true,
          recovery_token: createPasswordRecoveryToken(String(identity.id || ""), requestId),
          delivery_channel: "sms",
          masked_destination: maskPhoneNumber(phone),
          message: `A code was recently sent to the ${maskPhoneNumber(phone)}.`,
          sms_sent: true,
          resend_throttled: true
        };
      }
      const smsRequestKey = `${String(identity.id || "")}:${phone}`;
      const pendingSmsRequest = passwordResetSmsRequests.get(smsRequestKey);
      if (pendingSmsRequest) return await pendingSmsRequest;
      const smsRequest = (async (): Promise<JsonObject> => {
        const telnyx = createTelnyxVerifyClient({
          apiKey: env.telnyxApiKey,
          profileId: env.telnyxVerifyProfileId,
          baseUrl: env.telnyxBaseUrl,
          requestTimeoutMs: env.telnyxRequestTimeoutMs
        });
        try {
          const verification = await telnyx.startSms(phone);
          const timeoutMs = Math.max(60, verification.timeout_secs || 600) * 1000;
          const reset = {
            request_id: randomUUID(),
            channel: "sms",
            phone_e164: phone,
            provider_verification_id: verification.id,
            expires_at: Date.now() + timeoutMs,
            verified: false,
            requested_at: new Date().toISOString()
          };
          await patchIdentity(String(identity.id || ""), {
            metadata: { ...asObject(identity.metadata), password_reset: reset }
          });
          return {
            success: true,
            ok: true,
            require_otp: true,
            recovery_token: createPasswordRecoveryToken(String(identity.id || ""), reset.request_id),
            delivery_channel: "sms",
            masked_destination: maskPhoneNumber(phone),
            message: `Enter the code sent to the ${maskPhoneNumber(phone)}.`,
            sms_sent: true
          };
        } catch (error) {
          const statusCode = error instanceof TelnyxVerifyError && error.statusCode < 500 ? 400 : 503;
          return {
            success: false,
            ok: false,
            status_code: statusCode,
            error: "telnyx_verify_send_failed",
            message: "Unable to send a text verification code right now. Contact support if the problem continues."
          };
        }
      })();
      passwordResetSmsRequests.set(smsRequestKey, smsRequest);
      try {
        return await smsRequest;
      } finally {
        if (passwordResetSmsRequests.get(smsRequestKey) === smsRequest) passwordResetSmsRequests.delete(smsRequestKey);
      }
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const reset = {
      request_id: randomUUID(),
      channel: "email",
      code_hash: authResetCodeHash(String(identity.id || ""), code),
      expires_at: Date.now() + 10 * 60 * 1000,
      verified: false,
      requested_at: new Date().toISOString()
    };
    await patchIdentity(String(identity.id || ""), {
      metadata: { ...asObject(identity.metadata), password_reset: reset }
    });
    const postmark = await sendPasswordResetOtpEmail(email, code);
    if (!postmark.ok) {
      return {
        success: false,
        ok: false,
        status_code: 500,
        error: "postmark_send_failed",
        message: postmark.error || "Unable to send verification code."
      };
    }
    return {
      success: true,
      ok: true,
      require_otp: true,
      recovery_token: createPasswordRecoveryToken(String(identity.id || ""), reset.request_id),
      delivery_channel: "email",
      masked_destination: maskEmailAddress(email),
      message: "Password reset code sent.",
      email_sent: true,
      ...(env.isProduction ? {} : { dev_otp: code })
    };
  }

  if (action === "verify_otp") {
    const code = cleanText(body.otp || body.code);
    const identity = await resolvePasswordRecoveryIdentity(body);
    const reset = asObject(asObject(identity.metadata).password_reset);
    let codeIsValid = false;
    if (cleanText(reset.channel).toLowerCase() === "sms") {
      const phone = normalizeE164Phone(reset.phone_e164);
      if (phone && Number(reset.expires_at || 0) >= Date.now()) {
        const telnyx = createTelnyxVerifyClient({
          apiKey: env.telnyxApiKey,
          profileId: env.telnyxVerifyProfileId,
          baseUrl: env.telnyxBaseUrl,
          requestTimeoutMs: env.telnyxRequestTimeoutMs
        });
        try {
          codeIsValid = await telnyx.verifySms(phone, code) === "accepted";
        } catch {
          codeIsValid = false;
        }
      }
    } else {
      codeIsValid = authResetCodeValid(identity, reset, code);
    }
    if (!codeIsValid) {
      return { success: false, ok: false, status_code: 400, error: "Invalid or expired code." };
    }
    await patchIdentity(String(identity.id || ""), {
      metadata: { ...asObject(identity.metadata), password_reset: { ...reset, verified: true, verified_at: new Date().toISOString() } }
    });
    return { success: true, ok: true, require_new_password: true, recovery_token: cleanText(body.recovery_token) };
  }

  if (action === "set_new_password") {
    const password = String(body.new_password || body.password || "");
    if (password.length < 6) return { success: false, ok: false, status_code: 400, error: "Password too short" };
    const identity = await resolvePasswordRecoveryIdentity(body);
    const reset = asObject(asObject(identity.metadata).password_reset);
    if (reset.verified !== true || Number(reset.expires_at || 0) < Date.now()) {
      return { success: false, ok: false, status_code: 403, error: "Password reset is not authorized." };
    }
    const metadata = { ...asObject(identity.metadata), password_reset: null };
    await patchIdentity(String(identity.id || ""), {
      password_hash: await hashPassword(password),
      password_algo: "bcrypt",
      metadata
    });
    return { success: true, ok: true };
  }

  return { success: false, ok: false, status_code: 404, error: `Unsupported auth action: ${action}` };
}

function authResetCodeHash(identityId: string, code: string) {
  return createHash("sha256").update(`${identityId}:${code}`).digest("hex");
}

function passwordRecoverySignature(value: string) {
  return createHmac("sha256", env.platformSessionSecret).update(`password-recovery:${value}`).digest("base64url");
}

function createPasswordRecoveryToken(identityId: string, requestId: string) {
  if (!identityId || !requestId) return "";
  const payload = Buffer.from(JSON.stringify({ identity_id: identityId, request_id: requestId })).toString("base64url");
  return `${payload}.${passwordRecoverySignature(payload)}`;
}

function parsePasswordRecoveryToken(tokenValue: unknown) {
  const [payload, signature] = cleanText(tokenValue).split(".");
  if (!payload || !signature) throw badRequest("invalid_recovery_token", "Password recovery has expired. Start again.");
  const expected = passwordRecoverySignature(payload);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw badRequest("invalid_recovery_token", "Password recovery has expired. Start again.");
  }
  try {
    return asObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    throw badRequest("invalid_recovery_token", "Password recovery has expired. Start again.");
  }
}

async function resolvePasswordRecoveryIdentity(body: JsonObject) {
  const token = cleanText(body.recovery_token);
  if (!token) return await findIdentityByIdentifier(cleanText(body.identifier || body.email || body.phone));
  const payload = parsePasswordRecoveryToken(token);
  const identity = await readIdentity(cleanText(payload.identity_id));
  const reset = asObject(asObject(identity.metadata).password_reset);
  if (!cleanText(payload.request_id) || cleanText(reset.request_id) !== cleanText(payload.request_id)) {
    throw badRequest("invalid_recovery_token", "Password recovery has expired. Start again.");
  }
  return identity;
}

function maskEmailAddress(emailValue: string) {
  const [local, domain] = String(emailValue || "").split("@");
  if (!local || !domain) return "your email";
  return `${local.slice(0, 1)}${"*".repeat(Math.min(4, Math.max(1, local.length - 1)))}@${domain}`;
}

function authResetCodeValid(identity: JsonObject, reset: JsonObject, code: string) {
  const identityId = String(identity.id || "");
  const expected = cleanText(reset.code_hash);
  if (!identityId || !expected || !code || Number(reset.expires_at || 0) < Date.now()) return false;
  return expected === authResetCodeHash(identityId, code);
}

async function postmarkServerToken() {
  const configured = cleanText(env.postmarkServerToken);
  if (configured) return configured;

  try {
    return cleanText(await readFile(path.resolve(process.cwd(), "storage/secrets/pm_server_token.txt"), "utf8"));
  } catch {
    return "";
  }
}

function emailFooterHtml() {
  return `<div style="margin-top:22px;padding-top:14px;border-top:1px solid #e9e9e9;">
    <img src="https://1m8.ai/images/logo_red.png" alt="1m8" style="height:34px;width:auto;display:block;border:0;outline:none;text-decoration:none;" />
    <div style="margin-top:6px;font-size:12px;line-height:1.3;color:#777;">&copy; ${new Date().getFullYear()} <a href="https://1m8.ai" style="color:#1a73e8;text-decoration:none;">1m8.ai</a></div>
  </div>`;
}

function emailFooterText() {
  return "\n\n--\nThe FirstMeasure Team\n";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendPostmarkEmail(input: { to: string; subject: string; textBody: string; htmlBody?: string; attachments?: Array<{ Name: string; Content: string; ContentType: string }> }) {
  const token = await postmarkServerToken();
  if (!token) return { ok: false, error: "Postmark token missing" };

  const textBody = `${input.textBody}${emailFooterText()}`;
  const htmlBody = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.45;color:#111;">${input.htmlBody || `<div style="white-space:normal;">${escapeHtml(input.textBody).replace(/\n/g, "<br>")}</div>`}${emailFooterHtml()}</div>`;
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token
    },
    body: JSON.stringify({
      From: env.postmarkFrom,
      To: input.to,
      Subject: input.subject,
      TextBody: textBody,
      HtmlBody: htmlBody,
      ReplyTo: env.postmarkReplyTo,
      ...(input.attachments?.length ? { Attachments: input.attachments } : {})
    })
  });
  const body = await response.text();
  if (!response.ok) {
    return { ok: false, error: `Postmark HTTP ${response.status}`, postmark: body };
  }
  return { ok: true, status: response.status };
}

async function sendPasswordResetOtpEmail(email: string, code: string) {
  const subject = `1m8 Verification Code: ${code}`;
  const textBody = `Your verification code is: ${code}\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.`;
  const htmlBody = `<p>Your verification code is:</p>
    <div style="font-size:24px;font-weight:700;letter-spacing:4px;margin:12px 0;">${escapeHtml(code)}</div>
    <p>This code expires in 10 minutes.</p>
    <p>If you did not request this, you can ignore this email.</p>`;
  return sendPostmarkEmail({ to: email, subject, textBody, htmlBody });
}

function portalActivateUrl(request: { headers: Record<string, unknown> }, email: string) {
  const base = publicRequestBaseUrl(request).replace(/\/+$/, "");
  const params = new URLSearchParams({
    email,
    redirect: "./",
    start: "start"
  });
  return `${base}/portal/activate.php?${params.toString()}`;
}

async function sendPlatformOrgUserInvite(orgId: string, userDoc: JsonObject, request: { headers: Record<string, unknown> }, actorEmail = "") {
  const data = asObject(userDoc.data);
  const email = cleanEmail(data.email);
  const name = cleanText(data.name) || email;
  const activateUrl = portalActivateUrl(request, email);
  const organization = asObject(await readOrganization(orgId).catch(() => ({})));
  const orgName = cleanText(organization.name) || "your company";
  const subject = `You're invited to FirstMate`;
  const textBody = [
    `Hi ${name},`,
    "",
    `You've been invited to join ${orgName} in FirstMate.`,
    "",
    "Use this link to verify your email and set your password:",
    activateUrl,
    "",
    actorEmail ? `Invite sent by: ${actorEmail}` : ""
  ].filter((line, index, lines) => line || index < lines.length - 1).join("\n");
  const htmlBody = `
    <p>Hi ${escapeHtml(name)},</p>
    <p>You've been invited to join <strong>${escapeHtml(orgName)}</strong> in FirstMate.</p>
    <p>
      <a href="${escapeHtml(activateUrl)}" style="display:inline-block;background:#d93025;color:#fff;text-decoration:none;font-weight:700;padding:10px 14px;border-radius:6px;">Activate your account</a>
    </p>
    <p style="color:#555;">This link opens the activation page where you can verify your email and set your password.</p>
    ${actorEmail ? `<p style="color:#777;font-size:12px;">Invite sent by ${escapeHtml(actorEmail)}</p>` : ""}
  `;
  const sent = await sendPostmarkEmail({ to: email, subject, textBody, htmlBody });
  const now = new Date().toISOString();
  const nextMetadata = {
    ...asObject(data.metadata),
    invite_email_last_attempt_at: now,
    invite_email_last_error: sent.ok ? "" : cleanText(sent.error)
  };
  await upsertDocument(orgId, "users", {
    id: String(userDoc.id || ""),
    data: {
      invite_emailed_at: sent.ok ? now : data.invite_emailed_at,
      invite_email_last_attempt_at: now,
      invite_email_last_error: sent.ok ? "" : cleanText(sent.error),
      activate_url: activateUrl,
      metadata: nextMetadata
    },
    metadata: { invite_email_last_attempt_at: now }
  }, { replace: false }).catch(() => null);
  return {
    ok: sent.ok,
    emailed: sent.ok,
    email_sent: sent.ok,
    activate_url: activateUrl,
    error: sent.ok ? "" : cleanText(sent.error),
    postmark: sent
  };
}

function portalActor(body: JsonObject) {
  const actor = asObject(body.actor);
  return {
    email: cleanText(actor.email || body.actor_email || body.user_email).toLowerCase(),
    name: cleanText(actor.name || body.actor_name || body.user_name),
    organization_id: cleanText(actor.organization_id || actor.org_id || body.actor_org_id || body.organization_id || body.org_id),
    team_id: cleanText(actor.team_id || body.actor_team_id || body.team_id)
  };
}

async function portalContext(actor: ReturnType<typeof portalActor>, body: JsonObject) {
  let orgId = actor.organization_id || cleanText(body.org_id || body.organization_id);
  let userDoc: JsonObject | null = null;
  if (orgId) userDoc = await findPortalUserByEmail(orgId, actor.email);
  if (!orgId || !userDoc) {
    const identity = await findIdentityByEmail(actor.email);
    const memberships = await listIdentityMemberships(String(identity.id || ""));
    const first = memberships[0] ? asObject(memberships[0]) : {};
    const organization = asObject(first.organization);
    const user = asObject(first.user);
    orgId = orgId || String(organization.id || user.organization_id || "");
    userDoc = Object.keys(user).length ? user : null;
  }
  if (!orgId) throw badRequest("missing_org", "A portal organization is required.");
  if (!userDoc) userDoc = await findPortalUserByEmail(orgId, actor.email);
  return { orgId, userDoc };
}

async function findPortalUserByEmail(orgId: string, email: string) {
  const normalized = String(email || "").trim().toLowerCase();
  const users = await listDocuments(orgId, "users");
  return users.find((doc) => String(asObject(doc.data).email || "").toLowerCase() === normalized) ?? null;
}

function portalUserView(userDoc: unknown) {
  const doc = asObject(userDoc);
  const data = asObject(doc.data);
  const profile = asObject(data.profile);
  const orgPermissions = asObject(data.org_permissions);
  const level = String(orgPermissions.level || data.role || "viewer");
  const items = asObject(orgPermissions.items);
  return {
    id: doc.id,
    ...data,
    disabled: String(data.status || "active") === "disabled",
    deleted: data.deleted === true,
    org_permissions: { level, items },
    effective_permissions: effectivePortalPermissions(level, items),
    profile_photo_url: profile.profile_photo || profile.profile_photo_url || ""
  };
}

function googleWorkspaceWebsite(hostedDomain: string) {
  const domain = cleanText(hostedDomain).toLowerCase();
  if (!domain || domain === "gmail.com" || domain.length > 253) return "";
  if (!domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain) || domain.includes("..")) return "";
  return domain;
}

async function portalGetOrg(orgId: string, userDoc: JsonObject | null) {
  const org = await portalOrgView(orgId);
  const user = portalUserView(userDoc);
  const userData = asObject(userDoc?.data);
  let workspaceWebsiteSuggestion = "";
  const contact = asObject(org.contact);
  const isUnfinishedOwnerAccount = org.onboarding_completed !== true
    && cleanText(userData.role).toLowerCase() === "owner"
    && !cleanText(contact.website);
  if (isUnfinishedOwnerAccount && userDoc) {
    try {
      const identityId = cleanText(userData.identity_id);
      const identity = identityId ? await readIdentity(identityId) : {};
      const googleOnly = cleanText(identity.password_algo).toLowerCase() === "google"
        && !cleanText(identity.password_hash);
      if (googleOnly) {
        const providers = asObject(asObject(identity.metadata).auth_providers);
        const google = asObject(providers.google);
        workspaceWebsiteSuggestion = googleWorkspaceWebsite(cleanText(google.hosted_domain));
      }
    } catch {
      workspaceWebsiteSuggestion = "";
    }
  }
  return {
    success: true,
    org,
    user,
    workspace_website_suggestion: workspaceWebsiteSuggestion
  };
}

function effectivePortalPermissions(level: unknown, items: JsonObject = {}) {
  const normalized = String(level || "viewer").toLowerCase();
  const presets: Record<string, JsonObject> = {
    viewer: { view_reports: true },
    manager: { order_reports: true, view_reports: true },
    admin: { order_reports: true, view_reports: true, manage_billing: true, manage_company_settings: true, manage_report_settings: true, manage_company_users: true },
    owner: { "*": true },
    super_admin: { "*": true, order_reports: true, view_reports: true, manage_billing: true, manage_company_settings: true, manage_report_settings: true, manage_company_users: true, manage_company_user_permissions: true }
  };
  if (normalized === "custom") return items;
  if (presets[normalized]) return { ...presets[normalized], ...items };
  return Object.keys(items).length ? items : presets.viewer;
}

async function portalOrgView(orgId: string) {
  const [organization, global] = await Promise.all([readOrganization(orgId), readGlobal(orgId)]);
  const data = asObject(global.data);
  const metadata = asObject(organization.metadata);
  const legacyGlobal = asObject(data.legacy_org_snapshot);
  const legacyMetadata = asObject(metadata.legacy_snapshot);
  const branding = {
    ...asObject(legacyMetadata.branding),
    ...asObject(legacyGlobal.branding),
    ...asObject(organization.branding),
    ...asObject(metadata.branding),
    ...asObject(data.branding)
  };
  const colors = asObject(branding.colors);
  const logo = cleanText(branding.logo);
  const resolvedLogo = portalResolveLogo(logo, branding);
  return {
    ...organization,
    id: orgId,
    name: organization.name || cleanText(data.name) || cleanText(legacyGlobal.name) || cleanText(legacyMetadata.name) || "",
    branding: {
      ...branding,
      logo: resolvedLogo,
      logo_node_url: resolvedLogo || cleanText(branding.logo_node_url),
      colors: {
        primary: colors.primary || colors.accent || "#d93025",
        secondary: colors.secondary || "#111111",
        accent: colors.accent || colors.primary || "#d93025"
      }
    },
    contact: { ...asObject(legacyMetadata.contact), ...asObject(legacyGlobal.contact), ...asObject(data.contact) },
    report_settings: { ...asObject(legacyMetadata.report_settings), ...asObject(legacyGlobal.report_settings), ...asObject(data.report_settings) },
    billing: safeBillingView(Object.keys(asObject(data.billing)).length ? data.billing : legacyGlobal.billing),
    offers: { ...asObject(legacyMetadata.offers), ...asObject(legacyGlobal.offers), ...asObject(data.offers) },
    credits_balance: numericValue(data.credits_balance ?? legacyGlobal.credits_balance ?? legacyMetadata.credits_balance),
    free_expedite_uses: Math.max(0, Math.round(numericValue(data.free_expedite_uses))),
    free_expedite_ledger_count: Array.isArray(data.free_expedite_ledger) ? data.free_expedite_ledger.length : 0,
    onboarding_completed: data.onboarding_completed === true
  };
}

async function portalCredits(orgId: string, userDoc: JsonObject | null) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const legacy = asObject(data.legacy_org_snapshot);
  const balance = numericValue(data.credits_balance ?? legacy.credits_balance);
  const user = portalUserView(userDoc);
  return {
    success: true,
    credits: balance,
    credits_balance: balance,
    balance,
    remaining_credits: balance,
    free_expedite_uses: Math.max(0, Math.round(numericValue(data.free_expedite_uses))),
    permissions: user.effective_permissions || {},
    user
  };
}

function portalResolveLogo(logo: string, branding: JsonObject) {
  if (!logo) return "";
  if (/^(https?:|data:)/i.test(logo)) return logo;
  if (logo.startsWith("/v1/")) return logo.replace(/\/file(\?|$)/, "/logo$1");
  const importedLogo = cleanText(branding.logo_node_url);
  if (importedLogo && (logo.startsWith("/") || logo.startsWith("organizations/"))) return importedLogo;
  if (logo.startsWith("/")) return logo.startsWith("/storage/") ? logo : "";
  if (logo.startsWith("organizations/")) return "";
  return logo;
}

async function portalUpdateOrg(orgId: string, body: JsonObject, userDoc: JsonObject | null = null) {
  if (cleanText(body.name)) await patchOrganization(orgId, { name: cleanText(body.name) });
  const fullName = cleanText(body.full_name || body.user_name);
  const requestedPhone = cleanText(body.phone || body.user_phone);
  const phone = requestedPhone ? formatSignupPhone(requestedPhone) : "";
  if (requestedPhone && !phone) throw badRequest("invalid_phone_number", "Enter a valid ten-digit mobile phone number.");
  if ((fullName || phone) && userDoc) {
    const currentUser = asObject(userDoc.data);
    const identityId = cleanText(currentUser.identity_id);
    if (identityId) {
      const updatedIdentity = await patchIdentity(identityId, {
        ...(fullName ? { name: fullName } : {}),
        ...(phone ? { phone } : {})
      });
      if (phone) body.phone = updatedIdentity.phone;
    }
    await upsertDocument(orgId, "users", {
      id: String(userDoc.id || ""),
      data: {
        ...(fullName ? { name: fullName } : {}),
        ...(phone ? { phone } : {})
      }
    }, { replace: false });
  }
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const branding = asObject(data.branding);
  const colors = asObject(branding.colors);
  const contact = asObject(data.contact);
  await saveGlobal(orgId, {
    data: {
      branding: {
        ...branding,
        colors: {
          ...colors,
          accent: cleanText(body.accent) || colors.accent || colors.primary || "#d93025",
          primary: cleanText(body.accent) || colors.primary || colors.accent || "#d93025",
          secondary: cleanText(body.secondary) || colors.secondary || "#111111"
        }
      },
      contact: {
        ...contact,
        ...(Object.prototype.hasOwnProperty.call(body, "company_email") ? { email: cleanText(body.company_email) } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "company_phone") ? { phone: cleanText(body.company_phone) } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "company_address") ? { address: cleanText(body.company_address) } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "website") ? { website: cleanText(body.website) } : {})
      }
    }
  });
  return { success: true, org: await portalOrgView(orgId) };
}

async function portalUpdateReportSettings(orgId: string, body: JsonObject) {
  const reportSettings = asObject(tryParseJsonField(body.report_settings_json, {}));
  await saveGlobal(orgId, { data: { report_settings: reportSettings } });
  return { success: true, report_settings: reportSettings, org: await portalOrgView(orgId) };
}

async function portalUpdateBilling(orgId: string, body: JsonObject) {
  const patch = asObject(tryParseJsonField(body.billing_json, {}));
  const global = await readGlobal(orgId);
  const current = asObject(asObject(global.data).billing);
  const billing = {
    ...current,
    ...patch,
    stripe: { ...asObject(current.stripe), ...asObject(patch.stripe) },
    auto_topup: { ...asObject(current.auto_topup), ...asObject(patch.auto_topup) }
  };
  await saveGlobal(orgId, { data: { billing } });
  return { success: true, billing: safeBillingView(billing), org: await portalOrgView(orgId) };
}

async function portalBillingHistory(orgId: string, body: JsonObject) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const limit = Math.max(0, Math.min(500, Number(body.limit || 200) || 200));
  const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger.slice(-limit).reverse() : [];
  const events = Array.isArray(asObject(data.billing).events) ? asObject(data.billing).events : [];
  return { success: true, events, ledger };
}

async function portalMonthlyStatement(orgId: string, body: JsonObject) {
  const month = Math.max(1, Math.min(12, Number(body.month || new Date().getMonth() + 1) || 1));
  const year = Number(body.year || new Date().getFullYear()) || new Date().getFullYear();
  const history = await portalBillingHistory(orgId, { limit: 500 });
  const transactions = (Array.isArray(history.ledger) ? history.ledger : []).filter((entry) => {
    const d = new Date(String(asObject(entry).ts || ""));
    return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month;
  });
  const totalIn = transactions.reduce((sum, entry) => sum + Math.max(0, numericValue(asObject(entry).delta)), 0);
  const totalOut = transactions.reduce((sum, entry) => sum + Math.abs(Math.min(0, numericValue(asObject(entry).delta))), 0);
  return {
    success: true,
    month,
    year,
    month_label: new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric" }),
    transactions,
    ledger: transactions,
    orders: transactions.filter((entry) => String(asObject(entry).reason || "") === "order_submitted"),
    total_transactions: transactions.length,
    total_orders: transactions.filter((entry) => String(asObject(entry).reason || "") === "order_submitted").length,
    total_payments: transactions.filter((entry) => numericValue(asObject(entry).delta) > 0).length,
    total_in: totalIn,
    total_out: totalOut,
    net_change: totalIn - totalOut,
    total_spent: totalOut,
    by_type: {}
  };
}

async function portalOrgUsers(orgId: string) {
  return (await listDocuments(orgId, "users")).map(portalUserView).filter((user) => !user.deleted);
}

async function portalAddOrgUser(orgId: string, body: JsonObject, request?: FastifyRequest) {
  const email = cleanEmail(body.email);
  const name = cleanText(body.name) || email;
  let identity;
  try {
    identity = await findIdentityByEmail(email);
  } catch {
    identity = await createIdentity({ email, name, status: "pending", password_hash: "", password_algo: "pending" });
  }
  const level = cleanText(body.perm_level) || "viewer";
  const items = asObject(tryParseJsonField(body.perm_items_json, {}));
  const user = await upsertDocument(orgId, "users", {
    id: `user_${stableHash(email).slice(0, 16)}`,
    data: {
      identity_id: identity.id,
      email,
      name,
      status: "pending",
      role: level,
      org_permissions: { level, items },
      permissions: effectivePortalPermissions(level, items),
      account_type: "customer",
      branch_id: "default",
      profile: {}
    },
    metadata: { kind: "organization_user", identity_id: identity.id }
  });
  await addIdentityMembership(String(identity.id), orgId, String(user.id), level);
  const invite = request
    ? await sendPlatformOrgUserInvite(orgId, user, request, cleanText(body.actor_email || body.user_email)).catch((error) => ({
      ok: false,
      emailed: false,
      email_sent: false,
      activate_url: "",
      error: error instanceof Error ? error.message : String(error)
    }))
    : { ok: false, emailed: false, email_sent: false, activate_url: "" };
  return { success: true, user: portalUserView(user), emailed: invite.ok, email_sent: invite.ok, activate_url: invite.activate_url || null, invite };
}

async function portalUpdateOrgUser(orgId: string, body: JsonObject) {
  const userId = cleanText(body.user_id);
  const current = await readDocument(orgId, "users", userId);
  const data = asObject(current.data);
  const next = await upsertDocument(orgId, "users", {
    id: userId,
    data: { ...data, email: cleanText(body.email) || data.email, name: cleanText(body.name) || data.name, updated_at: new Date().toISOString() }
  });
  return { success: true, user: portalUserView(next), session_updated: false };
}

async function portalSetOrgUserDisabled(orgId: string, body: JsonObject) {
  const userId = cleanText(body.user_id);
  const current = await readDocument(orgId, "users", userId);
  const data = asObject(current.data);
  const disabled = parseBooleanField(body.disabled, true);
  const next = await upsertDocument(orgId, "users", {
    id: userId,
    data: { ...data, status: disabled ? "disabled" : "active", deleted: parseBooleanField(body.delete_user, false) }
  });
  return { success: true, user: portalUserView(next) };
}

async function portalSetOrgUserPermissions(orgId: string, body: JsonObject) {
  const userId = cleanText(body.user_id);
  const current = await readDocument(orgId, "users", userId);
  const data = asObject(current.data);
  const level = cleanText(body.perm_level) || "viewer";
  const items = asObject(tryParseJsonField(body.perm_items_json, {}));
  const next = await upsertDocument(orgId, "users", {
    id: userId,
    data: { ...data, role: level, org_permissions: { level, items }, permissions: effectivePortalPermissions(level, items) }
  });
  return { success: true, user: portalUserView(next) };
}

async function portalUploadLogo(orgId: string, body: JsonObject) {
  const file = asObject(body.__file);
  if (!file.bytes_base64) throw badRequest("missing_logo", "A logo file is required.");
  const media = await storeMediaUpload(orgId, {
    ownerType: "organization",
    ownerId: orgId,
    slot: "logo",
    collection: "branding",
    fileName: String(file.filename || "logo"),
    contentType: String(file.mimetype || "application/octet-stream"),
    bytes: Buffer.from(String(file.bytes_base64), "base64"),
    replaceSlot: true
  });
  const logo = `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(String(media.id))}/logo`;
  const global = await readGlobal(orgId);
  await saveGlobal(orgId, { data: { branding: { ...asObject(asObject(global.data).branding), logo, logo_node_url: logo } } });
  return { success: true, logo, media };
}

async function portalUploadAvatar(orgId: string, body: JsonObject) {
  const userId = cleanText(body.user_id);
  const file = asObject(body.__file);
  if (!file.bytes_base64) throw badRequest("missing_avatar", "An avatar file is required.");
  const media = await storeMediaUpload(orgId, {
    ownerType: "user",
    ownerId: userId,
    slot: "avatar",
    collection: "users",
    fileName: String(file.filename || "avatar"),
    contentType: String(file.mimetype || "application/octet-stream"),
    bytes: Buffer.from(String(file.bytes_base64), "base64"),
    replaceSlot: true
  });
  const avatarUrl = `/v1/platform/organizations/${encodeURIComponent(orgId)}/media/${encodeURIComponent(String(media.id))}/file`;
  const current = await readDocument(orgId, "users", userId);
  const data = asObject(current.data);
  const user = await upsertDocument(orgId, "users", {
    id: userId,
    data: { ...data, profile: { ...asObject(data.profile), avatar_media_id: media.id, profile_photo: avatarUrl } }
  });
  return { success: true, avatar_url: avatarUrl, user: portalUserView(user), media };
}

function validEmail(value: unknown) {
  const email = cleanText(value).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : "";
}

function signupEmailVerification(identity: JsonObject) {
  return asObject(asObject(identity.metadata).signup_email_verification);
}

function signupEmailIsVerified(identity: JsonObject) {
  const metadata = asObject(identity.metadata);
  const verification = signupEmailVerification(identity);
  return metadata.email_verified === true || verification.verified === true;
}

function signupOtpCodeHash(identityId: string, code: string) {
  return createHash("sha256").update(`${identityId}:signup:${code}`).digest("hex");
}

function signupOtpCodeValid(identity: JsonObject, verification: JsonObject, code: string) {
  const identityId = String(identity.id || "");
  const expected = cleanText(verification.code_hash);
  if (!identityId || !expected || !code || Number(verification.expires_at || 0) < Date.now()) return false;
  return expected === signupOtpCodeHash(identityId, code);
}

function onboardingCompletionData(actorEmail: string, body: JsonObject) {
  const now = new Date().toISOString();
  return {
    onboarding_completed: true,
    onboarding_completed_at: now,
    onboarding_meta: { ...asObject(body), completed_by: actorEmail, completed_at: now }
  };
}

async function portalOnboardingTrack(orgId: string, actorEmail: string, body: JsonObject, request?: FastifyRequest) {
  const rawEvents = Array.isArray(body.events)
    ? body.events
    : (() => {
        try {
          const parsed = JSON.parse(String(body.events_json || "[]"));
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();
  const sessionId = cleanText(body.session_id).slice(0, 120);
  const device = asObject(body.device);
  const now = new Date().toISOString();
  let saved = 0;
  for (const raw of rawEvents.slice(0, 50)) {
    const event = asObject(raw);
    const eventName = cleanText(event.event || event.event_name || event.name).slice(0, 120);
    if (!eventName) continue;
    await upsertDocument(orgId, "onboarding_events", {
      id: cleanText(event.id) || `onboarding_event_${Date.now()}_${randomUUID().slice(0, 8)}`,
      data: {
        event_name: eventName,
        actor_email: actorEmail,
        session_id: cleanText(event.session_id || sessionId),
        step: cleanText(event.step || event.page || event.page_id),
        step_index: Number(event.step_index ?? event.page_index ?? -1),
        occurred_at: cleanText(event.occurred_at || event.ts) || now,
        duration_ms: Number(event.duration_ms || 0) || 0,
        target: cleanText(event.target).slice(0, 240),
        label: cleanText(event.label).slice(0, 240),
        device: { ...device, ...asObject(event.device) },
        viewport: asObject(event.viewport),
        metadata: asObject(event.metadata),
        request: {
          ip: request?.ip || "",
          user_agent: String(request?.headers["user-agent"] || "")
        }
      },
      metadata: { kind: "portal_onboarding_event", actor_email: actorEmail, session_id: cleanText(event.session_id || sessionId) }
    });
    saved += 1;
  }
  return { success: true, saved };
}

async function sendSignupVerificationOtpEmail(email: string, code: string) {
  const subject = `1m8 Signup Verification Code: ${code}`;
  const textBody = `Your 1m8 signup verification code is: ${code}\n\nThis code expires in 10 minutes.`;
  const htmlBody = `<p>Your 1m8 signup verification code is:</p>
    <div style="font-size:24px;font-weight:700;letter-spacing:4px;margin:12px 0;">${escapeHtml(code)}</div>
    <p>This code expires in 10 minutes.</p>`;
  const sent = await sendPostmarkEmail({ to: email, subject, textBody, htmlBody });
  if (!sent.ok && !env.isProduction && sent.error === "Postmark token missing") return { ok: true, skipped: true };
  return sent;
}

async function portalOnboardingSignupVerificationStart(orgId: string, userDoc: JsonObject, actorEmail: string, body: JsonObject) {
  const identity = await findIdentityByEmail(actorEmail);
  const targetEmail = validEmail(body.email || identity.email);
  if (!targetEmail) return { success: false, status_code: 400, error: "A valid email address is required." };
  if (targetEmail !== cleanText(identity.email).toLowerCase()) {
    const existing = await findIdentityByEmail(targetEmail).catch(() => null);
    if (existing && String(existing.id || "") !== String(identity.id || "")) {
      return { success: false, status_code: 409, error: "That email is already in use." };
    }
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const requestedAt = new Date().toISOString();
  const metadata = asObject(identity.metadata);
  const verification = {
    ...signupEmailVerification(identity),
    verified: false,
    pending_email: targetEmail,
    code_hash: signupOtpCodeHash(String(identity.id || ""), code),
    expires_at: Date.now() + 10 * 60 * 1000,
    requested_at: requestedAt,
    requested_by: actorEmail,
    requested_org_id: orgId,
    requested_user_id: cleanText(userDoc.id)
  };
  await patchIdentity(String(identity.id || ""), {
    metadata: { ...metadata, email_verified: false, signup_email_verification: verification }
  });
  const postmark = await sendSignupVerificationOtpEmail(targetEmail, code);
  if (!postmark.ok) {
    return {
      success: false,
      status_code: 500,
      error: "postmark_send_failed",
      message: ("error" in postmark ? postmark.error : "") || "Unable to send verification code."
    };
  }
  return {
    success: true,
    require_signup_otp: true,
    email: targetEmail,
    email_sent: true,
    expires_at: verification.expires_at,
    ...(env.isProduction ? {} : { dev_otp: code, email_skipped: Boolean((postmark as { skipped?: unknown }).skipped) })
  };
}

async function portalOnboardingSignupVerificationConfirm(orgId: string, userDoc: JsonObject, actorEmail: string, body: JsonObject) {
  const identity = await findIdentityByEmail(actorEmail);
  const verification = signupEmailVerification(identity);
  const code = cleanText(body.otp || body.code);
  if (!signupOtpCodeValid(identity, verification, code)) {
    return { success: false, status_code: 400, error: "Invalid or expired code." };
  }
  const targetEmail = validEmail(verification.pending_email || body.email || identity.email);
  if (!targetEmail) return { success: false, status_code: 400, error: "A valid email address is required." };
  const now = new Date().toISOString();
  const nextVerification = {
    ...verification,
    verified: true,
    verified_email: targetEmail,
    verified_at: now
  };
  const nextMetadata = {
    ...asObject(identity.metadata),
    email_verified: true,
    signup_email_verification: nextVerification
  };
  const nextIdentity = await patchIdentity(String(identity.id || ""), {
    ...(targetEmail !== cleanText(identity.email).toLowerCase() ? { email: targetEmail } : {}),
    metadata: nextMetadata
  });
  const currentData = asObject(userDoc.data);
  if (targetEmail !== cleanText(currentData.email).toLowerCase()) {
    await upsertDocument(orgId, "users", {
      id: String(userDoc.id || ""),
      data: { ...currentData, email: targetEmail }
    });
  }
  await saveGlobal(orgId, {
    data: onboardingCompletionData(targetEmail, { ...body, email_verified: "1" })
  });
  return { success: true, verified: true, email: targetEmail, identity: publicIdentity(nextIdentity), org: await portalOrgView(orgId) };
}

async function portalOnboardingComplete(orgId: string, actorEmail: string, body: JsonObject) {
  const identity = await findIdentityByEmail(actorEmail).catch(() => null);
  if (identity && !signupEmailIsVerified(identity)) {
    const verification = signupEmailVerification(identity);
    return {
      success: false,
      require_signup_otp: true,
      email: cleanText(verification.pending_email || identity.email).toLowerCase(),
      message: "Email verification is required before onboarding can finish."
    };
  }
  await saveGlobal(orgId, {
    data: onboardingCompletionData(actorEmail, body)
  });
  return { success: true, org: await portalOrgView(orgId) };
}

function signupAttributionPayload(input: JsonObject) {
  const fields = [
    "referral_code",
    "referral_attribution_id",
    "acquisition_code",
    "acquisition_attribution_id",
    "campaign",
    "campaign_code",
    "campaign_type",
    "source_type",
    "landing_variant",
    "landing_page",
    "page_url",
    "referrer",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "cid",
    "xid",
    "acquisition_bonus_token",
    "acquisition_bonus_set_id",
    "acquisition_bonus_label",
    "fbclid",
    "_fbc",
    "_fbp",
    "page_path",
    "page_search",
    "page_hash",
    "request_received_at",
    "request_ip",
    "client_ip",
    "forwarded_for",
    "forwarded_proto",
    "forwarded_host",
    "real_ip",
    "remote_address",
    "user_agent",
    "accept_language",
    "request_referrer",
    "origin",
    "host",
    "request_host",
    "request_protocol",
    "request_url",
    "cf_connecting_ip",
    "cf_ipcountry",
    "cf_region",
    "cf_city",
    "cf_postal_code",
    "cf_timezone",
    "x_vercel_ip_country",
    "x_vercel_ip_country_region",
    "x_vercel_ip_city",
    "x_vercel_ip_latitude",
    "x_vercel_ip_longitude",
    "x_appengine_country",
    "x_appengine_region",
    "x_appengine_city",
    "browser_user_agent",
    "browser_language",
    "browser_languages",
    "browser_platform",
    "browser_vendor",
    "browser_cookie_enabled",
    "browser_do_not_track",
    "timezone",
    "timezone_offset_minutes",
    "screen_width",
    "screen_height",
    "screen_available_width",
    "screen_available_height",
    "screen_color_depth",
    "screen_pixel_depth",
    "viewport_width",
    "viewport_height",
    "device_pixel_ratio",
    "touch_points",
    "hardware_concurrency",
    "device_memory",
    "connection_type",
    "connection_effective_type",
    "connection_downlink",
    "connection_rtt",
    "page_title",
    "page_loaded_at",
    "visibility_state",
    "history_length",
    "navigation_type",
    "page_load_ms",
    "dom_interactive_ms",
    "dom_content_loaded_ms"
  ];
  const payload: JsonObject = {};
  for (const field of fields) {
    const value = input[field];
    if (value != null && cleanText(value)) payload[field] = cleanText(value);
  }
  const metadata = compactObject({
    ...parseJsonObject(input.metadata),
    ...parseJsonObject(input.attribution_metadata)
  });
  if (Object.keys(metadata).length) payload.metadata = metadata;
  return payload;
}

async function applyAcquisitionSignup(orgId: string, input: JsonObject) {
  const attributionInput = signupAttributionPayload(input);
  if (!cleanText(attributionInput.referral_code)
    && !cleanText(attributionInput.referral_attribution_id)
    && !cleanText(attributionInput.acquisition_code)
    && !cleanText(attributionInput.acquisition_attribution_id)
    && !cleanText(attributionInput.campaign)
    && !cleanText(attributionInput.campaign_code)) {
    return null;
  }

  const completed = await completeAcquisitionSignup({
    org_id: orgId,
    email: cleanText(input.email).toLowerCase(),
    name: cleanText(input.name),
    company: cleanText(input.company),
    ...attributionInput
  });
  if (!completed.success) return completed;

  if (cleanText(completed.acquisition_source_type) !== "referral") return completed;

  const referralCode = cleanText(input.referral_code || asObject(completed.code).code);
  const attributionId = cleanText(input.referral_attribution_id || asObject(completed).acquisition_attribution_id || asObject(completed).attribution_id);
  const offerId = cleanText(asObject(completed).offer_id);
  const now = new Date().toISOString();
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const offers = asObject(data.offers);
  const items = asObject(offers.items);

  if (offerId === "referral_week_discount_v1") {
    const startsAt = now;
    const endsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await saveGlobal(orgId, {
      data: {
        offers: {
          ...offers,
          items: {
            ...items,
            referral_week_discount_v1: {
              ...asObject(items.referral_week_discount_v1),
              offer_id: "referral_week_discount_v1",
              status: "active",
              starts_at: startsAt,
              ends_at: endsAt,
              discount_percent: 50,
              window_days: 7,
              claimed_at: now,
              metadata: {
                source: "referral_signup",
                referral_code: referralCode,
                attribution_id: asObject(completed).attribution_id || attributionId
              }
            }
          }
        }
      }
    });
    return { ...completed, offer_applied: true };
  }

  if (offerId === "referral_free_expedite_7_v1") {
    await saveGlobal(orgId, {
      data: {
        offers: {
          ...offers,
          items: {
            ...items,
            referral_free_expedite_7_v1: {
              ...asObject(items.referral_free_expedite_7_v1),
              offer_id: "referral_free_expedite_7_v1",
              status: "active",
              free_expedite_uses: 7,
              claimed_at: now,
              metadata: {
                source: "referral_signup",
                referral_code: referralCode,
                attribution_id: asObject(completed).attribution_id || attributionId
              }
            }
          }
        }
      }
    });
    await applyFreeExpediteDelta(orgId, {
      amount: 7,
      reason: "referral_free_expedite_offer",
      meta: {
        offer_id: "referral_free_expedite_7_v1",
        referral_code: referralCode,
        attribution_id: asObject(completed).attribution_id || attributionId
      }
    }, cleanText(input.email));
    return { ...completed, offer_applied: true };
  }

  return completed;
}

async function portalReferralStatus(orgId: string) {
  const org = await portalOrgView(orgId);
  const offer = asObject(asObject(asObject(org.offers).items).referral_week_discount_v1);
  return { success: true, active: offer.status === "active", offer, referral_link: "", discount: offer };
}

function bonusTimestampMs(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value > 10_000_000_000 ? value : value * 1000;
    const parsed = parseFirstMeasureTimestampMs(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function firstPositiveMoney(...values: unknown[]) {
  for (const value of values) {
    const amount = moneyAmount(Math.abs(numericValue(value, Number.NaN)));
    if (Number.isFinite(amount) && amount > 0) return amount;
  }
  return 0;
}

function bonusProjectData(value: unknown) {
  const doc = asObject(value);
  const data = asObject(doc.data);
  if (!Object.keys(data).length) return doc;
  return {
    id: doc.id,
    ...data,
    created_at: data.created_at ?? doc.created_at,
    updated_at: data.updated_at ?? doc.updated_at
  };
}

function bonusProjectUsageAmount(project: JsonObject) {
  const measurement = asObject(project.measurement_project ?? project.measurement);
  const raw = asObject(measurement.raw);
  const manifest = asObject(project.manifest);
  return firstPositiveMoney(
    project.amount_charged,
    measurement.amount_charged,
    raw.amount_charged,
    manifest.amount_charged,
    project.charged_amount,
    project.charge_amount,
    project.revenue
  );
}

function bonusProjectUsageDateMs(project: JsonObject) {
  const measurement = asObject(project.measurement_project ?? project.measurement);
  const raw = asObject(measurement.raw);
  const manifest = asObject(project.manifest);
  const timestamps = asObject(raw.timestamps);
  return bonusTimestampMs(
    measurement.submitted_at,
    measurement.queued_at,
    measurement.created_at,
    raw.submitted_at,
    raw.queued_at,
    raw.created_at,
    manifest.created_at,
    timestamps.created_at,
    timestamps.queued_at,
    project.submitted_at,
    project.queued_at,
    project.completed_at,
    project.uploaded_at,
    project.created_at,
    project.updated_at
  );
}

function bonusRunRateRoundingIncrement(twoMonthValue: number) {
  const value = Math.abs(Number(twoMonthValue || 0));
  if (value < 500) return 100;
  if (value < 1000) return 250;
  return 500;
}

function bonusRunRateTier(id: string, label: string, months: number, matchPercent: number, monthlyUsage: number, customerPays: number, roundingIncrement: number) {
  const absoluteCustomerPays = moneyAmount(Math.abs(monthlyUsage * months));
  const bonusDollars = moneyAmount(customerPays * (matchPercent / 100));
  return {
    id,
    label,
    months,
    customer_pays: customerPays,
    bonus_dollars: bonusDollars,
    total_account_value: moneyAmount(customerPays + bonusDollars),
    match_percent: matchPercent,
    type: "credit_usage_run_rate",
    absolute_customer_pays: absoluteCustomerPays,
    absolute_bonus_dollars: moneyAmount(absoluteCustomerPays * (matchPercent / 100)),
    absolute_total_account_value: moneyAmount(absoluteCustomerPays * (1 + matchPercent / 100)),
    rounding_increment: roundingIncrement
  };
}

function normalizedBonusTierSpec(value: unknown, index: number) {
  const spec = asObject(value);
  const multiplier = Math.max(0, numericValue(spec.multiplier ?? spec.month_multiplier ?? (index === 0 ? 1 : index === 1 ? 2 : 4), index === 0 ? 1 : index === 1 ? 2 : 4));
  const months = Math.max(0, numericValue(spec.months ?? spec.month_count ?? 0));
  const matchPercent = Math.max(0, numericValue(spec.match_percent ?? spec.bonus_percent ?? spec.match ?? (index === 0 ? 25 : 50), index === 0 ? 25 : 50));
  return {
    id: cleanText(spec.id) || `tier_${index + 1}`,
    label: `Option ${index + 1}`,
    multiplier,
    months,
    match_percent: matchPercent
  };
}

function normalizedBonusOfferConfig(value: unknown) {
  const input = asObject(value);
  const baseMonths = Math.max(0.01, numericValue(input.base_months ?? input.lowest_months, 2));
  const tiersInput = Array.isArray(input.tiers) ? input.tiers : [];
  const fallbackTiers = [
    { id: "tier_1", multiplier: 1, months: baseMonths, match_percent: 25 },
    { id: "tier_2", multiplier: 2, months: baseMonths * 2, match_percent: 50 },
    { id: "tier_3", multiplier: 4, months: baseMonths * 4, match_percent: 50 }
  ];
  const tiers = (tiersInput.length ? tiersInput : fallbackTiers)
    .slice(0, 8)
    .map((tier, index) => {
      const normalized = normalizedBonusTierSpec(tier, index);
      const months = normalized.months || moneyAmount(baseMonths * normalized.multiplier);
      return {
        ...normalized,
        months,
        label: `Option ${index + 1}`
      };
    })
    .filter((tier) => tier.multiplier > 0 && tier.match_percent >= 0);
  return {
    base_months: baseMonths,
    tiers: tiers.length ? tiers : fallbackTiers.map((tier, index) => normalizedBonusTierSpec(tier, index))
  };
}

async function bonusRunRateOffer(orgId: string, configInput: unknown = {}) {
  const config = normalizedBonusOfferConfig(configInput);
  const nowMs = Date.now();
  const thirtyDaysMs = 30 * 86_400_000;
  const [organization, global, projectDocs] = await Promise.all([
    readOrganization(orgId),
    readGlobal(orgId),
    listDocuments(orgId, "projects").catch(() => [])
  ]);
  const metadata = asObject(organization.metadata);
  const globalData = asObject(global.data);
  const legacyGlobal = asObject(globalData.legacy_org_snapshot);
  const legacyMetadata = asObject(metadata.legacy_snapshot);
  const projects = projectDocs.map((doc) => bonusProjectData(doc));
  const allOrderEvents = projects
    .map((project) => {
      const record = asObject(project);
      return {
        amount: bonusProjectUsageAmount(record),
        date_ms: bonusProjectUsageDateMs(record)
      };
    })
    .filter((event) => event.date_ms > 0 && event.date_ms <= nowMs);
  const usageEvents = allOrderEvents.filter((event) => event.amount > 0);
  const firstOrderMs = usageEvents.reduce((min, event) => Math.min(min, event.date_ms), Infinity);
  const signupMs = bonusTimestampMs(
    organization.created_at,
    metadata.created_at,
    metadata.signup_at,
    metadata.signed_up_at,
    globalData.created_at,
    globalData.signup_at,
    legacyGlobal.created_at,
    legacyGlobal.signup_at,
    legacyMetadata.created_at,
    legacyMetadata.signup_at
  ) || (Number.isFinite(firstOrderMs) ? firstOrderMs : 0);
  const accountAgeDays = signupMs ? Math.max(0, (nowMs - signupMs) / 86_400_000) : 0;
  const useLastMonth = accountAgeDays > 30;
  const windowStartMs = useLastMonth ? nowMs - thirtyDaysMs : (signupMs || (Number.isFinite(firstOrderMs) ? firstOrderMs : nowMs));
  const windowEvents = usageEvents.filter((event) => event.date_ms >= windowStartMs && event.date_ms <= nowMs);
  const windowCreditUsage = moneyAmount(windowEvents.reduce((sum, event) => sum + event.amount, 0));
  const observedDays = useLastMonth
    ? 30
    : Math.max(1, Math.min(30, accountAgeDays || ((nowMs - windowStartMs) / 86_400_000) || 1));
  const monthlyUsage = useLastMonth ? windowCreditUsage : moneyAmount((windowCreditUsage / observedDays) * 30);
  const baseValue = moneyAmount(monthlyUsage * config.base_months);
  const roundingIncrement = bonusRunRateRoundingIncrement(baseValue);
  const roundedBaseValue = Math.max(0, Math.round(baseValue / roundingIncrement) * roundingIncrement);
  const tiers = roundedBaseValue > 0
    ? config.tiers.map((tier) => bonusRunRateTier(
      tier.id,
      tier.label,
      tier.months,
      tier.match_percent,
      monthlyUsage,
      Math.max(0, Math.round(roundedBaseValue * tier.multiplier)),
      roundingIncrement
    ))
    : [];

  return {
    tiers,
    basis: {
      window: useLastMonth ? "last_30_days" : "lifetime_prorated",
      account_age_days: Math.round(accountAgeDays * 10) / 10,
      observed_days: Math.round(observedDays * 10) / 10,
      window_start: new Date(windowStartMs).toISOString(),
      window_end: new Date(nowMs).toISOString(),
      charged_order_count: windowEvents.length,
      lifetime_charged_order_count: usageEvents.length,
      visible_order_count: allOrderEvents.length,
      monthly_credit_usage_estimate: monthlyUsage,
      base_months: config.base_months,
      base_credit_usage_estimate: baseValue,
      rounded_base_customer_pays: roundedBaseValue,
      two_month_credit_usage_estimate: moneyAmount(monthlyUsage * 2),
      rounded_two_month_customer_pays: config.base_months === 2 ? roundedBaseValue : 0,
      rounding_increment: roundingIncrement
    }
  };
}

function bonusOfferInstances(value: unknown) {
  return asObject(value);
}

function bonusOfferInstanceStatus(instanceInput: unknown, nowMs = Date.now()) {
  const instance = asObject(instanceInput);
  const status = cleanText(instance.status || "scheduled").toLowerCase();
  if (status === "cancelled" || status === "archived") return "cancelled";
  if (instance.claimed === true || status === "claimed" || cleanText(instance.claimed_at)) return "claimed";
  const startsAt = bonusTimestampMs(instance.starts_at || instance.scheduled_at || instance.created_at);
  if (startsAt && nowMs < startsAt) return "scheduled";
  const viewedAt = bonusTimestampMs(instance.viewed_at || instance.first_shown_at);
  const expiresAt = bonusTimestampMs(instance.expires_at || instance.ends_at);
  if (viewedAt && expiresAt && nowMs > expiresAt) return "expired";
  return viewedAt ? "viewed" : "available";
}

function bonusOfferInstanceSecondsRemaining(instanceInput: unknown, nowMs = Date.now()) {
  const instance = asObject(instanceInput);
  const status = bonusOfferInstanceStatus(instance, nowMs);
  if (status !== "viewed") return 0;
  const expiresAt = bonusTimestampMs(instance.expires_at || instance.ends_at);
  return expiresAt ? Math.max(0, Math.floor((expiresAt - nowMs) / 1000)) : 0;
}

function sortedBonusOfferInstances(value: unknown) {
  return Object.values(bonusOfferInstances(value))
    .map((entry) => asObject(entry))
    .filter((entry) => cleanText(entry.id) && cleanText(entry.offer_id || "bonus_upfront_match_v1") === "bonus_upfront_match_v1")
    .sort((a, b) => {
      const aStart = bonusTimestampMs(a.starts_at || a.scheduled_at || a.created_at);
      const bStart = bonusTimestampMs(b.starts_at || b.scheduled_at || b.created_at);
      return bStart - aStart || cleanText(b.id).localeCompare(cleanText(a.id));
    });
}

function selectPortalBonusOfferInstance(globalData: JsonObject, nowMs = Date.now()) {
  return sortedBonusOfferInstances(globalData.bonus_offer_instances)
    .find((instance) => ["available", "viewed"].includes(bonusOfferInstanceStatus(instance, nowMs))) ?? null;
}

async function markBonusOfferInstanceViewed(orgId: string, instanceInput: JsonObject) {
  const id = cleanText(instanceInput.id);
  if (!id) return { instance: instanceInput, firstView: false };
  const existingViewedAt = cleanText(instanceInput.viewed_at || instanceInput.first_shown_at);
  if (existingViewedAt) return { instance: instanceInput, firstView: false };
  const now = new Date().toISOString();
  const windowHours = Math.max(1, numericValue(instanceInput.window_hours ?? instanceInput.duration_hours, 24));
  const expiresAt = new Date(Date.now() + windowHours * 3_600_000).toISOString();
  const latest = await readGlobal(orgId);
  const latestData = asObject(latest.data);
  const instances = bonusOfferInstances(latestData.bonus_offer_instances);
  const current = asObject(instances[id] || instanceInput);
  if (cleanText(current.viewed_at || current.first_shown_at)) return { instance: current, firstView: false };
  const next = {
    ...current,
    id,
    status: "viewed",
    viewed: true,
    viewed_at: now,
    first_shown_at: now,
    last_shown_at: now,
    show_count: Math.max(0, Math.round(numericValue(current.show_count))) + 1,
    expires_at: expiresAt,
    ends_at: expiresAt,
    updated_at: now
  };
  await saveGlobal(orgId, {
    data: {
      bonus_offer_instances: {
        ...instances,
        [id]: next
      }
    }
  });
  return { instance: next, firstView: true };
}

function publicBonusOfferInstance(instanceInput: unknown) {
  const instance = asObject(instanceInput);
  return {
    id: cleanText(instance.id),
    offer_id: cleanText(instance.offer_id || "bonus_upfront_match_v1"),
    rollout_id: cleanText(instance.rollout_id),
    label: cleanText(instance.label || instance.name || "Bonus offer"),
    status: bonusOfferInstanceStatus(instance),
    starts_at: cleanText(instance.starts_at),
    viewed_at: cleanText(instance.viewed_at || instance.first_shown_at),
    expires_at: cleanText(instance.expires_at || instance.ends_at),
    ends_at: cleanText(instance.expires_at || instance.ends_at),
    window_hours: numericValue(instance.window_hours ?? instance.duration_hours, 24)
  };
}

function publicRequestBaseUrl(request: { headers: Record<string, unknown> }) {
  const origin = cleanText(request.headers.origin);
  if (origin && /^https?:\/\//i.test(origin)) return origin.replace(/\/+$/, "");
  const host = cleanText(request.headers.host);
  const proto = cleanText(request.headers["x-forwarded-proto"]) || "http";
  return host ? `${proto}://${host}` : "";
}

function apiRequestBaseUrl(request: { headers: Record<string, unknown> }) {
  const host = cleanText(request.headers["x-forwarded-host"] || request.headers.host);
  const proto = cleanText(request.headers["x-forwarded-proto"]) || "http";
  return host ? `${proto}://${host}` : publicRequestBaseUrl(request);
}

async function portalBonusStatus(orgId: string) {
  const offerEnabled = await isAppFlagEnabled(orgId, "firstmeasure", "bonus_upfront_match").catch(() => false);
  if (!offerEnabled) {
    return {
      success: true,
      org_id: orgId,
      offer_enabled: false,
      show_banner: false,
      seconds_remaining: 0,
      offer: {},
      tiers: []
    };
  }

  const global = await readGlobal(orgId);
  const globalData = asObject(global.data);
  const rolloutInstance = selectPortalBonusOfferInstance(globalData);
  if (rolloutInstance) {
    const viewed = await markBonusOfferInstanceViewed(orgId, rolloutInstance);
    const instance = asObject(viewed.instance);
    const secondsRemaining = bonusOfferInstanceSecondsRemaining(instance);
    const tiers = Array.isArray(instance.tiers) ? instance.tiers : [];
    const publicInstance = publicBonusOfferInstance(instance);
    return {
      success: true,
      org_id: orgId,
      offer_enabled: true,
      show_banner: secondsRemaining > 0 && tiers.length > 0,
      seconds_remaining: secondsRemaining,
      auto_open_modal: viewed.firstView,
      offer: {
        ...publicInstance,
        offer_id: "bonus_upfront_match_v1",
        status: publicInstance.status === "viewed" ? "active" : publicInstance.status
      },
      bonus_offer_instance: publicInstance,
      offer_instance_id: publicInstance.id,
      rollout_id: publicInstance.rollout_id,
      tiers,
      bonus_run_rate_basis: asObject(instance.basis)
    };
  }

  return {
    success: true,
    org_id: orgId,
    offer_enabled: true,
    show_banner: false,
    seconds_remaining: 0,
    offer: {},
    tiers: []
  };
}

function stripeIsTestMode() {
  return env.stripeTestMode;
}

function stripeSecretKey() {
  return env.stripeSecretKey || (stripeIsTestMode() ? env.stripeTestSecretKey : env.stripeLiveSecretKey);
}

function stripeWebhookSecret() {
  return env.stripeWebhookSecret || (stripeIsTestMode() ? env.stripeTestWebhookSecret : env.stripeLiveWebhookSecret);
}

function stripeWebhookSecrets() {
  return Array.from(new Set([stripeWebhookSecret()].filter(Boolean)));
}

function stripePriceId(bonus = false) {
  if (bonus) return env.stripeBonusPriceId || (stripeIsTestMode() ? env.stripeTestBonusPriceId : env.stripeLiveBonusPriceId);
  return env.stripePriceId || (stripeIsTestMode() ? env.stripeTestPriceId : env.stripeLivePriceId);
}

function stripeReturnBaseUrl(body: JsonObject = {}) {
  const raw = cleanText(body.return_base_url || body.base_url || env.stripeBaseUrl);
  if (!raw || !/^https?:\/\//i.test(raw)) return env.stripeBaseUrl.replace(/\/+$/, "");
  return raw.replace(/\/+$/, "");
}

function stripeObjectId(value: unknown) {
  return value && typeof value === "object" ? cleanText(asObject(value).id) : cleanText(value);
}

async function stripeApiRequest(method: "GET" | "POST", apiPath: string, fields: Record<string, unknown> = {}, idempotencyKey = "") {
  const key = stripeSecretKey();
  if (!key) return { success: false, error: "Stripe secret key is not configured." };
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  let url = `https://api.stripe.com${apiPath}`;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? "")])).toString();
  } else if (Object.keys(fields).length) {
    const qs = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? "")])).toString();
    url += apiPath.includes("?") ? `&${qs}` : `?${qs}`;
  }
  const response = await fetch(url, init).catch((error) => ({ ok: false, status: 0, text: async () => String(error) } as Response));
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok || !data || typeof data !== "object") {
    return { success: false, http: response.status, error: "Stripe API error", stripe: data };
  }
  return { success: true, http: response.status, data: data as JsonObject };
}

async function stripeCreateCustomer(orgId: string) {
  const org = await portalOrgView(orgId);
  const result = await stripeApiRequest("POST", "/v1/customers", {
    name: cleanText(org.name) || "Organization",
    "metadata[org_id]": orgId
  });
  if (!result.success) return result;
  const customerId = cleanText(asObject(result.data).id);
  if (!customerId) return { success: false, error: "Stripe customer response was missing an id.", stripe: result.data };
  await stripePatchBilling(orgId, { stripe: { customer_id: customerId } }, "stripe_customer_created", { customer_id: customerId, source: "node" });
  return { success: true, customer_id: customerId, customer: result.data };
}

async function stripeCustomerIdForOrg(orgId: string) {
  const global = await readGlobal(orgId);
  const billing = asObject(asObject(global.data).billing);
  const stripe = asObject(billing.stripe);
  let customerId = cleanText(stripe.customer_id);
  if (customerId) return customerId;
  const created = await stripeCreateCustomer(orgId);
  if (!created.success) throw badRequest("stripe_customer_create_failed", cleanText(created.error) || "Could not create Stripe customer.");
  customerId = cleanText(asObject(created).customer_id);
  if (!customerId) throw badRequest("stripe_customer_create_failed", "Could not create Stripe customer.");
  return customerId;
}

async function stripeBonusQuote(orgId: string, qty: number, offerInstanceId = "") {
  const offerEnabled = await isAppFlagEnabled(orgId, "firstmeasure", "bonus_upfront_match").catch(() => false);
  if (!offerEnabled) return { valid: false, reason: "feature_disabled", tier_id: "", bonus_dollars: 0, total_account_value: qty };
  if (offerInstanceId) {
    const global = await readGlobal(orgId);
    const data = asObject(global.data);
    const instance = asObject(bonusOfferInstances(data.bonus_offer_instances)[offerInstanceId]);
    if (!cleanText(instance.id)) return { valid: false, reason: "offer_instance_not_found", tier_id: "", bonus_dollars: 0, total_account_value: qty };
    const status = bonusOfferInstanceStatus(instance);
    if (status !== "viewed") return { valid: false, reason: status === "expired" ? "offer_expired" : "offer_not_viewed", tier_id: "", bonus_dollars: 0, total_account_value: qty };
    const tiers = Array.isArray(instance.tiers) ? instance.tiers.map((tier) => asObject(tier)) : [];
    const tier = tiers.find((item) => Math.round(numericValue(item.customer_pays)) === qty);
    if (!tier) return { valid: false, reason: "invalid_amount", tier_id: "", bonus_dollars: 0, total_account_value: qty, offer_instance_id: offerInstanceId };
    return {
      valid: true,
      reason: "",
      tier_id: cleanText(tier.id),
      label: cleanText(tier.label),
      set_id: cleanText(instance.rollout_id),
      offer_instance_id: offerInstanceId,
      rollout_id: cleanText(instance.rollout_id),
      match_percent: numericValue(tier.match_percent),
      bonus_dollars: numericValue(tier.bonus_dollars),
      total_account_value: numericValue(tier.total_account_value)
    };
  }
  return { valid: false, reason: "campaign_required", tier_id: "", bonus_dollars: 0, total_account_value: qty };
}

async function portalStripeCreateCheckout(orgId: string, email: string, body: JsonObject) {
  const qty = Math.max(1, Math.min(50_000, Math.round(numericValue(body.qty || body.amount || 1, 1))));
  const metaAttribution = metaAttributionFields(body);
  const offerId = cleanText(body.offer_id);
  const offerToken = cleanText(body.offer_token || body.acquisition_bonus_token || body.xid);
  const offerInstanceId = cleanText(body.offer_instance_id || body.bonus_offer_instance_id);
  let bonus = 0;
  let totalCredit = qty;
  let offerTierId = "";
  let offerSetId = "";
  let offerLabel = "";
  let offerInstanceMetaId = "";
  let offerRolloutId = "";
  let matchPercent = 0;
  let useBonus = false;
  if (offerId) {
    if (offerId !== "bonus_upfront_match_v1" && offerId !== "acquisition_bonus_offer_v1") return { success: false, error: "This offer is not fulfilled through Stripe checkout." };
    const quote = offerId === "acquisition_bonus_offer_v1"
      ? await acquisitionBonusQuoteForOrganization(orgId, qty, offerToken)
      : await stripeBonusQuote(orgId, qty, offerInstanceId);
    if (!quote.valid) return { success: false, error: "This amount is not available for the bonus offer.", offer_id: offerId, reason: quote.reason, quote };
    bonus = quote.bonus_dollars;
    totalCredit = quote.total_account_value;
    offerTierId = quote.tier_id;
    offerSetId = cleanText(asObject(quote).set_id);
    offerLabel = cleanText(asObject(quote).label);
    offerInstanceMetaId = cleanText(asObject(quote).offer_instance_id || offerInstanceId);
    offerRolloutId = cleanText(asObject(quote).rollout_id);
    matchPercent = Number(asObject(quote).match_percent ?? 0);
    useBonus = true;
  }
  const customerId = await stripeCustomerIdForOrg(orgId);
  const baseUrl = stripeReturnBaseUrl(body);
  const successUrl = `${baseUrl}/index.php?paid=1&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${baseUrl}/index.php?paid=0`;
  const fields: Record<string, unknown> = {
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer: customerId,
    client_reference_id: email,
    "payment_intent_data[setup_future_usage]": "off_session",
    "metadata[user_email]": email,
    "metadata[org_id]": orgId,
    "metadata[credit_dollars]": totalCredit,
    "metadata[paid_dollars]": qty,
    "metadata[bonus_dollars]": bonus,
    "metadata[is_signup_match]": useBonus ? "1" : "0",
    "metadata[credits_qty]": totalCredit
  };
  for (const [key, value] of Object.entries(metaAttribution)) {
    fields[`metadata[${key}]`] = value;
  }
  if (useBonus) {
    fields["metadata[offer_id]"] = offerId;
    fields["metadata[offer_tier_id]"] = offerTierId;
    if (offerToken) fields["metadata[offer_token]"] = offerToken;
    if (offerInstanceMetaId) fields["metadata[offer_instance_id]"] = offerInstanceMetaId;
    if (offerRolloutId) fields["metadata[bonus_rollout_id]"] = offerRolloutId;
    if (offerSetId) fields["metadata[offer_set_id]"] = offerSetId;
    if (offerLabel) fields["metadata[offer_label]"] = offerLabel;
    if (matchPercent) fields["metadata[match_percent]"] = matchPercent;
  }
  const priceId = stripePriceId(useBonus);
  if (priceId && !useBonus) {
    fields["line_items[0][price]"] = priceId;
    fields["line_items[0][quantity]"] = qty;
  } else {
    const matchPercent = qty > 0 && bonus > 0 ? Math.round((bonus / qty) * 10_000) / 100 : 0;
    fields["line_items[0][price_data][currency]"] = "usd";
    fields["line_items[0][price_data][unit_amount]"] = "100";
    fields["line_items[0][price_data][product_data][name]"] = useBonus ? "Roof Measurement Credits With Limited-Time Bonus" : "Roof Measurement Credits";
    fields["line_items[0][price_data][product_data][description]"] = useBonus
      ? `$${qty} purchased + $${bonus} limited-time bonus (${matchPercent}% bonus) = $${totalCredit} total credit added to your account`
      : `$${totalCredit} credit added to your FirstMate account`;
    fields["line_items[0][quantity]"] = qty;
  }
  const created = await stripeApiRequest("POST", "/v1/checkout/sessions", fields);
  if (!created.success) return { success: false, error: created.error || "Stripe checkout failed.", stripe: created.stripe || created.data };
  const session = asObject(created.data);
  return {
    success: true,
    url: session.url || null,
    session,
    ...(useBonus ? { deal_applied: offerId, offer_id: offerId, deal_org_id: orgId, bonus_dollars: bonus, total_credited: totalCredit, offer_quote: { valid: true, tier_id: offerTierId, set_id: offerSetId, token: offerToken, label: offerLabel, offer_instance_id: offerInstanceMetaId, rollout_id: offerRolloutId, match_percent: matchPercent, bonus_dollars: bonus, total_account_value: totalCredit } } : {})
  };
}

async function portalStripeStartSetup(orgId: string, body: JsonObject) {
  const customerId = await stripeCustomerIdForOrg(orgId);
  const global = await readGlobal(orgId);
  const billing = safeBillingView(asObject(global.data).billing);
  const threshold = Math.max(35, Math.round(numericValue(billing.auto_topup.threshold_dollars, 50)));
  const topup = Math.max(35, Math.round(numericValue(billing.auto_topup.topup_dollars, 100)));
  const baseUrl = stripeReturnBaseUrl(body);
  const termsUrl = `${baseUrl}/terms`;
  const consent = billing.auto_topup.enabled
    ? `I authorize FirstMate to save my card for recurring billing and authorize an automatic top-up of $${topup} when my balance drops below $${threshold}. [Terms](${termsUrl})`
    : `I authorize FirstMate to save my card for future billing. [Terms](${termsUrl})`;
  const created = await stripeApiRequest("POST", "/v1/checkout/sessions", {
    mode: "setup",
    customer: customerId,
    currency: "usd",
    success_url: `${baseUrl}/index.php?tab=company_settings&sub=billing&setup=1&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/index.php?tab=company_settings&sub=billing&setup=0`,
    "consent_collection[terms_of_service]": "required",
    "custom_text[terms_of_service_acceptance][message]": consent,
    "metadata[type]": "org_auto_topup_setup",
    "metadata[org_id]": orgId,
    "metadata[topup_dollars]": topup,
    "metadata[threshold_dollars]": threshold,
    "metadata[auto_topup_enabled_at_checkout]": billing.auto_topup.enabled ? "1" : "0"
  });
  if (!created.success) return { success: false, error: "Setup session failed", stripe: created.stripe || created.data };
  return { success: true, url: asObject(created.data).url || null, session: created.data };
}

async function portalStripeFinishSetup(sessionId: string) {
  if (!sessionId) return { success: false, error: "Missing session_id" };
  const session = await stripeRetrieveCheckoutSessionExpanded(sessionId);
  if (!session.success) return session;
  return await stripeSavePaymentMethodFromSession(asObject(session.session), "stripe_setup_return");
}

async function stripeRetrieveCheckoutSession(sessionId: string) {
  if (!sessionId) return { success: false, error: "Missing session_id" };
  const result = await stripeApiRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`);
  if (!result.success) return { success: false, error: result.error || "Stripe retrieve error", stripe: result.stripe || result.data };
  return { success: true, session: result.data };
}

async function stripeRetrieveCheckoutSessionExpanded(sessionId: string) {
  if (!sessionId) return { success: false, error: "Missing session_id" };
  const result = await stripeApiRequest("GET", `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=payment_intent&expand[]=setup_intent&expand[]=customer`);
  if (!result.success) return { success: false, error: result.error || "Stripe retrieve error", stripe: result.stripe || result.data };
  return { success: true, session: result.data };
}

async function portalStripeFulfillSession(sessionId: string, source: string) {
  const retrieved = await stripeRetrieveCheckoutSession(sessionId);
  if (!retrieved.success) return retrieved;
  return await stripeFulfillFromSession(asObject(retrieved.session), source);
}

async function stripeFulfillFromSession(session: JsonObject, source: string) {
  const sessionId = cleanText(session.id);
  if (!sessionId) return { success: false, error: "Missing session id" };
  const liveMode = session.livemode === true;
  if (liveMode !== !stripeIsTestMode()) return { success: false, error: "Livemode mismatch", livemode: liveMode, test_mode: stripeIsTestMode(), session_id: sessionId };
  const paymentStatus = cleanText(session.payment_status);
  if (paymentStatus !== "paid") return { success: false, error: "Not paid yet", payment_status: paymentStatus, session_id: sessionId };
  const meta = asObject(session.metadata);
  const email = cleanText(meta.user_email || session.client_reference_id).toLowerCase();
  let orgId = cleanText(meta.org_id);
  if (!orgId && email) orgId = await portalOrgIdForEmail(email);
  const dollars = Math.max(0, Math.round(numericValue(meta.credit_dollars || meta.credits_qty)));
  if (!email || !orgId || dollars < 1) return { success: false, error: "Missing metadata", user_email: email, org_id: orgId, credit_dollars: dollars, session_id: sessionId };
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const fulfilled = asObject(data.stripe_fulfilled_sessions);
  if (fulfilled[sessionId]) return { success: true, duplicate: true, session_id: sessionId };
  const credit = await applyCreditDelta(orgId, {
    amount: dollars,
    reason: "stripe_checkout_paid",
    applied_for_user_email: email,
    meta: {
      source,
      session_id: sessionId,
      stripe_checkout_session_id: sessionId,
      offer_id: meta.offer_id || "",
      offer_tier_id: meta.offer_tier_id || "",
      amount_total: session.amount_total ?? null,
      currency: session.currency ?? null,
      paid_dollars: numericValue(meta.paid_dollars, dollars),
      bonus_dollars: numericValue(meta.bonus_dollars),
      is_signup_match: meta.is_signup_match === "1",
      test_mode: stripeIsTestMode()
    }
  }, email);
  const purchaseValue = Math.max(0, Math.round(numericValue(meta.paid_dollars, dollars) * 100) / 100);
  const metaCapi = await metaCapiPurchaseFromStripeSession({
    email,
    orgId,
    sessionId,
    value: purchaseValue,
    currency: cleanText(session.currency || "usd").toUpperCase() || "USD",
    fbc: cleanText(meta.fbc || meta._fbc),
    fbp: cleanText(meta.fbp || meta._fbp),
    eventSourceUrl: `${env.stripeBaseUrl.replace(/\/+$/, "")}/index.php?paid=1`,
    source
  }).catch((error) => ({ ok: false, skipped: false, error: cleanText((error as Error)?.message || "meta_capi_error") }));
  const latest = await readGlobal(orgId);
  const latestData = asObject(latest.data);
  const offerInstanceId = cleanText(meta.offer_instance_id);
  const currentBonusOfferInstances = bonusOfferInstances(latestData.bonus_offer_instances);
  const claimedBonusOfferInstance = offerInstanceId ? asObject(currentBonusOfferInstances[offerInstanceId]) : {};
  const nextBonusOfferInstances = offerInstanceId && cleanText(claimedBonusOfferInstance.id)
    ? {
      ...currentBonusOfferInstances,
      [offerInstanceId]: {
        ...claimedBonusOfferInstance,
        status: "claimed",
        claimed: true,
        claimed_at: new Date().toISOString(),
        claimed_session_id: sessionId,
        paid_dollars: purchaseValue,
        bonus_dollars: numericValue(meta.bonus_dollars),
        total_credited: dollars,
        selected_tier_id: cleanText(meta.offer_tier_id),
        updated_at: new Date().toISOString()
      }
    }
    : currentBonusOfferInstances;
  await saveGlobal(orgId, {
    data: {
      stripe_fulfilled_sessions: {
        ...asObject(latestData.stripe_fulfilled_sessions),
        [sessionId]: { fulfilled: true, source, user_email: email, credit_dollars: dollars, paid_dollars: purchaseValue, meta_capi: metaCapi, ts: new Date().toISOString() }
      },
      ...(offerInstanceId ? { bonus_offer_instances: nextBonusOfferInstances } : {}),
      claimed_deals: meta.is_signup_match === "1"
        ? { ...asObject(latestData.claimed_deals), signup_match_50: true, bonus_upfront_match_v1: true }
        : asObject(latestData.claimed_deals)
    }
  });
  await stripeSavePaymentMethodFromCheckout(orgId, session).catch(() => null);
  return { success: true, credited: dollars, paid_dollars: purchaseValue, email, scope: "org", org_id: orgId, session_id: sessionId, balance: credit.balance, meta_capi: metaCapi };
}

function metaAttributionFields(body: JsonObject) {
  const fields: Record<string, string> = {};
  for (const key of ["fbc", "fbp", "_fbc", "_fbp"]) {
    const value = cleanText(body[key]);
    if (value) fields[key.replace(/^_/, "")] = value.slice(0, 500);
  }
  return fields;
}

function metaHash(value: unknown) {
  const clean = cleanText(value).toLowerCase();
  if (!clean) return "";
  return createHash("sha256").update(clean).digest("hex");
}

async function metaCapiPurchaseFromStripeSession(input: { email: string; orgId: string; sessionId: string; value: number; currency: string; fbc?: string; fbp?: string; eventSourceUrl?: string; source?: string }) {
  const pixelId = cleanText(env.metaPixelId);
  const accessToken = cleanText(env.metaCapiAccessToken);
  if (!pixelId) return { ok: false, skipped: true, reason: "missing_pixel_id" };
  if (!accessToken && !env.metaCapiTestMode) return { ok: false, skipped: true, reason: "missing_access_token" };
  if (!input.sessionId || !input.email || !Number.isFinite(input.value) || input.value <= 0) return { ok: false, skipped: true, reason: "invalid_purchase_event" };

  const userData: JsonObject = { em: [metaHash(input.email)] };
  if (input.fbc) userData.fbc = input.fbc;
  if (input.fbp) userData.fbp = input.fbp;

  const event = {
    event_name: "Purchase",
    event_time: Math.floor(Date.now() / 1000),
    event_id: `stripe_purchase:${input.sessionId}`,
    action_source: "website",
    event_source_url: input.eventSourceUrl || env.stripeBaseUrl,
    user_data: userData,
    custom_data: {
      currency: input.currency || "USD",
      value: input.value,
      order_id: input.sessionId,
      content_type: "product",
      content_name: "FirstMate account credit",
      source: input.source || "stripe_checkout",
      org_id: input.orgId
    }
  };

  if (env.metaCapiTestMode) return { ok: true, skipped: false, test_mode: true, event };

  const version = cleanText(env.metaCapiVersion) || "v21.0";
  const url = `https://graph.facebook.com/${encodeURIComponent(version)}/${encodeURIComponent(pixelId)}/events`;
  const payload: JsonObject = { data: [event], access_token: accessToken };
  const testEventCode = cleanText(env.metaCapiTestEventCode);
  if (testEventCode) payload.test_event_code = testEventCode;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, skipped: false, http: response.status, response: data };
  return { ok: true, skipped: false, http: response.status, response: data };
}

async function stripeSavePaymentMethodFromCheckout(orgId: string, session: JsonObject) {
  const customerId = stripeObjectId(session.customer);
  const paymentIntent = session.payment_intent;
  const paymentIntentId = typeof paymentIntent === "object" && paymentIntent ? cleanText(asObject(paymentIntent).id) : cleanText(paymentIntent);
  if (!orgId || !customerId || !paymentIntentId) return;
  const result = await stripeApiRequest("GET", `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, { "expand[]": "payment_method" });
  if (!result.success) return;
  const pm = asObject(asObject(result.data).payment_method);
  const pmId = cleanText(pm.id);
  if (pmId) await stripeSaveCardToOrg(orgId, customerId, pmId, pm, "payment_method_saved_via_checkout");
}

async function stripeSavePaymentMethodFromSession(session: JsonObject, eventType: string) {
  const meta = asObject(session.metadata);
  const orgId = cleanText(meta.org_id);
  const customerId = stripeObjectId(session.customer);
  const setup = session.setup_intent;
  const setupIntentId = typeof setup === "object" && setup ? cleanText(asObject(setup).id) : cleanText(setup);
  if (!orgId || !customerId || !setupIntentId) return { success: false, error: "Missing setup metadata" };
  const result = await stripeApiRequest("GET", `/v1/setup_intents/${encodeURIComponent(setupIntentId)}`, { "expand[]": "payment_method" });
  if (!result.success) return { success: false, error: "Could not retrieve setup intent", stripe: result.stripe || result.data };
  const pm = asObject(asObject(result.data).payment_method);
  const pmId = cleanText(pm.id);
  if (!pmId) return { success: false, error: "Setup intent has no payment method" };
  await stripeSaveCardToOrg(orgId, customerId, pmId, pm, eventType);
  return { success: true, fulfilled: true, org_id: orgId, payment_method_id: pmId };
}

async function stripeSaveCardToOrg(orgId: string, customerId: string, paymentMethodId: string, paymentMethod: JsonObject, eventType: string) {
  const card = asObject(paymentMethod.card);
  await stripeApiRequest("POST", `/v1/customers/${encodeURIComponent(customerId)}`, {
    "invoice_settings[default_payment_method]": paymentMethodId
  }).catch(() => null);
  await stripePatchBilling(orgId, {
    stripe: {
      customer_id: customerId,
      payment_method_id: paymentMethodId,
      has_payment_method: true,
      brand: card.brand || null,
      last4: card.last4 || null,
      exp_month: card.exp_month || null,
      exp_year: card.exp_year || null
    },
    auto_topup: { status: "ok", last_error: null }
  }, eventType, { customer_id: customerId, payment_method_id: paymentMethodId, brand: card.brand || null, last4: card.last4 || null });
}

async function stripePatchBilling(orgId: string, patch: JsonObject, eventType = "", eventMeta: JsonObject = {}) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = asObject(data.billing);
  const next: JsonObject = {
    ...billing,
    ...patch,
    stripe: { ...asObject(billing.stripe), ...asObject(patch.stripe) },
    auto_topup: { ...asObject(billing.auto_topup), ...asObject(patch.auto_topup) }
  };
  const events = Array.isArray(next.events) ? [...next.events] : [];
  if (eventType) events.push({ ts: new Date().toISOString(), type: eventType, meta: eventMeta });
  next.events = events;
  await saveGlobal(orgId, { data: { billing: next } });
  return next;
}

async function stripeMaybeAutoTopup(orgId: string, actorEmail: string, balanceAfterSpend: number, triggerEntry: JsonObject) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = asObject(data.billing);
  const autoTopup = asObject(billing.auto_topup);
  const stripe = asObject(billing.stripe);
  if (autoTopup.enabled !== true) return null;
  const threshold = Math.max(0, Math.round(numericValue(autoTopup.threshold_dollars, 50)));
  if (balanceAfterSpend > threshold) return null;

  const topup = Math.max(35, Math.round(numericValue(autoTopup.topup_dollars, 100)));
  const customerId = cleanText(stripe.customer_id);
  const paymentMethodId = cleanText(stripe.payment_method_id);
  if (!customerId || !paymentMethodId) {
    await stripePatchBilling(orgId, {
      auto_topup: { status: "needs_payment_method", last_error: "No saved payment method" },
      stripe: { has_payment_method: false }
    }, "autotopup_missing_payment_method", { balance_after_spend: balanceAfterSpend, threshold_dollars: threshold });
    return { attempted: false, status: "needs_payment_method", error: "No saved payment method" };
  }

  const cooldownMinutes = Math.max(0, Math.round(numericValue(autoTopup.cooldown_minutes, 30)));
  const lastAttemptMs = Date.parse(cleanText(autoTopup.last_attempt_utc));
  if (cooldownMinutes > 0 && Number.isFinite(lastAttemptMs) && Date.now() - lastAttemptMs < cooldownMinutes * 60_000) {
    return { attempted: false, status: "cooldown", cooldown_minutes: cooldownMinutes };
  }

  const attemptUtc = new Date().toISOString();
  await stripePatchBilling(orgId, {
    auto_topup: { status: "attempting", last_attempt_utc: attemptUtc, last_error: null }
  }, "autotopup_attempting", { balance_after_spend: balanceAfterSpend, threshold_dollars: threshold, topup_dollars: topup });

  const triggerHash = stableHash(JSON.stringify({
    orgId,
    ts: triggerEntry.ts,
    delta: triggerEntry.delta,
    balance_after: triggerEntry.balance_after,
    reason: triggerEntry.reason,
    meta: triggerEntry.meta
  })).slice(0, 24);
  const result = await stripeApiRequest("POST", "/v1/payment_intents", {
    amount: Math.round(topup * 100),
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: "true",
    confirm: "true",
    description: `FirstMate auto top-up for ${orgId}`,
    "metadata[type]": "org_auto_topup",
    "metadata[org_id]": orgId,
    "metadata[topup_dollars]": topup,
    "metadata[balance_after_spend]": balanceAfterSpend,
    "metadata[threshold_dollars]": threshold
  }, `org_auto_topup_${orgId}_${triggerHash}`);

  if (!result.success) {
    const stripeError = asObject(asObject(result.stripe).error);
    const code = cleanText(stripeError.code || stripeError.decline_code);
    const requiresAction = code === "authentication_required" || code === "card_declined";
    await stripePatchBilling(orgId, {
      auto_topup: {
        status: requiresAction ? "needs_payment_method" : "failed",
        last_error: cleanText(stripeError.message) || cleanText(result.error) || "Stripe PaymentIntent failed",
        ...(requiresAction ? { enabled: false } : {})
      }
    }, "autotopup_payment_intent_failed", { balance_after_spend: balanceAfterSpend, threshold_dollars: threshold, topup_dollars: topup, stripe_error: result.stripe || result.data || result.error });
    return { attempted: true, success: false, status: requiresAction ? "needs_payment_method" : "failed", error: cleanText(stripeError.message) || cleanText(result.error) || "Stripe PaymentIntent failed" };
  }

  const paymentIntent = asObject(result.data);
  const paymentIntentId = cleanText(paymentIntent.id);
  const status = cleanText(paymentIntent.status);
  if (status !== "succeeded") {
    await stripePatchBilling(orgId, {
      auto_topup: {
        enabled: false,
        status: "needs_payment_method",
        last_error: `Top-up not completed (status=${status || "unknown"}). Update card.`
      }
    }, "autotopup_non_succeeded", { payment_intent_id: paymentIntentId, status, balance_after_spend: balanceAfterSpend });
    return { attempted: true, success: false, status: "needs_payment_method", payment_intent_id: paymentIntentId, payment_status: status };
  }

  const credit = await applyCreditDelta(orgId, {
    amount: topup,
    reason: "stripe_auto_topup",
    applied_for_user_email: actorEmail,
    meta: {
      payment_intent_id: paymentIntentId,
      balance_before_topup: balanceAfterSpend,
      threshold_dollars: threshold,
      trigger: triggerEntry
    }
  }, actorEmail);
  await stripePatchBilling(orgId, {
    auto_topup: { status: "ok", last_success_utc: new Date().toISOString(), last_error: null }
  }, "autotopup_succeeded", { payment_intent_id: paymentIntentId, topup_dollars: topup, balance_after_spend: balanceAfterSpend, balance_after_topup: credit.balance });
  return { attempted: true, success: true, status: "ok", payment_intent_id: paymentIntentId, topup_dollars: topup, balance: credit.balance };
}

async function portalOrgIdForEmail(email: string) {
  try {
    const identity = await findIdentityByEmail(email);
    const memberships = await listIdentityMemberships(String(identity.id || ""));
    const first = memberships[0] ? asObject(memberships[0]) : {};
    const organization = asObject(first.organization);
    const user = asObject(first.user);
    const orgId = cleanText(organization.id || user.organization_id);
    if (orgId) return orgId;
  } catch {}
  for (const org of await listOrganizations()) {
    const orgId = cleanText(asObject(org).id);
    if (!orgId) continue;
    const user = await findPortalUserByEmail(orgId, email).catch(() => null);
    if (user) return orgId;
  }
  return "";
}

async function portalStripeWebhookProxy(body: JsonObject) {
  const signature = cleanText(body.signature);
  const payload = Buffer.from(cleanText(body.payload_base64), "base64").toString("utf8");
  if (!payload || !signature) return { success: false, status_code: 400, error: "Missing payload/signature" };
  if (!verifyStripeSignatureCompat(payload, signature)) return { success: false, status_code: 400, error: "Invalid signature" };
  const event = tryParseJsonField(payload, null) as JsonObject | null;
  if (!event || !cleanText(event.id) || !cleanText(event.type)) return { success: false, status_code: 400, error: "Invalid event JSON" };
  const liveMode = event.livemode === true;
  if (liveMode !== !stripeIsTestMode()) return { success: true, ignored: true, reason: "livemode_mismatch", livemode: liveMode, test_mode: stripeIsTestMode() };
  const eventType = cleanText(event.type);
  const object = asObject(asObject(event.data).object);
  if (eventType === "checkout.session.completed" || eventType === "checkout.session.async_payment_succeeded") {
    const sessionId = cleanText(object.id);
    const expanded = sessionId ? await stripeRetrieveCheckoutSessionExpanded(sessionId) : { success: true, session: object };
    const session = asObject(expanded.success ? expanded.session : object);
    if (cleanText(session.mode) === "setup") return await stripeSavePaymentMethodFromSession(session, "stripe_setup_webhook");
    return await stripeFulfillFromSession(session, "stripe_webhook");
  }
  if (eventType === "setup_intent.succeeded") {
    const meta = asObject(object.metadata);
    const orgId = cleanText(meta.org_id);
    const customerId = stripeObjectId(object.customer);
    const pm = object.payment_method;
    const pmId = typeof pm === "object" && pm ? cleanText(asObject(pm).id) : cleanText(pm);
    if (orgId && customerId && pmId) {
      const pmObj = typeof pm === "object" && pm ? asObject(pm) : asObject((await stripeApiRequest("GET", `/v1/payment_methods/${encodeURIComponent(pmId)}`)).data);
      await stripeSaveCardToOrg(orgId, customerId, pmId, pmObj, "setup_intent_succeeded");
    }
  }
  return { success: true, received: true, type: eventType };
}

function verifyStripeSignatureCompat(payload: string, signature: string) {
  const secrets = stripeWebhookSecrets();
  if (!payload || !signature || !secrets.length) return false;
  const parts = signature.split(",").map((part) => part.trim());
  const timestamp = cleanText(parts.find((part) => part.startsWith("t="))?.slice(2));
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  if (!timestamp || !signatures.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  return secrets.some((secret) => {
    const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest();
    return signatures.some((value) => {
      const actual = Buffer.from(value, "hex");
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  });
}

async function portalFetchImage(body: JsonObject) {
  const url = cleanText(body.url);
  if (!url) return { success: false, error: "Image URL is required." };
  if (url.startsWith("data:")) return { success: true, data_url: url };
  if (!/^https?:\/\//i.test(url)) return { success: false, error: "Only http/https image URLs are supported." };
  const response = await fetch(url, {
    headers: { "User-Agent": "FirstMateLogoFetcher/1.0" },
    signal: AbortSignal.timeout(6000)
  }).catch(() => null);
  if (!response || !response.ok) return { success: false, error: "Fetch failed." };
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 2 * 1024 * 1024) return { success: false, error: "Image is too large." };
  const contentType = String(String(response.headers.get("content-type") || "image/png").split(";")[0] || "image/png").trim();
  if (!contentType.startsWith("image/")) return { success: false, error: "Not an image URL." };
  return { success: true, data_url: `data:${contentType};base64,${bytes.toString("base64")}` };
}

async function portalScrapeLogos(body: JsonObject) {
  const url = cleanText(body.url);
  if (!/^https?:\/\//i.test(url)) return { success: false, error: "A valid website URL is required." };
  const response = await fetch(url, {
    headers: { "User-Agent": "FirstMateLogoScraper/1.0" },
    signal: AbortSignal.timeout(8000)
  }).catch(() => null);
  if (!response || !response.ok) return { success: false, error: "Could not fetch page." };
  const html = (await response.text()).slice(0, 700_000);
  const origin = new URL(url).origin;
  const baseMatch = html.match(/<base\s[^>]*href\s*=\s*["']([^"']+)["']/i);
  const base = baseMatch?.[1] ? new URL(baseMatch[1], url).toString() : url;
  const seen = new Set<string>();
  const candidates: { url: string; score: number; source: string }[] = [];
  const add = (raw: string, score: number, source: string) => {
    const trimmed = String(raw || "").trim();
    if (!trimmed || trimmed.startsWith("data:")) return;
    let resolved = "";
    try {
      resolved = trimmed.startsWith("//") ? `https:${trimmed}` : new URL(trimmed, trimmed.startsWith("/") ? origin : base).toString();
    } catch {
      return;
    }
    const key = resolved.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ url: resolved, score, source });
  };
  for (const match of html.matchAll(/<meta\s[^>]*(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["'][^>]*>/gi)) add(String(match[1] || ""), 140, "meta");
  for (const match of html.matchAll(/<link\s[^>]*rel=["'][^"']*(?:icon|apple-touch-icon|preload)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>/gi)) add(String(match[1] || ""), 120, "link");
  for (const match of html.matchAll(/<img\s[^>]*(?:src|data-src)=["']([^"']+)["'][^>]*>/gi)) {
    const tag = match[0].toLowerCase();
    const src = String(match[1] || "");
    let score = 20;
    if (tag.includes("logo")) score += 140;
    if (tag.includes("brand")) score += 70;
    if (tag.includes("header")) score += 30;
    if (tag.includes("avatar") || tag.includes("photo") || tag.includes("banner")) score -= 80;
    add(src, score, "img");
  }
  return {
    success: true,
    candidates: candidates.sort((a, b) => b.score - a.score).slice(0, 24)
  };
}

function isReportExpediteKey(value: unknown) {
  return isExpeditedReportExpediteKey(value);
}

async function assertPortalFirstMeasureFlag(orgId: string, flag: string, message: string) {
  if (await isAppFlagEnabled(orgId, "firstmeasure", flag).catch(() => false)) return;
  throw forbidden("feature_disabled", message);
}

async function assertPortalPlatformFlag(orgId: string, flag: string, message: string) {
  if (await isAppFlagEnabled(orgId, "platform", flag).catch(() => false)) return;
  throw forbidden("feature_disabled", message);
}

function moneyAmount(value: unknown) {
  const amount = numericValue(value, 0);
  return Math.round(amount * 100) / 100;
}

function firstMeasureReportAmount(body: JsonObject, projectType: string, reportMode: string, pins: unknown) {
  return sharedFirstMeasureReportAmount({
    ...body,
    project_type: projectType,
    report_mode: reportMode,
    pins
  });
}

function isPortalStructurePinLimitedType(projectType: string) {
  const normalized = cleanText(projectType).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized === "commercial" || normalized === "multifamily" || normalized === "multi_family";
}

function portalPinLimitForType(projectType: string) {
  const normalized = cleanText(projectType).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (normalized === "residential") return MAX_PORTAL_RESIDENTIAL_PINS;
  if (isPortalStructurePinLimitedType(normalized)) return MAX_PORTAL_STRUCTURE_PINS;
  return 0;
}

function portalPinLimitMessage(maxPins: number) {
  return `Maximum of ${maxPins} pins per report. Remove a pin to place a new one.`;
}

function firstMeasureReportCharge(body: JsonObject, projectType: string, reportMode: string, pins: unknown, freeExpediteUses: number) {
  return sharedFirstMeasureReportCharge({
    ...body,
    project_type: projectType,
    report_mode: reportMode,
    pins,
    free_expedite_uses: freeExpediteUses
  });
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + (Number(minutes) || 0) * 60_000);
}

function reportExpediteWindowLabel(start: Date, end: Date) {
  const format = (date: Date) => date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles"
  });
  return `${format(start)} - ${format(end)}`;
}

function reportExpediteOptionFromQuote(projectType: string, optionKey: string, structureCount = 1) {
  const quote = buildReportExpediteOptions({ projectType, structureCount });
  const normalized = normalizeReportExpediteKey(optionKey);
  return quote.options.find((option) => option.key === normalized) ?? null;
}

function firstMeasureManifestOrderAmount(manifest: JsonObject, optionKey: string) {
  const projectType = cleanText(manifest.project_type) || "residential";
  const pins = Array.isArray(manifest.pins) ? manifest.pins : [];
  return firstMeasureReportAmount({
    report_expedite_option: optionKey,
    include_gutter_measurements: manifest.include_gutter_measurements,
    include_weather_report: manifest.include_weather_report
  }, projectType, cleanText(manifest.report_mode) || "full", pins);
}

function firstMeasureManifestExpediteUpgradeBaseline(manifest: JsonObject) {
  const projectType = cleanText(manifest.project_type) || "residential";
  const pins = Array.isArray(manifest.pins) ? manifest.pins : [];
  return firstMeasureReportAmount({
    report_expedite_option: cleanText(manifest.report_expedite_option) || "standard_3_6",
    include_gutter_measurements: false,
    include_weather_report: false
  }, projectType, cleanText(manifest.report_mode) || "full", pins);
}
function parseFirstMeasureTimestampMs(...values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;
    const hasExplicitZone = /[zZ]|[+-]\d\d:?\d\d$/.test(text);
    const isoish = text.includes("T") ? text : text.replace(" ", "T");
    if (hasExplicitZone) {
      const direct = Date.parse(isoish);
      if (Number.isFinite(direct)) return direct;
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(text)) {
      const utc = Date.parse(`${isoish}Z`);
      if (Number.isFinite(utc)) return utc;
    }
    const direct = Date.parse(text);
    if (Number.isFinite(direct)) return direct;
  }
  return NaN;
}

function firstMeasureManifestDueEnd(manifest: JsonObject) {
  const explicit = Date.parse(cleanText(manifest.report_due_window_end));
  if (Number.isFinite(explicit)) return new Date(explicit);
  const timestamps = asObject(manifest.timestamps);
  const submittedAt = parseFirstMeasureTimestampMs(manifest.created_at, timestamps.created_at, timestamps.queued_at);
  if (!Number.isFinite(submittedAt)) return null;
  const pins = Array.isArray(manifest.pins) ? manifest.pins : [];
  const option = reportExpediteOptionFromQuote(
    cleanText(manifest.project_type) || "residential",
    cleanText(manifest.report_expedite_option) || "standard_3_6",
    Math.max(1, pins.length)
  );
  const endMinutes = numericValue(option?.end_minutes, 360);
  return addMinutes(new Date(submittedAt), endMinutes);
}

async function firstMeasureProjectDetail(app: FastifyInstance, projectId: string) {
  const response = await app.inject({ method: "GET", url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}` });
  const data = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400 || data.ok === false || data.success === false) {
    throw badRequest("project_not_found", "Report order could not be found.");
  }
  const manifest = asObject(data.project?.manifest ?? data.manifest ?? data.project);
  if (!Object.keys(manifest).length) throw badRequest("project_not_found", "Report order could not be found.");
  return { data, manifest };
}

function assertPortalOwnsFirstMeasureProject(manifest: JsonObject, orgId: string, actor: ReturnType<typeof portalActor>) {
  const orgRef = asObject(manifest.organization_ref);
  const issuer = asObject(manifest.issuer);
  const manifestOrgId = cleanText(orgRef.id ?? manifest.organization_id);
  const issuerEmail = cleanText(issuer.email ?? manifest.issuer_email).toLowerCase();
  if (manifestOrgId && manifestOrgId === orgId) return;
  if (issuerEmail && issuerEmail === actor.email.toLowerCase()) return;
  throw forbidden("project_access_denied", "You do not have access to this report order.");
}

async function portalExpediteQueuedProject(app: FastifyInstance, orgId: string, actor: ReturnType<typeof portalActor>, body: JsonObject) {
  await assertPortalFirstMeasureFlag(orgId, "report_expedite_options", "Report expediting is not enabled for this organization.");
  const projectId = cleanText(body.project_id || body.folder || body.measurement_project_id);
  if (!projectId) throw badRequest("missing_project_id", "Project id is required.");
  const optionKey = cleanText(body.report_expedite_option).toLowerCase();
  if (!isReportExpediteKey(optionKey)) {
    throw badRequest("invalid_expedite_option", "Choose a valid expedited delivery option.");
  }
  const { manifest } = await firstMeasureProjectDetail(app, projectId);
  assertPortalOwnsFirstMeasureProject(manifest, orgId, actor);
  const status = cleanText(manifest.status).toLowerCase();
  if (["completed", "rejected", "rejected_no_coverage", "cancelled"].includes(status)) {
    throw badRequest("project_not_expeditable", "This report can no longer be expedited.");
  }

  const projectType = cleanText(manifest.project_type) || "residential";
  const pinCount = Math.max(1, Array.isArray(manifest.pins) ? manifest.pins.length : 1);
  const option = reportExpediteOptionFromQuote(projectType, optionKey, pinCount);
  if (!option || !option.expedited || option.end_minutes == null) throw badRequest("invalid_expedite_option", "Choose a valid expedited delivery option.");
  const now = new Date();
  const currentDueEnd = firstMeasureManifestDueEnd(manifest);
  const newDueStart = addMinutes(now, numericValue(option.start_minutes));
  const newDueEnd = addMinutes(now, numericValue(option.end_minutes));
  const newProductionDeadline = addMinutes(now, numericValue(option.production_deadline_minutes ?? option.start_minutes));
  if (currentDueEnd && currentDueEnd.getTime() <= newDueEnd.getTime()) {
    throw badRequest("expedite_not_faster", "This project is already being worked on, so expediting is too late.");
  }

  const global = await readGlobal(orgId);
  const freeExpediteUses = numericValue(asObject(global.data).free_expedite_uses);
  const currentCharged = moneyAmount(manifest.amount_charged);
  const currentExpediteBaseline = firstMeasureManifestExpediteUpgradeBaseline(manifest);
  const upgradeCredit = currentCharged > 0 ? Math.min(currentCharged, currentExpediteBaseline) : currentCharged;
  const newTotal = firstMeasureManifestOrderAmount(manifest, option.key);
  const delta = moneyAmount(newTotal - upgradeCredit);
  if (delta <= 0) throw badRequest("expedite_not_billable", "This expedite option would not increase the order total.");
  const freeExpediteApplied = freeExpediteUses > 0;
  const expediteDiscount = freeExpediteApplied ? delta : 0;
  const chargeDelta = moneyAmount(Math.max(0, delta - expediteDiscount));
  const finalCharged = moneyAmount(currentCharged + chargeDelta);

  const balance = numericValue(asObject(global.data).credits_balance);
  if (chargeDelta > balance) {
    return {
      success: false,
      ok: false,
      status_code: 402,
      error: "insufficient_credits",
      message: "This organization does not have enough credits to expedite this report.",
      balance,
      required: chargeDelta
    };
  }

  const charge = chargeDelta > 0
    ? await applyCreditDelta(orgId, {
      amount: -chargeDelta,
      reason: "order_expedite_upgrade",
      meta: {
        project_id: projectId,
        previous_report_expedite_option: cleanText(manifest.report_expedite_option) || "standard_3_6",
        report_expedite_option: option.key,
        previous_amount: currentCharged,
        previous_expedite_baseline_amount: currentExpediteBaseline,
        credited_amount: upgradeCredit,
        final_amount: finalCharged,
        expedite_delta: chargeDelta,
        expedite_gross_delta: delta,
        free_expedite_discount: expediteDiscount,
        free_expedite_applied: freeExpediteApplied
      }
    }, actor.email)
    : null;

  const patch = {
    is_vip: false,
    is_expedited: true,
    report_expedite_option: option.key,
    report_expedite_label: option.label,
    report_due_window_start: newDueStart.toISOString(),
    report_due_window_end: newDueEnd.toISOString(),
    report_due_window_label: reportExpediteWindowLabel(newDueStart, newDueEnd),
    report_production_deadline_at: newProductionDeadline.toISOString(),
    amount_charged: finalCharged,
    report_original_amount: newTotal,
    report_discount_amount: moneyAmount(numericValue(manifest.report_discount_amount) + expediteDiscount),
    report_expedite_coupon_applied: Boolean(manifest.report_expedite_coupon_applied) || freeExpediteApplied,
    expedite_upgraded_at: now.toISOString(),
    expedite_upgrade_charge_amount: chargeDelta,
    expedite_upgrade_previous_amount: currentCharged,
    expedite_upgrade_previous_baseline_amount: currentExpediteBaseline,
    expedite_upgrade_credited_amount: upgradeCredit,
    expedite_upgrade_gross_delta: delta,
    expedite_upgrade_discount_amount: expediteDiscount,
    expedite_upgrade_by_email: actor.email,
    workflow: {
      ...asObject(manifest.workflow),
      history: [
        ...(Array.isArray(asObject(manifest.workflow).history) ? asObject(manifest.workflow).history as unknown[] : []),
        {
          ts: now.toISOString(),
          event: "customer_expedited_order",
          actor,
          previous_amount: currentCharged,
          previous_expedite_baseline_amount: currentExpediteBaseline,
          credited_amount: upgradeCredit,
          final_amount: finalCharged,
          charge_amount: chargeDelta,
          gross_delta: delta,
          discount_amount: expediteDiscount,
          report_expedite_option: option.key
        }
      ]
    }
  };
  const response = await app.inject({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`,
    headers: { "content-type": "application/json" },
    payload: patch
  });
  const data = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400 || data.ok === false || data.success === false) {
    if (chargeDelta > 0) await applyCreditDelta(orgId, { amount: chargeDelta, reason: "order_expedite_upgrade_refund", meta: { project_id: projectId, failed_expedite: data } }, actor.email);
    return { success: false, status_code: 400, error: String(data.message || data.error || "Expedite upgrade failed.") };
  }
  let freeExpedite = null;
  if (freeExpediteApplied) {
    freeExpedite = await applyFreeExpediteDelta(orgId, {
      amount: -1,
      reason: "order_free_expedite_used",
      meta: {
        project_id: projectId,
        report_expedite_option: option.key,
        discount_amount: expediteDiscount,
        source: "post_order_expedite_upgrade"
      }
    }, actor.email).catch((error) => ({ error: String(error instanceof Error ? error.message : error) }));
  }
  const autoTopup = charge ? await stripeMaybeAutoTopup(orgId, actor.email, charge.balance, charge.ledger_entry) : null;
  return {
    success: true,
    folder: projectId,
    charge_amount: chargeDelta,
    discount_amount: expediteDiscount,
    amount_charged: finalCharged,
    balance: charge?.balance ?? numericValue(asObject(global.data).credits_balance),
    free_expedite: freeExpedite,
    manifest: data.project?.manifest ?? data.manifest ?? patch,
    ...(autoTopup ? { auto_topup: autoTopup } : {})
  };
}

async function portalCancelQueuedProject(app: FastifyInstance, orgId: string, actor: ReturnType<typeof portalActor>, body: JsonObject) {
  await assertPortalFirstMeasureFlag(orgId, "report_cancellations", "Report cancellations are not enabled for this organization.");
  const projectId = cleanText(body.project_id || body.folder || body.measurement_project_id);
  if (!projectId) throw badRequest("missing_project_id", "Project id is required.");
  const { manifest } = await firstMeasureProjectDetail(app, projectId);
  assertPortalOwnsFirstMeasureProject(manifest, orgId, actor);
  const status = cleanText(manifest.status).toLowerCase();
  if (["completed", "rejected", "rejected_no_coverage", "cancelled"].includes(status)) {
    throw badRequest("project_not_cancelable", "This report can no longer be cancelled.");
  }
  const now = new Date();
  const timestamps = asObject(manifest.timestamps);
  const submittedMs = parseFirstMeasureTimestampMs(manifest.created_at, timestamps.created_at, timestamps.queued_at);
  const isExpedited = Boolean(manifest.is_expedited) || reportExpediteOptionFromQuote(cleanText(manifest.project_type) || "residential", cleanText(manifest.report_expedite_option))?.expedited === true;
  const graceMinutes = isExpedited ? 1 : 15;
  if (!Number.isFinite(submittedMs) || now.getTime() - submittedMs > graceMinutes * 60_000) {
    throw badRequest("cancel_grace_period_ended", isExpedited
      ? "Expedited reports begin work immediately and cannot be cancelled after 1 minute."
      : "The cancellation grace period for this project has ended.");
  }
  const refundAmount = moneyAmount(manifest.amount_charged);
  if (refundAmount > 0) {
    await applyCreditDelta(orgId, {
      amount: refundAmount,
      reason: "order_cancellation_refund",
      meta: { project_id: projectId, report_expedite_option: cleanText(manifest.report_expedite_option), expedited: isExpedited }
    }, actor.email);
  }
  if (Boolean(manifest.report_expedite_coupon_applied)) {
    await applyFreeExpediteDelta(orgId, {
      amount: 1,
      reason: "order_free_expedite_restored",
      meta: { project_id: projectId, report_expedite_option: cleanText(manifest.report_expedite_option), source: "cancelled_inside_grace_period" }
    }, actor.email).catch(() => null);
  }
  const response = await app.inject({
    method: "POST",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}/status`,
    headers: { "content-type": "application/json" },
    payload: { status: "cancelled", actor }
  });
  const data = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400 || data.ok === false || data.success === false) {
    if (refundAmount > 0) await applyCreditDelta(orgId, { amount: -refundAmount, reason: "order_cancellation_refund_reversal", meta: { project_id: projectId, failed_cancel: data } }, actor.email).catch(() => null);
    return { success: false, status_code: 400, error: String(data.message || data.error || "Cancellation failed.") };
  }
  const cancelledManifest = asObject(data.project?.manifest ?? data.project ?? {});
  const cancelledAt = cleanText(asObject(cancelledManifest.timestamps).cancelled_at)
    || cleanText(cancelledManifest.cancelled_at)
    || now.toISOString();
  const cancellationPatch = {
    cancelled_at: cancelledAt,
    cancelled_by_customer: true,
    cancelled_by_email: actor.email,
    cancelled_by_name: actor.name || actor.email,
    cancellation_refund_decision: "refunded",
    cancellation_refunded: refundAmount > 0,
    cancellation_refund_amount: refundAmount,
    cancellation_refund_at: refundAmount > 0 ? now.toISOString() : null,
    cancellation_refund_by_email: actor.email,
    cancellation_refund_by_name: actor.name || actor.email,
    cancellation: {
      cancelled_at: cancelledAt,
      cancelled_by_customer: true,
      cancelled_by_email: actor.email,
      cancelled_by_name: actor.name || actor.email,
      refund_decision: "refunded",
      refund_amount: refundAmount,
      refund_at: refundAmount > 0 ? now.toISOString() : null,
      reason: "customer_cancelled_inside_grace_period"
    },
    workflow: {
      ...asObject(manifest.workflow),
      assigned_to: null,
      assigned_at: null,
      reserved_to: null,
      reserved_at: null,
      history: [
        ...(Array.isArray(asObject(manifest.workflow).history) ? asObject(manifest.workflow).history as unknown[] : []),
        {
          ts: now.toISOString(),
          event: "customer_cancelled_order",
          actor,
          refunded: refundAmount,
          report_expedite_option: cleanText(manifest.report_expedite_option),
          expedited: isExpedited
        }
      ]
    }
  };
  const patchResponse = await app.inject({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`,
    headers: { "content-type": "application/json" },
    payload: cancellationPatch
  });
  const patchData = patchResponse.body ? JSON.parse(patchResponse.body) : {};
  return {
    success: true,
    folder: projectId,
    refunded: refundAmount,
    manifest: patchData.project?.manifest ?? patchData.manifest ?? cancelledManifest
  };
}

async function portalSubmitReportReworkRequest(app: FastifyInstance, orgId: string, actor: ReturnType<typeof portalActor>, body: JsonObject) {
  await assertPortalFirstMeasureFlag(orgId, "report_followup", "Report follow-up requests are not enabled for this organization.");
  const projectId = cleanText(body.project_id || body.folder || body.measurement_project_id);
  if (!projectId) throw badRequest("missing_project_id", "Project id is required.");
  const { manifest } = await firstMeasureProjectDetail(app, projectId);
  assertPortalOwnsFirstMeasureProject(manifest, orgId, actor);
  const status = cleanText(manifest.status).toLowerCase();
  if (["cancelled", "rejected", "rejected_no_coverage"].includes(status)) {
    throw badRequest("project_not_reworkable", "This report is not eligible for report follow-up requests.");
  }

  const requestType = normalizeReportReworkRequestType(body.request_type || body.type);
  let notes = cleanText(body.notes || body.description || body.message);
  if (!notes && requestType !== "additional_structure") throw badRequest("missing_request_notes", "Please describe what you need.");
  if (!notes) notes = "Additional structure requested by pin.";
  const projectType = cleanText(manifest.project_type).toLowerCase() || "residential";
  const existingRequests = Array.isArray(manifest.report_change_requests) ? manifest.report_change_requests as unknown[] : [];
  const now = new Date();
  const requestId = `rr_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const pins = normalizeReportRequestPins(body.pins);
  const photos = normalizeReportRequestPhotos(body.photos);
  const expediteOption = cleanText(body.report_expedite_option).toLowerCase();
  const allowRushCharge = requestType === "additional_structure" && projectType !== "residential";
  if (allowRushCharge && isReportExpediteKey(expediteOption)) {
    await assertPortalFirstMeasureFlag(orgId, "report_expedite_options", "Report expediting is not enabled for this organization.");
  }
  const normalizedExpedite = allowRushCharge && isReportExpediteKey(expediteOption)
    ? normalizeReportExpediteKey(expediteOption)
    : "standard_3_6";
  const requestedStructureCount = Math.round(numericValue(body.structure_count, pins.length || 1));
  const structureCount = requestType === "additional_structure"
    ? Math.max(1, requestedStructureCount || pins.length || 1)
    : 0;
  const global = await readGlobal(orgId);
  const globalData = asObject(global.data);
  const chargeQuote = requestType === "additional_structure" && projectType !== "residential"
    ? firstMeasureReportCharge({
        report_expedite_option: normalizedExpedite,
        include_gutter_measurements: false
      }, projectType, "full", Array.from({ length: structureCount }, () => ({ lat: 0, lng: 0 })), numericValue(globalData.free_expedite_uses))
    : null;
  const chargeAmount = chargeQuote ? chargeQuote.amount : 0;
  const balance = numericValue(globalData.credits_balance);
  if (chargeAmount > balance) {
    return {
      success: false,
      ok: false,
      status_code: 402,
      error: "insufficient_credits",
      message: "This organization does not have enough credits for this additional structure request.",
      balance,
      required: chargeAmount
    };
  }
  const charge = chargeAmount > 0
    ? await applyCreditDelta(orgId, {
      amount: -chargeAmount,
      reason: "report_additional_structure_request",
      meta: {
        project_id: projectId,
        request_id: requestId,
        project_type: projectType,
        structure_count: structureCount,
        report_expedite_option: normalizedExpedite,
        gross_amount: chargeQuote?.gross_amount ?? chargeAmount,
        free_expedite_discount: chargeQuote?.free_expedite_discount ?? 0,
        free_expedite_applied: chargeQuote?.free_expedite_applied ?? false
      }
    }, actor.email)
    : null;

  const requestRecord = {
    id: requestId,
    type: requestType,
    label: reportReworkRequestLabel(requestType),
    status: requestType === "report_issue" ? "sent_to_support" : "pending_review",
    created_at: now.toISOString(),
    created_by_email: actor.email,
    created_by_name: actor.name || actor.email,
    organization_id: orgId,
    notes,
    pins,
    photos,
    project_type: projectType,
    charged_amount: chargeAmount,
    gross_amount: chargeQuote?.gross_amount ?? chargeAmount,
    free_expedite_discount: chargeQuote?.free_expedite_discount ?? 0,
    free_expedite_applied: chargeQuote?.free_expedite_applied ?? false,
    report_expedite_option: normalizedExpedite,
    rush_requested: normalizedExpedite !== "standard_3_6",
    support_email_sent: false
  };

  const history = Array.isArray(asObject(manifest.workflow).history) ? asObject(manifest.workflow).history as unknown[] : [];
  const patch: JsonObject = {
    report_change_requests: [...existingRequests, requestRecord],
    latest_report_change_request: requestRecord,
    workflow: {
      ...asObject(manifest.workflow),
      history: [
        ...history,
        {
          ts: now.toISOString(),
          event: requestType === "report_issue" ? "customer_reported_report_issue" : "customer_requested_report_rework",
          actor,
          request_id: requestId,
          request_type: requestType,
          charged_amount: chargeAmount
        }
      ]
    }
  };

  if (requestType !== "report_issue") {
    patch.status = "rework_requested";
    patch.__allow_terminal_status_transition = true;
    patch.rework_requested_at = now.toISOString();
    patch.rework_request_type = requestType;
    patch.rework_request_id = requestId;
    patch.timestamps = {
      rework_requested_at: now.toISOString()
    };
  }

  const response = await app.inject({
    method: "PATCH",
    url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`,
    headers: { "content-type": "application/json" },
    payload: patch
  });
  const data = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400 || data.ok === false || data.success === false) {
    if (chargeAmount > 0) {
      await applyCreditDelta(orgId, {
        amount: chargeAmount,
        reason: "report_additional_structure_request_refund",
        meta: { project_id: projectId, request_id: requestId, failed_rework_request: data }
      }, actor.email).catch(() => null);
    }
    return { success: false, status_code: 400, error: String(data.message || data.error || "Could not submit the request.") };
  }

  let supportEmail = null;
  let freeExpedite = null;
  if (chargeQuote?.free_expedite_applied) {
    freeExpedite = await applyFreeExpediteDelta(orgId, {
      amount: -1,
      reason: "rework_free_expedite_used",
      meta: {
        project_id: projectId,
        request_id: requestId,
        project_type: projectType,
        report_expedite_option: normalizedExpedite,
        discount_amount: chargeQuote.free_expedite_discount
      }
    }, actor.email).catch((error) => ({ error: String(error instanceof Error ? error.message : error) }));
  }
  if (requestType === "report_issue") {
    supportEmail = await sendReportIssueSupportEmail({
      projectId,
      request: requestRecord,
      manifest,
      actor,
      orgId
    }).catch((error) => ({ ok: false, error: String(error instanceof Error ? error.message : error) }));
    if (supportEmail?.ok) {
      const updatedManifest = asObject(data.project?.manifest ?? data.manifest ?? {});
      const requests = Array.isArray(updatedManifest.report_change_requests) ? [...updatedManifest.report_change_requests] : [...existingRequests, requestRecord];
      const nextRequests = requests.map((entry) => {
        const item = asObject(entry);
        return item.id === requestId ? { ...item, support_email_sent: true } : entry;
      });
      await app.inject({
        method: "PATCH",
        url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}`,
        headers: { "content-type": "application/json" },
        payload: { report_change_requests: nextRequests }
      }).catch(() => null);
    }
  }

  return {
    success: true,
    folder: projectId,
    request: requestRecord,
    charged_amount: chargeAmount,
    balance: charge?.balance ?? null,
    free_expedite: freeExpedite,
    support_email: supportEmail,
    manifest: data.project?.manifest ?? data.manifest ?? null
  };
}

function normalizeReportReworkRequestType(value: unknown) {
  const raw = cleanText(value).toLowerCase().replace(/[\s-]+/g, "_");
  if (raw === "issue" || raw === "report_issue") return "report_issue";
  if (raw === "change" || raw === "correction" || raw === "request_change" || raw === "request_correction" || raw === "change_correction") return "change_correction";
  if (raw === "additional_structure" || raw === "add_structure" || raw === "structure") return "additional_structure";
  throw badRequest("invalid_rework_request_type", "Choose a valid request type.");
}

function reportReworkRequestLabel(type: string) {
  if (type === "report_issue") return "Reported issue";
  if (type === "additional_structure") return "Additional structure";
  return "Change or correction";
}

function normalizeReportRequestPins(value: unknown) {
  const parsed = typeof value === "string" ? tryParseJsonField(value, []) : value;
  return Array.isArray(parsed)
    ? parsed.slice(0, 20).map((pin) => {
      const item = asObject(pin);
      const lat = numericValue(item.lat ?? item.latitude, Number.NaN);
      const lng = numericValue(item.lng ?? item.longitude, Number.NaN);
      return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    }).filter(Boolean)
    : [];
}

function normalizeReportRequestPhotos(value: unknown) {
  const parsed = typeof value === "string" ? tryParseJsonField(value, []) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 8).map((entry) => {
    const item = asObject(entry);
    const name = cleanText(item.name).slice(0, 120) || "upload";
    const type = cleanText(item.type).slice(0, 80) || "application/octet-stream";
    const dataUrl = cleanText(item.data_url || item.dataUrl);
    return dataUrl && dataUrl.length <= 3_500_000 ? { name, type, data_url: dataUrl } : null;
  }).filter(Boolean);
}

function reportIssueEmailAttachments(request: Record<string, unknown>) {
  const photos = Array.isArray(request.photos) ? request.photos : [];
  return photos.slice(0, 8).map((entry, index) => {
    const item = asObject(entry);
    const dataUrl = cleanText(item.data_url || item.dataUrl);
    const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
    if (!match) return null;
    const contentType = cleanText(item.type || match[1]) || "image/jpeg";
    if (!contentType.startsWith("image/")) return null;
    const rawName = cleanText(item.name) || `issue-image-${index + 1}`;
    const safeName = rawName.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || `issue-image-${index + 1}`;
    return {
      Name: safeName,
      Content: match[2],
      ContentType: contentType
    };
  }).filter((entry): entry is { Name: string; Content: string; ContentType: string } => Boolean(entry));
}

async function sendReportIssueSupportEmail(input: {
  projectId: string;
  request: Record<string, unknown>;
  manifest: JsonObject;
  actor: ReturnType<typeof portalActor>;
  orgId: string;
}) {
  const [org, organization] = await Promise.all([
    readGlobal(input.orgId).catch(() => null),
    readOrganization(input.orgId).catch(() => null)
  ]);
  const orgData = asObject(org?.data);
  const organizationRef = asObject(input.manifest.organization_ref);
  const company = cleanText(
    organization?.name
    || orgData.name
    || orgData.company
    || input.manifest.owner_company
    || input.manifest.organization_name
    || organizationRef.name
  ) || input.orgId;
  const address = cleanText(input.manifest.address);
  const subject = `Automated report issue: ${address || input.projectId}`;
  const attachments = reportIssueEmailAttachments(input.request);
  const attachmentNames = attachments.map((attachment) => attachment.Name);
  const textBody = [
    "A customer reported an issue with a returned FirstMeasure report.",
    "",
    `Company: ${company}`,
    `Organization ID: ${input.orgId}`,
    `Project ID: ${input.projectId}`,
    `Address: ${address || "-"}`,
    `Submitted by: ${input.actor.name || input.actor.email} <${input.actor.email}>`,
    `Request ID: ${cleanText(input.request.id)}`,
    attachmentNames.length ? `Images attached: ${attachmentNames.join(", ")}` : "",
    "",
    "Customer message:",
    cleanText(input.request.notes)
  ].filter((line) => line !== "").join("\n");
  const htmlBody = `
    <p>A customer reported an issue with a returned FirstMeasure report.</p>
    <table style="border-collapse:collapse;margin:12px 0;">
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Company</td><td>${escapeHtml(company)}</td></tr>
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Organization ID</td><td>${escapeHtml(input.orgId)}</td></tr>
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Project ID</td><td>${escapeHtml(input.projectId)}</td></tr>
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Address</td><td>${escapeHtml(address || "-")}</td></tr>
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Submitted by</td><td>${escapeHtml(input.actor.name || input.actor.email)} &lt;${escapeHtml(input.actor.email)}&gt;</td></tr>
      <tr><td style="font-weight:700;padding:3px 10px 3px 0;">Request ID</td><td>${escapeHtml(input.request.id)}</td></tr>
      ${attachmentNames.length ? `<tr><td style="font-weight:700;padding:3px 10px 3px 0;">Images</td><td>${attachmentNames.map(escapeHtml).join(", ")}</td></tr>` : ""}
    </table>
    <p style="font-weight:700;margin-bottom:6px;">Customer message</p>
    <div style="white-space:pre-wrap;border:1px solid #eee;background:#fafafa;border-radius:10px;padding:12px;">${escapeHtml(input.request.notes)}</div>
  `;
  return sendPostmarkEmail({
    to: "info@1m8.ai",
    subject,
    textBody,
    htmlBody,
    attachments
  });
}

function normalizedPortalQueuePayload(body: JsonObject, actor: ReturnType<typeof portalActor>, orgId: string, projectType: string, reportMode: string, charge: ReturnType<typeof firstMeasureReportCharge>) {
  const pins = tryParseJsonField(body.pins, []);
  const ccEmails = tryParseJsonField(body.cc_emails, []);
  const lat = numericValue(body.lat, Number.NaN);
  const lng = numericValue(body.lng, Number.NaN);
  const amount = charge.amount;
  const payload: JsonObject = {
    ...body,
    actor,
    organization_ref: { id: orgId },
    project_type: projectType,
    report_mode: reportMode,
    is_expedited: parseBooleanField(body.is_expedited, false),
    include_gutter_measurements: parseBooleanField(body.include_gutter_measurements, false),
    include_weather_report: parseBooleanField(body.include_weather_report, false),
    amount_charged: amount,
    report_original_amount: charge.gross_amount,
    report_discount_amount: charge.free_expedite_discount,
    report_expedite_coupon_applied: charge.free_expedite_applied,
    charge_token: `node_${Date.now()}_${stableHash(`${orgId}:${actor.email}:${Date.now()}`).slice(0, 10)}`,
    instant_enabled: reportMode === "both",
    process_async: true
  };
  if (Number.isFinite(lat)) payload.lat = lat;
  else delete payload.lat;
  if (Number.isFinite(lng)) payload.lng = lng;
  else delete payload.lng;
  const normalizedPins = Array.isArray(pins)
    ? pins.map((pin) => {
      const item = asObject(pin);
      const pinLat = numericValue(item.lat ?? item.latitude, Number.NaN);
      const pinLng = numericValue(item.lng ?? item.longitude, Number.NaN);
      return Number.isFinite(pinLat) && Number.isFinite(pinLng) ? { lat: pinLat, lng: pinLng } : null;
    }).filter(Boolean)
    : [];
  payload.pins = normalizedPins;
  const quote = buildReportExpediteOptions({ projectType, structureCount: Math.max(1, normalizedPins.length || 1) });
  const requestedExpediteKey = normalizeReportExpediteKey(cleanText(body.report_expedite_option) || "standard_3_6");
  const expediteOption = quote.options.find((option) => option.key === requestedExpediteKey)
    ?? quote.options.find((option) => option.key === "standard_3_6");
  if (expediteOption) {
    payload.report_expedite_option = expediteOption.key;
    payload.report_expedite_label = expediteOption.label;
    payload.report_due_window_start = expediteOption.due_window_start;
    payload.report_due_window_end = expediteOption.due_window_end;
    payload.report_due_window_label = expediteOption.window_label;
    payload.report_production_deadline_at = expediteOption.production_deadline_at;
    payload.is_expedited = expediteOption.expedited;
  }
  payload.cc_emails = Array.isArray(ccEmails) ? ccEmails.map((value) => cleanText(value)).filter(Boolean) : [];
  payload.resident = {
    name: cleanText(body.residentName || body.resident_name),
    email: cleanText(body.residentEmail || body.resident_email),
    phone: cleanText(body.residentPhone || body.resident_phone)
  };
  payload.issuer = {
    name: cleanText(body.issuerName || body.issuer_name || actor.name),
    email: cleanText(body.issuerEmail || body.issuer_email || actor.email)
  };
  delete payload.google_api_key;
  delete payload.gemini_api_key;
  const components = tryParseJsonField(body.address_components, undefined);
  if (components && typeof components === "object" && !Array.isArray(components)) payload.components = components;
  return payload;
}

async function portalQueueProject(app: FastifyInstance, orgId: string, actor: ReturnType<typeof portalActor>, body: JsonObject) {
  if (isReportExpediteKey(body.report_expedite_option) || parseBooleanField(body.is_expedited, false)) {
    await assertPortalFirstMeasureFlag(orgId, "report_expedite_options", "Report expediting is not enabled for this organization.");
  }
  if (parseBooleanField(body.include_weather_report, false)) {
    await assertPortalFirstMeasureFlag(orgId, "weather_reports", "Historical weather reports are not enabled for this organization.");
  }
  const projectType = cleanText(body.project_type) || "residential";
  const reportMode = cleanText(body.report_mode) || "full";
  const pins = normalizeReportRequestPins(body.pins);
  const maxPins = portalPinLimitForType(projectType);
  if (maxPins && pins.length > maxPins) {
    return {
      success: false,
      ok: false,
      status_code: 400,
      error: "pin_limit_exceeded",
      message: portalPinLimitMessage(maxPins),
      max_pins: maxPins,
      pin_count: pins.length
    };
  }
  const global = await readGlobal(orgId);
  const globalData = asObject(global.data);
  const chargeQuote = firstMeasureReportCharge(body, projectType, reportMode, pins, numericValue(globalData.free_expedite_uses));
  const amount = chargeQuote.amount;
  const balance = numericValue(globalData.credits_balance);
  if (amount > balance) {
    return {
      success: false,
      ok: false,
      status_code: 402,
      error: "insufficient_credits",
      message: "This organization does not have enough credits to place this roof report order.",
      balance,
      required: amount
    };
  }
  const charge = await applyCreditDelta(orgId, {
    amount: -amount,
    reason: "order_submitted",
    meta: {
      address: cleanText(body.address),
      project_type: projectType,
      report_mode: reportMode,
      report_expedite_option: cleanText(body.report_expedite_option),
      include_weather_report: parseBooleanField(body.include_weather_report, false),
      gross_amount: chargeQuote.gross_amount,
      free_expedite_discount: chargeQuote.free_expedite_discount,
      free_expedite_applied: chargeQuote.free_expedite_applied
    }
  }, actor.email);
  const response = await app.inject({
    method: "POST",
    url: reportMode === "instant" ? "/v1/firstmeasure/instants" : "/v1/firstmeasure/projects/queue",
    headers: {
      "content-type": "application/json",
      ...(env.firstMeasureInternalApiSecret ? { "x-firstmeasure-internal": env.firstMeasureInternalApiSecret } : {})
    },
    payload: normalizedPortalQueuePayload(body, actor, orgId, projectType, reportMode, chargeQuote)
  });
  const data = response.body ? JSON.parse(response.body) : {};
  if (response.statusCode >= 400 || data.ok === false || data.success === false) {
    await applyCreditDelta(orgId, { amount, reason: "order_refund", meta: { failed_order: data } }, actor.email);
    return { success: false, status_code: 400, error: String(data.message || data.error || "Order submission failed.") };
  }
  let freeExpedite = null;
  if (chargeQuote.free_expedite_applied) {
    freeExpedite = await applyFreeExpediteDelta(orgId, {
      amount: -1,
      reason: "order_free_expedite_used",
      meta: {
        address: cleanText(body.address),
        project_type: projectType,
        report_expedite_option: cleanText(body.report_expedite_option),
        discount_amount: chargeQuote.free_expedite_discount,
        project_id: data.folder ?? data.project?.id ?? null
      }
    }, actor.email).catch((error) => ({ error: String(error instanceof Error ? error.message : error) }));
  }
  const autoTopup = await stripeMaybeAutoTopup(orgId, actor.email, charge.balance, charge.ledger_entry);
  return {
    success: true,
    folder: data.folder ?? data.project?.id ?? null,
    project: data.project ?? null,
    manifest: data.manifest ?? data.project?.manifest ?? null,
    is_vip: false,
    report_mode: reportMode,
    instant_url: data.instant_url ?? null,
    balance: charge.balance,
    free_expedite: freeExpedite,
    ...(autoTopup ? { auto_topup: autoTopup } : {})
  };
}

async function portalRefundInstant(app: FastifyInstance, orgId: string, actorEmail: string, body: JsonObject) {
  const amount = Math.abs(numericValue(body.refund_amount));
  if (amount > 0) await applyCreditDelta(orgId, { amount, reason: "instant_no_coverage_refund", meta: body }, actorEmail);
  const projectId = cleanText(body.project_id);
  if (projectId) {
    await app.inject({
      method: "POST",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(projectId)}/instant/refund`,
      headers: { "content-type": "application/json" },
      payload: { refund_issued: true, refund_amount: amount, refund_reason: cleanText(body.refund_reason) || "instant_no_coverage", refund_pending: false }
    });
  }
  return { success: true, refunded: true };
}

async function portalFirstMeasure(app: FastifyInstance, path: string, payload: JsonObject) {
  const response = await app.inject({
    method: "POST",
    url: `/v1/firstmeasure/${path.replace(/^\/+/, "")}`,
    headers: { "content-type": "application/json" },
    payload
  });
  const data = response.body ? JSON.parse(response.body) : {};
  return { success: response.statusCode < 400 && data.ok !== false, ...data };
}

async function parseMediaUploadRequest(request: unknown) {
  const typed = request as {
    headers?: Record<string, unknown>;
    body?: unknown;
    parts?: () => AsyncIterable<{
      type: "file" | "field";
      fieldname: string;
      value?: unknown;
      filename?: string;
      mimetype?: string;
      toBuffer?: () => Promise<Buffer>;
    }>;
  };
  const contentType = String(typed.headers?.["content-type"] ?? "");

  if (contentType.includes("multipart/form-data")) {
    let bytes: Buffer | null = null;
    let fileName = "";
    let fileContentType = "application/octet-stream";
    const fields: Record<string, unknown> = {};
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_unavailable", "Multipart uploads are unavailable on this route.");

    for await (const part of parts) {
      if (part.type === "file") {
        const buffer = await part.toBuffer?.();
        if (!buffer || !buffer.length) continue;
        if (!bytes || ["file", "media", "image", "photo", "logo", "avatar"].includes(part.fieldname)) {
          bytes = buffer;
          fileName = String(part.filename || part.fieldname || "upload");
          fileContentType = String(part.mimetype || "application/octet-stream");
        }
        continue;
      }
      fields[part.fieldname] = part.value;
    }

    if (!bytes) throw badRequest("missing_media_file", "A file field is required.");
    const processing = asObject(tryParseJsonField(fields.processing, {}));
    return {
      id: String(fields.id || ""),
      ownerType: String(fields.owner_type || fields.ownerType || ""),
      ownerId: String(fields.owner_id || fields.ownerId || ""),
      slot: String(fields.slot || ""),
      collection: String(fields.collection || ""),
      scope: String(fields.scope || ""),
      fileName,
      contentType: fileContentType,
      bytes,
      replaceSlot: parseBooleanField(fields.replace_slot ?? fields.replaceSlot, false),
      thumbnails: Object.prototype.hasOwnProperty.call(fields, "thumbnails")
        ? tryParseJsonField(fields.thumbnails, undefined)
        : processing.thumbnails,
      compression: Object.prototype.hasOwnProperty.call(fields, "compression")
        ? tryParseJsonField(fields.compression, undefined)
        : processing.compression,
      markup: Object.prototype.hasOwnProperty.call(fields, "markup")
        ? tryParseJsonField(fields.markup, undefined)
        : processing.markup,
      metadata: asObject(tryParseJsonField(fields.metadata, {}))
    };
  }

  const body = asObject(typed.body);
  const base64 = String(body.base64 || body.bytes_base64 || "");
  if (!base64) throw badRequest("unsupported_media_upload", "Media uploads must use multipart/form-data or include base64 bytes.");
  return {
    id: String(body.id || ""),
    ownerType: String(body.owner_type || body.ownerType || ""),
    ownerId: String(body.owner_id || body.ownerId || ""),
    slot: String(body.slot || ""),
    collection: String(body.collection || ""),
    scope: String(body.scope || ""),
    fileName: String(body.file_name || body.fileName || "upload"),
    contentType: String(body.content_type || body.contentType || "application/octet-stream"),
    bytes: Buffer.from(base64.replace(/^data:[^,]+,/u, ""), "base64"),
    replaceSlot: Boolean(body.replace_slot ?? body.replaceSlot),
    thumbnails: body.thumbnails,
    compression: body.compression,
    markup: body.markup,
    metadata: asObject(body.metadata)
  };
}
