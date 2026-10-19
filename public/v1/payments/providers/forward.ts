import { randomBytes } from "node:crypto";

import { env } from "../../src/config/env.js";
import type {
  ApplicationInput,
  BoardingApplicationStatus,
  CreateBusinessInput,
  CreatePaymentInput,
  CreatePaymentIntentInput,
  CreatePaymentMethodIntentInput,
  CreateRefundInput,
  JsonObject,
  ListOptions,
  MerchantBoardingAdapter,
  PaymentProviderAdapter,
  PortalUserInput,
  ProviderAccount,
  ProviderApplication,
  ProviderApplicationLink,
  ProviderBalance,
  ProviderBankAccount,
  BankAccountListOptions,
  ProviderBusiness,
  ProviderDispute,
  ProviderDisputeStatus,
  ProviderPayment,
  ProviderPaymentIntent,
  ProviderPaymentIntentStatus,
  ProviderPaymentMethod,
  ProviderPaymentMethodIntent,
  ProviderPaymentMethodType,
  ProviderPaymentStatus,
  ProviderPayout,
  ProviderPortalLoginUrl,
  ProviderPortalUser,
  ProviderMcc,
  ProviderPayoutStatus,
  ProviderProcessingPlan,
  ProviderRefund,
  ProviderRefundStatus,
  SurchargeCalculation,
  SurchargeCalculationInput,
  UpdatePaymentMethodInput
} from "./types.js";

export const FORWARD_PROVIDER = "forward";

/** Forward partner id for FirstMate (constant across environments per docs). */
export const FORWARD_PARTNER_ID = "part_3HpmN6yqGUD2C8GvrVx0XBiAXpz";

export class ForwardApiError extends Error {
  readonly status: number;
  readonly body: JsonObject;
  /**
   * True when a write may have reached Forward but no answer came back
   * (network failure, timeout, 5xx after every retry). The caller must look
   * the outcome up before anyone tries the operation again.
   */
  readonly outcomeUnknown: boolean;
  constructor(status: number, body: JsonObject, message?: string, options: { outcomeUnknown?: boolean } = {}) {
    super(message || `Forward API request failed with status ${status}.`);
    this.name = "ForwardApiError";
    this.status = status;
    this.body = body;
    this.outcomeUnknown = options.outcomeUnknown === true;
  }
}

/** Forward's error guidance: 429 and 5xx are safe to retry with the same idempotency key. */
export function forwardStatusRetryable(status: number) {
  return status === 429 || status >= 500;
}

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

function idempotencyKey() {
  // Forward requires at least 10 characters; 1-hour retention.
  return `fm_${Date.now().toString(36)}${randomBytes(8).toString("hex")}`;
}

export type ForwardClientOptions = {
  /** Acts on behalf of a specific merchant account via `x-account-id`. */
  accountId?: string;
  apiBase?: string;
  privateKey?: string;
  timeoutMs?: number;
};

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  body?: JsonObject;
  idempotency?: boolean;
  /** Stable key for the business operation; a fresh one is minted when absent. */
  idempotencyKey?: string;
};

export function forwardConfigured() {
  return Boolean(env.forwardApiBase && env.forwardPrivateKey);
}

/** "sandbox" for a sandbox.getfwd.com API base, "production" otherwise, "" when unconfigured. */
export function forwardEnvironment(): "" | "sandbox" | "production" {
  if (!forwardConfigured()) return "";
  return env.forwardApiBase.includes("sandbox") ? "sandbox" : "production";
}

/**
 * Forward's browser SDK for the environment this deployment talks to. A
 * sandbox key only works with the sandbox SDK and a live key only with the
 * production one, so the URL follows the API base unless set explicitly.
 */
export function forwardSdkUrl() {
  const explicit = cleanText(env.forwardSdkUrl);
  if (explicit) return explicit;
  return forwardEnvironment() === "production"
    ? "https://cdn.pci.getfwd.com/sdk/forward.js"
    : "https://sandbox-cdn.pci.getfwd.com/sdk/forward.js";
}

/** Idempotency keys must be 10+ characters; keep them in Forward's safe alphabet. */
export function forwardIdempotencyKey(...parts: unknown[]) {
  const key = parts.map((part) => cleanText(part)).filter(Boolean).join("-").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 200);
  return key.length >= 10 ? key : `fm-${key}-${"0".repeat(10)}`.slice(0, 200);
}

const RETRY_DELAYS_MS = [400, 1500];

