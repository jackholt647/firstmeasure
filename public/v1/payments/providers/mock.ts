import { randomBytes } from "node:crypto";

import { badRequest, notFound } from "../../platform/errors.js";
import { readDocument, upsertDocument, type JsonObject } from "../../platform/storage.js";
import { getMerchantConfig } from "../merchant_config.js";
import { generatedForwardMessageId, ingestForwardEvent } from "../webhooks_forward.js";
import type {
  ApplicationInput,
  BoardingApplicationStatus,
  CreateBusinessInput,
  CreatePaymentInput,
  CreatePaymentIntentInput,
  CreatePaymentMethodIntentInput,
  CreateRefundInput,
  ListOptions,
  MerchantBoardingAdapter,
  PaymentProviderAdapter,
  ProviderAccount,
  ProviderApplication,
  ProviderDispute,
  ProviderDisputeStatus,
  ProviderPayment,
  ProviderPaymentIntent,
  ProviderPaymentIntentStatus,
  ProviderPaymentMethod,
  ProviderPayout,
  ProviderPayoutStatus,
  ProviderProcessingPlan,
  ProviderRefund,
  SurchargeCalculation,
  SurchargeCalculationInput,
  UpdatePaymentMethodInput
} from "./types.js";

/**
 * In-process mock provider — implements both PaymentProviderAdapter and
 * MerchantBoardingAdapter with no network so the whole Forward integration is
 * drivable end-to-end before API keys exist. Provider state persists per org
 * in the `payment_provider_mock` collection, and every state transition
 * synthesizes the corresponding `v2.*` webhook events through the SAME
 * ingestion path the HTTP receiver uses (ingestForwardEvent), so idempotency,
 * replay, and the projection handlers behave identically to production.
 */

export const MOCK_PROVIDER = "mock";

export const MOCK_STATE_COLLECTION = "payment_provider_mock";
const MOCK_STATE_DOC_ID = "state";

/** Fee schedule per the plan doc §5a (sandbox portal recon, 2026-08-12). */
const FLAT_RATE_FEES = {
  card: { rate_bps: 2, auth_fee_cents: 30 },
  bank: { rate_bps: 25, cap_cents: 2_500, linking_fee_cents: 100, reject_fee_cents: 1_500, reversal_fee_cents: 1_500 },
  platform_fee_cents: 300,
  chargeback_fee_cents: 1_500,
  retrieval_fee_cents: 1_500
};

export const MOCK_INTERCHANGE_PLUS_PLAN_ID = "partppl_mock_interchange_plus";

/** Mock surcharge cap (3% card surcharge never exceeds this). */
export const MOCK_SURCHARGE_MAX_CENTS = 50_000;

export const MOCK_PROCESSING_PLANS: JsonObject[] = [
  {
    id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m",
    name: "Standard Flat Rate Plan - US",
    type: "flat_rate",
    country: "US",
    currency: "USD",
    fees: FLAT_RATE_FEES
  },
  {
    id: "partppl_3HpoagfDHkidHgm5jNA6Y0UhuAk",
    name: "Standard Flat Rate - CAN",
    type: "flat_rate",
    country: "CA",
    currency: "CAD",
    fees: FLAT_RATE_FEES
  },
  {
    // Synthetic — no interchange-plus plan exists in the real sandbox yet
    // (requested from the rep); this one lets the plan-switch UI be exercised.
    id: MOCK_INTERCHANGE_PLUS_PLAN_ID,
    name: "Interchange Plus (mock)",
    type: "interchange_plus",
    country: "US",
    currency: "USD",
    fees: {
      card: { interchange_pass_through: true, assumed_interchange_bps: 150, markup_bps: 20, auth_fee_cents: 10 },
      bank: FLAT_RATE_FEES.bank,
      platform_fee_cents: 300,
      chargeback_fee_cents: 1_500,
      retrieval_fee_cents: 1_500
    }
  }
];

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

