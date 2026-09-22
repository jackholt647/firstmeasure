import { isAppFlagEnabled } from "../../platform/app_flags.js";
import { getMerchantConfig } from "../merchant_config.js";
import {
  createForwardAdapter,
  createForwardBoardingAdapter,
  FORWARD_PROVIDER,
  forwardConfigured
} from "./forward.js";
import { createMockAdapter, createMockBoardingAdapter, MOCK_PROVIDER } from "./mock.js";
import type { MerchantBoardingAdapter, PaymentProviderAdapter } from "./types.js";

export type { MerchantBoardingAdapter, PaymentProviderAdapter } from "./types.js";
export { ForwardApiError } from "./forward.js";
export { MOCK_PROVIDER } from "./mock.js";

/**
 * Resolves the payment processor for an organization. Returns null when no
 * real processor is wired — callers treat null as "keep today's mock
 * behavior" (recorded payments without provider money movement). The "mock"
 * provider is a fully in-process simulator (no env keys required) so the
 * integration is drivable end-to-end without Forward API access.
 */
export async function getPaymentProvider(orgId: string): Promise<PaymentProviderAdapter | null> {
  const resolved = await resolveMerchant(orgId);
  if (!resolved) return null;
  if (resolved.provider === MOCK_PROVIDER) return createMockAdapter(orgId);
  return createForwardAdapter({ accountId: resolved.accountId });
}

/**
 * Resolves the merchant boarding adapter for an organization. Boarding calls
 * act at the partner level (no `x-account-id`) until an account exists.
 */
export async function getBoardingProvider(orgId: string): Promise<MerchantBoardingAdapter | null> {
  const resolved = await resolveMerchant(orgId, { requireAccount: false });
  if (!resolved) return null;
  if (resolved.provider === MOCK_PROVIDER) return createMockBoardingAdapter(orgId);
  return createForwardBoardingAdapter(resolved.accountId ? { accountId: resolved.accountId } : {});
}

async function resolveMerchant(orgId: string, options: { requireAccount?: boolean } = {}) {
  if (!(await isAppFlagEnabled(orgId, "money", "merchant_processing"))) return null;
  const config = await getMerchantConfig(orgId).catch(() => null);
  if (!config) return null;
  const accountId = config.forward.account_id;
  if (config.provider === MOCK_PROVIDER) {
    // Mock runs entirely in-process — env keys are not required.
    if (options.requireAccount !== false && !accountId) return null;
    return { provider: MOCK_PROVIDER, accountId };
  }
  if (config.provider !== FORWARD_PROVIDER) return null;
  if (!forwardConfigured()) return null;
  if (options.requireAccount !== false && !accountId) return null;
  return { provider: FORWARD_PROVIDER, accountId };
}
