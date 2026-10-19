import { randomBytes } from "node:crypto";

import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, notFound, PlatformError } from "../platform/errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  readOrganization,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { getInvoicePaymentSettings } from "./invoices.js";
import { getMerchantConfig } from "./merchant_config.js";
import { PROVIDER_WEBHOOK_CTX } from "./payouts.js";
import { createForwardAdapter, ForwardApiError, forwardIdempotencyKey } from "./providers/forward.js";
import { createMockAdapter } from "./providers/mock.js";
import type { PaymentProviderAdapter } from "./providers/index.js";
import type { ProviderOrderDetails, ProviderPayment } from "./providers/types.js";
import { paymentsReadiness, requirePaymentsReady, type PaymentsReadiness } from "./readiness.js";
import { createPayment, PAYMENT_TRANSACTION_COLLECTION } from "./storage.js";

/**
 * Payment-intake server flow: provider tokenization (payment-method intents),
 * saved payment methods, surcharge quotes, and the provider charge path the
 * intake modal drives. Everything here is additive on top of the legacy
 * mock-record behavior — when an organization has no resolved provider,
 * callers skip this module entirely and record payments exactly as before.
 *
 * PAN/CVC safety: raw card data enters only through tokenizePaymentMethod,
 * which forwards it to the adapter's createPaymentMethodIntent and returns a
 * token. The MOCK adapter derives brand+last4 and discards the rest; nothing
 * in this module ever persists or logs card numbers or CVCs.
 */

export const PAYMENT_SAVED_METHOD_COLLECTION = "payment_saved_methods";

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

function nowIso() {
  return new Date().toISOString();
}

function generatedId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
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

/** Contact identity key used to scope saved methods (id preferred, else email). */
export function normalizeContactRef(value: unknown) {
  const contact = asObject(value);
  const direct = cleanText(typeof value === "string" ? value : "");
  return (direct || cleanText(contact.id || contact.contact_id) || cleanText(contact.email).toLowerCase()).slice(0, 200);
}

// --- Tokenization (payment-method intents) ---------------------------------

export type TokenizeInput = {
  type?: string;
  card?: JsonObject;
  bank?: JsonObject;
  billing_details?: JsonObject;
};

/**
 * Creates a provider payment-method intent. For the mock provider this also
 * performs the direct server-side "tokenization" of card/bank fields (a
 * mock-only convenience — real providers tokenize in the browser through
 * their SDK element, so the card block is ignored by them).
 */
export async function tokenizePaymentMethod(orgId: string, provider: PaymentProviderAdapter, input: TokenizeInput) {
  const card = asObject(input.card);
  const bank = asObject(input.bank);
  if (provider.provider !== "mock" && (Object.keys(card).length || Object.keys(bank).length)) {
    // Card and bank numbers are entered only in the processor's secure
    // fields; our servers never receive them.
    throw badRequest("raw_payment_details_refused", "Enter card and bank details in the secure payment form.");
  }
  const type = cleanText(input.type) === "bank" || cleanText(input.type) === "ach" || Object.keys(bank).length
    ? "bank" as const
    : "card" as const;
  const intent = await provider.createPaymentMethodIntent({
    type,
    billing_details: asObject(input.billing_details),
    ...(Object.keys(card).length ? {
      card: {
        number: cleanText(card.number),
        exp_month: cents(card.exp_month),
        exp_year: normalizeExpYear(card.exp_year),
        cvc: cleanText(card.cvc),
        name: cleanText(card.name),
        zip: cleanText(card.zip)
      }
    } : {}),
    ...(Object.keys(bank).length ? {
      bank: {
        routing: cleanText(bank.routing),
        account: cleanText(bank.account),
        account_type: cleanText(bank.account_type),
        name: cleanText(bank.name)
      }
    } : {})
  });
  let method: JsonObject = {};
  if (intent.payment_method_id) {
    method = asObject(await provider.getPaymentMethod(intent.payment_method_id).then((pm) => ({
      brand: pm.brand,
      last4: pm.last4,
      exp_month: pm.exp_month,
      exp_year: pm.exp_year,
      type: pm.type === "card" ? "card" : "bank"
    })).catch(() => ({})));
  }
  return {
    intent: {
      id: intent.id,
      status: intent.status,
      client_secret: intent.client_secret,
      payment_method_id: intent.payment_method_id
    },
    payment_method: {
      id: intent.payment_method_id,
      type,
      ...method
    }
  };
}

function normalizeExpYear(value: unknown) {
  const year = cents(value);
  return year > 0 && year < 100 ? 2000 + year : year;
}

// --- Saved payment methods ---------------------------------------------------

export async function listSavedMethods(orgId: string, contactRefValue: unknown) {
  const contactRef = normalizeContactRef(contactRefValue);
  if (!contactRef) return [];
  return (await listDocuments(orgId, PAYMENT_SAVED_METHOD_COLLECTION))
    .map(documentView)
    .filter((method) => cleanText(method.contact_ref) === contactRef)
    .sort((a, b) => cleanText(b.created_at).localeCompare(cleanText(a.created_at)))
    .map(savedMethodView);
}

export function savedMethodView(method: JsonObject) {
  const type = cleanText(method.type) === "bank" ? "bank" : "card";
  const brand = cleanText(method.brand) || (type === "bank" ? "Bank" : "Card");
  const last4 = cleanText(method.last4);
  return {
    id: cleanText(method.id),
    provider: cleanText(method.provider),
    provider_payment_method_id: cleanText(method.provider_payment_method_id),
    type,
    brand,
    last4,
    exp_month: cents(method.exp_month) || null,
    exp_year: cents(method.exp_year) || null,
    label: cleanText(method.label) || `${brand} ending in ${last4 || "????"}`,
    contact_ref: cleanText(method.contact_ref),
    default: method.default === true,
    created_at: cleanText(method.created_at)
  };
}

export type SaveMethodInput = {
  provider: string;
  provider_payment_method_id: string;
  type?: string;
  brand?: string;
  last4?: string;
  exp_month?: number | null;
  exp_year?: number | null;
  label?: string;
  default?: boolean;
};

