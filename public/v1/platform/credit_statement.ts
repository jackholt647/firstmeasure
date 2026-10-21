// Classifies credit ledger entries for the billing statement. A refund adds
// credit back but is not a payment: it is counted and totalled separately.
// The settings billing tab mirrors this in creditLedgerEntryKind
// (libraries/apps/settings/company.js); keep the two in step.

type Json = Record<string, unknown>;

export type CreditLedgerEntryKind = "payment" | "refund" | "credit" | "charge";

const PAYMENT_REASONS = new Set(["purchase", "credit_purchase", "credits_purchase", "credits_loaded"]);
const REFUND_REASONS = new Set(["customer_cancelled_inside_grace_period", "instant_no_coverage_refund", "instant_partial_no_coverage", "instant_no_coverage", "missed_delivery_window", "api_firstmeasure_order_funding_rollback"]);

function object(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

export function creditLedgerEntryKind(entry: unknown): CreditLedgerEntryKind {
  const row = object(entry);
  const delta = Number(row.delta ?? 0);
  if (!(delta > 0)) return "charge";
  const reason = String(row.reason ?? "").trim().toLowerCase();
  if (REFUND_REASONS.has(reason) || /refund|cancel|rollback|revers/.test(reason) || object(row.meta).source_charge) return "refund";
  if (PAYMENT_REASONS.has(reason) || reason.startsWith("stripe_")) return "payment";
  return "credit";
}

export function creditStatementTotals(transactions: unknown[]) {
  let paymentsIn = 0, refundsIn = 0, creditsIn = 0, totalOut = 0;
  let payments = 0, refunds = 0, credits = 0;
  for (const entry of transactions) {
    const delta = Number(object(entry).delta ?? 0) || 0;
    const kind = creditLedgerEntryKind(entry);
    if (kind === "payment") { payments += 1; paymentsIn += delta; }
    else if (kind === "refund") { refunds += 1; refundsIn += delta; }
    else if (kind === "credit") { credits += 1; creditsIn += delta; }
    else totalOut += Math.abs(Math.min(0, delta));
  }
  const totalIn = paymentsIn + creditsIn;
  return {
    total_payments: payments,
    total_refunds: refunds,
    total_credits: credits,
    payments_in: paymentsIn,
    refunds_in: refundsIn,
    credits_in: creditsIn,
    total_in: totalIn,
    total_out: totalOut,
    net_change: totalIn + refundsIn - totalOut,
    total_spent: totalOut
  };
}
