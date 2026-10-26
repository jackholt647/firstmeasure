import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// The real Forward adapter, end to end, against a fake Forward API. These
// pin what Forward's certification checks: the payment intent carries the
// amount, our reference id and card-network order details; every write
// carries an idempotency key that a retry reuses; declines, lost answers,
// voids, refunds and bank payments are handled without a double charge or a
// payment recorded that the processor never took.

let app: any = null;
let storageRoot = "";
const API = "https://api.sandbox.forward.test";
const WEBHOOK_SECRET_BYTES = Buffer.from("forward-checkout-test-webhook-key");
const WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_BYTES.toString("base64")}`;

type Call = { method: string; path: string; key: string; account: string; body: any };
const calls: Call[] = [];
const fake = {
  /** Boarding: applications and accounts Forward knows about. */
  applications: new Map<string, any>(),
  accounts: new Map<string, any>(),
  intents: new Map<string, any>(),
  payments: new Map<string, any>(),
  refunds: new Map<string, any>(),
  byKey: new Map<string, { status: number; body: any }>(),
  /** Payment-method ids that misbehave once: "503" answers 503, "lost" charges then drops the answer. */
  once: new Map<string, string>(),
  /** Idempotency keys whose requests never get an answer (Forward unreachable). */
  dropKeys: new Set<string>(),
  seq: 0
};
const realFetch = globalThis.fetch;

function json(status: number, body: any) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function intentView(intent: any) {
  const latest = [...fake.payments.values()].filter((payment) => payment.payment_intent_id === intent.id).at(-1) || null;
  return { ...intent, latest_payment: latest, settlement_status: latest?.settlement_status || "" };
}

async function fakeForward(url: string, init: RequestInit = {}) {
  const parsed = new URL(url);
  const method = String(init.method || "GET").toUpperCase();
  const headers = (init.headers || {}) as Record<string, string>;
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  const key = headers["x-idempotency-key"] || "";
  const pathName = parsed.pathname;
  calls.push({ method, path: pathName, key, account: headers["x-account-id"] || "", body });
  if (key && fake.dropKeys.has(key)) {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  }
  if (method !== "GET" && !key) return json(400, { message: "x-idempotency-key is required" });
  // Forward answers a repeated key with the first response.
  if (method !== "GET" && fake.byKey.has(key)) {
    const prior = fake.byKey.get(key)!;
    return json(prior.status, prior.body);
  }
  const remember = (status: number, response: any) => { fake.byKey.set(key, { status, body: response }); return json(status, response); };
  let match: RegExpMatchArray | null;
  if (method === "POST" && pathName === "/payment_intents") {
    const id = `pi_fake_${++fake.seq}`;
    const intent = { id, entity: "payment_intent", status: "created", amount: body.amount, currency: body.currency || "USD", reference_id: body.reference_id, order_details: body.order_details, payment_method_types: body.payment_method_types, user_fields: body.user_fields, client_secret: `${id}_secret_fake`, amount_captured: 0, amount_refunded: 0, amount_voided: 0 };
    fake.intents.set(id, intent);
    return remember(200, intent);
  }
  if (method === "GET" && (match = pathName.match(/^\/payment_intents\/([^/]+)$/))) {
    const intent = fake.intents.get(match[1]!);
    return intent ? json(200, intentView(intent)) : json(404, { message: "not found" });
  }
  if (method === "POST" && (match = pathName.match(/^\/payment_intents\/([^/]+)\/payments$/))) {
    const intent = fake.intents.get(match[1]!);
    const token = String(body.payment_method_id);
    const quirk = fake.once.get(token);
    if (quirk === "503") { fake.once.delete(token); return json(503, { message: "Service Unavailable" }); }
    const bank = token.startsWith("pm_bank");
    const declined = token.startsWith("pm_decline");
    const id = `pmt_fake_${++fake.seq}`;
    const payment = {
      id, entity: "payment", payment_intent_id: intent.id, payment_method_id: token,
      status: declined ? "failed" : bank ? "pending" : "captured",
      amount: intent.amount, currency: "USD", auth_code: declined ? "" : "AUTH01",
      decline_category: declined ? "RO1" : undefined, decline_category_text: declined ? "Payment authorization failed" : undefined,
      payment_rail_type: bank ? "bank" : "card", settlement_status: "unsettled",
      billing_details: body.billing_details, order_details: body.order_details, reference_id: body.reference_id
    };
    fake.payments.set(id, payment);
    if (!declined) intent.status = bank ? "pending" : "captured";
    if (quirk === "lost_all") fake.dropKeys.add(key);
    if (quirk === "lost" || quirk === "lost_all") {
      fake.once.delete(token);
      // Forward stored the key with the charge; a retry gets this answer.
      fake.byKey.set(key, { status: 200, body: payment });
      if (quirk === "lost") fake.dropKeys.delete(key);
      // The charge happened; the answer never arrives.
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    }
    return remember(200, payment);
  }
  if (method === "POST" && (match = pathName.match(/^\/payment_intents\/([^/]+)\/cancel$/))) {
    const intent = fake.intents.get(match[1]!);
    let voided = 0;
    for (const payment of fake.payments.values()) {
      if (payment.payment_intent_id === intent.id && payment.status === "captured") { payment.status = "voided"; voided += payment.amount; }
    }
    Object.assign(intent, { status: "cancelled", amount_voided: voided, amount_captured: 0, cancellation_reason: body?.cancellation_reason });
    return remember(200, intentView(intent));
  }
  if (method === "POST" && (match = pathName.match(/^\/payment_intents\/([^/]+)\/refunds$/))) {
    const intent = fake.intents.get(match[1]!);
    const payment = [...fake.payments.values()].find((entry) => entry.payment_intent_id === intent.id && entry.status === "captured");
    const id = `ref_fake_${++fake.seq}`;
    const refund = { id, entity: "refund", status: "succeeded", amount: body.amount ?? payment.amount, payment_id: payment.id, settlement_status: "unsettled" };
    fake.refunds.set(id, refund);
    return remember(200, refund);
  }
  if (method === "GET" && (match = pathName.match(/^\/applications\/([^/]+)$/))) {
    const application = fake.applications.get(match[1]!);
    return application ? json(200, application) : json(404, { message: "no application" });
  }
  if (method === "GET" && pathName === "/accounts") {
    return json(200, { data: [...fake.accounts.values()], meta: {} });
  }
  if (method === "GET" && (match = pathName.match(/^\/accounts\/([^/]+)$/))) {
    const account = fake.accounts.get(match[1]!);
    return account ? json(200, account) : json(404, { message: "no account" });
  }
  if (method === "GET" && (match = pathName.match(/^\/payment_methods\/([^/]+)$/))) {
    const id = match[1]!;
    return json(200, id.startsWith("pm_bank")
      ? { id, payment_method_type: "bank", bank: { bank_name: "Test Bank", last_four_digits: "6789" } }
      : { id, payment_method_type: "card", card: { brand: "visa", last_four_digits: "4242", exp_month: "12", exp_year: "2030" } });
  }
  return json(404, { message: `fake forward has no ${method} ${pathName}` });
}

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => (app.inject as any)({
    method,
    url,
    payload,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
    }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const parsed = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return parsed;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-forward-checkout-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  process.env.FORWARD_API_BASE = API;
  process.env.FORWARD_PRIVATE_KEY = "test_key_fake_private";
  process.env.FORWARD_PUBLIC_KEY = "test_pkey_fake_public";
  process.env.FORWARD_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FORWARD_REQUEST_TIMEOUT_MS = "2000";
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url || input);
    if (url.startsWith(API)) return fakeForward(url, init);
    return realFetch(input, init);
  }) as typeof fetch;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  globalThis.fetch = realFetch;
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>, options: { approved?: boolean } = {}) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `checkout-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Checkout Owner",
    company: "Forward Checkout Org",
    organization_id: `org_fwdco_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: { app_flags: { platform: { expanded_access: true, money: true }, money: { merchant_processing: true } } }
  }, { replace: false });
  const accountId = `acct_fake_${suffix}`;
  if (options.approved !== false) {
    const { upsertMerchantConfig } = await import("../payments/merchant_config.js");
    await upsertMerchantConfig(orgId, {
      provider: "forward",
      forward: { business_id: `bus_${suffix}`, application_id: `aapp_${suffix}`, account_id: accountId, boarding_status: "APPROVED", processing_enabled: true }
    }, { skipFlag: true });
  }
  const projectId = `project_fwd_${suffix}`;
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Forward Checkout Roof", address: "100 Main St, Springfield, IL 62704" },
    metadata: { kind: "platform_project" }
  });
  return { orgId, accountId, projectId };
}

function signedWebhook(body: any, id: string, headerPrefix: "svix" | "webhook" = "svix") {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac("sha256", WEBHOOK_SECRET_BYTES).update(`${id}.${timestamp}.${text}`).digest("base64")}`;
  return (app.inject as any)({
    method: "POST",
    url: "/v1/payments/webhooks/forward",
    payload: text,
    headers: { "content-type": "application/json", [`${headerPrefix}-id`]: id, [`${headerPrefix}-timestamp`]: timestamp, [`${headerPrefix}-signature`]: signature }
  });
}