export async function createSavedMethod(orgId: string, contactRefValue: unknown, input: SaveMethodInput) {
  const contactRef = normalizeContactRef(contactRefValue);
  if (!contactRef) throw badRequest("saved_method_contact_required", "A customer contact is required to save a payment method.");
  const providerPaymentMethodId = cleanText(input.provider_payment_method_id);
  if (!providerPaymentMethodId) throw badRequest("saved_method_token_required", "A provider payment method token is required.");
  const existing = (await listDocuments(orgId, PAYMENT_SAVED_METHOD_COLLECTION))
    .map(documentView)
    .find((method) => cleanText(method.contact_ref) === contactRef
      && cleanText(method.provider_payment_method_id) === providerPaymentMethodId);
  const id = cleanText(existing?.id) || generatedId("saved_method");
  const type = cleanText(input.type) === "bank" || cleanText(input.type) === "ach" ? "bank" : "card";
  const brand = cleanText(input.brand) || (type === "bank" ? "Bank" : "Card");
  const last4 = cleanText(input.last4).replace(/\D/g, "").slice(-4);
  const data: JsonObject = {
    id,
    provider: cleanText(input.provider),
    provider_payment_method_id: providerPaymentMethodId,
    type,
    brand,
    last4,
    exp_month: cents(input.exp_month) || null,
    exp_year: cents(input.exp_year) || null,
    label: cleanText(input.label) || `${brand} ending in ${last4 || "????"}`,
    contact_ref: contactRef,
    default: input.default === true,
    created_at: cleanText(existing?.created_at) || nowIso(),
    updated_at: nowIso()
  };
  const doc = await upsertDocument(orgId, PAYMENT_SAVED_METHOD_COLLECTION, {
    id,
    data,
    metadata: { kind: "payment_saved_method", contact_ref: contactRef, provider: cleanText(input.provider), type }
  }, { replace: true });
  return savedMethodView(documentView(doc));
}

export async function deleteSavedMethod(orgId: string, contactRefValue: unknown, methodId: string) {
  const contactRef = normalizeContactRef(contactRefValue);
  const method = documentView(await readDocument(orgId, PAYMENT_SAVED_METHOD_COLLECTION, cleanText(methodId)));
  if (!contactRef || cleanText(method.contact_ref) !== contactRef) {
    throw badRequest("saved_method_not_found", "That saved payment method does not belong to this customer.");
  }
  await deleteDocument(orgId, PAYMENT_SAVED_METHOD_COLLECTION, cleanText(methodId));
  return savedMethodView(method);
}

export async function findSavedMethod(orgId: string, savedMethodId: string) {
  const doc = await readDocument(orgId, PAYMENT_SAVED_METHOD_COLLECTION, cleanText(savedMethodId)).catch(() => null);
  return doc ? savedMethodView(documentView(doc)) : null;
}

// --- Surcharge ---------------------------------------------------------------

export type SurchargeSettings = { enabled: boolean; mode: string };

export async function surchargeSettings(orgId: string, branchId = "default"): Promise<SurchargeSettings> {
  const settings = await getInvoicePaymentSettings(orgId, branchId);
  return {
    enabled: (settings as JsonObject).surcharge_enabled === true,
    mode: cleanText((settings as JsonObject).surcharge_mode) || "card_only"
  };
}

export async function surchargeQuote(
  orgId: string,
  provider: PaymentProviderAdapter,
  input: { amount_cents: number; method?: string; branch_id?: string }
) {
  const amount = Math.max(0, cents(input.amount_cents));
  const method = cleanText(input.method).toLowerCase() === "bank" || cleanText(input.method).toLowerCase() === "ach" ? "bank" : "card";
  const settings = await surchargeSettings(orgId, cleanText(input.branch_id) || "default");
  if (!settings.enabled || (settings.mode === "card_only" && method === "bank")) {
    return { amount_cents: amount, surcharge_cents: 0, total_cents: amount, method, enabled: settings.enabled, mode: settings.mode };
  }
  const quote = await provider.calculateSurcharge({
    amount_cents: amount,
    ...(method === "bank" ? { payment_method_id: "bank" } : {})
  });
  return {
    amount_cents: amount,
    surcharge_cents: Math.max(0, cents(quote.surcharge_cents)),
    total_cents: amount + Math.max(0, cents(quote.surcharge_cents)),
    method,
    enabled: settings.enabled,
    mode: settings.mode
  };
}

// --- Intake config (one call powers each modal mount) ------------------------

/**
 * Everything a payment form needs before it shows: whether this organization
 * can take a payment right now (and if not, why), which rails are on, the
 * secure element settings, the customer's saved methods and the refund
 * policy. A form that is not ready offers no card or bank entry at all.
 */
export async function paymentIntakeConfig(orgId: string, contactRefValue: unknown, branchId = "default") {
  const readiness = await paymentsReadiness(orgId).catch(() => null);
  const refundPolicy = await refundPolicyText(orgId, branchId).catch(() => "");
  if (!readiness?.ready) {
    return {
      ready: false,
      not_ready_reason: readiness?.reason || "provider_unavailable",
      message: readiness?.message || "Online payments are not set up yet.",
      provider: null as string | null,
      tokenization: null,
      surcharge: null,
      rails: { card: false, bank: false },
      saved_methods: [] as JsonObject[],
      refund_policy: refundPolicy
    };
  }
  const [settings, savedMethods] = await Promise.all([
    surchargeSettings(orgId, branchId),
    listSavedMethods(orgId, contactRefValue)
  ]);
  return {
    ready: true,
    not_ready_reason: "",
    message: "",
    provider: readiness.provider,
    tokenization: readiness.provider === "mock"
      ? { mode: "mock" }
      : { mode: "forward", sdk_url: readiness.sdk_url, public_key: readiness.public_key },
    surcharge: settings,
    rails: readiness.rails,
    saved_methods: savedMethods
      .filter((method) => method.provider === readiness.provider && readiness.rails[method.type === "bank" ? "bank" : "card"])
      .map((method) => ({
        ...method,
        // Modal-friendly aliases (the intake modal filters on card|ach).
        type: method.type === "bank" ? "ach" : "card",
        detail: method.type === "bank" ? "Bank account on file" : "Card on file"
      })),
    refund_policy: refundPolicy
  };
}

