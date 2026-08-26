import { readGlobal, saveGlobal } from "../platform/storage.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { env } from "../src/config/env.js";
import { firstMeasureReportAmount } from "../firstmeasure/pricing.js";
import { asObject, cleanText, moneyAmount, numericValue, stableHash } from "./util.js";
import { withPublicFirstMeasureLock } from "./locks.js";

type JsonObject = Record<string, unknown>;

export function firstMeasurePublicReportAmount(input: {
  project_type?: unknown;
  report_mode?: unknown;
  report_expedite_option?: unknown;
  include_gutter_measurements?: unknown;
  include_weather_report?: unknown;
  pins?: unknown;
}) {
  return firstMeasureReportAmount(input);
}

export function makeChargeToken(orgId: string, keyId: string) {
  return `api_${Date.now()}_${stableHash(`${orgId}:${keyId}:${Date.now()}:${Math.random()}`).slice(0, 14)}`;
}

export async function publicFirstMeasureBalance(orgId: string) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = safeBillingView(data.billing);
  const ledger = Array.isArray(data.credits_ledger) ? data.credits_ledger : [];
  return {
    balance: moneyAmount(data.credits_balance),
    ledger_count: ledger.length,
    billing,
    document_revision: global.revision
  };
}

export async function chargePublicFirstMeasureOrder(input: {
  orgId: string;
  amount: number;
  actorEmail: string;
  meta: JsonObject;
}) {
  return withPublicFirstMeasureLock(`billing:${input.orgId}`, async () => {
    const current = await publicFirstMeasureBalance(input.orgId);
    const autoTopup = asObject(current.billing.auto_topup);
    const stripe = asObject(current.billing.stripe);
    const hasPaymentMethod = stripe.has_payment_method === true && cleanText(stripe.payment_method_id);
    const autoTopupEnabled = autoTopup.enabled === true;
    if (current.balance < input.amount && !(hasPaymentMethod && autoTopupEnabled)) {
      throw forbidden("insufficient_credits", "This organization does not have enough credits and API auto top-up is not ready.", {
        balance: current.balance,
        required: input.amount,
        has_payment_method: hasPaymentMethod,
        auto_topup_enabled: autoTopupEnabled
      });
    }
    const charge = await applyCreditDelta(input.orgId, {
      amount: -Math.abs(input.amount),
      reason: "api_firstmeasure_order_submitted",
      meta: input.meta
    }, input.actorEmail);

    let topup: Awaited<ReturnType<typeof stripeMaybeAutoTopup>> = null;
    try {
      topup = await stripeMaybeAutoTopup(input.orgId, input.actorEmail, charge.balance, charge.ledger_entry);
    } catch (error) {
      await applyCreditDelta(input.orgId, {
        amount: Math.abs(input.amount),
        reason: "api_firstmeasure_order_funding_rollback",
        meta: {
          ...input.meta,
          funding_error: error instanceof Error ? error.message : String(error)
        }
      }, input.actorEmail);
      throw error;
    }

    if (topup && topup.success !== true) {
      const rollback = await applyCreditDelta(input.orgId, {
        amount: Math.abs(input.amount),
        reason: "api_firstmeasure_order_funding_rollback",
        meta: { ...input.meta, auto_topup: topup }
      }, input.actorEmail);
      throw forbidden("auto_topup_failed", "Automatic credit top-up failed, so no report was ordered.", {
        balance: rollback.balance,
        auto_topup: topup
      });
    }
    return {
      ...charge,
      ...(topup ? { auto_topup: topup } : {})
    };
  });
}

export async function refundPublicFirstMeasureOrder(input: {
  orgId: string;
  amount: number;
  actorEmail: string;
  meta: JsonObject;
  reason?: string;
}) {
  if (input.amount <= 0) return null;
  return withPublicFirstMeasureLock(`billing:${input.orgId}`, () => applyCreditDelta(input.orgId, {
    amount: Math.abs(input.amount),
    reason: cleanText(input.reason) || "api_firstmeasure_order_refund",
    meta: input.meta
  }, input.actorEmail));
}

