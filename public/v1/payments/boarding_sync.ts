import { getMerchantConfigForOps, maybeNotifyMerchantApproved, upsertMerchantConfig } from "./merchant_config.js";
import { getBoardingProvider } from "./providers/index.js";
import type { ProviderApplication } from "./providers/types.js";

type JsonObject = Record<string, unknown>;
const cleanText = (value: unknown) => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

/**
 * Reads the organization's application (and, once approved, its account) from
 * the processor and records what changed: status, account id, processing and
 * payouts. Webhooks normally carry this; reading it here covers an
 * organization whose webhook has not arrived (or is not registered, as on
 * development). Settings › Payments calls it on view, and the readiness check
 * calls it for an organization that has applied but is not ready yet.
 */
export async function syncBoardingFromProvider(orgId: string, applicationId = ""): Promise<{ application: ProviderApplication | null; changed: boolean }> {
  const config = await getMerchantConfigForOps(orgId);
  const trackedId = cleanText(config?.forward.application_id);
  const id = cleanText(applicationId) || trackedId;
  if (!config || !id) return { application: null, changed: false };
  const boarding = await getBoardingProvider(orgId);
  if (!boarding) return { application: null, changed: false };
  const application = await boarding.getApplication(id);
  if (trackedId !== application.id) return { application, changed: false };
  const tracked = cleanText(config.forward.boarding_status);
  const live = cleanText(application.status);
  const patch: JsonObject = {};
  if (live && live !== tracked) patch.boarding_status = live;
  if (live === "APPROVED") {
    let accountId = cleanText(config.forward.account_id);
    if (!accountId) {
      const accounts = await boarding.listAccounts({ business_id: cleanText(config.forward.business_id) || undefined }).catch(() => []);
      const account = accounts.find((entry) => cleanText(entry.external_account_id) === orgId
        || (cleanText(config.forward.business_id) && cleanText(entry.business_id) === cleanText(config.forward.business_id)));
      if (account) {
        accountId = account.id;
        patch.account_id = account.id;
        patch.processing_enabled = account.processing_enabled;
        patch.payouts_enabled = account.payouts_enabled;
      }
    } else if (!config.forward.processing_enabled || !config.forward.payouts_enabled) {
      const account = await boarding.getAccount(accountId).catch(() => null);
      if (account) {
        if (account.processing_enabled !== config.forward.processing_enabled) patch.processing_enabled = account.processing_enabled;
        if (account.payouts_enabled !== config.forward.payouts_enabled) patch.payouts_enabled = account.payouts_enabled;
      }
    }
  }
  if (!Object.keys(patch).length) return { application, changed: false };
  await upsertMerchantConfig(orgId, { forward: patch }, { skipFlag: true });
  if (live === "APPROVED") await maybeNotifyMerchantApproved(orgId).catch(() => null);
  return { application, changed: true };
}

// At most one processor read per organization per minute from the readiness
// check, so a busy portal never turns into a stream of boarding calls.
const lastReadinessSync = new Map<string, number>();
const READINESS_SYNC_SPACING_MS = 60_000;

/** True when it read the processor and something changed. */
export async function refreshBoardingForReadiness(orgId: string) {
  const now = Date.now();
  if (now - (lastReadinessSync.get(orgId) ?? 0) < READINESS_SYNC_SPACING_MS) return false;
  lastReadinessSync.set(orgId, now);
  return (await syncBoardingFromProvider(orgId).catch(() => ({ changed: false }))).changed;
}