async function projectPayments(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  return (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments as any[];
}

test("a card checkout sends Forward the amount, our reference id and customer-initiated order details; the charge carries the token, billing details and a stable key", async () => {
  const client = createSessionClient();
  const { orgId, accountId, projectId } = await register(client);
  calls.length = 0;

  const config = await client.request("GET", `/v1/payments/organizations/${orgId}/payment-intake-config`);
  assert.equal(config.ready, true);
  assert.equal(config.tokenization.mode, "forward");
  assert.equal(config.tokenization.public_key, "test_pkey_fake_public");
  assert.equal(config.tokenization.sdk_url, "https://sandbox-cdn.pci.getfwd.com/sdk/forward.js");
  assert.ok(config.refund_policy);

  const { checkout } = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, {
    amount_cents: 1_000, method: "card", project_id: projectId, invoice_id: "INV-1001"
  });
  assert.match(checkout.client_secret, /_secret_/);
  assert.equal(checkout.amount_cents, 1_000);
  const intentCall = calls.find((call) => call.method === "POST" && call.path === "/payment_intents")!;
  assert.equal(intentCall.account, accountId, "acts on the merchant's account");
  assert.equal(intentCall.body.amount, 1_000);
  assert.equal(intentCall.body.reference_id, checkout.payment_id, "reference id is the payment id we will record");
  assert.deepEqual(intentCall.body.payment_method_types, ["card"]);
  // Level 2: the job site's ZIP goes as the ship-to ZIP.
  assert.deepEqual(intentCall.body.order_details, { card_not_present_type: "ecommerce", initiated_by: "customer", is_scheduled_payment: false, invoice_id: "INV-1001", ship_to_zip: "62704", ship_to_country: "US" });
  assert.match(intentCall.key, /^fm-pi-checkout_/);

  const paid = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 1_000,
    checkout_id: checkout.id,
    payment_method_id: "pm_ok_1",
    method: { type: "card" },
    billing_details: { name: "Jordan Smith", address: { address_line1: "100 Main St", postal_code: "62704" } }
  });
  assert.equal(paid.payment.id, checkout.payment_id);
  assert.equal(paid.payment.status, "settled");
  assert.equal(paid.payment.provider, "forward");
  assert.equal(paid.payment.method.last4, "4242");
  const chargeCall = calls.find((call) => call.path.endsWith("/payments") && call.method === "POST")!;
  assert.equal(chargeCall.body.payment_method_id, "pm_ok_1");
  assert.equal(chargeCall.body.reference_id, checkout.payment_id);
  assert.equal(chargeCall.body.billing_details.address.postal_code, "62704");
  assert.equal(chargeCall.body.order_details.initiated_by, "customer");
  assert.match(chargeCall.key, /^fm-pay-checkout_.*-1$/);

  // Paying the same checkout again is refused: one checkout, one charge.
  const again = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 1_000, checkout_id: checkout.id, payment_method_id: "pm_ok_1"
  });
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).error, "payment_already_completed");
  assert.equal([...fake.payments.values()].filter((payment) => payment.reference_id === checkout.payment_id).length, 1);
});

