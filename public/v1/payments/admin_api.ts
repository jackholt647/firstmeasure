import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";

import { badRequest, forbidden, notFound, unauthorized } from "../platform/errors.js";
import { listDocuments, listOrganizations, type JsonObject } from "../platform/storage.js";
import { readInternalUser } from "../internal/storage.js";
import {
  getMerchantConfigForOps,
  upsertMerchantConfig,
  type MerchantConfig
} from "./merchant_config.js";
import { recordPaymentEvent } from "./storage.js";
import { PAYMENT_PROVIDER_EVENT_COLLECTION } from "./webhooks_forward.js";
import {
  createForwardBoardingAdapter,
  FORWARD_PROVIDER,
  forwardConfigured
} from "./providers/forward.js";
import { createMockBoardingAdapter, MOCK_PROVIDER } from "./providers/mock.js";
import type { MerchantBoardingAdapter, ProviderApplication } from "./providers/types.js";

/**
 * Boarding-ops console API — /v1/payments/admin/*.
 *
 * FIRSTMATE-STAFF ONLY. These routes power the internal Staff Console
 * (public/measure/internal) "Boarding Ops" view: the cross-org merchant
 * application pipeline, plan assignment (interchange-plus <-> flat-rate) and
 * the provider go-live switch. They are deliberately NOT org-session routes:
 * requirePlatformAuth pins a session to a single organization, while this
 * console reads every org. Access is gated by the same internal-staff admin
 * guard that protects FirstMeasure API-key minting and feature-flag rollouts
 * (see requireInternalApiKeyAdmin in internal/api.ts): the actor identity
 * from the staff-console headers is resolved against the server-side internal
 * user store and must carry an internal admin role/permission.
 *
 * Kept in its own file (registered from payments/api.ts) so concurrent work
 * on the org-facing payments routes never collides with this block.
 */

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

function headerText(request: FastifyRequest, name: string) {
  const value = request.headers[name];
  return Array.isArray(value) ? cleanText(value[0]) : cleanText(value);
}

/** Actor identity supplied by the internal Staff Console shell. */
function staffActorFromRequest(request: FastifyRequest) {
  const query = asObject(request.query);
  const body = asObject(request.body);
  return {
    email: (headerText(request, "x-internal-user-email") || cleanText(query.actor_email) || cleanText(body.actor_email)).toLowerCase(),
    name: headerText(request, "x-internal-user-name") || cleanText(query.actor_name) || cleanText(body.actor_name),
    role: headerText(request, "x-internal-user-role") || cleanText(query.actor_role) || cleanText(body.actor_role)
  };
}

function isInternalStaffAdmin(user: JsonObject | null) {
  if (!user) return false;
  const role = cleanText(user.role).toLowerCase();
  const permissions = asObject(user.permissions);
  const status = cleanText(user.status).toLowerCase();
  if (status === "disabled" || status === "inactive" || user.disabled === true) return false;
  return role === "admin"
    || role === "system_admin"
    || user.is_admin === true
    || permissions.is_admin_legacy === true
    || permissions.platform_admin === true;
}

/**
 * The strongest staff guard the platform has: resolve the console-supplied
 * actor email against the internal user store and require an internal admin.
 * The claimed role header is never trusted for authorization — only the
 * stored record decides. Org users (no internal record) get 403.
 */
async function requireBoardingOpsStaff(request: FastifyRequest) {
  const actor = staffActorFromRequest(request);
  if (!actor.email) {
    throw unauthorized("missing_internal_actor", "An internal staff user is required for the boarding ops console.");
  }
  const user = await readInternalUser(actor.email).catch(() => null);
  if (!isInternalStaffAdmin(user)) {
    throw forbidden("staff_admin_required", "Only FirstMate internal admins can use the boarding ops console.");
  }
  return { ...actor, user };
}

/**
 * Resolves a boarding adapter for staff operations without requiring the
 * org's Money/merchant capability flags (staff must operate on orgs whose
 * apps are not switched on yet). Returns null when no adapter can act (e.g.
 * provider "forward" without env keys).
 */
function opsBoardingAdapter(orgId: string, config: MerchantConfig | null): MerchantBoardingAdapter | null {
  const provider = cleanText(config?.provider);
  if (provider === MOCK_PROVIDER) return createMockBoardingAdapter(orgId);
  if (provider === FORWARD_PROVIDER && forwardConfigured()) {
    const accountId = cleanText(config?.forward.account_id);
    return createForwardBoardingAdapter(accountId ? { accountId } : {});
  }
  return null;
}