/**
 * The refund policy every checkout shows next to the pay button. Each branch
 * can write its own in Settings, Payments; without one the customer is told
 * refunds follow their agreement and who to contact.
 */
export async function refundPolicyText(orgId: string, branchId = "default") {
  const settings = asObject(await getInvoicePaymentSettings(orgId, branchId));
  const custom = cleanText(settings.refund_policy);
  if (custom) return custom.slice(0, 2000);
  const organization = asObject(await readOrganization(orgId).catch(() => ({})));
  const data = asObject(organization.data);
  const name = cleanText(organization.name || data.name || organization.company_name) || "the company";
  const contact = [cleanText(organization.phone || data.phone), cleanText(organization.email || data.email)].filter(Boolean).join(" or ");
  return `Refunds follow the terms of your agreement with ${name}. To ask for a refund, contact ${name}${contact ? ` at ${contact}` : ""}.`;
}

// --- Checkouts ---------------------------------------------------------------
//
// A checkout is one attempt to take one payment. It is written before the
// processor is called and carries everything the payment record will need,
// so a charge whose answer is lost can still be finished from the
// processor's notification. Its id seeds every idempotency key, so a repeat
// of the same step is the same request to the processor.

export const PAYMENT_CHECKOUT_COLLECTION = "payment_checkouts";

export type CheckoutChannel = "staff" | "portal" | "field" | "partner" | "autopay";

export type CheckoutStatus = "open" | "processing" | "succeeded" | "unknown" | "cancelled";

export type PrepareCheckoutInput = {
  amount_cents: number;
  method?: string;
  channel: CheckoutChannel;
  /** Who started the payment (card-network CIT/MIT rules). */
  initiated_by?: "customer" | "merchant";
  /** A scheduled stored-credential repeat (autopay). */
  scheduled?: boolean;
  apply_surcharge?: boolean;
  project_id?: string;
  branch_id?: string;
  contact_ref?: JsonObject;
  invoice_id?: string;
  description?: string;
  tax_cents?: number;
  ship_to_zip?: string;
  /** What the browser or caller may later confirm against (document, output, obligations). */
  context?: JsonObject;
  /** Stable id for a server-side caller (autopay attempt); a fresh one otherwise. */
  checkout_id?: string;
};

function checkoutView(checkout: JsonObject, readiness?: PaymentsReadiness) {
  return {
    id: cleanText(checkout.id),
    status: cleanText(checkout.status),
    payment_id: cleanText(checkout.payment_id),
    method: cleanText(checkout.method),
    amount_cents: cents(checkout.amount_cents),
    base_amount_cents: cents(checkout.base_amount_cents),
    surcharge_cents: cents(checkout.surcharge_cents),
    currency: cleanText(checkout.currency || "USD"),
    provider: cleanText(checkout.provider),
    client_secret: cleanText(checkout.client_secret),
    ...(readiness && readiness.provider !== "mock" ? { sdk_url: readiness.sdk_url, public_key: readiness.public_key } : {})
  };
}

async function readCheckout(orgId: string, checkoutId: string) {
  const doc = await readDocument(orgId, PAYMENT_CHECKOUT_COLLECTION, cleanText(checkoutId)).catch(() => null);
  return doc ? documentView(doc) : null;
}

async function saveCheckout(orgId: string, checkout: JsonObject) {
  const data = { ...checkout, updated_at: nowIso() };
  await upsertDocument(orgId, PAYMENT_CHECKOUT_COLLECTION, {
    id: cleanText(checkout.id),
    data,
    metadata: {
      kind: "payment_checkout",
      status: cleanText(checkout.status),
      payment_id: cleanText(checkout.payment_id),
      project_id: cleanText(checkout.project_id),
      provider_intent_id: cleanText(checkout.provider_intent_id)
    }
  }, { replace: true });
  return data;
}

/** The checkout behind one of our payment ids (processor notifications carry it). */
export async function findCheckoutByPaymentId(orgId: string, paymentId: string) {
  const id = cleanText(paymentId);
  if (!id) return null;
  const direct = id.startsWith("payment_") ? await readCheckout(orgId, `checkout_${id.slice("payment_".length)}`) : null;
  if (direct && cleanText(direct.payment_id) === id) return direct;
  return (await listDocuments(orgId, PAYMENT_CHECKOUT_COLLECTION)).map(documentView)
    .find((checkout) => cleanText(checkout.payment_id) === id) ?? null;
}

function railOf(method: unknown): "card" | "bank" {
  const text = cleanText(method).toLowerCase();
  return text === "bank" || text === "ach" || text === "saved_ach" ? "bank" : "card";
}

function orderDetailsFor(checkout: JsonObject): ProviderOrderDetails {
  const merchant = cleanText(checkout.initiated_by) === "merchant";
  const scheduled = checkout.scheduled === true;
  return {
    card_not_present_type: scheduled ? "recurring" : "ecommerce",
    initiated_by: merchant ? "merchant" : "customer",
    is_scheduled_payment: scheduled,
    invoice_id: cleanText(checkout.invoice_id) || cleanText(checkout.payment_id),
    ...(cleanText(checkout.description) ? { description: cleanText(checkout.description) } : {}),
    ...(Number.isFinite(Number(checkout.tax_cents)) && cents(checkout.tax_cents) > 0 ? { tax_amount: cents(checkout.tax_cents) } : {}),
    ...(cleanText(checkout.ship_to_zip) ? { ship_to_zip: cleanText(checkout.ship_to_zip), ship_to_country: "US" } : {})
  };
}

/**
 * Opens a checkout: refuses unless the organization can take this payment,
 * prices any surcharge, writes the checkout, then creates the processor's
 * payment intent (whose client secret the browser element needs).
 */
/** A US ZIP code from an address (the last 5-digit group), or "". */
export function addressZip(...values: unknown[]) {
  for (const value of values) {
    const source = asObject(value);
    const text = typeof value === "string" ? value : cleanText(source.postal_code || source.zip || source.zip_code || source.address);
    const matches = cleanText(text).match(/\d{5}(?:-\d{4})?/g);
    if (matches?.length) return matches[matches.length - 1]!.slice(0, 5);
  }
  return "";
}

