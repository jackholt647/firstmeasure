// Decides whether a paid Stripe Checkout session for credits can be credited.
//
// The session is created by us (stripe_create_checkout), so its metadata says
// what was sold: `paid_minor` in `credit_currency`. Stripe's own totals can
// legitimately differ from that: tax is added to amount_total, a discount
// lowers it, and a US Price ID line item charges the Price's unit_amount times
// the quantity, which is amount_subtotal. A paid session is accepted when the
// configured line items (amount_subtotal) or the total match what was sold, or
// when the customer paid more than that (credited with a warning for the
// operator). It is held for review only when the currency differs or the
// customer paid less than the credit sold; a held payment is never dropped
// silently (the caller alerts operators and tells the customer).

type Json = Record<string, unknown>;

export type StripeCheckoutAmountCheck =
  | { accept: true; warning?: "configured_amount_above_credit_value"; expected_minor: number; configured_minor: number }
  | { accept: false; code: "currency_mismatch" | "amount_below_credit_value" | "missing_amount"; expected_minor: number; configured_minor: number | null };

function minor(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : null;
}

export function stripeCheckoutExpectedMinor(meta: Json, creditDollars: number) {
  const fromMeta = minor(meta.paid_minor);
  if (fromMeta !== null) return fromMeta;
  const paidDollars = Number(meta.paid_dollars);
  return Math.round((Number.isFinite(paidDollars) ? paidDollars : creditDollars) * 100);
}

export function checkStripeCheckoutAmount(session: Json, meta: Json, profileCurrency: string, creditDollars: number): StripeCheckoutAmountCheck {
  const expected = stripeCheckoutExpectedMinor(meta, creditDollars);
  const total = minor(session.amount_total);
  const subtotal = minor(session.amount_subtotal);
  const configured = subtotal ?? total;
  const soldCurrency = String(meta.credit_currency || "USD").trim().toUpperCase();
  const sessionCurrency = String(session.currency || "").trim().toUpperCase();
  if (soldCurrency !== String(profileCurrency).toUpperCase() || sessionCurrency !== soldCurrency) {
    return { accept: false, code: "currency_mismatch", expected_minor: expected, configured_minor: configured };
  }
  if (configured === null || expected <= 0) return { accept: false, code: "missing_amount", expected_minor: expected, configured_minor: configured };
  if (configured === expected || total === expected) return { accept: true, expected_minor: expected, configured_minor: configured };
  if (configured > expected) return { accept: true, warning: "configured_amount_above_credit_value", expected_minor: expected, configured_minor: configured };
  return { accept: false, code: "amount_below_credit_value", expected_minor: expected, configured_minor: configured };
}
