import { isAppFlagEnabled } from "../platform/app_flags.js";
import { forbidden } from "../platform/errors.js";
import {
  listOrganizations,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { forwardConfigured } from "./providers/forward.js";

/**
 * Per-org merchant processing configuration — a single document per
 * organization describing which acquiring provider the org is boarded with
 * and the provider-side identifiers/state we track (Forward business,
 * application, account, processing plan, boarding + payout status).
 */

export const PAYMENT_MERCHANT_CONFIG_COLLECTION = "payment_merchant_config";
export const MERCHANT_CONFIG_DOC_ID = "default";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function nowIso() {
  return new Date().toISOString();
}

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

export type ForwardMerchantConfig = {
  business_id: string;
  application_id: string;
  account_id: string;
  processing_plan_id: string;
  /**
   * Plan change requested by boarding ops while the provider-side application
   * is no longer mutable (post-approval plan switches are rep-mediated for
   * Forward). Cleared when a plan assignment is applied.
   */
  pending_plan_id: string;
  /**
   * Latest hosted-application link (Forward's mandatory submission surface).
   * Persisted so the Payments pane can re-offer the same URL until it
   * expires; regenerated on demand after expiry (14-day links).
   */
  application_link_url: string;
  application_link_expires_at: string;
  boarding_status: string;
  /** When the org-facing "payments approved" notification went out (dedupe). */
  approval_notified_at: string;
  processing_enabled: boolean;
  payouts_enabled: boolean;
  enabled_rails: { card: boolean; bank: boolean; wallets: boolean; terminals: boolean };
  last_event_at: string;
};

export type MerchantConfig = {
  id: string;
  provider: string;
  forward: ForwardMerchantConfig;
  created_at: string;
  updated_at: string;
};

function normalizeRails(value: unknown): ForwardMerchantConfig["enabled_rails"] {
  const rails = asObject(value);
  return {
    card: rails.card === true,
    bank: rails.bank === true,
    wallets: rails.wallets === true,
    terminals: rails.terminals === true
  };
}

function normalizeForward(value: unknown): ForwardMerchantConfig {
  const forward = asObject(value);
  return {
    business_id: cleanText(forward.business_id),
    application_id: cleanText(forward.application_id),
    account_id: cleanText(forward.account_id),
    processing_plan_id: cleanText(forward.processing_plan_id),
    pending_plan_id: cleanText(forward.pending_plan_id),
    application_link_url: cleanText(forward.application_link_url),
    application_link_expires_at: cleanText(forward.application_link_expires_at),
    boarding_status: cleanText(forward.boarding_status),
    approval_notified_at: cleanText(forward.approval_notified_at),
    processing_enabled: forward.processing_enabled === true,
    payouts_enabled: forward.payouts_enabled === true,
    enabled_rails: normalizeRails(forward.enabled_rails),
    last_event_at: cleanText(forward.last_event_at)
  };
}

function normalizeConfig(doc: unknown): MerchantConfig {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    id: MERCHANT_CONFIG_DOC_ID,
    provider: cleanText(data.provider),
    forward: normalizeForward(data.forward),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

async function readMerchantConfigDoc(orgId: string) {
  try {
    return await readDocument(orgId, PAYMENT_MERCHANT_CONFIG_COLLECTION, MERCHANT_CONFIG_DOC_ID);
  } catch {
    return null;
  }
}

/**
 * Which provider a fresh organization should board with when no explicit
 * choice was ever stored: the real Forward integration when its env keys are
 * configured, otherwise the in-process mock simulator. Boarding Ops
 * set-provider always overrides this by storing an explicit value.
 */
export function defaultMerchantProvider(): string {
  return forwardConfigured() ? "forward" : "mock";
}

export async function getMerchantConfig(orgId: string): Promise<MerchantConfig> {
  await requireMoneyFlag(orgId);
  const config = normalizeConfig(await readMerchantConfigDoc(orgId));
  if (config.provider) return config;
  // First read-or-create for a Money org with no stored provider: persist the
  // environment default so boarding "just works" on a fresh org (the wizard
  // can create an application without a Boarding-Ops set-provider step).
  // Concurrent first reads (a fresh org's pane fires several payments calls
  // at once) can race the persist write; the loser serves the same default
  // without persisting and the next read finds the stored document.
  try {
    return await upsertMerchantConfig(orgId, { provider: defaultMerchantProvider() }, { skipFlag: true });
  } catch {
    return { ...config, provider: defaultMerchantProvider() };
  }
}

/**
 * Boarding-ops (FirstMate staff) read: returns the org's merchant config
 * without requiring the org's Money app flag, or null when the org has no
 * merchant-config document at all. Staff tooling must see every org's
 * boarding state regardless of which apps the org has switched on.
 */
export async function getMerchantConfigForOps(orgId: string): Promise<MerchantConfig | null> {
  const doc = await readMerchantConfigDoc(orgId);
  return doc ? normalizeConfig(doc) : null;
}

export async function upsertMerchantConfig(orgId: string, patch: JsonObject, options: { skipFlag?: boolean } = {}): Promise<MerchantConfig> {
  // Webhook-driven boarding updates may land before the org's Money app is
  // switched on, mirroring the skipFlag convention in payments/storage.ts.
  if (!options.skipFlag) await requireMoneyFlag(orgId);
  const existing = normalizeConfig(await readMerchantConfigDoc(orgId));
  const now = nowIso();
  const patchForward = asObject(patch.forward);
  const data: JsonObject = {
    id: MERCHANT_CONFIG_DOC_ID,
    provider: patch.provider !== undefined ? cleanText(patch.provider) : existing.provider,
    forward: normalizeForward({
      ...existing.forward,
      ...patchForward,
      ...(patchForward.enabled_rails !== undefined
        ? { enabled_rails: { ...existing.forward.enabled_rails, ...asObject(patchForward.enabled_rails) } }
        : { enabled_rails: existing.forward.enabled_rails })
    }),
    created_at: existing.created_at || now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_MERCHANT_CONFIG_COLLECTION, {
    id: MERCHANT_CONFIG_DOC_ID,
    data,
    metadata: { kind: "payment_merchant_config", provider: cleanText(data.provider) }
  }, { replace: true });
  return normalizeConfig(doc);
}

/**
 * Fires the one-time org-facing "payments approved" notification. Called from
 * every path that can learn about an approval (application webhook, account
 * webhook, and the webhookless GET-application sync) — the
 * `approval_notified_at` stamp keeps it to exactly one notification. The
 * notification's frontend_action mints a fresh merchant-portal magic link on
 * click (bank-account linking is portal-only at Forward).
 */
export async function maybeNotifyMerchantApproved(orgId: string) {
  const config = await getMerchantConfigForOps(orgId);
  if (!config || config.forward.boarding_status !== "APPROVED" || config.forward.approval_notified_at) return;
  await upsertMerchantConfig(orgId, { forward: { approval_notified_at: nowIso() } }, { skipFlag: true });
  const { createPlatformNotification } = await import("../platform/api.js");
  await createPlatformNotification(orgId, {
    id: "merchant_processing_approved",
    title: "Payments approved",
    body: "Your merchant account is active and ready to take customer payments. Open the merchant portal to link your bank account so payouts have somewhere to land.",
    kind: "merchant_approved",
    source: "payments",
    push: true,
    frontend_action: { kind: "open_merchant_portal" }
  });
}

/**
 * Resolves which organization a provider-side event belongs to by scanning
 * orgs' merchant-config documents for a matching Forward account, application,
 * or business id. Webhooks arrive unauthenticated and carry only provider
 * identifiers, so this is the routing seam. Skips the money flag on purpose:
 * boarding events may arrive before an org's Money app is switched on.
 */
export async function findOrganizationByForwardIds(ids: {
  account_id?: string;
  application_id?: string;
  business_id?: string;
}): Promise<{ orgId: string; config: MerchantConfig } | null> {
  const accountId = cleanText(ids.account_id);
  const applicationId = cleanText(ids.application_id);
  const businessId = cleanText(ids.business_id);
  if (!accountId && !applicationId && !businessId) return null;
  for (const organization of await listOrganizations()) {
    const orgId = cleanText(asObject(organization).id);
    if (!orgId) continue;
    const doc = await readMerchantConfigDoc(orgId);
    if (!doc) continue;
    const config = normalizeConfig(doc);
    if ((accountId && config.forward.account_id === accountId)
      || (applicationId && config.forward.application_id === applicationId)
      || (businessId && config.forward.business_id === businessId)) {
      return { orgId, config };
    }
  }
  return null;
}