async function applyCreditDelta(orgId: string, body: Record<string, unknown>, actorEmail: unknown) {
  const amount = numericValue(body.amount ?? body.delta);
  if (amount === 0) throw badRequest("invalid_credit_amount", "Credit amount must be non-zero.");
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const balance = numericValue(data.credits_balance);
  const ledger = Array.isArray(data.credits_ledger) ? [...data.credits_ledger] : [];
  const entry = {
    ts: new Date().toISOString(),
    delta: moneyAmount(amount),
    reason: cleanText(body.reason) || "adjustment",
    by_email: cleanText(actorEmail),
    applied_for_user_email: body.applied_for_user_email ?? body.appliedForUserEmail ?? null,
    meta: asObject(body.meta),
    unit: cleanText(body.unit) || "usd_dollars",
    balance_after: moneyAmount(balance + amount)
  };
  ledger.push(entry);
  const document = await saveGlobal(orgId, {
    data: {
      credits_balance: entry.balance_after,
      credits_ledger: ledger
    },
    metadata: {
      last_credit_mutation_at: entry.ts,
      last_credit_mutation_reason: entry.reason
    }
  });
  return {
    balance: entry.balance_after,
    ledger_entry: entry,
    ledger_count: ledger.length,
    document
  };
}

function safeBillingView(value: unknown) {
  const billing = asObject(value);
  const autoTopup = asObject(billing.auto_topup);
  const stripe = asObject(billing.stripe);
  return {
    auto_topup: {
      enabled: autoTopup.enabled === true,
      threshold_dollars: numericValue(autoTopup.threshold_dollars),
      topup_dollars: numericValue(autoTopup.topup_dollars),
      cooldown_minutes: numericValue(autoTopup.cooldown_minutes),
      status: cleanText(autoTopup.status) || "idle",
      last_attempt_utc: autoTopup.last_attempt_utc ?? null,
      last_success_utc: autoTopup.last_success_utc ?? null,
      last_error: autoTopup.last_error ?? null
    },
    stripe: {
      has_payment_method: stripe.has_payment_method === true,
      customer_id: stripe.customer_id ?? null,
      payment_method_id: stripe.payment_method_id ?? null,
      brand: stripe.brand ?? null,
      last4: stripe.last4 ?? null,
      exp_month: stripe.exp_month ?? null,
      exp_year: stripe.exp_year ?? null
    }
  };
}

function stripeIsTestMode() {
  return env.stripeTestMode;
}

function stripeSecretKey() {
  return env.stripeSecretKey || (stripeIsTestMode() ? env.stripeTestSecretKey : env.stripeLiveSecretKey);
}

async function stripeApiRequest(method: "GET" | "POST", apiPath: string, fields: Record<string, unknown> = {}, idempotencyKey = "") {
  const key = stripeSecretKey();
  if (!key) return { success: false, error: "Stripe secret key is not configured." };
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const init: RequestInit = { method, headers, signal: AbortSignal.timeout(30_000) };
  let url = `https://api.stripe.com${apiPath}`;
  if (method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? "")])).toString();
  } else if (Object.keys(fields).length) {
    const qs = new URLSearchParams(Object.entries(fields).map(([k, v]) => [k, String(v ?? "")])).toString();
    url += apiPath.includes("?") ? `&${qs}` : `?${qs}`;
  }
  const response = await fetch(url, init).catch((error) => ({ ok: false, status: 0, text: async () => String(error) } as Response));
  const text = await response.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok || !data || typeof data !== "object") {
    return { success: false, http: response.status, error: "Stripe API error", stripe: data };
  }
  return { success: true, http: response.status, data: data as JsonObject };
}

async function stripePatchBilling(orgId: string, patch: JsonObject, eventType = "", eventMeta: JsonObject = {}) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = asObject(data.billing);
  const next = {
    ...billing,
    ...patch,
    stripe: { ...asObject(billing.stripe), ...asObject(patch.stripe) },
    auto_topup: { ...asObject(billing.auto_topup), ...asObject(patch.auto_topup) }
  };
  const events = Array.isArray(billing.events) ? billing.events : [];
  if (eventType) {
    events.push({ type: eventType, ts: new Date().toISOString(), ...eventMeta });
    (next as JsonObject).events = events.slice(-250);
  }
  await saveGlobal(orgId, { data: { billing: next } });
  return next;
}

