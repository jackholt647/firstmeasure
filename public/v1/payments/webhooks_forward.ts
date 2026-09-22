import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

import { env } from "../src/config/env.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../platform/storage.js";
import { findOrganizationByForwardIds, maybeNotifyMerchantApproved, upsertMerchantConfig } from "./merchant_config.js";
import {
  PROVIDER_WEBHOOK_CTX,
  upsertDisputeFromEvent,
  upsertPayoutFromEvent
} from "./payouts.js";
import {
  PAYMENT_INTENT_COLLECTION,
  PAYMENT_TRANSACTION_COLLECTION,
  patchPaymentProviderFields,
  refundPayment
} from "./storage.js";

/**
 * Forward webhook receiver — POST /v1/payments/webhooks/forward.
 *
 * Unauthenticated but signature-verified: Forward signs webhooks Svix-style
 * (svix-id / svix-timestamp / svix-signature headers, HMAC-SHA256 over
 * `{id}.{timestamp}.{body}` with a base64 `whsec_` secret). Verified events
 * are stored per-org in the `payment_provider_events` collection keyed by the
 * Svix message id for idempotency, then dispatched by `v2.*` type prefix.
 * Completely separate from the Stripe SaaS-billing webhook path.
 */

export const PAYMENT_PROVIDER_EVENT_COLLECTION = "payment_provider_events";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function headerValue(headers: JsonObject, name: string) {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? cleanText(value[0]) : cleanText(value);
}

function decodeWebhookSecret(secret: string) {
  const encoded = cleanText(secret).replace(/^whsec_/, "");
  return Buffer.from(encoded, "base64");
}

export function verifyForwardWebhookSignature(input: {
  id: string;
  timestamp: string;
  body: Buffer | string;
  signatureHeader: string;
  secret?: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: string } {
  const secret = cleanText(input.secret ?? env.forwardWebhookSecret);
  if (!secret) return { ok: false, reason: "webhook_secret_missing" };
  const id = cleanText(input.id);
  const timestamp = cleanText(input.timestamp);
  const signatureHeader = cleanText(input.signatureHeader);
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: "webhook_signature_missing" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "webhook_timestamp_invalid" };
  const toleranceMs = (input.toleranceSeconds ?? env.forwardWebhookToleranceSeconds) * 1000;
  const nowMs = input.nowMs ?? Date.now();
  if (Math.abs(nowMs - Number(timestamp) * 1000) > toleranceMs) {
    return { ok: false, reason: "webhook_timestamp_invalid" };
  }
  let key: Buffer;
  try {
    key = decodeWebhookSecret(secret);
  } catch {
    return { ok: false, reason: "webhook_secret_invalid" };
  }
  if (!key.length) return { ok: false, reason: "webhook_secret_invalid" };
  const body = Buffer.isBuffer(input.body) ? input.body : Buffer.from(String(input.body), "utf8");
  const expected = createHmac("sha256", key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), body]))
    .digest();
  // The signature header carries space-delimited `v1,<base64>` entries so
  // secrets can rotate; any matching signature verifies the message.
  const candidates = signatureHeader.split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  for (const candidate of candidates) {
    let actual: Buffer;
    try {
      actual = Buffer.from(candidate, "base64");
    } catch {
      continue;
    }
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { ok: true };
  }
  return { ok: false, reason: "webhook_signature_invalid" };
}