/** The job site's ZIP, sent as the ship-to ZIP (Level 2 card data). */
async function projectZip(orgId: string, projectId: string) {
  if (!projectId) return "";
  const project = asObject(asObject(await readDocument(orgId, "projects", projectId).catch(() => null)).data);
  return addressZip(project.address, project.location, project.zip, project.postal_code, asObject(project.site).address);
}

function brandLabel(brand: unknown) {
  const text = cleanText(brand);
  const known: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", american_express: "American Express", discover: "Discover" };
  return known[text.toLowerCase()] || (text ? text.charAt(0).toUpperCase() + text.slice(1) : "");
}

export async function prepareCheckout(orgId: string, input: PrepareCheckoutInput) {
  const method = railOf(input.method);
  const { readiness, provider } = await requirePaymentsReady(orgId, { rail: method });
  const baseAmount = Math.max(0, cents(input.amount_cents));
  if (baseAmount <= 0) throw badRequest("invalid_payment_amount", "Payment amount must be greater than zero.");
  const existing = cleanText(input.checkout_id) ? await readCheckout(orgId, cleanText(input.checkout_id)) : null;
  if (existing && cleanText(existing.provider_intent_id)) return { checkout: existing, view: checkoutView(existing, readiness), provider };
  let surchargeCents = 0;
  if (input.apply_surcharge !== false) {
    const quote = await surchargeQuote(orgId, provider, { amount_cents: baseAmount, method, branch_id: cleanText(input.branch_id) || "default" });
    surchargeCents = quote.surcharge_cents;
  }
  const suffix = cleanText(input.checkout_id).replace(/^checkout_/, "") || generatedId("x").slice(2);
  const checkoutId = `checkout_${suffix}`;
  const paymentId = `payment_${suffix}`;
  const now = nowIso();
  let checkout: JsonObject = {
    id: checkoutId,
    organization_id: orgId,
    payment_id: paymentId,
    status: "open" satisfies CheckoutStatus,
    provider: provider.provider,
    channel: input.channel,
    initiated_by: input.initiated_by === "merchant" ? "merchant" : "customer",
    scheduled: input.scheduled === true,
    method,
    base_amount_cents: baseAmount,
    surcharge_cents: surchargeCents,
    amount_cents: baseAmount + surchargeCents,
    currency: "USD",
    project_id: cleanText(input.project_id),
    branch_id: cleanText(input.branch_id) || "default",
    contact_ref: asObject(input.contact_ref),
    invoice_id: cleanText(input.invoice_id),
    description: cleanText(input.description).slice(0, 255),
    ...(Number.isFinite(Number(input.tax_cents)) ? { tax_cents: Math.max(0, cents(input.tax_cents)) } : {}),
    ship_to_zip: (cleanText(input.ship_to_zip) || await projectZip(orgId, cleanText(input.project_id))).slice(0, 10),
    context: asObject(input.context),
    attempts: 0,
    created_at: now,
    // An unpaid browser checkout is abandoned after a day.
    expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString()
  };
  checkout = await saveCheckout(orgId, checkout);
  const intent = await provider.createPaymentIntent({
    amount_cents: cents(checkout.amount_cents),
    currency: "USD",
    reference_id: paymentId,
    payment_method_types: [method],
    description: cleanText(checkout.description) || undefined,
    order_details: orderDetailsFor(checkout),
    user_fields: {
      payment_id: paymentId,
      checkout_id: checkoutId,
      organization_id: orgId,
      ...(cleanText(checkout.project_id) ? { project_id: cleanText(checkout.project_id) } : {})
    },
    idempotency_key: forwardIdempotencyKey("fm-pi", checkoutId)
  }).catch((error) => { throw providerFailure(error, "The payment could not be started."); });
  checkout = await saveCheckout(orgId, {
    ...checkout,
    provider_intent_id: intent.id,
    client_secret: intent.client_secret
  });
  return { checkout, view: checkoutView(checkout, readiness), provider };
}

/** What staff (and support) see of a checkout, including declined attempts. */
export async function checkoutStatusView(orgId: string, checkoutId: string) {
  const checkout = await readCheckout(orgId, checkoutId);
  if (!checkout || cleanText(checkout.organization_id) !== orgId) throw notFound("checkout_not_found", "That payment attempt was not found.");
  return {
    id: cleanText(checkout.id),
    status: cleanText(checkout.status),
    channel: cleanText(checkout.channel),
    method: cleanText(checkout.method),
    amount_cents: cents(checkout.amount_cents),
    payment_id: cleanText(checkout.payment_id),
    recorded_payment_id: cleanText(checkout.recorded_payment_id),
    provider: cleanText(checkout.provider),
    provider_intent_id: cleanText(checkout.provider_intent_id),
    provider_payment_id: cleanText(checkout.provider_payment_id),
    last_provider_payment_id: cleanText(checkout.last_provider_payment_id),
    payment_method_id: cleanText(checkout.payment_method_id),
    initiated_by: cleanText(checkout.initiated_by),
    scheduled: checkout.scheduled === true,
    attempts: cents(checkout.attempts),
    last_error: cleanText(checkout.last_error),
    last_decline_category: cleanText(checkout.last_decline_category),
    created_at: cleanText(checkout.created_at),
    updated_at: cleanText(checkout.updated_at)
  };
}

/** A checkout the browser prepared, checked against what is now being paid. */
export async function openCheckoutFor(orgId: string, checkoutId: string, expected: { project_id?: string; amount_cents?: number; method?: string; context?: JsonObject } = {}) {
  const checkout = await readCheckout(orgId, checkoutId);
  if (!checkout || cleanText(checkout.organization_id) !== orgId) throw notFound("checkout_not_found", "This payment form expired. Start the payment again.");
  if (expected.project_id !== undefined && cleanText(checkout.project_id) !== cleanText(expected.project_id)) {
    throw badRequest("checkout_mismatch", "This payment form belongs to a different job. Start the payment again.");
  }
  if (expected.amount_cents !== undefined && cents(checkout.base_amount_cents) !== cents(expected.amount_cents)) {
    throw badRequest("checkout_amount_changed", "The payment amount changed. Review the amount and pay again.", { expected_amount_cents: cents(checkout.base_amount_cents) });
  }
  if (expected.method && railOf(expected.method) !== railOf(checkout.method)) {
    throw badRequest("checkout_method_changed", "The payment method changed. Start the payment again.");
  }
  for (const [key, value] of Object.entries(asObject(expected.context))) {
    if (value !== undefined && cleanText(asObject(checkout.context)[key]) !== cleanText(value)) {
      throw badRequest("checkout_mismatch", "This payment form belongs to a different request. Start the payment again.");
    }
  }
  return checkout;
}