async function stripeMaybeAutoTopup(orgId: string, actorEmail: string, balanceAfterSpend: number, triggerEntry: JsonObject) {
  const global = await readGlobal(orgId);
  const data = asObject(global.data);
  const billing = asObject(data.billing);
  const autoTopup = asObject(billing.auto_topup);
  const stripe = asObject(billing.stripe);
  if (autoTopup.enabled !== true) return null;
  const threshold = Math.max(35, Math.round(numericValue(autoTopup.threshold_dollars, 50)));
  const topup = Math.max(35, Math.round(numericValue(autoTopup.topup_dollars, 100)));
  if (balanceAfterSpend >= threshold) return null;
  const customerId = cleanText(stripe.customer_id);
  const paymentMethodId = cleanText(stripe.payment_method_id);
  if (!customerId || !paymentMethodId) {
    await stripePatchBilling(orgId, {
      auto_topup: { status: "needs_payment_method", last_error: "No saved payment method" },
      stripe: { has_payment_method: false }
    }, "api_autotopup_missing_payment_method", { balance_after_spend: balanceAfterSpend, threshold_dollars: threshold });
    return { attempted: false, status: "needs_payment_method", error: "No saved payment method" };
  }

  const now = new Date().toISOString();
  await stripePatchBilling(orgId, {
    auto_topup: { status: "processing", last_attempt_utc: now, last_error: null }
  }, "api_autotopup_attempted", { balance_after_spend: balanceAfterSpend, threshold_dollars: threshold, topup_dollars: topup });

  const result = await stripeApiRequest("POST", "/v1/payment_intents", {
    amount: Math.round(topup * 100),
    currency: "usd",
    customer: customerId,
    payment_method: paymentMethodId,
    off_session: "true",
    confirm: "true",
    "metadata[org_id]": orgId,
    "metadata[source]": "public_firstmeasure_api",
    "metadata[trigger_reason]": cleanText(triggerEntry.reason),
    "metadata[trigger_actor_email]": actorEmail
  }, `api_autotopup_${orgId}_${stableHash(JSON.stringify(triggerEntry)).slice(0, 16)}`);

  if (!result.success) {
    await stripePatchBilling(orgId, {
      auto_topup: { status: "failed", last_error: cleanText(result.error) || "Stripe PaymentIntent failed" }
    }, "api_autotopup_payment_intent_failed", { balance_after_spend: balanceAfterSpend, topup_dollars: topup, stripe_error: result.stripe || result.data || result.error });
    return { attempted: true, success: false, status: "failed", error: cleanText(result.error) || "Stripe PaymentIntent failed" };
  }

  const paymentIntent = asObject(result.data);
  const paymentIntentId = cleanText(paymentIntent.id);
  const status = cleanText(paymentIntent.status);
  if (status !== "succeeded") {
    await stripePatchBilling(orgId, {
      auto_topup: { status: "needs_payment_method", last_error: `Top-up not completed (status=${status || "unknown"}).` }
    }, "api_autotopup_non_succeeded", { payment_intent_id: paymentIntentId, status, balance_after_spend: balanceAfterSpend });
    return { attempted: true, success: false, status: "needs_payment_method", payment_intent_id: paymentIntentId, payment_status: status };
  }

  const credit = await applyCreditDelta(orgId, {
    amount: topup,
    reason: "stripe_auto_topup",
    meta: { payment_intent_id: paymentIntentId, source: "public_firstmeasure_api", trigger_entry: triggerEntry }
  }, "stripe");
  await stripePatchBilling(orgId, {
    auto_topup: { status: "ok", last_success_utc: new Date().toISOString(), last_error: null }
  }, "api_autotopup_succeeded", { payment_intent_id: paymentIntentId, topup_dollars: topup, balance_after_spend: balanceAfterSpend, balance_after_topup: credit.balance });
  return { attempted: true, success: true, status: "ok", payment_intent_id: paymentIntentId, topup_dollars: topup, balance: credit.balance };
}