function eventDocumentId(svixId: string) {
  // Platform document ids are lowercased [a-z0-9_-]; keep the mapping
  // deterministic so redelivered messages hit the same id.
  return cleanText(svixId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

function forwardEventIds(event: JsonObject) {
  const data = asObject(event.data);
  const nested = asObject(data.object);
  // LIVE-VERIFIED id prefixes (sandbox 2026-08-13): businesses are `bus_`,
  // applications are `aapp_` (mock keeps the older `app_`/`biz_` spellings).
  const id = cleanText(data.id);
  const isAccount = id.startsWith("acct_") || id.startsWith("acc_");
  const isApplication = id.startsWith("aapp_") || id.startsWith("app_");
  const isBusiness = id.startsWith("bus_") || id.startsWith("biz_");
  return {
    account_id: cleanText(data.account_id || nested.account_id || (isAccount ? id : "")),
    application_id: cleanText(data.application_id || nested.application_id || (isApplication ? id : "")),
    business_id: cleanText(data.business_id || nested.business_id || (isBusiness ? id : ""))
  };
}

export async function storeForwardEvent(orgId: string, svixId: string, eventType: string, event: JsonObject, options: { provider?: string } = {}): Promise<{ stored: boolean }> {
  const documentId = eventDocumentId(svixId);
  const provider = cleanText(options.provider) || "forward";
  const existing = await readDocument(orgId, PAYMENT_PROVIDER_EVENT_COLLECTION, documentId).catch(() => null);
  if (existing) return { stored: false };
  await upsertDocument(orgId, PAYMENT_PROVIDER_EVENT_COLLECTION, {
    id: documentId,
    data: {
      id: documentId,
      provider,
      svix_id: cleanText(svixId),
      event_type: eventType,
      event,
      received_at: new Date().toISOString()
    },
    metadata: { kind: "payment_provider_event", provider, event_type: eventType }
  }, { replace: false });
  return { stored: true };
}

async function handleApplicationEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  // Sandbox approvals arrive as MANUALLY_APPROVED — store the normalized
  // APPROVED the rest of the platform keys on.
  const rawStatus = cleanText(data.status).toUpperCase();
  const status = rawStatus === "MANUALLY_APPROVED" ? "APPROVED" : rawStatus;
  await upsertMerchantConfig(orgId, {
    forward: {
      ...(status ? { boarding_status: status } : {}),
      ...(cleanText(data.id).startsWith("aapp_") || cleanText(data.id).startsWith("app_") ? { application_id: cleanText(data.id) } : {}),
      ...(cleanText(data.processing_plan_id) ? { processing_plan_id: cleanText(data.processing_plan_id) } : {}),
      last_event_at: new Date().toISOString()
    }
  }, { skipFlag: true });
  if (status === "APPROVED" || status === "MANUALLY_APPROVED") {
    await maybeNotifyMerchantApproved(orgId).catch(() => null);
  }
}

async function handleAccountEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  await upsertMerchantConfig(orgId, {
    forward: {
      ...(cleanText(data.id).startsWith("acct_") || cleanText(data.id).startsWith("acc_") ? { account_id: cleanText(data.id) } : {}),
      ...(data.processing_enabled !== undefined ? { processing_enabled: data.processing_enabled === true } : {}),
      ...(data.payouts_enabled !== undefined || eventType === "v2.account.payouts_enabled"
        ? { payouts_enabled: eventType === "v2.account.payouts_enabled" || data.payouts_enabled === true }
        : {}),
      last_event_at: new Date().toISOString()
    }
  }, { skipFlag: true });
}

function documentData(doc: unknown) {
  return asObject(asObject(doc).data);
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  return {
    ...documentData(doc),
    id: cleanText(documentData(doc).id || source.id),
    created_at: cleanText(source.created_at || documentData(doc).created_at),
    updated_at: cleanText(source.updated_at || documentData(doc).updated_at)
  };
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/** Our-side identifiers a provider event may carry back to us. */
function ourReferenceIds(data: JsonObject) {
  const userFields = asObject(data.user_fields);
  return [cleanText(userFields.payment_id), cleanText(userFields.payment_intent_id), cleanText(data.reference_id)].filter(Boolean);
}

async function findTransactionForPaymentEvent(orgId: string, data: JsonObject) {
  const references = ourReferenceIds(data);
  for (const reference of references) {
    const doc = await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, reference).catch(() => null);
    if (doc) return documentView(doc);
  }
  const providerPaymentId = cleanText(data.id);
  if (!providerPaymentId) return null;
  const match = (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION)).map(documentView)
    .find((payment) => cleanText(asObject(payment.processor).provider_payment_id) === providerPaymentId);
  return match ?? null;
}

async function handlePaymentIntentEvent(orgId: string, eventType: string, data: JsonObject) {
  const references = ourReferenceIds(data);
  for (const reference of references) {
    const doc = await readDocument(orgId, PAYMENT_INTENT_COLLECTION, reference).catch(() => null);
    if (!doc) continue;
    const intent = documentView(doc);
    const providerStatus = cleanText(data.status).toLowerCase() || cleanText(eventType.split(".").pop());
    const status = providerStatus === "captured" ? "captured"
      : providerStatus === "cancelled" ? "cancelled"
        : cleanText(intent.status) || "pending";
    await upsertDocument(orgId, PAYMENT_INTENT_COLLECTION, {
      id: cleanText(intent.id),
      data: {
        ...intent,
        status,
        provider: cleanText(data.provider) || cleanText(intent.provider) || "forward",
        provider_status: providerStatus,
        processor: { ...asObject(intent.processor), provider_intent_id: cleanText(data.id) },
        updated_at: new Date().toISOString()
      },
      metadata: { kind: "payment_intent", project_id: cleanText(intent.project_id), direction: cleanText(intent.direction), status }
    }, { replace: true });
    return;
  }
}