const DECLINE_MESSAGES: Record<string, string> = {
  generic_decline: "The card was declined. Try a different payment method.",
  cvv_failure: "The security code did not match. Check the CVC and try again.",
  avs_failure: "The billing address could not be verified. Check the ZIP code and try again.",
  insufficient_funds: "The card has insufficient funds. Try a different payment method.",
  expired_card: "The card has expired. Use a different card."
};

export function declineMessage(category: string, providerText = "") {
  const known = DECLINE_MESSAGES[cleanText(category)];
  if (known) return known;
  const text = cleanText(providerText).replace(/\.$/, "");
  return text
    ? `${text}. Try a different payment method.`
    : "The payment was declined. Try a different payment method.";
}

/**
 * Processor errors become answers a person can act on. 4xx: the request
 * itself was refused (nothing was charged). An unknown outcome is reported as
 * such so nobody pays twice.
 */
export function providerFailure(error: unknown, fallback: string) {
  if (error instanceof PlatformError) return error;
  if (error instanceof ForwardApiError) {
    if (error.outcomeUnknown) {
      return new PlatformError("payment_outcome_unknown", 502, "We could not confirm this payment with the processor. Do not pay again. It will update here as soon as the processor answers.");
    }
    if (error.status === 402 || error.status === 422) {
      return badRequest("payment_declined", declineMessage(cleanText(error.body.code), error.message), { decline_category: cleanText(error.body.code) });
    }
    if (error.status === 401 || error.status === 403) {
      return new PlatformError("processor_unavailable", 503, "Online payments are not available right now. No payment was taken.");
    }
    if (error.status === 409) {
      return conflict("payment_in_progress", "This payment is already being processed. Refresh before trying again.");
    }
    if (error.status > 0 && error.status < 500) {
      return badRequest("payment_failed", `${cleanText(error.message) || fallback} No payment was taken.`, { provider_status: error.status, provider_code: cleanText(error.body.code) });
    }
    return new PlatformError("processor_unavailable", 503, `${fallback} No payment was taken. Try again in a moment.`);
  }
  return error instanceof Error ? error : new Error(fallback);
}

export type ProviderChargeInput = {
  amount_cents: number;
  payment_method_id?: string;
  saved_method_id?: string;
  method?: string;
  project_id?: string;
  branch_id?: string;
  apply_surcharge?: boolean;
  /** A checkout the browser element already prepared. */
  checkout_id?: string;
  channel?: CheckoutChannel;
  initiated_by?: "customer" | "merchant";
  scheduled?: boolean;
  billing_details?: JsonObject;
  invoice_id?: string;
  tax_cents?: number;
  ship_to_zip?: string;
  description?: string;
  checkout_context?: JsonObject;
};

export type ProviderChargeResult = {
  payment_id: string;
  checkout_id: string;
  intent_id: string;
  provider_payment_id: string;
  amount_cents: number;
  base_amount_cents: number;
  surcharge_cents: number;
  fee_cents: number;
  merchant_amount_cents: number;
  auth_code: string;
  /** A bank debit that has not cleared yet. */
  pending: boolean;
  rail: "card" | "bank";
  saved_method: JsonObject | null;
};

function chargeResult(checkout: JsonObject, charge: ProviderPayment, savedMethod: JsonObject | null): ProviderChargeResult {
  const raw = asObject(charge.raw);
  const fee = Math.max(0, cents(raw.fee ?? raw.fee_cents));
  const total = cents(checkout.amount_cents);
  const merchantAmount = cents(raw.merchant_amount ?? raw.merchant_amount_cents) || Math.max(0, total - fee);
  return {
    payment_id: cleanText(checkout.payment_id),
    checkout_id: cleanText(checkout.id),
    intent_id: cleanText(checkout.provider_intent_id),
    provider_payment_id: charge.id,
    amount_cents: total,
    base_amount_cents: cents(checkout.base_amount_cents),
    surcharge_cents: cents(checkout.surcharge_cents),
    fee_cents: fee,
    merchant_amount_cents: merchantAmount,
    auth_code: charge.auth_code,
    pending: charge.status !== "captured" && charge.status !== "settled",
    rail: charge.rail,
    saved_method: savedMethod
  };
}

const SUCCEEDED_PAYMENT = new Set(["captured", "settled", "pending", "processing", "authorized"]);
const FAILED_PAYMENT = new Set(["failed", "rejected", "cancelled", "voided"]);

/**
 * Charges an open checkout once. The checkout is claimed (status
 * "processing") before the processor is called; every attempt sends the
 * same key, so a retry after a lost answer is the same request. A decline
 * leaves the checkout open for another card; an unanswered charge is looked
 * up before anyone may try again.
 */