function mockId(prefix: string) {
  return `${prefix}_mock_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function addBusinessDays(from: Date, days: number) {
  const date = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date;
}

// --- State persistence -------------------------------------------------------

type MockState = {
  businesses: Record<string, JsonObject>;
  applications: Record<string, JsonObject>;
  accounts: Record<string, JsonObject>;
  bank_accounts: Record<string, JsonObject>;
  payment_intents: Record<string, JsonObject>;
  payments: Record<string, JsonObject>;
  refunds: Record<string, JsonObject>;
  payouts: Record<string, JsonObject>;
  payment_methods: Record<string, JsonObject>;
  disputes: Record<string, JsonObject>;
  portal_users: Record<string, JsonObject>;
};

function emptyState(): MockState {
  return {
    businesses: {},
    applications: {},
    accounts: {},
    bank_accounts: {},
    payment_intents: {},
    payments: {},
    refunds: {},
    payouts: {},
    payment_methods: {},
    disputes: {},
    portal_users: {}
  };
}

async function readMockState(orgId: string): Promise<MockState> {
  const doc = await readDocument(orgId, MOCK_STATE_COLLECTION, MOCK_STATE_DOC_ID).catch(() => null);
  const data = asObject(asObject(doc).data);
  const state = emptyState();
  for (const key of Object.keys(state) as (keyof MockState)[]) {
    const stored = asObject(data[key]);
    const bucket: Record<string, JsonObject> = {};
    for (const [id, value] of Object.entries(stored)) bucket[id] = asObject(value);
    state[key] = bucket;
  }
  return state;
}

async function writeMockState(orgId: string, state: MockState) {
  await upsertDocument(orgId, MOCK_STATE_COLLECTION, {
    id: MOCK_STATE_DOC_ID,
    data: { id: MOCK_STATE_DOC_ID, ...state, updated_at: nowIso() },
    metadata: { kind: "payment_provider_mock", provider: MOCK_PROVIDER }
  }, { replace: true });
}

async function withMockState<T>(orgId: string, fn: (state: MockState) => Promise<T> | T): Promise<T> {
  const state = await readMockState(orgId);
  const result = await fn(state);
  await writeMockState(orgId, state);
  return result;
}

async function emitMockEvent(orgId: string, eventType: string, data: JsonObject) {
  await ingestForwardEvent(orgId, generatedForwardMessageId(), eventType, {
    type: eventType,
    provider: MOCK_PROVIDER,
    data: { ...data, provider: MOCK_PROVIDER },
    created_at: nowIso()
  }, { provider: MOCK_PROVIDER });
}

// --- Fee model ---------------------------------------------------------------

async function resolveMockPlanId(orgId: string, state: MockState) {
  const config = await getMerchantConfig(orgId).catch(() => null);
  const configured = cleanText(config?.forward.processing_plan_id);
  if (configured) return configured;
  const application = Object.values(state.applications)[0];
  return cleanText(asObject(application).processing_plan_id) || cleanText(asObject(MOCK_PROCESSING_PLANS[0]).id);
}

export function mockCardFeeCents(planId: string, amountCents: number) {
  const plan = MOCK_PROCESSING_PLANS.find((entry) => cleanText(entry.id) === cleanText(planId)) || asObject(MOCK_PROCESSING_PLANS[0]);
  const card = asObject(asObject(plan.fees).card);
  const rateBps = card.interchange_pass_through === true
    ? cents(card.assumed_interchange_bps) + cents(card.markup_bps)
    : cents(card.rate_bps);
  return Math.round(Math.max(0, amountCents) * rateBps / 10_000) + cents(card.auth_fee_cents);
}

// --- Simulated card outcomes -------------------------------------------------

const DECLINE_SUFFIXES: Array<{ suffix: string; category: string }> = [
  { suffix: "_declined", category: "generic_decline" },
  { suffix: "_cvv_fail", category: "cvv_failure" },
  { suffix: "_avs_fail", category: "avs_failure" },
  { suffix: "_insufficient", category: "insufficient_funds" },
  { suffix: "_expired", category: "expired_card" }
];

function declineCategoryFor(paymentMethodId: string) {
  const id = cleanText(paymentMethodId).toLowerCase();
  return DECLINE_SUFFIXES.find((entry) => id.endsWith(entry.suffix))?.category || "";
}

/**
 * Magic test card numbers for the mock provider (all Luhn-valid, mirroring
 * the industry-standard test PANs so the intake modal's client validation
 * passes). Tokenizing one of these yields a pm_mock_*<suffix> token whose
 * suffix drives the simulated charge outcome above. Any other Luhn-valid
 * number approves.
 *
 *   4242424242424242  approved (Visa)
 *   4000000000000002  generic_decline
 *   4000000000000127  cvv_failure
 *   4000000000000010  avs_failure
 *   4000000000009995  insufficient_funds
 *   4000000000000069  expired_card
 */
export const MOCK_MAGIC_CARDS: Array<{ number: string; suffix: string; category: string }> = [
  { number: "4000000000000002", suffix: "_declined", category: "generic_decline" },
  { number: "4000000000000127", suffix: "_cvv_fail", category: "cvv_failure" },
  { number: "4000000000000010", suffix: "_avs_fail", category: "avs_failure" },
  { number: "4000000000009995", suffix: "_insufficient", category: "insufficient_funds" },
  { number: "4000000000000069", suffix: "_expired", category: "expired_card" }
];

export function mockCardBrand(cardNumber: string) {
  const digits = cleanText(cardNumber).replace(/\D/g, "");
  if (/^3[47]/.test(digits)) return "Amex";
  if (/^(5[1-5]|2[2-7])/.test(digits)) return "Mastercard";
  if (/^6/.test(digits)) return "Discover";
  return "Visa";
}

// --- Mappers to provider-agnostic shapes ------------------------------------

function mapMockIntent(raw: JsonObject): ProviderPaymentIntent {
  return {
    id: cleanText(raw.id),
    status: cleanText(raw.status) as ProviderPaymentIntentStatus,
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    captured_cents: cents(raw.amount_captured),
    refunded_cents: cents(raw.amount_refunded),
    reference_id: cleanText(raw.reference_id),
    raw
  };
}

function mapMockPayment(raw: JsonObject): ProviderPayment {
  const status = cleanText(raw.status);
  return {
    id: cleanText(raw.id),
    intent_id: cleanText(raw.payment_intent_id),
    status: (status === "captured" || status === "authorized" || status === "failed" || status === "settled" || status === "refunded" ? status : "pending") as ProviderPayment["status"],
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    auth_code: cleanText(raw.auth_code),
    decline_reason: cleanText(raw.decline_category),
    raw
  };
}

function mapMockPayout(raw: JsonObject): ProviderPayout {
  const status = cleanText(raw.status);
  const mapped: ProviderPayoutStatus = status === "completed" ? "paid" : status === "failed" ? "failed" : "pending";
  return {
    id: cleanText(raw.id),
    status: mapped,
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    arrival_date: cleanText(raw.expected_arrival_date),
    raw
  };
}

function mapMockDispute(raw: JsonObject): ProviderDispute {
  const status = cleanText(raw.status);
  const mapped: ProviderDisputeStatus = status === "contested" ? "under_review"
    : status === "accepted" ? "lost"
      : ["won", "lost", "closed"].includes(status) ? status as ProviderDisputeStatus
        : "open";
  return {
    id: cleanText(raw.id),
    payment_id: cleanText(raw.payment_id),
    status: mapped,
    amount_cents: cents(raw.amount),
    reason: cleanText(raw.reason),
    respond_by: cleanText(raw.respond_by),
    raw
  };
}

function mapMockApplication(raw: JsonObject): ProviderApplication {
  return {
    id: cleanText(raw.id),
    business_id: cleanText(raw.business_id),
    status: (cleanText(raw.status) || "DRAFT") as BoardingApplicationStatus,
    processing_plan_id: cleanText(raw.processing_plan_id),
    documents_requested: asArray(raw.documents_requested).map(asObject),
    raw
  };
}

function mapMockAccount(raw: JsonObject): ProviderAccount {
  return {
    id: cleanText(raw.id),
    business_id: cleanText(raw.business_id),
    external_account_id: cleanText(raw.external_account_id),
    processing_enabled: raw.processing_enabled === true,
    payouts_enabled: raw.payouts_enabled === true,
    raw
  };
}

function mockPaymentMethod(raw: JsonObject): ProviderPaymentMethod {
  return {
    id: cleanText(raw.id),
    type: (cleanText(raw.type) === "bank" || cleanText(raw.type) === "ca_bank" ? cleanText(raw.type) : "card") as ProviderPaymentMethod["type"],
    brand: cleanText(raw.brand) || "Visa",
    last4: cleanText(raw.last4) || "4242",
    exp_month: cents(raw.exp_month) || 12,
    exp_year: cents(raw.exp_year) || new Date().getUTCFullYear() + 3,
    raw
  };
}

// --- Payments adapter --------------------------------------------------------

export function createMockAdapter(orgId: string): PaymentProviderAdapter {
  return {
    provider: MOCK_PROVIDER,
    async createPaymentIntent(input: CreatePaymentIntentInput) {
      const intent = await withMockState(orgId, (state) => {
        const id = mockId("pi");
        const record: JsonObject = {
          id,
          status: "created",
          amount: cents(input.amount_cents),
          currency: cleanText(input.currency || "USD").toUpperCase(),
          ...(input.merchant_amount_cents !== undefined ? { merchant_amount: cents(input.merchant_amount_cents) } : {}),
          reference_id: cleanText(input.reference_id),
          user_fields: asObject(input.user_fields),
          payment_method_types: input.payment_method_types?.length ? input.payment_method_types : ["card"],
          auto_capture: input.auto_capture !== false,
          description: cleanText(input.description),
          amount_captured: 0,
          amount_refunded: 0,
          created_at: nowIso()
        };
        state.payment_intents[id] = record;
        return record;
      });
      await emitMockEvent(orgId, "v2.payment_intent.created", {
        id: cleanText(intent.id),
        status: "created",
        amount: cents(intent.amount),
        currency: cleanText(intent.currency),
        reference_id: cleanText(intent.reference_id),
        user_fields: asObject(intent.user_fields)
      });
      return mapMockIntent(intent);
    },
    async capturePaymentIntent(intentId, input = {}) {
      const intent = await withMockState(orgId, (state) => {
        const record = state.payment_intents[cleanText(intentId)];
        if (!record) throw notFound("mock_intent_not_found", "Mock payment intent was not found.");
        const captureAmount = input.amount_cents !== undefined ? cents(input.amount_cents) : cents(record.amount);
        record.status = "captured";
        record.amount_captured = captureAmount;
        for (const payment of Object.values(state.payments)) {
          if (cleanText(payment.payment_intent_id) === cleanText(intentId) && cleanText(payment.status) === "authorized") {
            payment.status = "captured";
          }
        }
        return record;
      });
      await emitMockEvent(orgId, "v2.payment_intent.captured", {
        id: cleanText(intent.id),
        status: "captured",
        amount: cents(intent.amount),
        reference_id: cleanText(intent.reference_id),
        user_fields: asObject(intent.user_fields)
      });
      return mapMockIntent(intent);
    },
    async cancelPaymentIntent(intentId) {
      const intent = await withMockState(orgId, (state) => {
        const record = state.payment_intents[cleanText(intentId)];
        if (!record) throw notFound("mock_intent_not_found", "Mock payment intent was not found.");
        record.status = "cancelled";
        return record;
      });
      await emitMockEvent(orgId, "v2.payment_intent.cancelled", {
        id: cleanText(intent.id),
        status: "cancelled",
        reference_id: cleanText(intent.reference_id),
        user_fields: asObject(intent.user_fields)
      });
      return mapMockIntent(intent);
    },
    async createPayment(intentId, input: CreatePaymentInput) {
      const result = await withMockState(orgId, async (state) => {
        const intent = state.payment_intents[cleanText(intentId)];
        if (!intent) throw notFound("mock_intent_not_found", "Mock payment intent was not found.");
        const amount = input.amount_cents !== undefined ? cents(input.amount_cents) : cents(intent.amount);
        const declineCategory = declineCategoryFor(cleanText(input.payment_method_id));
        const planId = await resolveMockPlanId(orgId, state);
        const fee = declineCategory ? 0 : mockCardFeeCents(planId, amount);
        const id = mockId("pay");
        const autoCapture = intent.auto_capture !== false;
        const payment: JsonObject = {
          id,
          payment_intent_id: cleanText(intent.id),
          payment_method_id: cleanText(input.payment_method_id),
          status: declineCategory ? "failed" : autoCapture ? "captured" : "authorized",
          amount,
          currency: cleanText(intent.currency || "USD").toUpperCase(),
          fee,
          merchant_amount: Math.max(0, amount - fee),
          processing_plan_id: planId,
          auth_code: declineCategory ? "" : `A${randomBytes(3).toString("hex").toUpperCase()}`,
          decline_category: declineCategory,
          reference_id: cleanText(intent.reference_id),
          user_fields: asObject(intent.user_fields),
          amount_refunded: 0,
          payout_id: "",
          created_at: nowIso()
        };
        state.payments[id] = payment;
        if (!declineCategory) {
          intent.status = autoCapture ? "captured" : "uncaptured";
          intent.amount_captured = autoCapture ? amount : 0;
        }
        return { payment, intent };
      });
      const { payment, intent } = result;
      const eventBase = {
        id: cleanText(payment.id),
        payment_intent_id: cleanText(payment.payment_intent_id),
        amount: cents(payment.amount),
        currency: cleanText(payment.currency),
        fee: cents(payment.fee),
        merchant_amount: cents(payment.merchant_amount),
        reference_id: cleanText(payment.reference_id),
        user_fields: asObject(payment.user_fields)
      };
      if (cleanText(payment.decline_category)) {
        await emitMockEvent(orgId, "v2.payment.failed", {
          ...eventBase,
          status: "failed",
          decline_category: cleanText(payment.decline_category)
        });
      } else {
        await emitMockEvent(orgId, "v2.payment.created", { ...eventBase, status: cleanText(payment.status) });
        if (cleanText(payment.status) === "captured") {
          await emitMockEvent(orgId, "v2.payment.captured", { ...eventBase, status: "captured" });
          await emitMockEvent(orgId, "v2.payment_intent.captured", {
            id: cleanText(intent.id),
            status: "captured",
            amount: cents(intent.amount),
            reference_id: cleanText(intent.reference_id),
            user_fields: asObject(intent.user_fields)
          });
        }
      }
      return mapMockPayment(payment);
    },
    async createRefund(intentId, input: CreateRefundInput = {}) {
      const refund = await withMockState(orgId, (state) => {
        const intent = state.payment_intents[cleanText(intentId)];
        if (!intent) throw notFound("mock_intent_not_found", "Mock payment intent was not found.");
        const payment = Object.values(state.payments)
          .find((entry) => cleanText(entry.payment_intent_id) === cleanText(intentId) && ["captured", "settled"].includes(cleanText(entry.status)));
        if (!payment) throw badRequest("mock_payment_not_refundable", "No captured mock payment exists for this intent.");
        const remaining = Math.max(0, cents(payment.amount) - cents(payment.amount_refunded));
        const amount = input.amount_cents !== undefined ? cents(input.amount_cents) : remaining;
        if (amount <= 0 || amount > remaining) throw badRequest("mock_refund_amount_invalid", "Refund amount exceeds the refundable balance.");
        const id = mockId("ref");
        const record: JsonObject = {
          id,
          payment_id: cleanText(payment.id),
          payment_intent_id: cleanText(intent.id),
          status: "succeeded",
          amount,
          currency: cleanText(payment.currency),
          reason: cleanText(input.reason),
          reference_id: cleanText(intent.reference_id),
          user_fields: asObject(intent.user_fields),
          created_at: nowIso()
        };
        state.refunds[id] = record;
        payment.amount_refunded = cents(payment.amount_refunded) + amount;
        intent.amount_refunded = cents(intent.amount_refunded) + amount;
        return record;
      });
      await emitMockEvent(orgId, "v2.refund.created", {
        id: cleanText(refund.id),
        payment_id: cleanText(refund.payment_id),
        payment_intent_id: cleanText(refund.payment_intent_id),
        amount: cents(refund.amount),
        currency: cleanText(refund.currency),
        reason: cleanText(refund.reason),
        reference_id: cleanText(refund.reference_id),
        user_fields: asObject(refund.user_fields)
      });
      return {
        id: cleanText(refund.id),
        payment_id: cleanText(refund.payment_id),
        status: "succeeded",
        amount_cents: cents(refund.amount),
        raw: refund
      } satisfies ProviderRefund;
    },
    async getPayment(paymentId) {
      const state = await readMockState(orgId);
      const payment = state.payments[cleanText(paymentId)];
      if (!payment) throw notFound("mock_payment_not_found", "Mock payment was not found.");
      return mapMockPayment(payment);
    },
    async listPayouts(_options: ListOptions = {}) {
      const state = await readMockState(orgId);
      return Object.values(state.payouts)
        .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)))
        .map(mapMockPayout);
    },
    async getPayout(payoutId) {
      const state = await readMockState(orgId);
      const payout = state.payouts[cleanText(payoutId)];
      if (!payout) throw notFound("mock_payout_not_found", "Mock payout was not found.");
      return mapMockPayout(payout);
    },
    async getBalances() {
      const state = await readMockState(orgId);
      const pending = Object.values(state.payments)
        .filter((payment) => cleanText(payment.status) === "captured" && !cleanText(payment.payout_id))
        .reduce((sum, payment) => sum + Math.max(0, cents(payment.merchant_amount) - cents(payment.amount_refunded)), 0);
      return [{ currency: "USD", available_cents: 0, pending_cents: pending, raw: { pending } }];
    },
    async listDisputes(_options: ListOptions = {}) {
      const state = await readMockState(orgId);
      return Object.values(state.disputes)
        .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)))
        .map(mapMockDispute);
    },
    async getDispute(disputeId) {
      const state = await readMockState(orgId);
      const dispute = state.disputes[cleanText(disputeId)];
      if (!dispute) throw notFound("mock_dispute_not_found", "Mock dispute was not found.");
      return mapMockDispute(dispute);
    },
    async calculateSurcharge(input: SurchargeCalculationInput) {
      // Mock surcharge model: 3% on cards capped at $500.00, $0 on bank rails
      // (identified by a bank/ach payment_method hint). Real providers own
      // state-compliance logic; the cap exercises the "respect a max" path.
      const amount = Math.max(0, cents(input.amount_cents));
      const method = cleanText(input.payment_method_id).toLowerCase();
      const isBank = method.includes("bank") || method.includes("ach");
      const surcharge = isBank ? 0 : Math.min(Math.round(amount * 0.03), MOCK_SURCHARGE_MAX_CENTS);
      return {
        amount_cents: amount,
        surcharge_cents: surcharge,
        total_cents: amount + surcharge,
        raw: { mock: true, rate: isBank ? 0 : 0.03, max_cents: MOCK_SURCHARGE_MAX_CENTS }
      } satisfies SurchargeCalculation;
    },
    async createPaymentMethodIntent(input: CreatePaymentMethodIntentInput = {}) {
      // Direct server-side "tokenization" is a MOCK-ONLY convenience: derive
      // brand + last4, map magic numbers to decline-suffixed tokens, and
      // DISCARD the PAN/CVC — the stored record is built exclusively from the
      // whitelisted fields below, never by spreading the input.
      const card = asObject(input.card);
      const bank = asObject(input.bank);
      const type = cleanText(input.type) || (Object.keys(bank).length ? "bank" : "card");
      const cardDigits = cleanText(card.number).replace(/\D/g, "");
      const magic = MOCK_MAGIC_CARDS.find((entry) => entry.number === cardDigits);
      const record = await withMockState(orgId, (state) => {
        const id = mockId("pmi");
        const paymentMethodId = `${mockId("pm")}${magic ? magic.suffix : ""}`;
        state.payment_methods[paymentMethodId] = {
          id: paymentMethodId,
          type,
          brand: type === "card" ? mockCardBrand(cardDigits || "4242") : "Bank",
          last4: (type === "card"
            ? cardDigits.slice(-4)
            : cleanText(bank.account).replace(/\D/g, "").slice(-4)) || "4242",
          exp_month: cents(card.exp_month) || 12,
          exp_year: cents(card.exp_year) || new Date().getUTCFullYear() + 3,
          ...(type !== "card" ? { account_type: cleanText(bank.account_type) || "checking" } : {}),
          holder_name: cleanText(card.name || bank.name),
          billing_details: asObject(input.billing_details),
          user_fields: asObject(input.user_fields),
          created_at: nowIso()
        };
        return {
          id,
          status: "succeeded",
          client_secret: `pmi_secret_${randomBytes(8).toString("hex")}`,
          payment_method_id: paymentMethodId
        };
      });
      return { ...record, raw: { ...record, mock: true } };
    },
    async getPaymentMethod(paymentMethodId) {
      const state = await readMockState(orgId);
      return mockPaymentMethod(state.payment_methods[cleanText(paymentMethodId)] || { id: cleanText(paymentMethodId) });
    },
    async updatePaymentMethod(paymentMethodId, input: UpdatePaymentMethodInput) {
      const record = await withMockState(orgId, (state) => {
        const existing = asObject(state.payment_methods[cleanText(paymentMethodId)]);
        const next: JsonObject = {
          ...existing,
          id: cleanText(paymentMethodId),
          ...(input.billing_details ? { billing_details: { ...asObject(existing.billing_details), ...input.billing_details } } : {}),
          ...(input.exp_month !== undefined ? { exp_month: cents(input.exp_month) } : {}),
          ...(input.exp_year !== undefined ? { exp_year: cents(input.exp_year) } : {}),
          updated_at: nowIso()
        };
        state.payment_methods[cleanText(paymentMethodId)] = next;
        return next;
      });
      return mockPaymentMethod(record);
    }
  };
}

// --- Boarding adapter --------------------------------------------------------

export function createMockBoardingAdapter(orgId: string): MerchantBoardingAdapter {
  const createPortalUser: MerchantBoardingAdapter["createPortalUser"] = async (input) => {
    const record = await withMockState(orgId, (state) => {
      const id = mockId("user");
      const fullName = cleanText(input.name);
      const [firstName, ...restName] = fullName.split(/\s+/);
      const user: JsonObject = {
        id,
        type: "BUSINESS",
        first_name: cleanText(input.first_name || firstName) || "Merchant",
        last_name: cleanText(input.last_name || restName.join(" ")) || "User",
        email: cleanText(input.email).toLowerCase(),
        business_id: cleanText(input.business_id),
        status: "ACTIVE",
        created_at: nowIso()
      };
      state.portal_users[id] = user;
      return user;
    });
    return {
      id: cleanText(record.id),
      email: cleanText(record.email),
      first_name: cleanText(record.first_name),
      last_name: cleanText(record.last_name),
      status: cleanText(record.status),
      raw: record
    };
  };
  return {
    provider: MOCK_PROVIDER,
    async createBusiness(input: CreateBusinessInput) {
      const record = await withMockState(orgId, (state) => {
        const id = mockId("biz");
        const business: JsonObject = {
          id,
          name: cleanText(input.name),
          email: cleanText(input.email),
          phone: cleanText(input.phone),
          created_at: nowIso()
        };
        state.businesses[id] = business;
        return business;
      });
      return { id: cleanText(record.id), name: cleanText(record.name), raw: record };
    },
    async createApplication(input: ApplicationInput) {
      const record = await withMockState(orgId, (state) => {
        const id = `app_mock_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
        const application: JsonObject = {
          id,
          business_id: cleanText(input.business_id),
          status: "DRAFT",
          processing_plan_id: cleanText(input.processing_plan_id),
          external_account_id: cleanText(input.external_account_id),
          company: asObject(input.company),
          address: asObject(input.address),
          owners: asArray(input.owners).map(asObject),
          volumes: asObject(input.volumes),
          bank_account: asObject(input.bank_account),
          user_fields: asObject(input.user_fields),
          documents_requested: [],
          created_at: nowIso()
        };
        state.applications[id] = application;
        return application;
      });
      await emitMockEvent(orgId, "v2.application.created", {
        id: cleanText(record.id),
        status: "DRAFT",
        business_id: cleanText(record.business_id),
        processing_plan_id: cleanText(record.processing_plan_id)
      });
      return mapMockApplication(record);
    },
    async updateApplication(applicationId, input: ApplicationInput) {
      const record = await withMockState(orgId, (state) => {
        const application = state.applications[cleanText(applicationId)];
        if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
        if (!["DRAFT", "NEED_INFORMATION"].includes(cleanText(application.status))) {
          throw badRequest("mock_application_not_editable", "Only draft or need-information applications can be updated.");
        }
        if (cleanText(input.business_id)) application.business_id = cleanText(input.business_id);
        if (cleanText(input.processing_plan_id)) application.processing_plan_id = cleanText(input.processing_plan_id);
        if (cleanText(input.external_account_id)) application.external_account_id = cleanText(input.external_account_id);
        if (input.company) application.company = { ...asObject(application.company), ...input.company };
        if (input.address) application.address = { ...asObject(application.address), ...input.address };
        if (input.owners) application.owners = asArray(input.owners).map(asObject);
        if (input.volumes) application.volumes = { ...asObject(application.volumes), ...input.volumes };
        if (input.bank_account) application.bank_account = { ...asObject(application.bank_account), ...input.bank_account };
        if (input.user_fields) application.user_fields = { ...asObject(application.user_fields), ...input.user_fields };
        application.updated_at = nowIso();
        return application;
      });
      await emitMockEvent(orgId, "v2.application.updated", {
        id: cleanText(record.id),
        status: cleanText(record.status),
        processing_plan_id: cleanText(record.processing_plan_id)
      });
      return mapMockApplication(record);
    },
    async getApplication(applicationId) {
      const state = await readMockState(orgId);
      const application = state.applications[cleanText(applicationId)];
      if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
      return mapMockApplication(application);
    },
    async submitApplication(applicationId) {
      // Mirrors Forward's partner reality loosely: the mock keeps API submit
      // working (it validates + transitions), but the org-facing flow goes
      // through generateApplicationLink + the "hosted_submit" advance op —
      // this method is only for partner-capability-enabled integrations.
      const record = await withMockState(orgId, (state) => {
        const application = state.applications[cleanText(applicationId)];
        if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
        application.status = "UNDER_REVIEW";
        application.submitted_at = nowIso();
        return application;
      });
      await emitMockEvent(orgId, "v2.application.submitted", {
        id: cleanText(record.id),
        status: "UNDER_REVIEW",
        processing_plan_id: cleanText(record.processing_plan_id)
      });
      return mapMockApplication(record);
    },
    async generateApplicationLink(applicationId) {
      // Same wire semantics as Forward's POST /applications/{id}/link:
      // { link_id, uri, expiration_date, expired } with a 14-day expiry, and
      // each call mints a fresh link. The latest link is stamped onto the
      // application (Forward echoes application_link_id/uri on GET).
      const record = await withMockState(orgId, (state) => {
        const application = state.applications[cleanText(applicationId)];
        if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
        const linkId = mockId("aapplink");
        const expiration = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
        const link: JsonObject = {
          link_id: linkId,
          uri: `https://application.mock.local/${linkId}`,
          expiration_date: expiration,
          expired: false
        };
        application.application_link_id = linkId;
        application.application_link_uri = link.uri;
        application.application_link_expiration_date = expiration;
        return link;
      });
      return {
        id: cleanText(record.link_id),
        url: cleanText(record.uri),
        expires_at: cleanText(record.expiration_date),
        expired: false,
        raw: record
      };
    },
    createPortalUser,
    async ensurePortalUser(input) {
      const email = cleanText(input.email).toLowerCase();
      const state = await readMockState(orgId);
      const existing = Object.values(state.portal_users).find((user) => cleanText(user.email).toLowerCase() === email);
      if (existing) {
        return {
          id: cleanText(existing.id),
          email: cleanText(existing.email),
          first_name: cleanText(existing.first_name),
          last_name: cleanText(existing.last_name),
          status: cleanText(existing.status),
          raw: existing
        };
      }
      return createPortalUser(input);
    },
    async generatePortalLoginUrl(userId) {
      const state = await readMockState(orgId);
      const user = state.portal_users[cleanText(userId)];
      if (!user) throw notFound("mock_portal_user_not_found", "Mock merchant-portal user was not found.");
      // Single-use magic link shape mirroring the live portal domain layout.
      return {
        user_id: cleanText(user.id),
        url: `https://portal.mock.local/auth/magic-link?code=${randomBytes(16).toString("hex")}`,
        raw: { id: cleanText(user.id), mock: true }
      };
    },
    async listProcessingPlans(_options: ListOptions = {}) {
      return MOCK_PROCESSING_PLANS.map((plan) => ({
        id: cleanText(plan.id),
        name: cleanText(plan.name),
        raw: plan
      } satisfies ProviderProcessingPlan));
    },
    async getAccount(accountId) {
      const state = await readMockState(orgId);
      const account = state.accounts[cleanText(accountId)];
      if (!account) throw notFound("mock_account_not_found", "Mock account was not found.");
      return mapMockAccount(account);
    },
    async listAccounts(_options: ListOptions & { business_id?: string } = {}) {
      const state = await readMockState(orgId);
      return Object.values(state.accounts).map(mapMockAccount);
    },
    async listBankAccounts(options: ListOptions & { business_id?: string } = {}) {
      const state = await readMockState(orgId);
      return Object.values(state.bank_accounts)
        .filter((raw) => !cleanText(options.business_id) || cleanText(raw.business_id) === cleanText(options.business_id))
        .map((raw) => ({
        id: cleanText(raw.bank_account_id || raw.id),
        business_id: cleanText(raw.business_id),
        name: cleanText(raw.bank_account_name || raw.bank_name),
        mask: cleanText(raw.bank_account_mask || raw.last4),
        validation_status: cleanText(raw.validation_status || raw.status),
        verification_status: cleanText(raw.verification_status),
        status: cleanText(raw.bank_account_status || raw.status),
        active: raw.bank_account_active === true || cleanText(raw.bank_account_status || raw.status) === "ACTIVE",
        country: cleanText(raw.country),
        created_at: cleanText(raw.created_at),
        updated_at: cleanText(raw.updated_at),
        removed_at: cleanText(raw.removed_at),
        needs_info_comments: cleanText(raw.needs_info_comments),
        needs_info_documents: asArray(raw.needs_info_documents).map(asObject),
        bank_name: cleanText(raw.bank_account_name || raw.bank_name),
        last4: cleanText(raw.bank_account_mask || raw.last4).replace(/\D/g, "").slice(-4),
        raw
      }));
    }
  };
}

