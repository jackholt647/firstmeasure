import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let originalFetch: typeof globalThis.fetch;
let metaCapiRequests: Array<{ url: string; body: any }> = [];

const STRIPE_TEST_WEBHOOK_SECRET = "whsec_SO06qf7FNJJwQXK8AAG2TjVb2LSBq4b7";

function signedStripeBody(event: unknown) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", STRIPE_TEST_WEBHOOK_SECRET).update(`${timestamp}.${payload}`).digest("hex");
  return {
    payload_base64: Buffer.from(payload).toString("base64"),
    signature: `t=${timestamp},v1=${signature}`
  };
}

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
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
    let json: any = null;
    try {
      json = response.body ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-stripe-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  process.env.STRIPE_TEST_MODE = "1";
  process.env.STRIPE_TEST_WEBHOOK_SECRET = STRIPE_TEST_WEBHOOK_SECRET;
  process.env.STRIPE_TEST_SECRET_KEY = "sk_test_simulated";
  process.env.META_CAPI_ACCESS_TOKEN = "test_meta_capi_token";
  process.env.META_CAPI_TEST_EVENT_CODE = "TEST123";
  metaCapiRequests = [];

  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://graph.facebook.com/")) {
      metaCapiRequests.push({
        url,
        body: JSON.parse(String(init?.body || "{}"))
      });
      return new Response(JSON.stringify({ events_received: 1, messages: [], fbtrace_id: "meta_test_trace" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!url.startsWith("https://api.stripe.com/")) return originalFetch(input, init);
    if (url.includes("/v1/checkout/sessions/cs_test_credit")) {
      return new Response(JSON.stringify({
        id: "cs_test_credit",
        object: "checkout.session",
        livemode: false,
        mode: "payment",
        payment_status: "paid",
        amount_total: 25000,
        currency: "usd",
        customer: "cus_test_123",
        payment_intent: "pi_test_credit",
        client_reference_id: "stripe-owner@example.test",
        metadata: {
          user_email: "stripe-owner@example.test",
          org_id: "org_stripe_sim",
          credit_dollars: "250",
          paid_dollars: "250",
          bonus_dollars: "0",
          credits_qty: "250"
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/payment_intents/pi_test_credit")) {
      return new Response(JSON.stringify({
        id: "pi_test_credit",
        status: "succeeded",
        payment_method: {
          id: "pm_test_credit",
          card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2034 }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.endsWith("/v1/payment_intents") && String(init?.method || "").toUpperCase() === "POST") {
      return new Response(JSON.stringify({
        id: "pi_test_auto_topup",
        status: "succeeded",
        amount: 5000,
        currency: "usd"
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/checkout/sessions/cs_test_setup")) {
      return new Response(JSON.stringify({
        id: "cs_test_setup",
        object: "checkout.session",
        livemode: false,
        mode: "setup",
        customer: "cus_test_setup",
        setup_intent: "seti_test_setup",
        metadata: { org_id: "org_stripe_sim" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/setup_intents/seti_test_setup")) {
      return new Response(JSON.stringify({
        id: "seti_test_setup",
        status: "succeeded",
        payment_method: {
          id: "pm_test_setup",
          card: { brand: "mastercard", last4: "5555", exp_month: 8, exp_year: 2035 }
        }
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.includes("/v1/customers/")) {
      return new Response(JSON.stringify({ id: "cus_test_updated", object: "customer" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ error: { message: `Unhandled simulated Stripe URL: ${url}` } }), { status: 404, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  globalThis.fetch = originalFetch;
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

test("simulated Stripe checkout webhook credits org exactly once and saves checkout card", async () => {
  const client = createSessionClient();
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: "stripe-owner@example.test",
    password: "stripe-password",
    name: "Stripe Owner",
    company: "Stripe Simulation Roofing",
    organization_id: "org_stripe_sim"
  });
  assert.equal(registered.ok, true);

  const event = {
    id: "evt_test_credit",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: "cs_test_credit" } }
  };
  const first = await client.request("POST", "/v1/platform/stripe-webhook-proxy", signedStripeBody(event));
  assert.equal(first.success, true);
  assert.equal(first.credited, 250);
  assert.equal(first.meta_capi.ok, true);
  assert.equal(metaCapiRequests.length, 1);
  const metaRequest = metaCapiRequests[0];
  assert.ok(metaRequest);
  assert.match(metaRequest.url, /\/636685175264715\/events$/);
  assert.equal(metaRequest.body.test_event_code, "TEST123");
  assert.equal(metaRequest.body.data[0].event_name, "Purchase");
  assert.equal(metaRequest.body.data[0].event_id, "stripe_purchase:cs_test_credit");
  assert.equal(metaRequest.body.data[0].custom_data.value, 250);
  assert.equal(metaRequest.body.data[0].custom_data.currency, "USD");

  const creditsAfterFirst = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/credits?limit=20");
  assert.equal(creditsAfterFirst.balance, 250);
  assert.equal(creditsAfterFirst.ledger_count, 1);
  assert.equal(creditsAfterFirst.ledger[0].reason, "stripe_checkout_paid");

  const duplicate = await client.request("POST", "/v1/platform/stripe-webhook-proxy", signedStripeBody(event));
  assert.equal(duplicate.success, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(metaCapiRequests.length, 1);

  const creditsAfterDuplicate = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/credits?limit=20");
  assert.equal(creditsAfterDuplicate.balance, 250);
  assert.equal(creditsAfterDuplicate.ledger_count, 1);

  const portalState = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/portal-state");
  assert.equal(portalState.billing.stripe.has_payment_method, true);
  assert.equal(portalState.billing.stripe.last4, "4242");
});

test("simulated Stripe setup return saves a payment method without adding credits", async () => {
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", {
    email: "stripe-owner@example.test",
    password: "stripe-password",
    organization_id: "org_stripe_sim"
  });

  const finished = await client.request("POST", "/v1/platform/portal-action", {
    action: "billing_autotopup_setup_finish",
    actor_email: "stripe-owner@example.test",
    actor_name: "Stripe Owner",
    actor_org_id: "org_stripe_sim",
    session_id: "cs_test_setup"
  });
  assert.equal(finished.success, true);
  assert.equal(finished.fulfilled, true);

  const portalState = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/portal-state");
  assert.equal(portalState.credits.balance, 250);
  assert.equal(portalState.billing.stripe.has_payment_method, true);
  assert.equal(portalState.billing.stripe.last4, "5555");
  assert.equal(portalState.billing.stripe.brand, "mastercard");
  assert.equal(portalState.billing.stripe.payment_method_id, "pm_test_setup");
});

test("simulated auto top-up charges saved card when a spend crosses the threshold", async () => {
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", {
    email: "stripe-owner@example.test",
    password: "stripe-password",
    organization_id: "org_stripe_sim"
  });

  const billing = await client.request("POST", "/v1/platform/portal-action", {
    action: "org_update_my_billing",
    actor_email: "stripe-owner@example.test",
    actor_name: "Stripe Owner",
    actor_org_id: "org_stripe_sim",
    billing_json: JSON.stringify({
      auto_topup: { enabled: true, threshold_dollars: 245, topup_dollars: 50, cooldown_minutes: 0 }
    })
  });
  assert.equal(billing.success, true);

  const charged = await client.request("POST", "/v1/platform/organizations/org_stripe_sim/credits/charge", {
    amount: 10,
    reason: "order_submitted",
    meta: { charge_token: "auto-topup-smoke" }
  });
  assert.equal(charged.balance, 240);
  assert.equal(charged.auto_topup.success, true);
  assert.equal(charged.auto_topup.payment_intent_id, "pi_test_auto_topup");
  assert.equal(charged.auto_topup.balance, 290);

  const credits = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/credits?limit=10");
  assert.equal(credits.balance, 290);
  assert.equal(credits.ledger[0].reason, "stripe_auto_topup");
  assert.equal(credits.ledger[0].delta, 50);

  const portalState = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/portal-state");
  assert.equal(portalState.billing.auto_topup.status, "ok");
  assert.equal(portalState.billing.stripe.payment_method_id, "pm_test_setup");
});

test("simulated auto top-up does not charge after it is disabled", async () => {
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", {
    email: "stripe-owner@example.test",
    password: "stripe-password",
    organization_id: "org_stripe_sim"
  });

  const billing = await client.request("POST", "/v1/platform/portal-action", {
    action: "org_update_my_billing",
    actor_email: "stripe-owner@example.test",
    actor_name: "Stripe Owner",
    actor_org_id: "org_stripe_sim",
    billing_json: JSON.stringify({
      auto_topup: { enabled: false, threshold_dollars: 1000, topup_dollars: 100, cooldown_minutes: 0 }
    })
  });
  assert.equal(billing.success, true);

  const charged = await client.request("POST", "/v1/platform/organizations/org_stripe_sim/credits/charge", {
    amount: 10,
    reason: "order_submitted",
    meta: { charge_token: "auto-topup-disabled-smoke" }
  });
  assert.equal(charged.balance, 280);
  assert.equal(charged.auto_topup, undefined);

  const credits = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/credits?limit=10");
  assert.equal(credits.balance, 280);
  assert.notEqual(credits.ledger[0].reason, "stripe_auto_topup");

  const portalState = await client.request("GET", "/v1/platform/organizations/org_stripe_sim/portal-state");
  assert.equal(portalState.billing.auto_topup.enabled, false);
});