async function chargeCheckout(orgId: string, provider: PaymentProviderAdapter, checkoutInput: JsonObject, input: { token: string; savedMethod: JsonObject | null; billing_details?: JsonObject }) {
  let checkout = (await readCheckout(orgId, cleanText(checkoutInput.id))) ?? checkoutInput;
  const status = cleanText(checkout.status);
  if (status === "succeeded") throw conflict("payment_already_completed", "This payment already went through.", { payment_id: cleanText(checkout.payment_id) });
  if (status === "cancelled") throw badRequest("checkout_cancelled", "This payment was cancelled. Start the payment again.");
  if (status === "unknown") {
    const settled = await reconcileCheckout(orgId, provider, checkout);
    if (settled) return { checkout: settled.checkout, charge: settled.charge };
    throw providerFailure(new ForwardApiError(0, {}, "", { outcomeUnknown: true }), "");
  }
  if (status === "processing" && Date.now() - Date.parse(cleanText(checkout.updated_at)) < 120_000) {
    throw conflict("payment_in_progress", "This payment is already being processed. Refresh before trying again.");
  }
  if (cleanText(checkout.provider) !== provider.provider) throw badRequest("checkout_provider_changed", "The payment setup changed. Start the payment again.");
  const attempt = cents(checkout.attempts) + 1;
  checkout = await saveCheckout(orgId, { ...checkout, status: "processing", attempts: attempt, payment_method_id: input.token });
  let charge: ProviderPayment;
  try {
    charge = await provider.createPayment(cleanText(checkout.provider_intent_id), {
      payment_method_id: input.token,
      ...(input.billing_details && Object.keys(input.billing_details).length ? { billing_details: input.billing_details } : {}),
      order_details: orderDetailsFor(checkout),
      reference_id: cleanText(checkout.payment_id),
      idempotency_key: forwardIdempotencyKey("fm-pay", checkout.id, attempt)
    });
  } catch (error) {
    if (error instanceof ForwardApiError && error.outcomeUnknown) {
      checkout = await saveCheckout(orgId, { ...checkout, status: "unknown", last_error: cleanText(error.message) });
      const settled = await reconcileCheckout(orgId, provider, checkout).catch(() => null);
      if (settled) return { checkout: settled.checkout, charge: settled.charge };
      throw providerFailure(error, "The payment could not be completed.");
    }
    await saveCheckout(orgId, { ...checkout, status: "open", last_error: cleanText((error as Error)?.message) });
    throw providerFailure(error, "The payment could not be completed.");
  }
  if (FAILED_PAYMENT.has(charge.status) || (cleanText(charge.decline_reason) && !SUCCEEDED_PAYMENT.has(charge.status))) {
    const category = cleanText(charge.decline_reason) || "generic_decline";
    const message = declineMessage(category, charge.decline_text);
    await saveCheckout(orgId, { ...checkout, status: "open", last_error: message, last_decline_category: category, last_provider_payment_id: charge.id });
    throw badRequest("payment_declined", message, { decline_category: category, message, provider_payment_id: charge.id });
  }
  checkout = await saveCheckout(orgId, {
    ...checkout,
    status: "succeeded",
    provider_payment_id: charge.id,
    provider_payment_status: charge.status,
    rail: charge.rail,
    last_error: ""
  });
  return { checkout, charge };
}

/**
 * Looks a checkout's charge up at the processor (the answer was lost). A
 * charge that went through closes the checkout as succeeded; one that was
 * declined reopens it; no attempt at all reopens it too.
 */
export async function reconcileCheckout(orgId: string, provider: PaymentProviderAdapter, checkout: JsonObject) {
  const intentId = cleanText(checkout.provider_intent_id);
  if (!intentId) return null;
  const intent = await provider.getPaymentIntent(intentId);
  const latest = intent.latest_payment;
  if (latest && SUCCEEDED_PAYMENT.has(latest.status)) {
    const saved = await saveCheckout(orgId, {
      ...checkout,
      status: "succeeded",
      provider_payment_id: latest.id,
      provider_payment_status: latest.status,
      rail: latest.rail,
      reconciled_at: nowIso()
    });
    return { checkout: saved, charge: latest };
  }
  if (!latest || FAILED_PAYMENT.has(latest.status)) {
    await saveCheckout(orgId, { ...checkout, status: "open", reconciled_at: nowIso() });
  }
  return null;
}

/**
 * The mock provider emits v2.payment.created/captured synchronously during
 * the charge — before our transaction exists — so the webhook handler writes
 * an unmatched shadow record. Once the real transaction is persisted with the
 * provider payment id, the shadow is redundant; remove it.
 */
const providerShadowId = (providerPaymentId: string) => `payment_provider_${cleanText(providerPaymentId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 120)}`;

/**
 * The first thing written once the processor has taken money: a record of the
 * charge with everything known about it, in the same unmatched-settlement
 * shape the processor's own notification writes. It is written directly, with
 * no feature gate, allocation or ledger step that could refuse it, so a
 * charge is on our books before any bookkeeping is attempted. The full
 * payment replaces it; if that never happens it stays in the unmatched
 * settlements queue, attributed as well as we could, for someone to finish.
 */
export async function recordProviderChargeSafely(orgId: string, provider: string, charge: ProviderChargeResult, input: IntakeChargePaymentInput, problem = "") {
  const id = providerShadowId(charge.provider_payment_id || charge.payment_id);
  const now = new Date().toISOString();
  const existing = asObject(asObject(await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, id).catch(() => null)).data);
  const intended = asObject(input.payment);
  const projectId = cleanText(input.project_id);
  const data: JsonObject = {
    ...existing,
    id,
    organization_id: orgId,
    direction: "inbound",
    kind: "provider_payment",
    status: "pending",
    provider_status: "succeeded",
    amount_cents: charge.amount_cents,
    currency: cleanText(intended.currency || existing.currency || "USD").toUpperCase(),
    provider,
    fee_cents: charge.fee_cents,
    merchant_amount_cents: charge.merchant_amount_cents,
    project_id: projectId,
    ...(cleanText(input.branch_id) ? { branch_id: cleanText(input.branch_id) } : {}),
    contact_ref: asObject(input.contact_ref),
    processor: {
      ...asObject(existing.processor),
      provider,
      provider_payment_id: charge.provider_payment_id,
      provider_intent_id: charge.intent_id,
      ...(charge.auth_code ? { auth_code: charge.auth_code } : {})
    },
    metadata: {
      ...asObject(existing.metadata),
      ...asObject(intended.metadata),
      provider_unmatched: true,
      // What the full payment record was going to be, for whoever finishes it.
      charged_by: "intake",
      intended_payment_id: charge.payment_id,
      checkout_id: charge.checkout_id,
      ...(cleanText(intended.obligation_id) ? { intended_obligation_id: cleanText(intended.obligation_id) } : {}),
      ...(cleanText(intended.kind) ? { intended_kind: cleanText(intended.kind) } : {}),
      ...(problem ? { record_error: problem.slice(0, 500), needs_review: true } : {})
    },
    created_at: cleanText(existing.created_at) || now,
    updated_at: now
  };
  await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
    id, data, metadata: { kind: "payment_transaction", project_id: projectId, direction: "inbound", payment_kind: "provider_payment", status: "pending" }
  }, { replace: true });
  return data;
}

