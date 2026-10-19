import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict } from "../platform/errors.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";
import { providerFailure } from "./intake.js";
import { getMerchantConfigForOps } from "./merchant_config.js";
import { createForwardAdapter, FORWARD_PROVIDER, forwardIdempotencyKey } from "./providers/forward.js";
import { createMockAdapter, MOCK_PROVIDER } from "./providers/mock.js";
import type { PaymentProviderAdapter } from "./providers/types.js";
import { mockProviderAllowed } from "./readiness.js";
import { PAYMENT_TRANSACTION_COLLECTION, patchPaymentProviderFields, readPayment, refundPayment } from "./storage.js";

/**
 * Refunds and voids that move money. A payment the processor took is given
 * back through the processor first; our refund record is written only once
 * the processor accepted it. Before the payment settles the whole amount is
 * voided (it never reaches the merchant's batch); after that it is refunded,
 * in full or in part. A payment recorded by hand (cash, check, a card run
 * elsewhere) is reversed on our books only, as before.
 */

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/** Recent enough that a processor notification for it is ours, not a portal refund. */
export const REFUND_IN_FLIGHT_MS = 5 * 60_000;

export function refundInFlight(payment: JsonObject) {
  const marker = asObject(asObject(payment.metadata).refund_in_flight);
  const at = Date.parse(cleanText(marker.at));
  return Number.isFinite(at) && Date.now() - at < REFUND_IN_FLIGHT_MS ? marker : null;
}

async function adapterForPayment(orgId: string, provider: string): Promise<PaymentProviderAdapter> {
  if (provider === MOCK_PROVIDER) {
    if (!mockProviderAllowed()) throw badRequest("refund_provider_unavailable", "This payment cannot be refunded here.");
    return createMockAdapter(orgId);
  }
  const config = await getMerchantConfigForOps(orgId);
  const accountId = cleanText(config?.forward.account_id);
  if (!accountId) throw badRequest("refund_provider_unavailable", "The merchant account for this payment is not connected. Refund it from Forward's merchant portal.");
  return createForwardAdapter({ accountId });
}

async function refundsOf(orgId: string, paymentId: string) {
  return (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION))
    .map((doc): JsonObject => ({ ...asObject(asObject(doc).data), id: cleanText(asObject(asObject(doc).data).id || asObject(doc).id) }))
    .filter((payment) => cleanText(payment.kind) === "customer_refund" && cleanText(asObject(payment.metadata).related_payment_id) === paymentId);
}

export async function refundPaymentWithProvider(orgId: string, paymentId: string, input: JsonObject, ctx: PlatformAuthContext) {
  const payment = await readPayment(orgId, paymentId);
  const processor = asObject(payment.processor);
  const provider = cleanText(payment.provider || processor.provider);
  const intentId = cleanText(processor.provider_intent_id);
  if (!intentId || ![FORWARD_PROVIDER, MOCK_PROVIDER].includes(provider)) {
    // Recorded by hand: the money is returned outside the platform.
    return { ...(await refundPayment(orgId, paymentId, input, ctx)), provider_action: "recorded" };
  }
  if (cleanText(payment.direction) !== "inbound") throw badRequest("invalid_refund_payment", "Only inbound payments can be refunded.");
  if (["refunded", "voided", "failed", "returned"].includes(cleanText(payment.status))) {
    throw badRequest("payment_not_refundable", "This payment has nothing left to refund.");
  }
  const total = Math.max(0, cents(payment.amount_cents));
  const prior = await refundsOf(orgId, paymentId);
  const refunded = prior.reduce((sum, refund) => sum + Math.max(0, cents(refund.amount_cents)), 0);
  const refundable = Math.max(0, total - refunded);
  const requested = input.amount_cents !== undefined && input.amount_cents !== null
    ? Math.max(0, cents(input.amount_cents))
    : input.amount !== undefined ? Math.round(Number(input.amount) * 100) : refundable;
  if (requested <= 0) throw badRequest("invalid_refund_amount", "Refund amount must be greater than zero.");
  if (requested > refundable) throw badRequest("refund_exceeds_payment", "The refund is more than what is left on this payment.", { refundable_cents: refundable });
  if (refundInFlight(payment)) throw conflict("refund_in_progress", "A refund for this payment is already being processed.");

  const adapter = await adapterForPayment(orgId, provider);
  const intent = await adapter.getPaymentIntent(intentId).catch((error) => { throw providerFailure(error, "The refund could not be started."); });
  const settled = intent.settlement_status === "settled" || intent.latest_payment?.settlement_status === "settled";
  const voidWhole = !settled && refunded === 0 && requested === total;
  if (!settled && !voidWhole) {
    // Only the whole charge can be voided before it settles.
    if (intent.latest_payment?.rail === "bank") {
      throw badRequest("refund_not_settled", "This bank payment has not cleared yet. Refund the whole amount now, or a part once it clears.");
    }
  }
  await patchPaymentProviderFields(orgId, paymentId, {
    metadata: { refund_in_flight: { amount_cents: requested, at: new Date().toISOString(), action: voidWhole ? "void" : "refund" } }
  });
  try {
    if (voidWhole) {
      const cancelled = await adapter.cancelPaymentIntent(intentId, {
        reason: "requested_by_customer",
        idempotency_key: forwardIdempotencyKey("fm-void", paymentId)
      });
      const result = await refundPayment(orgId, paymentId, {
        ...input,
        amount_cents: requested,
        provider,
        processor: { provider, provider_intent_id: intentId, provider_void: true, provider_payment_id: cleanText(processor.provider_payment_id) },
        metadata: { ...asObject(input.metadata), void: true, provider_intent_status: cancelled.status, amount_voided_cents: cancelled.voided_cents }
      }, ctx);
      const voided = await patchPaymentProviderFields(orgId, paymentId, {
        status: "voided",
        voided_at: new Date().toISOString(),
        metadata: { refund_in_flight: null, voided: true }
      });
      return { ...result, payment: voided, provider_action: "voided" };
    }
    const providerRefund = await adapter.createRefund(intentId, {
      amount_cents: requested,
      idempotency_key: forwardIdempotencyKey("fm-ref", paymentId, prior.length + 1, requested)
    });
    if (providerRefund.status === "failed" || providerRefund.status === "cancelled") {
      throw badRequest("refund_failed", "The processor did not accept this refund. No money was returned.");
    }
    const existing = prior.find((refund) => cleanText(asObject(refund.processor).provider_refund_id) === providerRefund.id);
    if (existing) {
      await patchPaymentProviderFields(orgId, paymentId, { metadata: { refund_in_flight: null } });
      return { payment: await readPayment(orgId, paymentId), refund: existing, provider_action: "refunded" };
    }
    const result = await refundPayment(orgId, paymentId, {
      ...input,
      amount_cents: requested,
      provider,
      processor: {
        provider,
        provider_refund_id: providerRefund.id,
        provider_payment_id: cleanText(providerRefund.payment_id || processor.provider_payment_id),
        provider_intent_id: intentId
      },
      metadata: { ...asObject(input.metadata), provider_refund_status: providerRefund.status }
    }, ctx);
    const updated = await patchPaymentProviderFields(orgId, paymentId, { metadata: { refund_in_flight: null } });
    return { ...result, payment: updated, provider_action: "refunded" };
  } catch (error) {
    await patchPaymentProviderFields(orgId, paymentId, { metadata: { refund_in_flight: null } }).catch(() => null);
    throw providerFailure(error, voidWhole ? "The payment could not be voided." : "The refund could not be completed.");
  }
}