async function handleRefundCreatedEvent(orgId: string, event: JsonObject) {
  const data = asObject(event.data);
  const providerRefundId = cleanText(data.id);
  if (!providerRefundId) return;
  // Dedupe: refunds initiated through our API already wrote the outbound
  // customer_refund transaction carrying the provider refund id.
  const existing = (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION)).map(documentView)
    .find((payment) => cleanText(payment.kind) === "customer_refund"
      && cleanText(asObject(payment.processor).provider_refund_id) === providerRefundId);
  if (existing) return;
  // A refund event's own id is the refund id; the payment linkage rides on
  // payment_id (plus any of our reference ids echoed through user_fields).
  const original = await findTransactionForPaymentEvent(orgId, { ...data, id: cleanText(data.payment_id || data.payment) });
  if (!original || cleanText(original.direction) !== "inbound") return;
  // Provider-originated refund (e.g. issued from the processor dashboard):
  // mirror it through the existing refund flow so allocations reverse and the
  // original transaction's refunded state stays truthful.
  await refundPayment(orgId, cleanText(original.id), {
    amount_cents: Math.max(0, cents(data.amount ?? data.amount_cents)) || undefined,
    reason: cleanText(data.reason) || "provider_refund",
    provider: cleanText(data.provider) || "forward",
    processor: {
      provider: cleanText(data.provider) || "forward",
      provider_refund_id: providerRefundId,
      provider_payment_id: cleanText(data.payment_id || data.payment)
    },
    metadata: { provider_originated: true }
  }, PROVIDER_WEBHOOK_CTX).catch(() => null);
}

async function handlePaymentEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  if (eventType.startsWith("v2.payment_intent.")) return handlePaymentIntentEvent(orgId, eventType, data);
  if (eventType === "v2.refund.created" || eventType === "v2.reversal.created") return handleRefundCreatedEvent(orgId, event);
  if (!eventType.startsWith("v2.payment.")) return;

  const providerStatus = cleanText(data.status).toLowerCase() || cleanText(eventType.split(".").pop());
  const matched = await findTransactionForPaymentEvent(orgId, data);
  if (matched) {
    await patchPaymentProviderFields(orgId, cleanText(matched.id), {
      provider: cleanText(data.provider) || cleanText(matched.provider) || "forward",
      provider_status: providerStatus,
      ...(Number.isFinite(Number(data.fee ?? data.fee_cents)) ? { fee_cents: cents(data.fee ?? data.fee_cents) } : {}),
      ...(Number.isFinite(Number(data.merchant_amount ?? data.merchant_amount_cents))
        ? { merchant_amount_cents: cents(data.merchant_amount ?? data.merchant_amount_cents) }
        : {}),
      processor: {
        provider: cleanText(data.provider) || "forward",
        provider_payment_id: cleanText(data.id),
        ...(cleanText(data.payment_intent_id || data.payment_intent) ? { provider_intent_id: cleanText(data.payment_intent_id || data.payment_intent) } : {}),
        ...(cleanText(data.decline_category || data.decline_reason) ? { decline_category: cleanText(data.decline_category || data.decline_reason) } : {})
      }
    });
    return;
  }
  // Unmatched provider payment: keep a shadow record for later reconciliation
  // (pending status keeps it out of collected/reconciliation totals; direct
  // upsert avoids allocation/ledger side effects of createPayment).
  if (!["created", "captured"].includes(cleanText(eventType.split(".").pop()))) return;
  const providerPaymentId = cleanText(data.id);
  if (!providerPaymentId) return;
  const shadowId = `payment_provider_${providerPaymentId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 120)}`;
  const existingShadow = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, shadowId).catch(() => null));
  const now = new Date().toISOString();
  await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id: shadowId,
    data: {
      ...existingShadow,
      id: shadowId,
      organization_id: orgId,
      direction: "inbound",
      kind: "provider_payment",
      status: "pending",
      provider_status: providerStatus,
      amount_cents: cents(data.amount ?? data.amount_cents) || cents(existingShadow.amount_cents),
      currency: cleanText(data.currency || existingShadow.currency || "USD").toUpperCase(),
      provider: cleanText(data.provider) || "forward",
      ...(Number.isFinite(Number(data.fee ?? data.fee_cents)) ? { fee_cents: cents(data.fee ?? data.fee_cents) } : {}),
      ...(Number.isFinite(Number(data.merchant_amount ?? data.merchant_amount_cents))
        ? { merchant_amount_cents: cents(data.merchant_amount ?? data.merchant_amount_cents) }
        : {}),
      processor: {
        ...asObject(existingShadow.processor),
        provider: cleanText(data.provider) || "forward",
        provider_payment_id: providerPaymentId,
        ...(cleanText(data.payment_intent_id || data.payment_intent) ? { provider_intent_id: cleanText(data.payment_intent_id || data.payment_intent) } : {})
      },
      metadata: { ...asObject(existingShadow.metadata), provider_unmatched: true },
      created_at: cleanText(existingShadow.created_at) || now,
      updated_at: now
    },
    metadata: { kind: "payment_transaction", project_id: "", direction: "inbound", payment_kind: "provider_payment", status: "pending" }
  }, { replace: true });
}

