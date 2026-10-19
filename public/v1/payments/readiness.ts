import { isAppFlagEnabled } from "../platform/app_flags.js";
import { forbidden, PlatformError } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import { getMerchantConfigForOps, type MerchantConfig } from "./merchant_config.js";
import { createForwardAdapter, FORWARD_PROVIDER, forwardConfigured, forwardSdkUrl } from "./providers/forward.js";
import { createMockAdapter, MOCK_PROVIDER } from "./providers/mock.js";
import type { PaymentProviderAdapter } from "./providers/types.js";

/**
 * The one answer to "can this organization take a customer payment right
 * now?". Every path that charges, saves a card or bank account for later,
 * enrolls autopay or asks a customer to pay online calls this, on the server.
 *
 * Ready means: Money and taking payments are switched on, online processing
 * is switched on, the merchant account runs on Forward (the in-process mock
 * stands in for it only outside production data), the account is approved
 * and Forward has processing enabled for it. Anything less refuses with a
 * reason the person can act on. Nothing ever records a "paid" payment in
 * place of a charge.
 */

export type PaymentRail = "card" | "bank";

export type PaymentsNotReadyReason =
  | "money_off"
  | "take_payment_off"
  | "online_processing_off"
  | "no_merchant_account"
  | "provider_unavailable"
  | "not_approved"
  | "processing_disabled";

export type PaymentsReadiness = {
  ready: boolean;
  reason: PaymentsNotReadyReason | "";
  message: string;
  provider: string;
  account_id: string;
  boarding_status: string;
  processing_enabled: boolean;
  /** Payouts can lag approval (no bank linked yet); charges still work. */
  payouts_enabled: boolean;
  rails: Record<PaymentRail, boolean>;
  /** Browser element settings for Forward; empty for the mock. */
  sdk_url: string;
  public_key: string;
};

const MESSAGES: Record<PaymentsNotReadyReason, string> = {
  money_off: "Money is not turned on for this organization.",
  take_payment_off: "Taking payments is turned off for this organization.",
  online_processing_off: "Online payments are not set up yet. Finish payment setup in Settings, Payments.",
  no_merchant_account: "Online payments are not set up yet. Finish payment setup in Settings, Payments.",
  provider_unavailable: "Online payments are not available right now. Contact support if this continues.",
  not_approved: "Online payments start once the merchant account is approved. Check the application in Settings, Payments.",
  processing_disabled: "Payment processing is paused for this merchant account. Check Settings, Payments."
};

/** The mock simulator never stands in for real processing on production data. */
export function mockProviderAllowed() {
  return env.dataEnvironment !== "production";
}

/** Rails default on once approved; the organization may switch either off. */
function railsFor(config: MerchantConfig) {
  const stored = config.forward.enabled_rails_set === true ? config.forward.enabled_rails : null;
  return {
    card: stored ? stored.card === true : true,
    bank: stored ? stored.bank === true : true
  };
}

function notReady(reason: PaymentsNotReadyReason, partial: Partial<PaymentsReadiness> = {}): PaymentsReadiness {
  return {
    ready: false,
    reason,
    message: MESSAGES[reason],
    provider: "",
    account_id: "",
    boarding_status: "",
    processing_enabled: false,
    payouts_enabled: false,
    rails: { card: false, bank: false },
    sdk_url: "",
    public_key: "",
    ...partial
  };
}

export async function paymentsReadiness(orgId: string): Promise<PaymentsReadiness> {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) return notReady("money_off");
  if (!(await isAppFlagEnabled(orgId, "money", "take_payment"))) return notReady("take_payment_off");
  if (!(await isAppFlagEnabled(orgId, "money", "merchant_processing"))) return notReady("online_processing_off");
  const config = await getMerchantConfigForOps(orgId);
  if (!config) return notReady("no_merchant_account");
  const forward = config.forward;
  const base = {
    provider: config.provider,
    account_id: forward.account_id,
    boarding_status: forward.boarding_status,
    processing_enabled: forward.processing_enabled,
    payouts_enabled: forward.payouts_enabled
  };
  const isForward = config.provider === FORWARD_PROVIDER;
  const isMock = config.provider === MOCK_PROVIDER && mockProviderAllowed();
  if (!isForward && !isMock) return notReady("no_merchant_account", base);
  if (isForward && (!forwardConfigured() || !env.forwardPublicKey)) return notReady("provider_unavailable", base);
  if (!forward.account_id) return notReady("no_merchant_account", base);
  if (forward.boarding_status !== "APPROVED") return notReady("not_approved", base);
  if (!forward.processing_enabled) return notReady("processing_disabled", base);
  return {
    ready: true,
    reason: "",
    message: "",
    ...base,
    rails: railsFor(config),
    sdk_url: isForward ? forwardSdkUrl() : "",
    public_key: isForward ? env.forwardPublicKey : ""
  };
}

export class PaymentsNotReadyError extends PlatformError {
  constructor(readiness: PaymentsReadiness) {
    super("payments_not_ready", 409, readiness.message || "Online payments are not set up for this organization.", { reason: readiness.reason });
  }
}

/**
 * Refuses unless the organization can take money now, and hands back the
 * provider to charge through. A rail the organization switched off refuses
 * too.
 */
export async function requirePaymentsReady(orgId: string, options: { rail?: PaymentRail } = {}): Promise<{ readiness: PaymentsReadiness; provider: PaymentProviderAdapter }> {
  const readiness = await paymentsReadiness(orgId);
  if (!readiness.ready) throw new PaymentsNotReadyError(readiness);
  if (options.rail && !readiness.rails[options.rail]) {
    throw forbidden("payment_rail_disabled", options.rail === "bank"
      ? "Bank payments are turned off for this organization."
      : "Card payments are turned off for this organization.");
  }
  const provider = readiness.provider === MOCK_PROVIDER
    ? createMockAdapter(orgId)
    : createForwardAdapter({ accountId: readiness.account_id });
  return { readiness, provider };
}

/** True when the organization can ask customers to pay online right now. */
export async function canTakeOnlinePayments(orgId: string) {
  return (await paymentsReadiness(orgId).catch(() => null))?.ready === true;
}