// --- Test-only advance mechanism --------------------------------------------

const ADVANCE_UNDERWRITING_TARGETS = ["APPROVED", "NEED_INFORMATION", "DECLINED"];

/**
 * Underwriting/settlement simulation behind
 * POST /organizations/:orgId/merchant-mock/advance. Ops:
 * - underwriting (default): {application_id, to, documents_requested?} —
 *   transitions the application; approval creates the mock account
 *   (processing then payouts enabled) and a verified bank account.
 * - hosted_submit: {application_id?} — simulates the merchant COMPLETING
 *   Forward's hosted application workflow (signatures included): transitions
 *   DRAFT/NEED_INFORMATION -> UNDER_REVIEW and synthesizes
 *   v2.application.submitted through the shared event path, exactly as the
 *   real webhook would arrive after a hosted-form completion.
 * - settle: batches all captured-but-unsettled mock payments into a payout
 *   (~2 business days out) and completes it.
 * - dispute: {payment_id, amount_cents?, reason?} — opens a mock dispute.
 * - orphan_payment: {amount_cents?} — synthesizes a captured provider payment
 *   with NO local reference so the webhook projection writes an unmatched
 *   shadow record (drives the reconciliation queue).
 * Every transition synthesizes the matching v2.* events through the shared
 * webhook ingestion path.
 */