export async function removeProviderShadowRecord(orgId: string, providerPaymentId: string) {
  const normalized = cleanText(providerPaymentId).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 120);
  if (!normalized) return;
  await deleteDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, `payment_provider_${normalized}`).catch(() => null);
}

export type IntakeChargePaymentInput = JsonObject & ProviderChargeInput & {
  save_payment_method?: boolean;
  contact_ref?: JsonObject;
  method_label?: string;
};

/** The parts of a charge request the payment record is built from (no card data). */
function recordInputOf(input: IntakeChargePaymentInput): JsonObject {
  return {
    project_id: cleanText(input.project_id),
    branch_id: cleanText(input.branch_id),
    contact_ref: asObject(input.contact_ref),
    method_label: cleanText(input.method_label),
    method_descriptor: asObject(input.method_descriptor),
    save_payment_method: input.save_payment_method === true,
    payment: asObject(input.payment)
  };
}

/**
 * Full provider-backed intake flow used by every place a customer pays: the
 * staff payments route, the customer portal and document checkout, the
 * field crew and autopay. It refuses unless the organization can take
 * payments, charges the checkout (the browser's, or one opened here for a
 * saved method), then writes the payment_transactions record through the
 * EXISTING createPayment / allocation / ledger path.
 */
export async function recordProviderChargedPayment(
  orgId: string,
  _provider: PaymentProviderAdapter | null,
  input: IntakeChargePaymentInput,
  ctx: PlatformAuthContext
) {
  let token = cleanText(input.payment_method_id);
  let savedMethod: JsonObject | null = null;
  if (!token && cleanText(input.saved_method_id)) {
    savedMethod = await findSavedMethod(orgId, cleanText(input.saved_method_id));
    if (!savedMethod) throw badRequest("saved_method_not_found", "That saved payment method is no longer available.");
    token = cleanText(savedMethod.provider_payment_method_id);
  }
  if (!token) throw badRequest("payment_method_required", "Enter the payment details to continue.");
  const method = savedMethod ? (cleanText(savedMethod.type) === "bank" ? "bank" : "card") : railOf(input.method);
  if (!cleanText(input.checkout_id) && !savedMethod) {
    // A Forward token comes from the browser element, which only mounts on a
    // prepared checkout; a bare token did not come from Forward's fields.
    const readiness = await paymentsReadiness(orgId);
    if (readiness.ready && readiness.provider === "forward") throw badRequest("checkout_required", "Open the payment form again to pay.");
  }
  let checkout: JsonObject;
  let provider: PaymentProviderAdapter;
  if (cleanText(input.checkout_id)) {
    checkout = await openCheckoutFor(orgId, cleanText(input.checkout_id), {
      project_id: input.project_id !== undefined ? cleanText(input.project_id) : undefined,
      amount_cents: Math.max(0, cents(input.amount_cents)),
      method,
      context: input.checkout_context
    });
    ({ provider } = await requirePaymentsReady(orgId, { rail: method }));
  } else {
    const prepared = await prepareCheckout(orgId, {
      amount_cents: cents(input.amount_cents),
      method,
      channel: input.channel || "staff",
      initiated_by: input.initiated_by,
      scheduled: input.scheduled,
      apply_surcharge: input.apply_surcharge,
      project_id: cleanText(input.project_id),
      branch_id: cleanText(input.branch_id),
      contact_ref: asObject(input.contact_ref),
      invoice_id: cleanText(input.invoice_id),
      description: cleanText(input.description),
      tax_cents: input.tax_cents,
      ship_to_zip: cleanText(input.ship_to_zip),
      context: asObject(input.checkout_context)
    });
    checkout = prepared.checkout;
    provider = prepared.provider;
  }
  await saveCheckout(orgId, { ...checkout, record_input: recordInputOf(input) });
  const { checkout: charged, charge } = await chargeCheckout(orgId, provider, checkout, { token, savedMethod, billing_details: asObject(input.billing_details) });
  return finishChargedPayment(orgId, provider, charged, charge, input, savedMethod, token, ctx);
}

/**
 * Turns a charge the processor accepted into our payment record. Card
 * payments are settled; a bank debit stays pending until it clears.
 */