test("Forward 503s are retried with the same idempotency key; a decline shows Forward's reason and leaves the checkout open for another card", async () => {
  const client = createSessionClient();
  const { orgId, projectId } = await register(client);
  const { checkout } = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: 555, method: "card", project_id: projectId });
  calls.length = 0;

  const declined = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 555, checkout_id: checkout.id, payment_method_id: "pm_decline_1"
  });
  assert.equal(declined.statusCode, 400);
  const declinedBody = JSON.parse(declined.body);
  assert.equal(declinedBody.error, "payment_declined");
  assert.equal(declinedBody.details.decline_category, "RO1");
  assert.match(declinedBody.message, /Payment authorization failed/);
  assert.equal((await projectPayments(client, orgId, projectId)).length, 0, "a decline records nothing");

  fake.once.set("pm_ok_retry", "503");
  const paid = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 555, checkout_id: checkout.id, payment_method_id: "pm_ok_retry"
  });
  assert.equal(paid.payment.status, "settled");
  const attempts = calls.filter((call) => call.path.endsWith("/payments") && call.body?.payment_method_id === "pm_ok_retry");
  assert.equal(attempts.length, 2, "the 503 was retried");
  assert.equal(attempts[0]!.key, attempts[1]!.key, "the retry reused the idempotency key");
  assert.match(attempts[0]!.key, /-2$/, "the second attempt on this checkout has its own key");
  assert.equal((await projectPayments(client, orgId, projectId)).length, 1);
});