export async function advanceMockMerchant(orgId: string, input: JsonObject) {
  const config = await getMerchantConfig(orgId).catch(() => null);
  if (cleanText(config?.provider) !== MOCK_PROVIDER) {
    throw badRequest("merchant_provider_not_mock", "The mock advance route requires the organization's merchant provider to be \"mock\".");
  }
  const op = cleanText(input.op) || "underwriting";
  if (op === "underwriting") return advanceUnderwriting(orgId, input);
  if (op === "hosted_submit") return hostedSubmitMockApplication(orgId, input);
  if (op === "settle") return settleMockPayments(orgId);
  if (op === "dispute") return openMockDispute(orgId, input);
  if (op === "orphan_payment") return createOrphanMockPayment(orgId, input);
  throw badRequest("mock_advance_op_invalid", "Supported mock advance ops: underwriting, hosted_submit, settle, dispute, orphan_payment.");
}

/**
 * Simulates the merchant finishing Forward's HOSTED application workflow —
 * the only submission path available to partners without the API-submit
 * capability. The application transitions to UNDER_REVIEW and the same
 * v2.application.submitted event the live webhook would deliver flows through
 * the shared ingestion path.
 */
async function hostedSubmitMockApplication(orgId: string, input: JsonObject) {
  const record = await withMockState(orgId, (state) => {
    const requestedId = cleanText(input.application_id);
    const application = requestedId
      ? state.applications[requestedId]
      : Object.values(state.applications).sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)))[0];
    if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
    if (!["DRAFT", "NEED_INFORMATION"].includes(cleanText(application.status))) {
      throw badRequest("mock_application_not_submittable", "Only draft or need-information applications can be submitted from the hosted workflow.");
    }
    application.status = "UNDER_REVIEW";
    application.submitted_at = nowIso();
    application.submitted_via = "hosted_application";
    application.terms_accepted = true;
    application.documents_requested = [];
    return application;
  });
  await emitMockEvent(orgId, "v2.application.submitted", {
    id: cleanText(record.id),
    status: "UNDER_REVIEW",
    processing_plan_id: cleanText(record.processing_plan_id),
    submitted_via: "hosted_application"
  });
  return { application: mapMockApplication(record) };
}