const MUTABLE_APPLICATION_STATUSES = ["DRAFT", "NEED_INFORMATION"];

function pipelineRow(orgId: string, orgName: string, config: MerchantConfig) {
  return {
    org_id: orgId,
    org_name: orgName,
    provider: config.provider,
    boarding_status: config.forward.boarding_status,
    business_id: config.forward.business_id,
    application_id: config.forward.application_id,
    account_id: config.forward.account_id,
    processing_plan_id: config.forward.processing_plan_id,
    pending_plan_id: config.forward.pending_plan_id,
    processing_enabled: config.forward.processing_enabled,
    payouts_enabled: config.forward.payouts_enabled,
    last_event_at: config.forward.last_event_at,
    updated_at: config.updated_at
  };
}

async function collectPipeline() {
  const rows: Array<ReturnType<typeof pipelineRow>> = [];
  for (const organization of await listOrganizations()) {
    const org = asObject(organization);
    const orgId = cleanText(org.id);
    if (!orgId) continue;
    const config = await getMerchantConfigForOps(orgId).catch(() => null);
    if (!config) continue;
    rows.push(pipelineRow(orgId, cleanText(org.name) || orgId, config));
  }
  rows.sort((a, b) => cleanText(b.last_event_at || b.updated_at).localeCompare(cleanText(a.last_event_at || a.updated_at)));
  return rows;
}

function eventView(doc: unknown) {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    id: cleanText(data.id || source.id),
    provider: cleanText(data.provider),
    event_type: cleanText(data.event_type),
    received_at: cleanText(data.received_at || source.created_at),
    event: asObject(data.event)
  };
}

async function recentProviderEvents(orgId: string, limit = 20) {
  const documents = await listDocuments(orgId, PAYMENT_PROVIDER_EVENT_COLLECTION).catch(() => [] as unknown[]);
  return documents
    .map(eventView)
    .sort((a, b) => b.received_at.localeCompare(a.received_at))
    .slice(0, limit);
}

const assignPlanSchema = z.object({
  processing_plan_id: z.string().trim().min(1).max(200)
}).passthrough();

const setProviderSchema = z.object({
  provider: z.enum([MOCK_PROVIDER, FORWARD_PROVIDER]).nullable()
}).passthrough();

