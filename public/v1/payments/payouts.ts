import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { forbidden, notFound } from "../platform/errors.js";
import {
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import {
  PAYMENT_TRANSACTION_COLLECTION,
  patchPaymentProviderFields,
  setPaymentCleared
} from "./storage.js";

/**
 * Payout + dispute projections and the finance-summary read model.
 *
 * `payment_payouts` and `payment_disputes` are org-scoped collections fed by
 * provider webhook events (webhooks_forward.ts) — the batches-to-bank data
 * behind the finance dashboards. Read functions here back the
 * /payouts, /disputes and /finance-summary API routes.
 */

export const PAYMENT_PAYOUT_COLLECTION = "payment_payouts";
export const PAYMENT_DISPUTE_COLLECTION = "payment_disputes";

const PAYOUT_OPEN_STATUSES = ["created", "pending", "pended", "held", "retried", "updated", "in_transit"];
const DISPUTE_CLOSED_STATUSES = ["accepted", "won", "lost", "closed", "cancelled"];

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

function nowIso() {
  return new Date().toISOString();
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

async function requireMoneyFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "platform", "money"))) {
    throw forbidden("app_flag_disabled", "Money is not enabled for this organization.");
  }
}

function stableDocId(value: unknown) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

/**
 * Webhook-context actor for provider-driven reconciliation writes (payout
 * arrival auto-clearing member transactions, mirrored provider refunds).
 * createPayment / setPaymentCleared only read userId + branchId off the
 * context, so a minimal system identity is sufficient and auditable.
 */
export const PROVIDER_WEBHOOK_CTX = {
  userId: "system:payment_provider_webhook",
  branchId: "default"
} as unknown as PlatformAuthContext;

async function listTransactionViews(orgId: string) {
  return (await listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION)).map(documentView);
}

/** Maps provider-side payment ids to our payment_transactions records. */
export async function resolveTransactionsByProviderPaymentIds(orgId: string, providerPaymentIds: string[]) {
  const wanted = new Set(providerPaymentIds.map(cleanText).filter(Boolean));
  if (!wanted.size) return [] as JsonObject[];
  return (await listTransactionViews(orgId))
    .filter((payment) => wanted.has(cleanText(asObject(payment.processor).provider_payment_id)));
}

/**
 * Projects a v2.payout.* event into the payment_payouts collection. On
 * creation the member transactions are stamped with the payout id; on
 * completion arrival is recorded and each member transaction is auto-cleared
 * (the manual cleared_at flag the plan replaces with settlement data).
 */
export async function upsertPayoutFromEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  const providerPayoutId = cleanText(data.id);
  if (!providerPayoutId) return null;
  const payoutId = `payment_payout_${stableDocId(providerPayoutId)}`;
  const existing = documentView(await readDocument(orgId, PAYMENT_PAYOUT_COLLECTION, payoutId).catch(() => null));
  const now = nowIso();
  const suffixStatus = cleanText(eventType.split(".").pop());
  const status = cleanText(data.status) || (suffixStatus === "created" || suffixStatus === "updated" ? cleanText(existing.status) || "created" : suffixStatus) || "created";

  const providerPaymentIds = asArray(data.payment_ids ?? data.payments ?? data.transaction_ids).map(cleanText).filter(Boolean);
  let transactionIds = asArray(existing.transaction_ids).map(cleanText).filter(Boolean);
  if (providerPaymentIds.length) {
    const matched = await resolveTransactionsByProviderPaymentIds(orgId, providerPaymentIds);
    transactionIds = Array.from(new Set([...transactionIds, ...matched.map((payment) => cleanText(payment.id))]));
    for (const payment of matched) {
      if (cleanText(payment.payout_id) === payoutId) continue;
      await patchPaymentProviderFields(orgId, cleanText(payment.id), { payout_id: payoutId });
    }
  }

  const completed = status === "completed";
  const arrivedAt = completed ? (cleanText(data.arrived_at) || cleanText(existing.arrived_at) || now) : cleanText(existing.arrived_at);
  const payoutData: JsonObject = {
    id: payoutId,
    organization_id: orgId,
    provider: cleanText(data.provider || existing.provider || "forward"),
    provider_payout_id: providerPayoutId,
    status,
    amount_cents: cents(data.amount ?? data.amount_cents ?? existing.amount_cents),
    fee_cents: cents(data.fee ?? data.fee_cents ?? existing.fee_cents),
    currency: cleanText(data.currency || existing.currency || "USD").toUpperCase(),
    expected_arrival_at: cleanText(data.expected_arrival_date || data.expected_arrival_at || existing.expected_arrival_at),
    arrived_at: arrivedAt,
    transaction_ids: transactionIds,
    provider_payment_ids: Array.from(new Set([...asArray(existing.provider_payment_ids).map(cleanText).filter(Boolean), ...providerPaymentIds])),
    last_event_type: eventType,
    created_at: cleanText(existing.created_at) || now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_PAYOUT_COLLECTION, {
    id: payoutId,
    data: payoutData,
    metadata: { kind: "payment_payout", provider: cleanText(payoutData.provider), status, provider_payout_id: providerPayoutId }
  }, { replace: true });

  if (completed) {
    for (const transactionId of transactionIds) {
      // Already-cleared or non-reconcilable rows are fine — arrival is a
      // confirmation, not a state machine we own.
      await setPaymentCleared(orgId, transactionId, {
        cleared_at: arrivedAt,
        note: `Auto-cleared by payout ${providerPayoutId}.`
      }, PROVIDER_WEBHOOK_CTX).catch(() => null);
    }
  }
  return documentView(doc);
}