test("a charge whose answer is lost is reported as unknown, never charged twice, and finished from Forward's record", async () => {
  const client = createSessionClient();
  const { orgId, projectId } = await register(client);
  const { checkout } = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: 1_200, method: "card", project_id: projectId });

  fake.once.set("pm_lost_1", "lost");
  const lost = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 1_200, checkout_id: checkout.id, payment_method_id: "pm_lost_1"
  });
  // The adapter retried with the same key, Forward answered with the charge
  // it already made, and the payment was recorded once.
  const charges = [...fake.payments.values()].filter((payment) => payment.reference_id === checkout.payment_id);
  assert.equal(charges.length, 1, "Forward charged exactly once");
  if (lost.statusCode < 400) {
    assert.equal(JSON.parse(lost.body).payment.id, checkout.payment_id);
  } else {
    // Or the answer stayed lost: the customer is told not to pay again and
    // the next look finishes the payment from Forward's record.
    assert.equal(JSON.parse(lost.body).error, "payment_outcome_unknown");
    const { finishCheckoutFromProvider } = await import("../payments/intake.js");
    await finishCheckoutFromProvider(orgId, checkout.id);
  }
  const payments = await projectPayments(client, orgId, projectId);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].processor.provider_payment_id, charges[0].id);

  // Forward unreachable on every retry after it charged: we look the intent
  // up instead of charging again, and record the charge Forward made.
  const second = (await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: 700, method: "card", project_id: projectId })).checkout;
  fake.once.set("pm_lost_all", "lost_all");
  const unreachable = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 700, checkout_id: second.id, payment_method_id: "pm_lost_all"
  });
  assert.equal(unreachable.statusCode, 201, unreachable.body);
  assert.equal(JSON.parse(unreachable.body).payment.id, second.payment_id);
  assert.equal([...fake.payments.values()].filter((payment) => payment.reference_id === second.payment_id).length, 1, "looked up, not charged again");
  assert.equal((await projectPayments(client, orgId, projectId)).length, 2);
});

test("refund: the whole amount before settlement is a void; after settlement Forward refunds full or part", async () => {
  const client = createSessionClient();
  const { orgId, projectId } = await register(client);
  const pay = async (amount: number, token: string) => {
    const { checkout } = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: amount, method: "card", project_id: projectId });
    return (await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, { project_id: projectId, amount_cents: amount, checkout_id: checkout.id, payment_method_id: token })).payment;
  };

  // V00: void before the payment settles.
  const first = await pay(1_200, "pm_ok_void");
  calls.length = 0;
  const voided = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${first.id}/refunds`, {});
  assert.equal(voided.provider_action, "voided");
  assert.equal(voided.payment.status, "voided");
  const cancelCall = calls.find((call) => call.path.endsWith("/cancel"))!;
  assert.equal(cancelCall.body.cancellation_reason, "requested_by_customer");
  assert.match(cancelCall.key, /^fm-void-/);
  assert.equal(calls.some((call) => call.path.endsWith("/refunds")), false, "a void is not a refund");

  // R01 and R00 on a settled payment.
  const second = await pay(1_000, "pm_ok_refund");
  for (const payment of fake.payments.values()) if (payment.payment_method_id === "pm_ok_refund") payment.settlement_status = "settled";
  calls.length = 0;
  const partial = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${second.id}/refunds`, { amount_cents: 900 });
  assert.equal(partial.provider_action, "refunded");
  assert.equal(partial.payment.status, "partially_refunded");
  assert.match(partial.refund.processor.provider_refund_id, /^ref_fake_/);
  const refundCall = calls.find((call) => call.path.endsWith("/refunds"))!;
  assert.equal(refundCall.body.amount, 900);
  assert.match(refundCall.key, /^fm-ref-/);
  const rest = await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${second.id}/refunds`, {});
  assert.equal(rest.payment.status, "refunded");
  assert.equal(rest.refund.amount_cents, 100);
  const tooMuch = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments/${second.id}/refunds`, { amount_cents: 1 });
  assert.equal(tooMuch.statusCode, 400);
});