async function finishChargedPayment(
  orgId: string,
  provider: PaymentProviderAdapter,
  checkout: JsonObject,
  providerCharge: ProviderPayment,
  input: IntakeChargePaymentInput,
  savedMethod: JsonObject | null,
  token: string,
  ctx: PlatformAuthContext
) {
  const charge = chargeResult(checkout, providerCharge, savedMethod);
  // Money has moved. From here nothing may leave it unrecorded, and nothing
  // may report this payment as failed: a customer told it failed pays twice.
  let safety: JsonObject | null = await recordProviderChargeSafely(orgId, provider.provider, charge, input).catch(error => {
    console.error("[payments] could not write the charge safety record", { orgId, provider_payment_id: charge.provider_payment_id, payment_id: charge.payment_id, amount_cents: charge.amount_cents, error: String((error as Error)?.message || error) });
    return null;
  });
  let methodDescriptor: JsonObject = asObject(input.method_descriptor);
  if (savedMethod) {
    // The stored method is authoritative for the descriptor.
    methodDescriptor = {
      ...methodDescriptor,
      type: savedMethod.type === "bank" ? "saved_ach" : "saved_card",
      label: cleanText(savedMethod.label),
      brand: cleanText(savedMethod.brand),
      last4: cleanText(savedMethod.last4)
    };
  } else if (charge.provider_payment_id) {
    const details = await provider.getPaymentMethod(token).catch(() => null);
    if (details) {
      methodDescriptor = {
        ...methodDescriptor,
        type: details.type === "card" ? "card" : "ach",
        label: `${brandLabel(details.brand) || (details.type === "card" ? "Card" : "Bank")} ending in ${details.last4}`,
        brand: brandLabel(details.brand),
        last4: details.last4
      };
    }
  }
  const payment = asObject(input.payment);
  let result: Awaited<ReturnType<typeof createPayment>>;
  try {
    result = await createPayment(orgId, {
      ...payment,
      id: charge.payment_id,
      direction: "inbound",
      status: charge.pending ? "pending" : "settled",
      amount_cents: charge.amount_cents,
      project_id: cleanText(input.project_id),
      ...(cleanText(input.branch_id) ? { branch_id: cleanText(input.branch_id) } : {}),
      contact_ref: asObject(input.contact_ref),
      method: methodDescriptor,
      provider: provider.provider,
      fee_cents: charge.fee_cents,
      merchant_amount_cents: charge.merchant_amount_cents,
      processor: {
        provider: provider.provider,
        provider_payment_id: charge.provider_payment_id,
        provider_intent_id: charge.intent_id,
        checkout_id: charge.checkout_id,
        rail: charge.rail,
        ...(charge.auth_code ? { auth_code: charge.auth_code } : {})
      },
      metadata: {
        ...asObject(payment.metadata),
        checkout_id: charge.checkout_id,
        // A pending bank debit is applied when it clears (settlePendingPayment).
        ...(charge.pending ? {
          awaiting_clearance: true,
          ...(cleanText(payment.obligation_id) ? { intended_obligation_id: cleanText(payment.obligation_id) } : {}),
          ...(payment.allocation_mode ? { allocation_mode: cleanText(payment.allocation_mode) } : {}),
          ...(Array.isArray(payment.allocation_obligation_ids) ? { allocation_obligation_ids: payment.allocation_obligation_ids } : {}),
          ...(payment.allocate === false ? { allocate: false } : {})
        } : {}),
        ...(charge.surcharge_cents > 0 ? {
          surcharge_cents: charge.surcharge_cents,
          base_amount_cents: charge.base_amount_cents
        } : {})
      },
      ...(cleanText(payment.obligation_id) ? { obligation_id: cleanText(payment.obligation_id) } : {}),
      ...(payment.allocation_mode ? { allocation_mode: cleanText(payment.allocation_mode) } : {}),
      ...(cleanText(payment.kind) ? { kind: cleanText(payment.kind) } : {}),
      ...(cleanText(payment.notes) ? { notes: cleanText(payment.notes) } : {})
    }, ctx);
  } catch (error) {
    // The card was charged and the full payment record could not be written
    // (a disabled feature, an allocation rule, storage). The charge stays on
    // the books as an unmatched settlement that says why, and the caller is
    // told the payment went through, because it did.
    const problem = String((error as Error)?.message || error);
    console.error("[payments] charged but the payment record failed; kept as an unmatched settlement", { orgId, provider_payment_id: charge.provider_payment_id, payment_id: charge.payment_id, amount_cents: charge.amount_cents, error: problem });
    safety = await recordProviderChargeSafely(orgId, provider.provider, charge, input, problem).catch(() => safety);
    if (!safety) throw Object.assign(new Error("Your payment went through, but we could not save it. Please do not pay again; contact us and mention this message."), { statusCode: 500, code: "payment_charged_unrecorded", details: { provider_payment_id: charge.provider_payment_id, amount_cents: charge.amount_cents } });
    return { payment: { ...safety, needs_review: true }, charge, saved_method: savedMethod, needs_review: true } as unknown as Awaited<ReturnType<typeof createPayment>> & { charge: ProviderChargeResult; saved_method: JsonObject | null };
  }
  await removeProviderShadowRecord(orgId, charge.provider_payment_id);
  await saveCheckout(orgId, { ...checkout, recorded_payment_id: charge.payment_id, recorded_at: nowIso() }).catch(() => null);
  let saved: JsonObject | null = savedMethod;
  if (!savedMethod && input.save_payment_method === true && token) {
    const contactRef = normalizeContactRef(input.contact_ref);
    if (contactRef) {
      const details = await provider.getPaymentMethod(token).catch(() => null);
      saved = await createSavedMethod(orgId, contactRef, {
        provider: provider.provider,
        provider_payment_method_id: token,
        type: details?.type === "card" ? "card" : details ? "bank" : "card",
        brand: details?.brand,
        last4: details?.last4,
        exp_month: details?.exp_month ?? null,
        exp_year: details?.exp_year ?? null
      }).catch(() => null);
    }
  }
  return { ...result, charge, saved_method: saved };
}

/**
 * Finishes a checkout whose charge succeeded at the processor but whose
 * answer never reached us (the processor's notification or a lookup found
 * it). Writes the payment record exactly once.
 */
export async function finishCheckoutFromProvider(orgId: string, checkoutId: string) {
  let checkout = await readCheckout(orgId, checkoutId);
  if (!checkout || cleanText(checkout.recorded_payment_id)) return null;
  const existing = await readDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, cleanText(checkout.payment_id)).catch(() => null);
  if (existing) return null;
  if (!["unknown", "succeeded"].includes(cleanText(checkout.status))) return null;
  const provider = cleanText(checkout.provider) === "mock" ? createMockAdapter(orgId) : createForwardAdapter({ accountId: (await paymentsReadiness(orgId)).account_id });
  let charge: ProviderPayment | null = null;
  if (cleanText(checkout.status) === "unknown") {
    const settled = await reconcileCheckout(orgId, provider, checkout);
    if (!settled) return null;
    checkout = settled.checkout;
    charge = settled.charge;
  } else {
    charge = await provider.getPayment(cleanText(checkout.provider_payment_id));
  }
  const recordInput = asObject(checkout.record_input);
  const ctx = { ...PROVIDER_WEBHOOK_CTX, branchId: cleanText(checkout.branch_id) || "default" } as PlatformAuthContext;
  return finishChargedPayment(orgId, provider, checkout, charge, {
    ...recordInput,
    amount_cents: cents(checkout.base_amount_cents),
    checkout_id: cleanText(checkout.id)
  } as IntakeChargePaymentInput, null, cleanText(checkout.payment_method_id), ctx);
}

/** Convenience: resolved provider + merchant config (or nulls when unwired). */
export async function resolveIntakeProvider(orgId: string) {
  const readiness = await paymentsReadiness(orgId).catch(() => null);
  if (!readiness?.ready) return { provider: null, config: null };
  const { provider } = await requirePaymentsReady(orgId);
  const config = await getMerchantConfig(orgId).catch(() => null);
  return { provider, config };
}