function retryDelay(attempt: number, response?: Response) {
  const header = Number(response?.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 5000);
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 1500;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function forwardRequest(
  options: ForwardClientOptions,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  request: RequestOptions = {}
): Promise<JsonObject> {
  const apiBase = cleanText(options.apiBase || env.forwardApiBase).replace(/\/+$/, "");
  const privateKey = cleanText(options.privateKey || env.forwardPrivateKey);
  if (!apiBase || !privateKey) {
    throw new ForwardApiError(0, {}, "Forward is not configured: FORWARD_API_BASE and FORWARD_PRIVATE_KEY are required.");
  }
  const url = new URL(`${apiBase}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    "x-api-key": privateKey,
    Accept: "application/json"
  };
  if (cleanText(options.accountId)) headers["x-account-id"] = cleanText(options.accountId);
  // One key for every attempt of this call: a retry after a lost response is
  // the same request to Forward, never a second charge or refund.
  const idempotent = request.idempotency !== false && method !== "GET";
  if (idempotent) headers["x-idempotency-key"] = cleanText(request.idempotencyKey) || idempotencyKey();
  if (request.body !== undefined) headers["Content-Type"] = "application/json";

  const timeoutMs = options.timeoutMs || env.forwardRequestTimeoutMs;
  // Without a key a write cannot be repeated safely, so it gets one attempt.
  const maxAttempts = method === "GET" || idempotent ? RETRY_DELAYS_MS.length + 1 : 1;
  let response: Response | null = null;
  let networkError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    networkError = null;
    try {
      response = await fetch(url, {
        method,
        headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      networkError = error;
      response = null;
    }
    const retryable = networkError !== null || (response !== null && forwardStatusRetryable(response.status));
    if (!retryable || attempt === maxAttempts - 1) break;
    await sleep(retryDelay(attempt, response ?? undefined));
  }
  if (!response) {
    const timedOut = (networkError as { name?: string })?.name === "TimeoutError";
    throw new ForwardApiError(0, { network_error: String((networkError as Error)?.message || networkError) },
      timedOut ? "Forward did not respond in time." : "Forward could not be reached.",
      { outcomeUnknown: method !== "GET" });
  }
  const text = await response.text();
  let parsed: JsonObject = {};
  try {
    parsed = text ? asObject(JSON.parse(text)) : {};
  } catch {
    parsed = { raw_text: text };
  }
  if (!response.ok) {
    // Forward error shape (live-verified): { type, code, argument_errors?,
    // message } — surface field-level validation details in the message.
    const argumentErrors = asObject(parsed.argument_errors);
    const details = Object.entries(argumentErrors).map(([field, issue]) => `${field}: ${cleanText(issue)}`).join("; ");
    const message = [cleanText(parsed.message || parsed.error), details].filter(Boolean).join(" — ");
    throw new ForwardApiError(response.status, parsed, message || undefined, {
      outcomeUnknown: method !== "GET" && forwardStatusRetryable(response.status)
    });
  }
  return parsed;
}

// --- Response mappers -------------------------------------------------------

function intentStatus(value: unknown): ProviderPaymentIntentStatus {
  const status = cleanText(value).toLowerCase();
  const known: ProviderPaymentIntentStatus[] = ["created", "processing", "pending", "uncaptured", "captured", "cancelled", "failed"];
  return (known as string[]).includes(status) ? status as ProviderPaymentIntentStatus : "created";
}

function paymentStatus(value: unknown): ProviderPaymentStatus {
  const status = cleanText(value).toLowerCase();
  // Forward payments: processing | pending | uncaptured | captured |
  // cancelled | voided | failed | rejected (an uncaptured payment is an auth).
  if (status === "uncaptured") return "authorized";
  const known: ProviderPaymentStatus[] = ["pending", "processing", "authorized", "captured", "settled", "failed", "cancelled", "voided", "rejected", "refunded"];
  return (known as string[]).includes(status) ? status as ProviderPaymentStatus : "pending";
}

function refundStatus(value: unknown): ProviderRefundStatus {
  const status = cleanText(value).toLowerCase();
  const known: ProviderRefundStatus[] = ["pending", "processing", "succeeded", "failed", "cancelled"];
  return (known as string[]).includes(status) ? status as ProviderRefundStatus : "pending";
}

function payoutStatus(value: unknown): ProviderPayoutStatus {
  const status = cleanText(value).toLowerCase();
  const known: ProviderPayoutStatus[] = ["pending", "in_transit", "paid", "failed"];
  return (known as string[]).includes(status) ? status as ProviderPayoutStatus : "pending";
}

function disputeStatus(value: unknown): ProviderDisputeStatus {
  const status = cleanText(value).toLowerCase();
  const known: ProviderDisputeStatus[] = ["open", "under_review", "won", "lost", "closed"];
  return (known as string[]).includes(status) ? status as ProviderDisputeStatus : "open";
}

function applicationStatus(value: unknown): BoardingApplicationStatus {
  const status = cleanText(value).toUpperCase();
  // LIVE-VERIFIED (2026-08-24): sandbox approvals arrive as MANUALLY_APPROVED
  // — normalize onto the single APPROVED concept the platform tracks.
  if (status === "MANUALLY_APPROVED") return "APPROVED";
  const known: BoardingApplicationStatus[] = [
    "DRAFT", "UNDER_REVIEW", "UNDERWRITING", "APPROVED", "NEED_INFORMATION", "CONDITIONALLY_APPROVED",
    "CREDIT_PENDED", "DECLINED", "CANCELLED", "REEVALUATION_PENDING", "REEVALUATION_APPROVED",
    "REEVALUATION_DECLINED", "REJECT_BY_SALES", "UNDERWRITING_ERROR", "DECLINE_REEVALUATION_INITIATED"
  ];
  // A new provider status must never be treated as an editable draft: doing
  // so offers a link that Forward rejects after the application was submitted.
  return (known as string[]).includes(status) ? status as BoardingApplicationStatus : "UNDER_REVIEW";
}

function paymentMethodType(value: unknown): ProviderPaymentMethodType {
  const type = cleanText(value).toLowerCase();
  return type === "bank" || type === "ca_bank" ? type : "card";
}

function unwrap(payload: JsonObject, key: string): JsonObject {
  const inner = asObject(payload[key]);
  return Object.keys(inner).length ? inner : payload;
}

/**
 * LIVE-VERIFIED (2026-08-13): Forward list responses use the envelope
 * `{ "data": [...], "meta": { "page", "size", "total_count" } }` — objects are
 * never nested under a resource-named key.
 */
function unwrapList(payload: JsonObject, key: string): JsonObject[] {
  const list = asArray(payload[key]).length ? asArray(payload[key]) : asArray(payload.data);
  return list.map(asObject);
}

/**
 * LIVE-VERIFIED (2026-08-13): Forward objects carry entity-named id fields
 * (`processing_plan_id`, `business_id`, `application_id`, `account_id`, ...)
 * rather than a bare `id` on boarding resources; payments-side objects use
 * `id`. Accept both.
 */
function entityId(raw: JsonObject, ...keys: string[]) {
  for (const key of keys) {
    const value = cleanText(raw[key]);
    if (value) return value;
  }
  return cleanText(raw.id);
}

/** Forward paginates lists with `page`/`size` (meta.page/meta.size). */
function listQuery(listOptions: ListOptions) {
  return {
    ...(listOptions.limit !== undefined ? { size: listOptions.limit } : {}),
    ...(listOptions.starting_after !== undefined ? { starting_after: listOptions.starting_after } : {})
  };
}

function mapPaymentIntent(raw: JsonObject): ProviderPaymentIntent {
  const latest = asObject(raw.latest_payment);
  return {
    id: cleanText(raw.id),
    status: intentStatus(raw.status),
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    captured_cents: cents(raw.amount_captured ?? raw.captured_amount),
    refunded_cents: cents(raw.amount_refunded ?? raw.refunded_amount),
    voided_cents: cents(raw.amount_voided),
    reference_id: cleanText(raw.reference_id),
    client_secret: cleanText(raw.client_secret),
    settlement_status: cleanText(raw.settlement_status).toLowerCase(),
    latest_payment: cleanText(latest.id) ? mapPayment(latest) : null,
    raw
  };
}

function mapPayment(raw: JsonObject): ProviderPayment {
  const failed = ["failed", "rejected"].includes(cleanText(raw.status).toLowerCase());
  const method = asObject(raw.payment_method);
  const rail = cleanText(raw.payment_rail_type || method.payment_method_type).toLowerCase();
  return {
    id: cleanText(raw.id),
    intent_id: cleanText(raw.payment_intent_id || raw.payment_intent),
    status: paymentStatus(raw.status),
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    auth_code: failed ? "" : cleanText(raw.auth_code),
    // LIVE-VERIFIED (sandbox 2026-10-19): a declined card answers HTTP 200
    // with status "failed", decline_category (e.g. "RO1") and
    // decline_category_text "Payment authorization failed".
    decline_reason: cleanText(raw.decline_reason || raw.decline_category || raw.failure_code),
    decline_text: cleanText(raw.decline_category_text || raw.failure_message || raw.return_message || (failed ? raw.auth_response_text : "")),
    rail: rail === "bank" || rail === "us_bank_ach" || rail === "ca_bank" || rail === "ca_bank_eft" ? "bank" : "card",
    settlement_status: cleanText(raw.settlement_status).toLowerCase(),
    payment_method_id: cleanText(raw.payment_method_id || method.id),
    raw
  };
}

function mapRefund(raw: JsonObject): ProviderRefund {
  return {
    id: cleanText(raw.id),
    payment_id: cleanText(raw.payment_id || raw.payment),
    status: refundStatus(raw.status),
    amount_cents: cents(raw.amount),
    raw
  };
}

function mapPayout(raw: JsonObject): ProviderPayout {
  return {
    id: cleanText(raw.id),
    status: payoutStatus(raw.status),
    amount_cents: cents(raw.amount),
    currency: cleanText(raw.currency || "USD").toUpperCase(),
    arrival_date: cleanText(raw.arrival_date || raw.expected_arrival_date),
    raw
  };
}

function mapDispute(raw: JsonObject): ProviderDispute {
  return {
    id: cleanText(raw.id),
    payment_id: cleanText(raw.payment_id || raw.payment),
    status: disputeStatus(raw.status),
    amount_cents: cents(raw.amount ?? raw.amount_disputed),
    reason: cleanText(raw.reason),
    respond_by: cleanText(raw.respond_by || raw.evidence_due_by),
    raw
  };
}

function mapPaymentMethod(raw: JsonObject): ProviderPaymentMethod {
  const card = asObject(raw.card);
  const bank = asObject(raw.bank);
  // Forward card objects use last_four_digits / first_six_digits and string
  // exp_month/exp_year (docs.getfwd.com stored-credentials guide).
  return {
    id: cleanText(raw.id),
    type: paymentMethodType(raw.payment_method_type ?? raw.type),
    brand: cleanText(card.brand || bank.bank_name),
    last4: cleanText(card.last_four_digits || card.last4 || bank.last_four_digits || bank.last4 || raw.last4),
    exp_month: cents(card.exp_month),
    exp_year: normalizeYear(cents(card.exp_year)),
    raw
  };
}

function normalizeYear(year: number) {
  return year > 0 && year < 100 ? 2000 + year : year;
}

function mapApplication(raw: JsonObject): ProviderApplication {
  return {
    id: entityId(raw, "application_id"),
    business_id: cleanText(raw.business_id || raw.business),
    status: applicationStatus(raw.status),
    // Live application objects echo the plan as `partner_processing_plan_id`.
    processing_plan_id: cleanText(raw.processing_plan_id || raw.partner_processing_plan_id),
    // Live field name is `docs_requested`.
    documents_requested: asArray(raw.documents_requested ?? raw.docs_requested).map(asObject),
    raw
  };
}

function mapPortalUser(raw: JsonObject): ProviderPortalUser {
  return {
    id: entityId(raw, "user_id"),
    email: cleanText(raw.email),
    first_name: cleanText(raw.first_name),
    last_name: cleanText(raw.last_name),
    status: cleanText(raw.status),
    raw
  };
}

function mapAccount(raw: JsonObject): ProviderAccount {
  return {
    id: entityId(raw, "account_id"),
    business_id: cleanText(raw.business_id || raw.business),
    external_account_id: cleanText(raw.external_account_id),
    processing_enabled: raw.processing_enabled === true,
    payouts_enabled: raw.payouts_enabled === true,
    status: cleanText(raw.status).toUpperCase(),
    gateway_mid: cleanText(raw.mid),
    raw
  };
}

/** Order details on Forward's wire: only the fields that are set. */
function orderDetailsBody(value: unknown): JsonObject | undefined {
  const details = asObject(value);
  const body: JsonObject = {};
  if (cleanText(details.card_not_present_type)) body.card_not_present_type = cleanText(details.card_not_present_type);
  if (cleanText(details.initiated_by)) body.initiated_by = cleanText(details.initiated_by);
  if (typeof details.is_scheduled_payment === "boolean") body.is_scheduled_payment = details.is_scheduled_payment;
  if (cleanText(details.invoice_id)) body.invoice_id = cleanText(details.invoice_id).slice(0, 100);
  if (cleanText(details.description)) body.description = cleanText(details.description).slice(0, 255);
  if (cleanText(details.po_number)) body.po_number = cleanText(details.po_number).slice(0, 100);
  if (details.tax_amount !== undefined && Number.isFinite(Number(details.tax_amount))) body.tax_amount = Math.max(0, cents(details.tax_amount));
  if (typeof details.tax_exempt === "boolean") body.tax_exempt = details.tax_exempt;
  const zip = cleanText(details.ship_to_zip).replace(/[^A-Za-z0-9 -]/g, "");
  if (zip) body.ship_to_zip = zip.slice(0, 10);
  if (cleanText(details.ship_to_country)) body.ship_to_country = cleanText(details.ship_to_country).toUpperCase().slice(0, 2);
  return Object.keys(body).length ? body : undefined;
}

/** Billing details on Forward's wire (AVS reads address_line1 and postal_code). */
function billingDetailsBody(value: unknown): JsonObject | undefined {
  const details = asObject(value);
  const address = asObject(details.address);
  const wireAddress: JsonObject = {};
  const fields: Array<[string, string]> = [["address_line1", "address_line1"], ["line1", "address_line1"], ["address_line2", "address_line2"], ["line2", "address_line2"], ["city", "city"], ["state", "state"], ["postal_code", "postal_code"], ["zip", "postal_code"], ["country", "country"]];
  for (const [from, to] of fields) {
    const text = cleanText(address[from]);
    if (text && wireAddress[to] === undefined) wireAddress[to] = text;
  }
  const body: JsonObject = {
    ...(cleanText(details.name) ? { name: cleanText(details.name).slice(0, 120) } : {}),
    ...(cleanText(details.email) ? { email: cleanText(details.email).slice(0, 200) } : {}),
    ...(cleanText(details.phone) ? { phone: cleanText(details.phone).replace(/[^\d+]/g, "").slice(0, 20) } : {}),
    ...(Object.keys(wireAddress).length ? { address: { country: "US", ...wireAddress } } : {})
  };
  return Object.keys(body).length ? body : undefined;
}

// --- Adapters ---------------------------------------------------------------

export function createForwardAdapter(options: ForwardClientOptions = {}): PaymentProviderAdapter {
  const call = (method: "GET" | "POST" | "PATCH", path: string, request: RequestOptions = {}) =>
    forwardRequest(options, method, path, request);
  return {
    provider: FORWARD_PROVIDER,
    async createPaymentIntent(input: CreatePaymentIntentInput) {
      const orderDetails = orderDetailsBody(input.order_details);
      const body: JsonObject = {
        amount: cents(input.amount_cents),
        currency: cleanText(input.currency || "USD").toUpperCase(),
        ...(input.merchant_amount_cents !== undefined ? { merchant_amount: cents(input.merchant_amount_cents) } : {}),
        ...(cleanText(input.reference_id) ? { reference_id: cleanText(input.reference_id).slice(0, 300) } : {}),
        ...(input.payment_method_types?.length ? { payment_method_types: input.payment_method_types } : {}),
        // Forward's documented field is the `capture` boolean.
        ...(input.auto_capture === false ? { capture: false } : {}),
        ...(cleanText(input.description) ? { description: cleanText(input.description).slice(0, 255) } : {}),
        ...(input.user_fields ? { user_fields: input.user_fields } : {}),
        ...(orderDetails ? { order_details: orderDetails } : {})
      };
      return mapPaymentIntent(unwrap(await call("POST", "/payment_intents", { body, idempotencyKey: input.idempotency_key }), "payment_intent"));
    },
    async getPaymentIntent(intentId) {
      return mapPaymentIntent(unwrap(await call("GET", `/payment_intents/${encodeURIComponent(intentId)}`), "payment_intent"));
    },
    async searchPaymentIntents(input) {
      const payload = await call("POST", "/payment_intents/search", {
        body: { reference_id: cleanText(input.reference_id), limit: 10 },
        idempotency: false
      });
      return unwrapList(payload, "payment_intents").map(mapPaymentIntent);
    },
    async updatePaymentIntent(intentId, input) {
      const orderDetails = orderDetailsBody(input.order_details);
      const body: JsonObject = {
        ...(input.amount_cents !== undefined ? { amount: cents(input.amount_cents) } : {}),
        ...(orderDetails ? { order_details: orderDetails } : {})
      };
      return mapPaymentIntent(unwrap(await call("PATCH", `/payment_intents/${encodeURIComponent(intentId)}`, { body, idempotencyKey: input.idempotency_key }), "payment_intent"));
    },
    async capturePaymentIntent(intentId, input = {}) {
      const body: JsonObject = input.amount_cents !== undefined ? { amount: cents(input.amount_cents) } : {};
      return mapPaymentIntent(unwrap(await call("POST", `/payment_intents/${encodeURIComponent(intentId)}/capture`, { body, idempotencyKey: input.idempotency_key }), "payment_intent"));
    },
    async cancelPaymentIntent(intentId, input = {}) {
      // LIVE-VERIFIED (sandbox 2026-10-19): cancelling an intent whose card
      // payment is captured but unsettled voids it — the intent answers
      // status "cancelled" with amount_voided equal to the charge.
      const body: JsonObject = cleanText(input.reason) ? { cancellation_reason: cleanText(input.reason) } : {};
      return mapPaymentIntent(unwrap(await call("POST", `/payment_intents/${encodeURIComponent(intentId)}/cancel`, { body, idempotencyKey: input.idempotency_key }), "payment_intent"));
    },
    async createPayment(intentId, input: CreatePaymentInput) {
      const billing = billingDetailsBody(input.billing_details);
      const orderDetails = orderDetailsBody(input.order_details);
      const body: JsonObject = {
        payment_method_id: cleanText(input.payment_method_id),
        ...(input.amount_cents !== undefined ? { amount: cents(input.amount_cents) } : {}),
        ...(billing ? { billing_details: billing } : {}),
        ...(orderDetails ? { order_details: orderDetails } : {}),
        ...(cleanText(input.reference_id) ? { reference_id: cleanText(input.reference_id).slice(0, 300) } : {})
      };
      return mapPayment(unwrap(await call("POST", `/payment_intents/${encodeURIComponent(intentId)}/payments`, { body, idempotencyKey: input.idempotency_key }), "payment"));
    },
    async createRefund(intentId, input: CreateRefundInput = {}) {
      // LIVE-VERIFIED (sandbox 2026-10-19): full and partial refunds both work
      // on a captured payment that has not settled yet.
      const body: JsonObject = {
        ...(input.amount_cents !== undefined ? { amount: cents(input.amount_cents) } : {})
      };
      return mapRefund(unwrap(await call("POST", `/payment_intents/${encodeURIComponent(intentId)}/refunds`, { body, idempotencyKey: input.idempotency_key }), "refund"));
    },
    async getRefund(refundId) {
      return mapRefund(unwrap(await call("GET", `/refunds/${encodeURIComponent(refundId)}`), "refund"));
    },
    async getPayment(paymentId) {
      return mapPayment(unwrap(await call("GET", `/payments/${encodeURIComponent(paymentId)}`), "payment"));
    },
    async listPayouts(listOptions: ListOptions = {}) {
      const payload = await call("GET", "/payouts", { query: listQuery(listOptions) });
      return unwrapList(payload, "payouts").map(mapPayout);
    },
    async getPayout(payoutId) {
      return mapPayout(unwrap(await call("GET", `/payouts/${encodeURIComponent(payoutId)}`), "payout"));
    },
    async getBalances() {
      // Forward exposes ledger balances at /ledger/balances (not /balances).
      const payload = await call("GET", "/ledger/balances");
      return unwrapList(payload, "balances").map((raw) => ({
        currency: cleanText(raw.currency || "USD").toUpperCase(),
        available_cents: cents(raw.available ?? raw.available_amount ?? raw.balance),
        pending_cents: cents(raw.pending ?? raw.pending_amount),
        raw
      } satisfies ProviderBalance));
    },
    async listDisputes(listOptions: ListOptions = {}) {
      const payload = await call("GET", "/disputes", { query: listQuery(listOptions) });
      return unwrapList(payload, "disputes").map(mapDispute);
    },
    async getDispute(disputeId) {
      return mapDispute(unwrap(await call("GET", `/disputes/${encodeURIComponent(disputeId)}`), "dispute"));
    },
    async calculateSurcharge(input: SurchargeCalculationInput) {
      const body: JsonObject = {
        amount: cents(input.amount_cents),
        ...(cleanText(input.payment_method_id) ? { payment_method_id: cleanText(input.payment_method_id) } : {}),
        ...(cleanText(input.bin) ? { bin: cleanText(input.bin) } : {}),
        ...(cleanText(input.state) ? { state: cleanText(input.state) } : {})
      };
      const raw = await call("POST", "/surcharge/calculate", { body, idempotency: false });
      const surcharge = cents(raw.surcharge_amount ?? raw.surcharge);
      const amount = cents(raw.amount) || cents(input.amount_cents);
      return {
        amount_cents: amount,
        surcharge_cents: surcharge,
        total_cents: cents(raw.total_amount ?? raw.total) || amount + surcharge,
        raw
      } satisfies SurchargeCalculation;
    },
    async createPaymentMethodIntent(input: CreatePaymentMethodIntentInput = {}) {
      // Forward wire format (stored-credentials guide): payment_method_types
      // array + optional server-side payment_method_data (migration flow).
      const type = input.type || "card";
      const card = asObject(input.card);
      const bank = asObject(input.bank);
      const body: JsonObject = {
        payment_method_types: [type],
        ...(input.validate !== undefined ? { validate: input.validate === true } : {}),
        ...(input.billing_details && Object.keys(asObject(input.billing_details)).length
          ? { billing_details: input.billing_details } : {}),
        ...(input.user_fields ? { user_fields: input.user_fields } : {}),
        ...(Object.keys(card).length ? {
          payment_method_data: {
            payment_method_type: "card",
            card: {
              number: cleanText(card.number).replace(/\D/g, ""),
              exp_month: String(card.exp_month ?? "").padStart(2, "0"),
              exp_year: String(cents(card.exp_year) % 100).padStart(2, "0"),
              ...(cleanText(card.cvc) ? { cvv: cleanText(card.cvc) } : {}),
              ...(cleanText(card.name) ? { name: cleanText(card.name) } : {})
            }
          }
        } : {}),
        ...(Object.keys(bank).length ? {
          payment_method_data: {
            payment_method_type: "bank",
            bank: {
              routing_number: cleanText(bank.routing),
              account_number: cleanText(bank.account),
              ...(cleanText(bank.account_type) ? { account_type: cleanText(bank.account_type) } : {}),
              ...(cleanText(bank.name) ? { name: cleanText(bank.name) } : {})
            }
          }
        } : {})
      };
      const raw = unwrap(await call("POST", "/payment_method_intents", { body }), "payment_method_intent");
      return {
        id: cleanText(raw.id),
        status: cleanText(raw.status),
        client_secret: cleanText(raw.client_secret),
        payment_method_id: cleanText(raw.payment_method_id) || cleanText(asObject(raw.payment_method).id),
        raw
      } satisfies ProviderPaymentMethodIntent;
    },
    async getPaymentMethod(paymentMethodId) {
      return mapPaymentMethod(unwrap(await call("GET", `/payment_methods/${encodeURIComponent(paymentMethodId)}`), "payment_method"));
    },
    async updatePaymentMethod(paymentMethodId, input: UpdatePaymentMethodInput) {
      const body: JsonObject = {
        ...(input.billing_details ? { billing_details: input.billing_details } : {}),
        ...(input.exp_month !== undefined ? { exp_month: cents(input.exp_month) } : {}),
        ...(input.exp_year !== undefined ? { exp_year: cents(input.exp_year) } : {})
      };
      return mapPaymentMethod(unwrap(await call("PATCH", `/payment_methods/${encodeURIComponent(paymentMethodId)}`, { body }), "payment_method"));
    }
  };
}

// --- Boarding wire translation ----------------------------------------------
// Translates our neutral application shape (the onboarding wizard's fields)
// into Forward's documented wire format. Callers may also pass exact wire
// fields; recognized neutral fields are renamed, everything else passes
// through untouched.

function forwardAddress(value: unknown): JsonObject {
  const address = asObject(value);
  const { address1, address2, postal_code, ...rest } = address;
  return {
    ...rest,
    ...(cleanText(address.address_line1 || address1) ? { address_line1: cleanText(address.address_line1 || address1) } : {}),
    ...(cleanText(address.address_line2 || address2) ? { address_line2: cleanText(address.address_line2 || address2) } : {}),
    ...(cleanText(address.zip_code || postal_code) ? { zip_code: cleanText(address.zip_code || postal_code) } : {}),
    country: cleanText(address.country) || "US"
  };
}

/** Neutral ownership-type spellings -> Forward's US enum. */
const OWNERSHIP_TYPES: Record<string, string> = {
  LLC: "LIMITED_LIABILITY_COMPANY",
  SOLE_PROPRIETORSHIP: "SOLO_TRADER",
  SOLE_PROPRIETOR: "SOLO_TRADER",
  CORPORATION: "PRIVATE",
  NON_PROFIT: "TAX_EXEMPT_ORGANIZATION"
};

function forwardCompany(value: unknown): JsonObject {
  const company = asObject(value);
  const { dba, phone, ...rest } = company;
  const ownership = cleanText(company.ownership_type).toUpperCase().replace(/\s+/g, "_");
  return {
    ...rest,
    ...(ownership ? { ownership_type: OWNERSHIP_TYPES[ownership] || ownership } : {}),
    ...(cleanText(company.dba_name || dba) ? { dba_name: cleanText(company.dba_name || dba) } : {}),
    ...(cleanText(company.phone_number || phone) ? { phone_number: cleanText(company.phone_number || phone).replace(/\D/g, "") } : {}),
    ...(cleanText(company.ein) ? { ein: cleanText(company.ein).replace(/\D/g, "") } : {})
  };
}

function forwardOwner(value: unknown): JsonObject {
  const owner = asObject(value);
  const { name, address, dob, phone, ownership_percent, ...rest } = owner;
  const fullName = cleanText(name);
  const [firstName, ...restName] = fullName.split(/\s+/);
  return {
    ...rest,
    ...(cleanText(owner.first_name || firstName) ? { first_name: cleanText(owner.first_name || firstName) } : {}),
    ...(cleanText(owner.last_name || restName.join(" ")) ? { last_name: cleanText(owner.last_name || restName.join(" ")) } : {}),
    // Forward's field is birth_date (not dob / date_of_birth).
    ...(cleanText(owner.birth_date || dob) ? { birth_date: cleanText(owner.birth_date || dob) } : {}),
    ...(cleanText(owner.phone_number || phone) ? { phone_number: cleanText(owner.phone_number || phone).replace(/\D/g, "") } : {}),
    // Valid titles vary by ownership type (e.g. LLC accepts MEMBER but not
    // OWNER — live-verified); normalize the wizard's display words.
    ...(cleanText(owner.title) ? { title: cleanText(owner.title).toUpperCase().replace(/\s+/g, "_") } : {}),
    ...(ownership_percent !== undefined ? { ownership_percent: cents(ownership_percent) } : {}),
    ...(owner.residence_address || address ? { residence_address: forwardAddress(owner.residence_address || address) } : {}),
    ...(cleanText(owner.ssn) ? { ssn: cleanText(owner.ssn).replace(/\D/g, "") } : {})
  };
}

function forwardVolumes(value: unknown): JsonObject {
  const volumes = asObject(value);
  const annual = cents(volumes.avg_annual_volume ?? volumes.annual_volume);
  const avgTicket = cents(volumes.avg_ticket_amount ?? volumes.avg_ticket);
  const highTicket = cents(volumes.high_ticket_amount ?? volumes.high_ticket);
  const cardPresent = Math.min(100, Math.max(0, cents(volumes.card_present_percent)));
  return {
    industry_volume: {
      ...(annual ? { avg_annual_volume: annual } : {}),
      ...(avgTicket ? { avg_ticket_amount: avgTicket } : {}),
      ...(highTicket ? { high_ticket_amount: highTicket } : {})
    },
    transaction_modes: asObject(volumes.transaction_modes ?? {
      in_person: cardPresent,
      online: 100 - cardPresent
    }),
    ...(volumes.services_deliveries ? { services_deliveries: asObject(volumes.services_deliveries) } : {})
  };
}

export function createForwardBoardingAdapter(options: ForwardClientOptions = {}): MerchantBoardingAdapter {
  const call = (method: "GET" | "POST" | "PUT", path: string, request: RequestOptions = {}) =>
    forwardRequest(options, method, path, request);
  const createPortalUser = async (input: PortalUserInput): Promise<ProviderPortalUser> => {
    // LIVE-VERIFIED (2026-08-14): POST /users accepts { first_name, last_name,
    // email, business_id } and returns the bare user object { id: "user_...",
    // type: "BUSINESS", first_name, last_name, email, status: "ACTIVE" }.
    const fullName = cleanText(input.name);
    const [firstName, ...restName] = fullName.split(/\s+/);
    const body: JsonObject = {
      first_name: cleanText(input.first_name || firstName) || "Merchant",
      last_name: cleanText(input.last_name || restName.join(" ")) || "User",
      email: cleanText(input.email),
      ...(cleanText(input.business_id) ? { business_id: cleanText(input.business_id) } : {})
    };
    const raw = unwrap(await call("POST", "/users", { body }), "user");
    return mapPortalUser(raw);
  };
  const applicationBody = (input: ApplicationInput): JsonObject => ({
    ...(cleanText(input.business_id) ? { business_id: cleanText(input.business_id) } : {}),
    ...(cleanText(input.name) ? { name: cleanText(input.name) } : {}),
    ...(cleanText(input.processing_plan_id) ? { processing_plan_id: cleanText(input.processing_plan_id) } : {}),
    ...(cleanText(input.external_account_id) ? { external_account_id: cleanText(input.external_account_id) } : {}),
    ...(input.company ? { company: forwardCompany(input.company) } : {}),
    ...(input.address ? { address: forwardAddress(input.address) } : {}),
    ...(input.owners ? { owners: input.owners.map(forwardOwner) } : {}),
    ...(input.volumes ? { ...forwardVolumes(input.volumes) } : {}),
    ...(input.partner_data ? { partner_data: asObject(input.partner_data) } : {}),
    // Forward's application wire format has no documented bank-account slot
    // (bank accounts are a separate post-approval resource), so the wizard's
    // payout account rides along under user_fields.bank_account.
    ...(input.user_fields || input.bank_account
      ? {
          user_fields: {
            ...asObject(input.user_fields),
            ...(input.bank_account ? { bank_account: asObject(input.bank_account) } : {})
          }
        }
      : {})
  });
  return {
    provider: FORWARD_PROVIDER,
    async createBusiness(input: CreateBusinessInput) {
      // LIVE-VERIFIED wire fields: name + contact_email / contact_phone_number.
      const body: JsonObject = {
        name: cleanText(input.name),
        ...(cleanText(input.email) ? { contact_email: cleanText(input.email) } : {}),
        ...(cleanText(input.phone) ? { contact_phone_number: cleanText(input.phone) } : {})
      };
      const raw = unwrap(await call("POST", "/businesses", { body }), "business");
      return { id: entityId(raw, "business_id"), name: cleanText(raw.name), raw } satisfies ProviderBusiness;
    },
    async createApplication(input: ApplicationInput) {
      return mapApplication(unwrap(await call("POST", "/applications", { body: applicationBody(input) }), "application"));
    },
    async updateApplication(applicationId, input: ApplicationInput) {
      // LIVE-VERIFIED (2026-08-13): PUT /applications/{id} is FULL-REPLACE —
      // a partial body nulls out every omitted section (company, owners, ...).
      // Merge the patch over the current application so callers get PATCH
      // semantics. DRAFT-only per Forward's docs.
      const current = unwrap(await call("GET", `/applications/${encodeURIComponent(applicationId)}`), "application");
      delete current.processing_plan_data;
      const patch = applicationBody(input);
      const body: JsonObject = {
        ...current,
        ...(cleanText(current.processing_plan_id) === "" && cleanText(current.partner_processing_plan_id)
          ? { processing_plan_id: cleanText(current.partner_processing_plan_id) }
          : {}),
        ...patch,
        ...(patch.user_fields !== undefined
          ? { user_fields: { ...asObject(current.user_fields), ...asObject(patch.user_fields) } }
          : {}),
        ...(patch.partner_data !== undefined
          ? { partner_data: { ...asObject(current.partner_data), ...asObject(patch.partner_data) } }
          : {})
      };
      return mapApplication(unwrap(await call("PUT", `/applications/${encodeURIComponent(applicationId)}`, { body }), "application"));
    },
    async getApplication(applicationId) {
      return mapApplication(unwrap(await call("GET", `/applications/${encodeURIComponent(applicationId)}`), "application"));
    },
    async submitApplication(applicationId) {
      // PARTNER-CAPABILITY-GATED (rep-confirmed 2026-08-14): our integration
      // gets "You cannot submit applications via the API because this
      // capability is not enabled for your integration" — merchants must
      // complete the HOSTED application workflow (generateApplicationLink)
      // instead. Kept because the wire call is correct and may work for
      // integrations with the capability enabled.
      // LIVE-VERIFIED (2026-08-13): submission is PUT /applications/{id}/submit
      // carrying the FULL application body (an empty body 400s with
      // must-not-be-null errors for name/company/address/owners/...). POST
      // /submit, /submissions and PATCH do not exist (404). Re-play the
      // current application state; Forward requires terms_accepted for
      // underwriting, so accept terms as part of API submission.
      const current = unwrap(await call("GET", `/applications/${encodeURIComponent(applicationId)}`), "application");
      const body: JsonObject = {
        ...current,
        ...(cleanText(current.processing_plan_id) === "" && cleanText(current.partner_processing_plan_id)
          ? { processing_plan_id: cleanText(current.partner_processing_plan_id) }
          : {}),
        terms_accepted: true
      };
      delete body.processing_plan_data;
      return mapApplication(unwrap(await call("PUT", `/applications/${encodeURIComponent(applicationId)}/submit`, { body }), "application"));
    },
    async generateApplicationLink(applicationId) {
      // LIVE-VERIFIED (2026-08-14): POST /applications/{id}/link with an empty
      // body returns { link_id, uri, expiration_date, expired } — a fresh
      // aapplink_* URL on application.<env>.getfwd.com with a 14-day expiry.
      // A `redirect_url` in the POST body is accepted but ignored; the
      // documented redirect_url lives on the application's partner_data
      // (PartnerDataDto) instead.
      const raw = unwrap(await call("POST", `/applications/${encodeURIComponent(applicationId)}/link`, { body: {} }), "link");
      return {
        id: entityId(raw, "link_id"),
        url: cleanText(raw.uri || raw.url),
        expires_at: cleanText(raw.expiration_date || raw.expires_at),
        expired: raw.expired === true,
        raw
      } satisfies ProviderApplicationLink;
    },
    createPortalUser,
    async ensurePortalUser(input: PortalUserInput) {
      // LIVE-VERIFIED (2026-08-14): GET /users REQUIRES a `type` query param
      // (400 without it); filters on email/business_id work and results come
      // back in the standard { data: [...], meta } envelope.
      const email = cleanText(input.email).toLowerCase();
      const businessId = cleanText(input.business_id);
      try {
        const payload = await call("GET", "/users", {
          query: {
            type: "BUSINESS",
            ...(email ? { email } : {}),
            ...(businessId ? { business_id: businessId } : {})
          }
        });
        const existing = unwrapList(payload, "users")
          .find((raw) => cleanText(raw.email).toLowerCase() === email);
        if (existing) return mapPortalUser(existing);
      } catch {
        // Lookup failures fall through to create — POST /users dedupes upstream.
      }
      return createPortalUser(input);
    },
    async generatePortalLoginUrl(userId) {
      // LIVE-VERIFIED (2026-08-14): POST /users/{id}/login_url (no body)
      // returns { id, login_url } — a single-use magic link into the
      // partner-branded merchant portal (<merchant-portal-domain>/auth/...).
      // A `redirect_url` body field is accepted but ignored.
      const raw = unwrap(await call("POST", `/users/${encodeURIComponent(userId)}/login_url`, { body: {} }), "login");
      return {
        user_id: entityId(raw, "user_id"),
        url: cleanText(raw.login_url || raw.url),
        raw
      } satisfies ProviderPortalLoginUrl;
    },
    async listProcessingPlans(listOptions: ListOptions = {}) {
      const payload = await call("GET", "/processing_plans", { query: listQuery(listOptions) });
      return unwrapList(payload, "processing_plans").map((raw) => ({
        id: entityId(raw, "processing_plan_id"),
        name: cleanText(raw.name),
        raw
      } satisfies ProviderProcessingPlan));
    },
    async listMccs() {
      // GET /mccs lists the MCCs assigned to our partner account (the
      // application's company.mcc must be one of them); paged {data, meta}.
      const mccs: ProviderMcc[] = [];
      for (let page = 0; page < 10; page += 1) {
        const payload = await call("GET", "/mccs", { query: { page, size: 100, active: "true" } });
        const rows = unwrapList(payload, "mccs");
        for (const raw of rows) {
          const code = cleanText(raw.code || raw.mcc);
          if (code) mccs.push({ code, description: cleanText(raw.description), active: raw.active !== false });
        }
        const total = cents(asObject(payload.meta).total_count);
        if (!rows.length || mccs.length >= total) break;
      }
      return mccs;
    },
    async getAccount(accountId) {
      return mapAccount(unwrap(await call("GET", `/accounts/${encodeURIComponent(accountId)}`), "account"));
    },
    async listAccounts(listOptions: ListOptions & { business_id?: string } = {}) {
      // LIVE-VERIFIED (2026-08-24): GET /accounts returns the standard
      // {data, meta} envelope with account_id / business_id /
      // external_account_id / processing_enabled / payouts_enabled fields.
      const payload = await call("GET", "/accounts", {
        query: {
          ...listQuery(listOptions),
          ...(cleanText(listOptions.business_id) ? { business_id: cleanText(listOptions.business_id) } : {})
        }
      });
      return unwrapList(payload, "accounts").map(mapAccount);
    },
    async listBankAccounts(listOptions: BankAccountListOptions = {}) {
      const payload = await call("GET", "/bank_accounts", { query: {
        ...listQuery(listOptions),
        ...(cleanText(listOptions.business_id) ? { business_id:cleanText(listOptions.business_id) } : {}),
        ...(cleanText(listOptions.status) ? { status:cleanText(listOptions.status) } : {}),
        ...(cleanText(listOptions.created_from) ? { created_from:cleanText(listOptions.created_from) } : {}),
        ...(cleanText(listOptions.country) ? { country:cleanText(listOptions.country) } : {})
      } });
      return unwrapList(payload, "bank_accounts").map((raw) => ({
        id: entityId(raw, "bank_account_id"),
        business_id: cleanText(raw.business_id),
        name: cleanText(raw.bank_account_name),
        mask: cleanText(raw.bank_account_mask),
        validation_status: cleanText(raw.validation_status),
        verification_status: cleanText(raw.verification_status),
        status: cleanText(raw.bank_account_status),
        active: raw.bank_account_active === true,
        country: cleanText(raw.country),
        created_at: cleanText(raw.created_at),
        updated_at: cleanText(raw.updated_at),
        removed_at: cleanText(raw.removed_at),
        needs_info_comments: cleanText(raw.needs_info_comments),
        needs_info_documents: Array.isArray(raw.needs_info_documents) ? raw.needs_info_documents.map(asObject) : [],
        bank_name: cleanText(raw.bank_account_name),
        last4: cleanText(raw.bank_account_mask).replace(/\D/g, "").slice(-4),
        raw
      } satisfies ProviderBankAccount));
    }
  };
}