test("a bank payment is pending until Forward says it cleared; a failed one reopens what it paid for", async () => {
  const client = createSessionClient();
  const { orgId, accountId, projectId } = await register(client);
  const { ensureReceivablesFromSchedule } = await import("../payments/storage.js");
  await ensureReceivablesFromSchedule(orgId, {
    project_id: projectId,
    source: { type: "invoice", id: `inv_${projectId}` },
    items: [{ label: "Deposit", amount_cents: 2_000, payment_kind: "deposit", due_rule: "on_signature", due_at: new Date().toISOString(), grace_days: 1, sequence: 1 } as any]
  });
  const pay = async (token: string) => {
    const { checkout } = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: 1_000, method: "bank", project_id: projectId });
    return (await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, { project_id: projectId, amount_cents: 1_000, checkout_id: checkout.id, payment_method_id: token, method: { type: "ach" } })).payment;
  };
  const intentBody = () => calls.filter((call) => call.path === "/payment_intents").at(-1)!.body;

  calls.length = 0;
  const cleared = await pay("pm_bank_ok");
  assert.deepEqual(intentBody().payment_method_types, ["bank"]);
  assert.equal(cleared.status, "pending", "ACH is not money in hand yet");
  const deposit = async () => (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`)).summary.obligations.find((item: any) => item.label === "Deposit");
  assert.equal((await deposit()).allocated_cents, 0, "a pending debit pays nothing yet");

  const clearedEvent = await signedWebhook({ type: "v2.payment.captured", data: { id: cleared.processor.provider_payment_id, account_id: accountId, status: "captured", payment_rail_type: "bank", reference_id: cleared.id, user_fields: { payment_id: cleared.id } } }, "msg_bank_cleared_1");
  assert.equal(clearedEvent.statusCode, 200);
  const afterClear = (await projectPayments(client, orgId, projectId)).find((payment) => payment.id === cleared.id);
  assert.equal(afterClear.status, "settled");
  assert.equal((await deposit()).allocated_cents, 1_000);

  const returned = await pay("pm_bank_returned");
  await signedWebhook({ type: "v2.payment.captured", data: { id: returned.processor.provider_payment_id, account_id: accountId, status: "captured", reference_id: returned.id, user_fields: { payment_id: returned.id } } }, "msg_bank_cleared_2");
  assert.equal((await deposit()).allocated_cents, 2_000);
  const failedEvent = await signedWebhook({ type: "v2.payment.failed", data: { id: returned.processor.provider_payment_id, account_id: accountId, status: "failed", return_message: "R01: Insufficient funds", reference_id: returned.id, user_fields: { payment_id: returned.id } } }, "msg_bank_returned_1");
  assert.equal(failedEvent.statusCode, 200);
  const afterReturn = (await projectPayments(client, orgId, projectId)).find((payment) => payment.id === returned.id);
  assert.equal(afterReturn.status, "returned");
  assert.equal(afterReturn.failure_reason, "R01: Insufficient funds");
  assert.equal((await deposit()).allocated_cents, 1_000, "the returned debit no longer pays the deposit");
});

test("autopay charges are merchant-initiated recurring charges with a stable key per attempt", async () => {
  const client = createSessionClient();
  const { orgId, projectId } = await register(client);
  const { ensureReceivablesFromSchedule } = await import("../payments/storage.js");
  await ensureReceivablesFromSchedule(orgId, {
    project_id: projectId,
    source: { type: "invoice", id: `inv_auto_${projectId}` },
    items: [{ label: "Installment", amount_cents: 1_281, payment_kind: "progress", due_rule: "on_signature", due_at: new Date(Date.now() - 86_400_000).toISOString(), grace_days: 0, sequence: 1 } as any]
  });
  const saved = await client.request("POST", `/v1/payments/organizations/${orgId}/customers/contact_auto/payment-methods`, { provider_payment_method_id: "pm_ok_saved", type: "card" });
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: saved.payment_method.id, contact_ref: { id: "contact_auto" }, customer_authorized: true
  });
  calls.length = 0;
  const run = await client.request("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
  assert.equal(run.charged.length, 1);
  const intentCall = calls.find((call) => call.path === "/payment_intents")!;
  assert.deepEqual(intentCall.body.order_details, { card_not_present_type: "recurring", initiated_by: "merchant", is_scheduled_payment: true, invoice_id: intentCall.body.order_details.invoice_id, description: "Autopay: Installment", ship_to_zip: "62704", ship_to_country: "US" });
  assert.match(intentCall.key, /^fm-pi-checkout_autopay_[a-f0-9]{20}_1$/);
  const chargeCall = calls.find((call) => call.path.endsWith("/payments"))!;
  assert.equal(chargeCall.body.payment_method_id, "pm_ok_saved");
  assert.equal(chargeCall.body.order_details.initiated_by, "merchant");
});

test("raw card numbers and bare tokens never reach Forward from our server; unapproved orgs cannot open a checkout", async () => {
  const client = createSessionClient();
  const { orgId, projectId } = await register(client);
  const raw = await client.raw("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card", card: { number: "4242424242424242", exp_month: 12, exp_year: 2030, cvc: "123" }
  });
  assert.equal(raw.statusCode, 400);
  assert.equal(JSON.parse(raw.body).error, "raw_payment_details_refused");
  const bare = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, { project_id: projectId, amount_cents: 500, payment_method_id: "pm_from_nowhere" });
  assert.equal(bare.statusCode, 400);
  assert.equal(JSON.parse(bare.body).error, "checkout_required");

  const other = createSessionClient();
  const pending = await register(other, { approved: false });
  const refused = await other.raw("POST", `/v1/payments/organizations/${pending.orgId}/payment-checkouts`, { amount_cents: 500, method: "card", project_id: pending.projectId });
  assert.equal(refused.statusCode, 409);
  assert.equal(JSON.parse(refused.body).error, "payments_not_ready");
  const config = await other.request("GET", `/v1/payments/organizations/${pending.orgId}/payment-intake-config`);
  assert.equal(config.ready, false);
  assert.equal(config.tokenization, null);
});

test("an organization approved at Forward is ready as soon as anyone asks, even before a webhook arrives", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { approved: false });
  const suffix = orgId.replace(/^org_fwdco_/, "");
  const { upsertMerchantConfig } = await import("../payments/merchant_config.js");
  await upsertMerchantConfig(orgId, {
    provider: "forward",
    forward: { business_id: `bus_${suffix}`, application_id: `aapp_${suffix}`, boarding_status: "SUBMITTED" }
  }, { skipFlag: true });
  const { paymentsReadiness } = await import("../payments/readiness.js");
  fake.applications.set(`aapp_${suffix}`, { id: `aapp_${suffix}`, status: "SUBMITTED", business_id: `bus_${suffix}` });
  const before = await paymentsReadiness(orgId);
  assert.equal(before.ready, false, "still under review at Forward");

  // Forward approves; no webhook is delivered. The next ask (a customer opening the portal) reads it.
  fake.applications.set(`aapp_${suffix}`, { id: `aapp_${suffix}`, status: "APPROVED", business_id: `bus_${suffix}` });
  fake.accounts.set(`acct_new_${suffix}`, { id: `acct_new_${suffix}`, business_id: `bus_${suffix}`, external_account_id: orgId, processing_enabled: true, payouts_enabled: true });
  const soon = await paymentsReadiness(orgId);
  assert.equal(soon.ready, false, "the processor is read at most once a minute per organization");
  const { refreshBoardingForReadiness } = await import("../payments/boarding_sync.js");
  const realNow = Date.now;
  Date.now = () => realNow() + 61_000;
  try {
    const after = await paymentsReadiness(orgId);
    assert.equal(after.ready, true, JSON.stringify(after));
    assert.equal(after.account_id, `acct_new_${suffix}`);
    assert.deepEqual(after.rails, { card: true, bank: true });
    assert.equal(await refreshBoardingForReadiness(orgId), false, "a ready organization is not read again within the minute");
  } finally {
    Date.now = realNow;
  }
});

test("a live-shaped Forward delivery (Standard Webhooks headers, CloudEvents body) is verified and applied", async () => {
  const client = createSessionClient();
  const { orgId, accountId } = await register(client);
  // What Forward sent dev on 2026-10-26: unprefixed type, record under data.object.
  const delivery = (id: string, type: string, object: any) => signedWebhook({
    data: { object }, datacontenttype: "application/json", id: `evt_${id}`, specversion: "1.1", subject: object.id, timestamp: new Date().toISOString(), type
  }, `msg_${id}`, "webhook");
  const gateway = await delivery("gateway_1", "account.gateway_updated", { id: accountId, entity: "account", status: "ACTIVE", mid: "MID-LIVE-1", processing_enabled: true, payouts_enabled: true });
  assert.equal(gateway.statusCode, 200, gateway.body);
  const { getMerchantConfigForOps } = await import("../payments/merchant_config.js");
  const config = await getMerchantConfigForOps(orgId);
  assert.equal(config?.forward.gateway_mid, "MID-LIVE-1", "the gateway MID from data.object is recorded");
  assert.ok(config?.forward.gateway_updated_at, "v2.account.gateway_updated is recognized from the unprefixed type");
  const unsigned = await (app.inject as any)({ method: "POST", url: "/v1/payments/webhooks/forward", payload: "{}", headers: { "content-type": "application/json", "webhook-id": "msg_x", "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": "v1,AAAA" } });
  assert.equal(unsigned.statusCode, 401, "a bad signature on the standard headers is still refused");
});

test("application events that arrive out of order never roll an approval back", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { approved: false });
  const suffix = orgId.replace(/^org_fwdco_/, "");
  const { upsertMerchantConfig, getMerchantConfigForOps } = await import("../payments/merchant_config.js");
  await upsertMerchantConfig(orgId, { provider: "forward", forward: { business_id: `bus_${suffix}`, application_id: `aapp_${suffix}`, boarding_status: "DRAFT" } }, { skipFlag: true });
  const app = (id: string, type: string, status: string, at: string) => signedWebhook({
    data: { object: { id: `aapp_${suffix}`, entity: "application", status, business_id: `bus_${suffix}`, external_account_id: orgId } }, id: `evt_${id}`, timestamp: at, type
  }, `msg_${id}`, "webhook");
  assert.equal((await app("approved", "application.manually_approved", "MANUALLY_APPROVED", "2026-10-26T18:50:02Z")).statusCode, 200);
  // Replayed later: an older update still saying DRAFT.
  assert.equal((await app("older", "application.updated", "DRAFT", "2026-10-26T18:50:01Z")).statusCode, 200);
  assert.equal((await getMerchantConfigForOps(orgId))?.forward.boarding_status, "APPROVED");
});

test("Forward reversing a whole bank payment is recorded as a returned payment, not a refund", async () => {
  const client = createSessionClient();
  const { orgId, accountId, projectId } = await register(client);
  const prepared = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-checkouts`, { amount_cents: 555, method: "bank", project_id: projectId });
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: 555, kind: "customer_payment", direction: "inbound", method: { type: "ach", label: "Bank" },
    payment_method_id: "pm_bank_return_1", checkout_id: prepared.checkout.id
  });
  const recorded = (await projectPayments(client, orgId, projectId)).find((payment) => payment.direction === "inbound");
  const reversal = await signedWebhook({
    data: { object: { id: "revsl_return_1", entity: "reversal", amount: 555, payment_id: recorded.processor.provider_payment_id, account_id: accountId, reason: "R01: Insufficient funds" } },
    id: "evt_return_1", timestamp: new Date().toISOString(), type: "reversal.created"
  }, "msg_return_1", "webhook");
  assert.equal(reversal.statusCode, 200, reversal.body);
  const after = (await projectPayments(client, orgId, projectId)).find((payment) => payment.id === recorded.id);
  assert.equal(after.status, "returned");
  assert.equal(after.processor.provider_reversal_id, "revsl_return_1");
  assert.equal((await projectPayments(client, orgId, projectId)).filter((payment) => payment.kind === "customer_refund").length, 0, "no refund is booked for a return");
});