async function advanceUnderwriting(orgId: string, input: JsonObject) {
  const to = cleanText(input.to).toUpperCase();
  if (!ADVANCE_UNDERWRITING_TARGETS.includes(to)) {
    throw badRequest("mock_advance_target_invalid", "Underwriting can advance to APPROVED, NEED_INFORMATION, or DECLINED.");
  }
  const result = await withMockState(orgId, (state) => {
    const requestedId = cleanText(input.application_id);
    const application = requestedId
      ? state.applications[requestedId]
      : Object.values(state.applications).sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)))[0];
    if (!application) throw notFound("mock_application_not_found", "Mock application was not found.");
    application.status = to;
    application.documents_requested = to === "NEED_INFORMATION" ? asArray(input.documents_requested).map(asObject) : [];
    application.updated_at = nowIso();
    let account: JsonObject | null = null;
    let bankAccount: JsonObject | null = null;
    if (to === "APPROVED") {
      account = Object.values(state.accounts).find((entry) => cleanText(entry.application_id) === cleanText(application.id)) || null;
      if (!account) {
        const accountId = mockId("acct");
        const bankAccountId = mockId("ba");
        account = {
          id: accountId,
          business_id: cleanText(application.business_id),
          application_id: cleanText(application.id),
          external_account_id: cleanText(application.external_account_id),
          processing_plan_id: cleanText(application.processing_plan_id),
          processing_enabled: true,
          payouts_enabled: true,
          bank_account_id: bankAccountId,
          created_at: nowIso()
        };
        state.accounts[accountId] = account;
        bankAccount = {
          bank_account_id: bankAccountId,
          business_id: cleanText(application.business_id),
          account_id: accountId,
          bank_account_name: "Mock Bank",
          bank_account_mask: "****6789",
          validation_status: "VALIDATED",
          verification_status: "AUTOMATICALLY_VERIFIED",
          bank_account_status: "ACTIVE",
          bank_account_active: true,
          country: "US",
          created_at: nowIso(),
          updated_at: nowIso()
        };
        state.bank_accounts[bankAccountId] = bankAccount;
      }
    }
    return { application, account, bankAccount };
  });

  const { application, account } = result;
  const applicationEventType = to === "APPROVED" ? "v2.application.approved"
    : to === "NEED_INFORMATION" ? "v2.application.need_information"
      : "v2.application.manually_declined";
  await emitMockEvent(orgId, applicationEventType, {
    id: cleanText(application.id),
    status: to,
    processing_plan_id: cleanText(application.processing_plan_id),
    ...(to === "NEED_INFORMATION" ? { documents_requested: asArray(application.documents_requested).map(asObject) } : {})
  });
  if (to === "APPROVED" && account) {
    // Account comes online in the documented order: created (processing on),
    // then payouts enabled — two events so the tracker sees both edges.
    await emitMockEvent(orgId, "v2.account.created", {
      id: cleanText(account.id),
      application_id: cleanText(account.application_id),
      business_id: cleanText(account.business_id),
      external_account_id: cleanText(account.external_account_id),
      processing_enabled: true,
      payouts_enabled: false
    });
    await emitMockEvent(orgId, "v2.account.payouts_enabled", {
      id: cleanText(account.id),
      processing_enabled: true,
      payouts_enabled: true
    });
  }
  return {
    application: mapMockApplication(application),
    ...(account ? { account: mapMockAccount(account) } : {})
  };
}

