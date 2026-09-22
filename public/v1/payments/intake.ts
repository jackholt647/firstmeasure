import { randomBytes } from "node:crypto";

import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import {
  deleteDocument,
  listDocuments,
  readDocument,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { getInvoicePaymentSettings } from "./invoices.js";
import { getMerchantConfig } from "./merchant_config.js";
import { getPaymentProvider, type PaymentProviderAdapter } from "./providers/index.js";
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

export const FORWARD_SDK_URL = "https://sandbox-cdn.pci.getfwd.com/sdk/forward.js";

/**
 * Everything a payment-intake mount needs to decide between the legacy
 * mock-record flow and provider tokenization: null provider means "behave
 * exactly as before". Saved methods are returned in the modal's shape.
 */
export async function paymentIntakeConfig(orgId: string, contactRefValue: unknown, branchId = "default") {
  const provider = await getPaymentProvider(orgId).catch(() => null);
  if (!provider) return { provider: null as string | null, tokenization: null, surcharge: null, saved_methods: [] as JsonObject[] };
  const [settings, savedMethods] = await Promise.all([
    surchargeSettings(orgId, branchId),
    listSavedMethods(orgId, contactRefValue)
  ]);
  return {
    provider: provider.provider,
    tokenization: {
      mode: provider.provider === "mock" ? "mock" : "forward",
      ...(provider.provider !== "mock" ? { sdk_url: FORWARD_SDK_URL } : {})
    },
    surcharge: settings,
    saved_methods: savedMethods.map((method) => ({
      ...method,
      // Modal-friendly aliases (the intake modal filters on card|ach).
      type: method.type === "bank" ? "ach" : "card",
      detail: method.type === "bank" ? "Bank account on file" : "Card on file"
    }))
  };
}

// --- Provider charge path ----------------------------------------------------

const DECLINE_MESSAGES: Record<string, string> = {
  generic_decline: "The card was declined. Try a different payment method.",
  cvv_failure: "The security code did not match. Check the CVC and try again.",
  avs_failure: "The billing address could not be verified. Check the ZIP code and try again.",
  insufficient_funds: "The card has insufficient funds. Try a different payment method.",
  expired_card: "The card has expired. Use a different card."
};

export function declineMessage(category: string) {
  return DECLINE_MESSAGES[cleanText(category)] || "The payment was declined. Try a different payment method.";
}

export type ProviderChargeInput = {
  amount_cents: number;
  payment_method_id?: string;
  saved_method_id?: string;
  method?: string;
  project_id?: string;
  branch_id?: string;
  apply_surcharge?: boolean;
};

export type ProviderChargeResult = {
  payment_id: string;
  intent_id: string;
  provider_payment_id: string;
  amount_cents: number;
  base_amount_cents: number;
  surcharge_cents: number;
  fee_cents: number;
  merchant_amount_cents: number;
  auth_code: string;
  saved_method: JsonObject | null;
};

/**
 * Charges through the provider adapter ahead of writing our transaction:
 * quote surcharge -> create intent (reference_id = the payment id we will
 * write) -> charge. A decline throws a structured `payment_declined` error
 * (details: {decline_category}) and leaves NO transaction behind — the mock's
 * v2.payment.failed event neither matches nor creates shadow records. On
 * capture the caller writes the payment_transactions record with the fee
 * fields from the charge, then removeProviderShadowRecord clears the
 * unmatched-event shadow the synchronous mock events created before our
 * record existed. Later webhook projections (settlement, payouts) find the
 * real record by processor.provider_payment_id, so nothing double-writes.
 */
export async function chargeThroughProvider(
  orgId: string,
  provider: PaymentProviderAdapter,
  input: ProviderChargeInput
): Promise<ProviderChargeResult> {
  const baseAmount = Math.max(0, cents(input.amount_cents));
  if (baseAmount <= 0) throw badRequest("invalid_payment_amount", "Payment amount must be greater than zero.");
  let token = cleanText(input.payment_method_id);
  let savedMethod: JsonObject | null = null;
  if (!token && cleanText(input.saved_method_id)) {
    savedMethod = await findSavedMethod(orgId, cleanText(input.saved_method_id));
    if (!savedMethod) throw badRequest("saved_method_not_found", "That saved payment method is no longer available.");
    token = cleanText(savedMethod.provider_payment_method_id);
  }
  if (!token) throw badRequest("payment_method_required", "A payment method token is required to charge through the processor.");
  const method = cleanText(input.method).toLowerCase() === "ach" || cleanText(input.method).toLowerCase() === "bank"
    || cleanText(savedMethod?.type) === "bank" ? "bank" : "card";
  let surchargeCents = 0;
  if (input.apply_surcharge !== false) {
    const quote = await surchargeQuote(orgId, provider, {
      amount_cents: baseAmount,
      method,
      branch_id: cleanText(input.branch_id) || "default"
    });
    surchargeCents = quote.surcharge_cents;
  }
  const totalCents = baseAmount + surchargeCents;
  const paymentId = generatedId("payment");
  const intent = await provider.createPaymentIntent({
    amount_cents: totalCents,
    reference_id: paymentId,
    user_fields: {
      payment_id: paymentId,
      ...(cleanText(input.project_id) ? { project_id: cleanText(input.project_id) } : {})
    }
  });
  const charge = await provider.createPayment(intent.id, { payment_method_id: token });
  if (charge.status === "failed" || cleanText(charge.decline_reason)) {
    const category = cleanText(charge.decline_reason) || "generic_decline";
    throw badRequest("payment_declined", declineMessage(category), {
      decline_category: category,
      message: declineMessage(category)
    });
  }
  const raw = asObject(charge.raw);
  const fee = Math.max(0, cents(raw.fee ?? raw.fee_cents));
  const merchantAmount = cents(raw.merchant_amount ?? raw.merchant_amount_cents) || Math.max(0, totalCents - fee);
  return {
    payment_id: paymentId,
    intent_id: intent.id,
    provider_payment_id: charge.id,
    amount_cents: totalCents,
    base_amount_cents: baseAmount,
    surcharge_cents: surchargeCents,
    fee_cents: fee,
    merchant_amount_cents: merchantAmount,
    auth_code: charge.auth_code,
    saved_method: savedMethod
  };
}

/**
 * The mock provider emits v2.payment.created/captured synchronously during
 * the charge — before our transaction exists — so the webhook handler writes
 * an unmatched shadow record. Once the real transaction is persisted with the
 * provider payment id, the shadow is redundant; remove it.
 */
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

/**
 * Full provider-backed intake flow used by both the staff payments route and
 * the public portal payment path: charge through the adapter, then write the
 * payment_transactions record through the EXISTING createPayment /
 * allocation / ledger path with the provider fee fields, clean the shadow,
 * and optionally save the method for the contact.
 */
export async function recordProviderChargedPayment(
  orgId: string,
  provider: PaymentProviderAdapter,
  input: IntakeChargePaymentInput,
  ctx: PlatformAuthContext
) {
  const charge = await chargeThroughProvider(orgId, provider, input);
  const savedMethod = charge.saved_method;
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
    const details = await provider.getPaymentMethod(cleanText(input.payment_method_id)).catch(() => null);
    if (details) {
      methodDescriptor = {
        type: details.type === "card" ? "card" : "ach",
        label: cleanText(input.method_label) || `${details.brand} ending in ${details.last4}`,
        brand: details.brand,
        last4: details.last4,
        ...methodDescriptor
      };
    }
  }
  const result = await createPayment(orgId, {
    ...asObject(input.payment),
    id: charge.payment_id,
    direction: "inbound",
    status: "settled",
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
      ...(charge.auth_code ? { auth_code: charge.auth_code } : {})
    },
    metadata: {
      ...asObject(asObject(input.payment).metadata),
      ...(charge.surcharge_cents > 0 ? {
        surcharge_cents: charge.surcharge_cents,
        base_amount_cents: charge.base_amount_cents
      } : {})
    },
    ...(cleanText(asObject(input.payment).obligation_id) ? { obligation_id: cleanText(asObject(input.payment).obligation_id) } : {}),
    ...(asObject(input.payment).allocation_mode ? { allocation_mode: cleanText(asObject(input.payment).allocation_mode) } : {}),
    ...(cleanText(asObject(input.payment).kind) ? { kind: cleanText(asObject(input.payment).kind) } : {}),
    ...(cleanText(asObject(input.payment).notes) ? { notes: cleanText(asObject(input.payment).notes) } : {})
  }, ctx);
  await removeProviderShadowRecord(orgId, charge.provider_payment_id);
  let saved: JsonObject | null = savedMethod;
  if (!savedMethod && input.save_payment_method === true && cleanText(input.payment_method_id)) {
    const contactRef = normalizeContactRef(input.contact_ref);
    if (contactRef) {
      const details = await provider.getPaymentMethod(cleanText(input.payment_method_id)).catch(() => null);
      saved = await createSavedMethod(orgId, contactRef, {
        provider: provider.provider,
        provider_payment_method_id: cleanText(input.payment_method_id),
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

/** Convenience: resolved provider + merchant config (or nulls when unwired). */
export async function resolveIntakeProvider(orgId: string) {
  const provider = await getPaymentProvider(orgId).catch(() => null);
  if (!provider) return { provider: null, config: null };
  const config = await getMerchantConfig(orgId).catch(() => null);
  return { provider, config };
}
