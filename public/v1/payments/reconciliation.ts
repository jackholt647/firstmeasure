import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  type JsonObject
} from "../platform/storage.js";
import {
  PAYMENT_TRANSACTION_COLLECTION,
  patchPaymentProviderFields,
  recordPaymentEvent
} from "./storage.js";

/**
 * Unmatched-settlements reconciliation queue.
 *
 * The Forward webhook projection writes "shadow" provider payments
 * (kind "provider_payment", status pending, excluded from totals) whenever a
 * provider event carries no reference back to one of our transactions —
 * see webhooks_forward.ts handlePaymentEvent. This module is the exceptions
 * queue over those records: list them, link one onto an existing transaction
 * (merging the provider fee/processor fields and deleting the shadow), or
 * dismiss it. Forward's GET /unmatched_settlements passthrough can feed the
 * same queue later.
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

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

function isShadowRecord(record: JsonObject) {
  return cleanText(record.kind) === "provider_payment"
    && asObject(record.metadata).provider_unmatched === true;
}

export async function listUnmatchedSettlements(orgId: string) {
  await requireMoneyFlag(orgId);
  return (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION)).map(documentView)
    .filter(isShadowRecord)
    .filter((record) => cleanText(record.status) !== "dismissed")
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

async function readShadowRecord(orgId: string, recordId: string) {
  const doc = await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, cleanText(recordId)).catch(() => null);
  const record = doc ? documentView(doc) : null;
  if (!record || !isShadowRecord(record)) {
    throw notFound("unmatched_record_not_found", "That unmatched settlement record was not found.");
  }
  return record;
}

/**
 * Links a shadow provider payment onto an existing real transaction: the
 * provider identifiers and fee fields merge onto the transaction (the same
 * additive projection the webhook handler applies on a reference match) and
 * the shadow is deleted so the queue and totals stay clean.
 */
export async function matchUnmatchedSettlement(orgId: string, recordId: string, paymentIdValue: string, ctx: PlatformAuthContext) {
  await requireMoneyFlag(orgId);
  const shadow = await readShadowRecord(orgId, recordId);
  const paymentId = cleanText(paymentIdValue);
  if (!paymentId) throw badRequest("payment_id_required", "Choose the payment this settlement belongs to.");
  if (paymentId === cleanText(shadow.id)) throw badRequest("unmatched_self_match", "An unmatched settlement cannot be matched to itself.");
  const paymentDoc = await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, paymentId).catch(() => null);
  const payment = paymentDoc ? documentView(paymentDoc) : null;
  if (!payment || isShadowRecord(payment)) {
    throw notFound("payment_not_found", "That payment was not found.");
  }
  if (cleanText(payment.direction) !== "inbound") {
    throw badRequest("unmatched_match_invalid", "Provider settlements can only be matched to inbound payments.");
  }
  const shadowProcessor = asObject(shadow.processor);
  const updated = await patchPaymentProviderFields(orgId, paymentId, {
    provider: cleanText(shadow.provider) || cleanText(payment.provider) || "forward",
    ...(cleanText(shadow.provider_status) ? { provider_status: cleanText(shadow.provider_status) } : {}),
    ...(Number.isFinite(Number(shadow.fee_cents)) ? { fee_cents: cents(shadow.fee_cents) } : {}),
    ...(Number.isFinite(Number(shadow.merchant_amount_cents)) ? { merchant_amount_cents: cents(shadow.merchant_amount_cents) } : {}),
    processor: {
      provider: cleanText(shadowProcessor.provider) || cleanText(shadow.provider) || "forward",
      ...(cleanText(shadowProcessor.provider_payment_id) ? { provider_payment_id: cleanText(shadowProcessor.provider_payment_id) } : {}),
      ...(cleanText(shadowProcessor.provider_intent_id) ? { provider_intent_id: cleanText(shadowProcessor.provider_intent_id) } : {})
    },
    metadata: {
      reconciled_from_unmatched: cleanText(shadow.id),
      reconciled_by_user_id: ctx.userId
    }
  });
  await deleteDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, cleanText(shadow.id));
  await recordPaymentEvent(orgId, "reconciliation.unmatched_matched", {
    project_id: cleanText(updated.project_id),
    payment_id: paymentId,
    shadow_record_id: cleanText(shadow.id),
    provider_payment_id: cleanText(shadowProcessor.provider_payment_id),
    amount_cents: cents(shadow.amount_cents)
  }, ctx);
  return { payment: updated, shadow };
}

/** Removes a shadow record from the queue without linking it anywhere. */
export async function dismissUnmatchedSettlement(orgId: string, recordId: string, ctx: PlatformAuthContext, reason = "") {
  await requireMoneyFlag(orgId);
  const shadow = await readShadowRecord(orgId, recordId);
  await deleteDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, cleanText(shadow.id));
  await recordPaymentEvent(orgId, "reconciliation.unmatched_dismissed", {
    shadow_record_id: cleanText(shadow.id),
    provider_payment_id: cleanText(asObject(shadow.processor).provider_payment_id),
    amount_cents: cents(shadow.amount_cents),
    ...(cleanText(reason) ? { reason: cleanText(reason) } : {})
  }, ctx);
  return { shadow };
}
