import { isAppFlagEnabled } from "../platform/app_flags.js";
import { forbidden } from "../platform/errors.js";
import {
  listDocuments,
  listOrganizations,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
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
  /** False until the organization first chooses rails; card and bank default on. */
  enabled_rails_set: boolean;
  /** Forward account status (BOARDING until the gateway is set up) and gateway id. */
  account_status: string;
  gateway_mid: string;
  gateway_updated_at: string;
  /** When the newest application event happened at Forward (older redeliveries are ignored). */
  application_event_at: string;
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
    enabled_rails_set: forward.enabled_rails_set === true,
    account_status: cleanText(forward.account_status),
    gateway_mid: cleanText(forward.gateway_mid),
    gateway_updated_at: cleanText(forward.gateway_updated_at),
    application_event_at: cleanText(forward.application_event_at),
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
  // The simulator never becomes an organization's processor on production
  // data, even when the Forward keys are missing there.
  if (forwardConfigured() || env.dataEnvironment === "production") return "forward";
  return "mock";
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
        ? {
            // The first choice starts from the defaults (card and bank on).
            enabled_rails: {
              ...(existing.forward.enabled_rails_set ? existing.forward.enabled_rails : { card: true, bank: true, wallets: false, terminals: false }),
              ...asObject(patchForward.enabled_rails)
            },
            enabled_rails_set: true
          }
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
 * Fires the one-time org-facing "payments are on" notification once the
 * application is approved AND Forward has processing enabled on the account
 * (an approval without processing cannot take a payment yet). Called from
 * every path that can learn about either (application webhook, account
 * webhook, and the webhookless sync) — the `approval_notified_at` stamp keeps
 * it to exactly one notification. Payouts are not mentioned: they can still
 * be switching on, and the money onboarding attention entry says so while
 * Forward reports them off. The click lands on Settings › Money › Payments.
 *
 * It goes to everyone who can manage company settings (who set payments up),
 * one notification per branch: a notification with no recipients reaches
 * nobody, which is how earlier approvals went unseen.
 */
export async function maybeNotifyMerchantApproved(orgId: string) {
  const config = await getMerchantConfigForOps(orgId);
  if (!config || config.forward.boarding_status !== "APPROVED" || !config.forward.processing_enabled || config.forward.approval_notified_at) return;
  const { backgroundAuthContext, hasPermission } = await import("../platform/auth.js");
  const audiences = new Map<string, string[]>();
  for (const user of await listDocuments(orgId, "users")) {
    const data = asObject(user.data);
    if (data.disabled === true || data.deleted === true || ["disabled", "inactive", "removed"].includes(cleanText(data.status))) continue;
    const auth = await backgroundAuthContext(orgId, user.id).catch(() => null);
    if (!auth || !hasPermission(auth, "manage_company_settings")) continue;
    const branch = auth.branchId || "default";
    audiences.set(branch, [...(audiences.get(branch) || []), user.id]);
  }
  await upsertMerchantConfig(orgId, { forward: { approval_notified_at: nowIso() } }, { skipFlag: true });
  const { createPlatformNotification } = await import("../platform/api.js");
  for (const [branch, users] of audiences) {
    await createPlatformNotification(orgId, {
      id: branch === "default" ? "merchant_processing_approved" : `merchant_processing_approved_${branch}`,
      title: "Payments are on — you can take card and bank payments.",
      body: "Your merchant account is approved. Customers can now pay you online.",
      kind: "merchant_approved",
      source: "payments",
      target_user_ids: users,
      branch_id: branch,
      push: true,
      frontend_action: { kind: "open_payment_settings" }
    });
  }
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