async function settleMockPayments(orgId: string) {
  const payout = await withMockState(orgId, (state) => {
    const unsettled = Object.values(state.payments)
      .filter((payment) => cleanText(payment.status) === "captured" && !cleanText(payment.payout_id));
    if (!unsettled.length) throw badRequest("mock_nothing_to_settle", "There are no captured, unsettled mock payments to sweep.");
    const id = mockId("po");
    const amount = unsettled.reduce((sum, payment) => sum + Math.max(0, cents(payment.merchant_amount) - cents(payment.amount_refunded)), 0);
    const fee = unsettled.reduce((sum, payment) => sum + Math.max(0, cents(payment.fee)), 0);
    const record: JsonObject = {
      id,
      status: "created",
      amount,
      fee,
      currency: cleanText(asObject(unsettled[0]).currency || "USD").toUpperCase(),
      expected_arrival_date: addBusinessDays(new Date(), 2).toISOString(),
      payment_ids: unsettled.map((payment) => cleanText(payment.id)),
      created_at: nowIso()
    };
    for (const payment of unsettled) {
      payment.payout_id = id;
      payment.status = "settled";
    }
    state.payouts[id] = record;
    return record;
  });
  const eventBase = {
    id: cleanText(payout.id),
    amount: cents(payout.amount),
    fee: cents(payout.fee),
    currency: cleanText(payout.currency),
    expected_arrival_date: cleanText(payout.expected_arrival_date),
    payment_ids: asArray(payout.payment_ids).map(cleanText)
  };
  await emitMockEvent(orgId, "v2.payout.created", { ...eventBase, status: "created" });
  const arrivedAt = nowIso();
  await withMockState(orgId, (state) => {
    const record = state.payouts[cleanText(payout.id)];
    if (record) {
      record.status = "completed";
      record.arrived_at = arrivedAt;
    }
  });
  await emitMockEvent(orgId, "v2.payout.completed", { ...eventBase, status: "completed", arrived_at: arrivedAt });
  return { payout: { ...payout, status: "completed", arrived_at: arrivedAt } };
}