/** Projects a v2.dispute.* event into the payment_disputes collection. */
export async function upsertDisputeFromEvent(orgId: string, eventType: string, event: JsonObject) {
  const data = asObject(event.data);
  const providerDisputeId = cleanText(data.id);
  if (!providerDisputeId) return null;
  const disputeId = `payment_dispute_${stableDocId(providerDisputeId)}`;
  const existing = documentView(await readDocument(orgId, PAYMENT_DISPUTE_COLLECTION, disputeId).catch(() => null));
  const now = nowIso();
  const suffixStatus = cleanText(eventType.split(".").pop());
  const status = cleanText(data.status) || (suffixStatus === "updated" ? cleanText(existing.status) || "created" : suffixStatus) || "created";

  const providerPaymentId = cleanText(data.payment_id || data.payment || existing.provider_payment_id);
  let transactionId = cleanText(existing.transaction_id);
  if (!transactionId) {
    const userFields = asObject(data.user_fields);
    transactionId = cleanText(userFields.payment_id || data.reference_id);
    if (!transactionId && providerPaymentId) {
      const matched = await resolveTransactionsByProviderPaymentIds(orgId, [providerPaymentId]);
      transactionId = cleanText(matched[0]?.id);
    }
  }
  const transaction = transactionId
    ? documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, transactionId).catch(() => null))
    : {};

  const disputeData: JsonObject = {
    id: disputeId,
    organization_id: orgId,
    provider: cleanText(data.provider || existing.provider || "forward"),
    provider_dispute_id: providerDisputeId,
    provider_payment_id: providerPaymentId,
    transaction_id: cleanText(transaction.id) || transactionId,
    project_id: cleanText(transaction.project_id || existing.project_id),
    status,
    amount_cents: cents(data.amount ?? data.amount_disputed ?? data.amount_cents ?? existing.amount_cents),
    currency: cleanText(data.currency || existing.currency || "USD").toUpperCase(),
    reason: cleanText(data.reason || existing.reason),
    respond_by: cleanText(data.respond_by || data.evidence_due_by || existing.respond_by),
    opened_at: cleanText(existing.opened_at) || cleanText(data.opened_at || data.created_at) || now,
    last_event_type: eventType,
    last_event: event,
    created_at: cleanText(existing.created_at) || now,
    updated_at: now
  };
  const doc = await upsertDocument(orgId, PAYMENT_DISPUTE_COLLECTION, {
    id: disputeId,
    data: disputeData,
    metadata: { kind: "payment_dispute", provider: cleanText(disputeData.provider), status, provider_dispute_id: providerDisputeId, transaction_id: cleanText(disputeData.transaction_id) }
  }, { replace: true });
  return documentView(doc);
}

// --- Read models -------------------------------------------------------------

export function payoutIsOpen(payout: JsonObject) {
  return PAYOUT_OPEN_STATUSES.includes(cleanText(payout.status).toLowerCase());
}

export function disputeIsOpen(dispute: JsonObject) {
  return !DISPUTE_CLOSED_STATUSES.includes(cleanText(dispute.status).toLowerCase());
}

export async function listPayouts(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const status = cleanText(input.status).toLowerCase();
  const from = Date.parse(cleanText(input.from));
  const to = Date.parse(cleanText(input.to));
  return (await listDocuments(orgId, PAYMENT_PAYOUT_COLLECTION)).map(documentView)
    .filter((payout) => !status || cleanText(payout.status).toLowerCase() === status)
    .filter((payout) => {
      const created = Date.parse(cleanText(payout.created_at));
      if (Number.isFinite(from) && (!Number.isFinite(created) || created < from)) return false;
      if (Number.isFinite(to) && (!Number.isFinite(created) || created > to)) return false;
      return true;
    })
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)));
}