export const registerPaymentsAdminApi: FastifyPluginAsync = async (app) => {
  app.get("/", async (request) => {
    await requireBoardingOpsStaff(request);
    return {
      ok: true,
      api: "payments-admin",
      routes: {
        merchantConfigs: "/merchant-configs",
        merchantConfigDetail: "/merchant-configs/:orgId",
        assignPlan: "/merchant-configs/:orgId/assign-plan",
        setProvider: "/merchant-configs/:orgId/set-provider",
        processingPlans: "/processing-plans"
      }
    };
  });

  // Cross-org pipeline: every org holding a payment_merchant_config document,
  // joined with the org name. Filterable by boarding status and provider.
  app.get("/merchant-configs", async (request) => {
    await requireBoardingOpsStaff(request);
    const query = asObject(request.query);
    const statusFilter = cleanText(query.status).toUpperCase();
    const providerFilter = cleanText(query.provider).toLowerCase();
    let rows = await collectPipeline();
    if (statusFilter) rows = rows.filter((row) => cleanText(row.boarding_status).toUpperCase() === statusFilter);
    if (providerFilter) rows = rows.filter((row) => cleanText(row.provider).toLowerCase() === providerFilter);
    return { ok: true, merchant_configs: rows, count: rows.length };
  });

  // Org detail: config + live application snapshot through the org's boarding
  // adapter + the last provider events for the timeline.
  app.get("/merchant-configs/:orgId", async (request) => {
    await requireBoardingOpsStaff(request);
    const orgId = getParam(request.params, "orgId");
    const config = await getMerchantConfigForOps(orgId);
    if (!config) throw notFound("merchant_config_not_found", "This organization has no merchant configuration.");
    const organizations = await listOrganizations();
    const org = organizations.map(asObject).find((entry) => cleanText(entry.id) === orgId);
    const adapter = opsBoardingAdapter(orgId, config);
    let application: ProviderApplication | null = null;
    if (adapter && config.forward.application_id) {
      application = await adapter.getApplication(config.forward.application_id).catch(() => null);
    }
    return {
      ok: true,
      org_id: orgId,
      org_name: cleanText(org?.name) || orgId,
      merchant_config: config,
      application,
      events: await recentProviderEvents(orgId)
    };
  });

  // Plan assignment — the interchange-plus <-> flat-rate switch.
  // - Application still mutable (DRAFT / NEED_INFORMATION): update it at the
  //   provider and mirror the plan onto the merchant config.
  // - Post-approval, mock provider: apply immediately (the simulator has no
  //   rep in the loop).
  // - Post-approval, forward (or no adapter available): record the change as
  //   a pending intent on the merchant config — Forward plan switches after
  //   approval are rep-mediated.
  app.post("/merchant-configs/:orgId/assign-plan", async (request) => {
    const staff = await requireBoardingOpsStaff(request);
    const orgId = getParam(request.params, "orgId");
    const body = assignPlanSchema.parse(request.body ?? {});
    const planId = cleanText(body.processing_plan_id);
    const config = await getMerchantConfigForOps(orgId);
    if (!config) throw notFound("merchant_config_not_found", "This organization has no merchant configuration.");

    const adapter = opsBoardingAdapter(orgId, config);
    const applicationId = cleanText(config.forward.application_id);
    let application: ProviderApplication | null = null;
    if (adapter && applicationId) {
      application = await adapter.getApplication(applicationId).catch(() => null);
    }

    let mode: "application_updated" | "applied_immediately" | "change_requested";
    if (adapter && application && MUTABLE_APPLICATION_STATUSES.includes(cleanText(application.status))) {
      application = await adapter.updateApplication(applicationId, { processing_plan_id: planId });
      mode = "application_updated";
    } else if (cleanText(config.provider) === MOCK_PROVIDER) {
      mode = "applied_immediately";
    } else {
      mode = "change_requested";
    }

    const merchantConfig = await upsertMerchantConfig(orgId, {
      forward: mode === "change_requested"
        ? { pending_plan_id: planId }
        : { processing_plan_id: planId, pending_plan_id: "" }
    }, { skipFlag: true });

    await recordPaymentEvent(orgId, "merchant_admin.plan_assigned", {
      processing_plan_id: planId,
      mode,
      application_id: applicationId,
      actor_email: staff.email
    });

    return { ok: true, mode, merchant_config: merchantConfig, application };
  });

  // Provider switch — the go-live flip between the in-process mock and the
  // real Forward adapter (null clears the provider entirely).
  app.post("/merchant-configs/:orgId/set-provider", async (request) => {
    const staff = await requireBoardingOpsStaff(request);
    const orgId = getParam(request.params, "orgId");
    const parsed = setProviderSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest("provider_invalid", "Provider must be \"mock\", \"forward\", or null.");
    }
    const provider = parsed.data.provider === null ? "" : cleanText(parsed.data.provider);
    const config = await getMerchantConfigForOps(orgId);
    if (!config) throw notFound("merchant_config_not_found", "This organization has no merchant configuration.");
    const merchantConfig = await upsertMerchantConfig(orgId, { provider }, { skipFlag: true });
    await recordPaymentEvent(orgId, "merchant_admin.provider_changed", {
      provider,
      previous_provider: config.provider,
      actor_email: staff.email
    });
    return { ok: true, merchant_config: merchantConfig };
  });

  // Org-agnostic plan catalog: union of the mock simulator's plans and (when
  // env keys exist) Forward's partner-level processing plans.
  app.get("/processing-plans", async (request) => {
    await requireBoardingOpsStaff(request);
    const plans = new Map<string, JsonObject>();
    const mockPlans = await createMockBoardingAdapter("__boarding_ops__").listProcessingPlans();
    for (const plan of mockPlans) {
      plans.set(plan.id, { id: plan.id, name: plan.name, source: MOCK_PROVIDER, raw: plan.raw });
    }
    if (forwardConfigured()) {
      const forwardPlans = await createForwardBoardingAdapter({}).listProcessingPlans().catch(() => []);
      for (const plan of forwardPlans) {
        plans.set(plan.id, { id: plan.id, name: plan.name, source: FORWARD_PROVIDER, raw: plan.raw });
      }
    }
    const list = [...plans.values()];
    return { ok: true, processing_plans: list, count: list.length };
  });
};