async function handlePayoutEvent(orgId: string, eventType: string, event: JsonObject) {
  await upsertPayoutFromEvent(orgId, eventType, event);
}

async function handleDisputeEvent(orgId: string, eventType: string, event: JsonObject) {
  await upsertDisputeFromEvent(orgId, eventType, event);
}

export async function dispatchForwardEvent(orgId: string, eventType: string, event: JsonObject) {
  if (eventType.startsWith("v2.application.")) return handleApplicationEvent(orgId, eventType, event);
  if (eventType.startsWith("v2.account.")) return handleAccountEvent(orgId, eventType, event);
  if (eventType.startsWith("v2.payment.") || eventType.startsWith("v2.payment_intent.")
    || eventType.startsWith("v2.refund.") || eventType.startsWith("v2.reversal.")) {
    return handlePaymentEvent(orgId, eventType, event);
  }
  if (eventType.startsWith("v2.payout.")) return handlePayoutEvent(orgId, eventType, event);
  if (eventType.startsWith("v2.dispute.")) return handleDisputeEvent(orgId, eventType, event);
  // Unknown v2.* families (bank_account, payee, ...) are persisted only.
}

/**
 * Post-verification ingestion path shared by the HTTP webhook route and the
 * mock provider's synthesized events: persist once per message id (replay and
 * redelivery behave identically), then dispatch. Returns whether the message
 * was new.
 */
export async function ingestForwardEvent(
  orgId: string,
  messageId: string,
  eventType: string,
  event: JsonObject,
  options: { provider?: string } = {}
): Promise<{ stored: boolean }> {
  const { stored } = await storeForwardEvent(orgId, messageId, eventType, event, options);
  if (stored) await dispatchForwardEvent(orgId, eventType, event);
  return { stored };
}

/** Generates a Svix-shaped message id for provider-synthesized (mock) events. */
export function generatedForwardMessageId() {
  return `mockmsg_${Date.now().toString(36)}${randomBytes(6).toString("hex")}`;
}

export const registerForwardWebhooks: FastifyPluginAsync = async (app) => {
  // Scoped raw-body parser so signature verification sees the exact bytes,
  // mirroring the Telnyx webhook registration in messaging/api.ts.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 512 * 1024 }, (_request, body, done) => done(null, body));

  app.post("/webhooks/forward", { bodyLimit: 512 * 1024 }, async (request, reply) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from(String(request.body ?? ""));
    const headers = asObject(request.headers);
    const svixId = headerValue(headers, "svix-id");
    const verification = verifyForwardWebhookSignature({
      id: svixId,
      timestamp: headerValue(headers, "svix-timestamp"),
      body: rawBody,
      signatureHeader: headerValue(headers, "svix-signature")
    });
    if (!verification.ok) {
      reply.code(401);
      return { ok: false, error: verification.reason };
    }
    let event: JsonObject;
    try {
      event = asObject(JSON.parse(rawBody.toString("utf8")));
    } catch {
      reply.code(400);
      return { ok: false, error: "invalid_json" };
    }
    const eventType = cleanText(event.type || event.event_type);
    if (!eventType) {
      reply.code(400);
      return { ok: false, error: "event_type_missing" };
    }
    const resolved = await findOrganizationByForwardIds(forwardEventIds(event));
    if (!resolved) {
      // Acknowledge so Forward stops retrying: the event is for a merchant we
      // have no config for yet (or ids arrive on a shape we don't map).
      request.log.warn({ event_type: eventType, svix_id: svixId }, "Forward webhook could not be routed to an organization.");
      return { ok: true, ignored: true, reason: "organization_unresolved" };
    }
    const { stored } = await ingestForwardEvent(resolved.orgId, svixId, eventType, event);
    if (!stored) return { ok: true, duplicate: true };
    return { ok: true, received: true, type: eventType };
  });
};