export async function getPayoutDetail(orgId: string, payoutId: string) {
  await requireMoneyFlag(orgId);
  const doc = await readDocument(orgId, PAYMENT_PAYOUT_COLLECTION, payoutId).catch(() => null);
  if (!doc) throw notFound("payout_not_found", "Payout was not found.");
  const payout = documentView(doc);
  const projectDocs = await listDocuments(orgId, "projects").catch(() => []);
  const projectTitles = new Map<string, string>(projectDocs.map(documentView)
    .map((project): [string, string] => [cleanText(project.id), cleanText(project.title || project.customer_name || project.address)]));
  const transactions: JsonObject[] = [];
  for (const transactionId of asArray(payout.transaction_ids).map(cleanText).filter(Boolean)) {
    const transaction = documentView(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, transactionId).catch(() => null));
    if (!cleanText(transaction.id)) continue;
    transactions.push({
      ...transaction,
      project_title: projectTitles.get(cleanText(transaction.project_id)) || "",
      invoice_id: cleanText(asObject(transaction.metadata).invoice_id)
    });
  }
  return { payout, transactions };
}

export async function listDisputes(orgId: string, input: JsonObject = {}) {
  await requireMoneyFlag(orgId);
  const status = cleanText(input.status).toLowerCase();
  return (await listDocuments(orgId, PAYMENT_DISPUTE_COLLECTION)).map(documentView)
    .filter((dispute) => !status || cleanText(dispute.status).toLowerCase() === status)
    .sort((a, b) => cleanText(b.opened_at || b.created_at).localeCompare(cleanText(a.opened_at || a.created_at)));
}

/**
 * Org finance snapshot for the payouts dashboard: what's been captured but
 * not swept, what's on its way to the bank, what it cost, and what's next.
 * Provider-backed transactions are recognized by processor.provider_payment_id
 * (fee capture stamps it via the webhook projection).
 */
export async function financeSummary(orgId: string) {
  await requireMoneyFlag(orgId);
  const [transactions, payoutDocs, disputeDocs] = await Promise.all([
    listTransactionViews(orgId),
    listDocuments(orgId, PAYMENT_PAYOUT_COLLECTION),
    listDocuments(orgId, PAYMENT_DISPUTE_COLLECTION)
  ]);
  const payouts = payoutDocs.map(documentView);
  const disputes = disputeDocs.map(documentView);
  const cutoff = Date.now() - 30 * 86_400_000;
  const within30d = (value: unknown) => {
    const parsed = Date.parse(cleanText(value));
    return Number.isFinite(parsed) && parsed >= cutoff;
  };

  const providerBacked = transactions
    .filter((payment) => cleanText(payment.direction) === "inbound")
    .filter((payment) => cleanText(asObject(payment.processor).provider_payment_id))
    .filter((payment) => ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)));
  const netCents = (payment: JsonObject) => {
    const merchant = Number(payment.merchant_amount_cents);
    return Number.isFinite(merchant) ? Math.round(merchant) : Math.max(0, cents(payment.amount_cents));
  };
  const balancePending = providerBacked
    .filter((payment) => !cleanText(payment.payout_id))
    .reduce((sum, payment) => sum + netCents(payment), 0);
  const inTransit = payouts
    .filter(payoutIsOpen)
    .reduce((sum, payout) => sum + Math.max(0, cents(payout.amount_cents)), 0);
  const paidOut30d = payouts
    .filter((payout) => cleanText(payout.status).toLowerCase() === "completed" && within30d(payout.arrived_at || payout.updated_at))
    .reduce((sum, payout) => sum + Math.max(0, cents(payout.amount_cents)), 0);
  const recent = providerBacked.filter((payment) => within30d(payment.received_at || payment.created_at));
  const fees30d = recent.reduce((sum, payment) => sum + Math.max(0, cents(payment.fee_cents)), 0);
  const gross30d = recent.reduce((sum, payment) => sum + Math.max(0, cents(payment.amount_cents)), 0);
  const nextExpected = payouts
    .filter(payoutIsOpen)
    .sort((a, b) => cleanText(a.expected_arrival_at || "9999").localeCompare(cleanText(b.expected_arrival_at || "9999")))[0];

  return {
    balance_pending_cents: balancePending,
    in_transit_cents: inTransit,
    paid_out_30d_cents: paidOut30d,
    fees_30d_cents: fees30d,
    gross_30d_cents: gross30d,
    effective_rate_bps: gross30d > 0 ? Math.round((fees30d / gross30d) * 10_000) : 0,
    next_expected_payout: nextExpected
      ? {
        payout_id: cleanText(nextExpected.id),
        amount_cents: Math.max(0, cents(nextExpected.amount_cents)),
        expected_arrival_at: cleanText(nextExpected.expected_arrival_at)
      }
      : null,
    disputes_open_count: disputes.filter(disputeIsOpen).length
  };
}