/**
 * Synthesizes a captured provider payment carrying NO reference back to any
 * of our transactions (no reference_id, no user_fields), so the payment-event
 * projection creates an unmatched shadow record — the drivable feed for the
 * unmatched-settlements reconciliation queue.
 */
async function createOrphanMockPayment(orgId: string, input: JsonObject) {
  const payment = await withMockState(orgId, async (state) => {
    const amount = input.amount_cents !== undefined ? Math.max(1, cents(input.amount_cents)) : 12_345;
    const planId = await resolveMockPlanId(orgId, state);
    const fee = mockCardFeeCents(planId, amount);
    const intentId = mockId("pi");
    state.payment_intents[intentId] = {
      id: intentId,
      status: "captured",
      amount,
      currency: "USD",
      reference_id: "",
      user_fields: {},
      auto_capture: true,
      amount_captured: amount,
      amount_refunded: 0,
      created_at: nowIso()
    };
    const id = mockId("pay");
    const record: JsonObject = {
      id,
      payment_intent_id: intentId,
      payment_method_id: "pm_mock_orphan",
      status: "captured",
      amount,
      currency: "USD",
      fee,
      merchant_amount: Math.max(0, amount - fee),
      processing_plan_id: planId,
      auth_code: `A${randomBytes(3).toString("hex").toUpperCase()}`,
      decline_category: "",
      reference_id: "",
      user_fields: {},
      amount_refunded: 0,
      payout_id: "",
      created_at: nowIso()
    };
    state.payments[id] = record;
    return record;
  });
  const eventBase = {
    id: cleanText(payment.id),
    payment_intent_id: cleanText(payment.payment_intent_id),
    amount: cents(payment.amount),
    currency: cleanText(payment.currency),
    fee: cents(payment.fee),
    merchant_amount: cents(payment.merchant_amount)
  };
  await emitMockEvent(orgId, "v2.payment.created", { ...eventBase, status: "captured" });
  await emitMockEvent(orgId, "v2.payment.captured", { ...eventBase, status: "captured" });
  return { payment: mapMockPayment(payment) };
}

async function openMockDispute(orgId: string, input: JsonObject) {
  const dispute = await withMockState(orgId, (state) => {
    const requested = cleanText(input.payment_id);
    const payment = state.payments[requested]
      || Object.values(state.payments).find((entry) => cleanText(asObject(entry.user_fields).payment_id) === requested
        || cleanText(entry.reference_id) === requested);
    if (!payment) throw notFound("mock_payment_not_found", "Mock payment was not found for the dispute.");
    const id = mockId("dp");
    const record: JsonObject = {
      id,
      payment_id: cleanText(payment.id),
      payment_intent_id: cleanText(payment.payment_intent_id),
      status: "created",
      amount: input.amount_cents !== undefined ? Math.max(0, cents(input.amount_cents)) : cents(payment.amount),
      currency: cleanText(payment.currency),
      reason: cleanText(input.reason) || "fraudulent",
      respond_by: addBusinessDays(new Date(), 10).toISOString(),
      reference_id: cleanText(payment.reference_id),
      user_fields: asObject(payment.user_fields),
      created_at: nowIso()
    };
    state.disputes[id] = record;
    return record;
  });
  await emitMockEvent(orgId, "v2.dispute.created", {
    id: cleanText(dispute.id),
    payment_id: cleanText(dispute.payment_id),
    status: "created",
    amount: cents(dispute.amount),
    currency: cleanText(dispute.currency),
    reason: cleanText(dispute.reason),
    respond_by: cleanText(dispute.respond_by),
    reference_id: cleanText(dispute.reference_id),
    user_fields: asObject(dispute.user_fields)
  });
  return { dispute: mapMockDispute(dispute) };
}
