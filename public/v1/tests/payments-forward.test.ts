import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

const WEBHOOK_SECRET_BYTES = Buffer.from("forward-test-webhook-secret-key!");
const WEBHOOK_SECRET = `whsec_${WEBHOOK_SECRET_BYTES.toString("base64")}`;

function signWebhook(id: string, timestamp: string, body: string, secretBytes: Buffer = WEBHOOK_SECRET_BYTES) {
  const digest = createHmac("sha256", secretBytes).update(`${id}.${timestamp}.${body}`).digest("base64");
  return `v1,${digest}`;
}

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}),
        ...extraHeaders
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, extraHeaders);
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
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-forward-test-"));
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
  // Webhook verification is configured; adapter API keys deliberately are not,
  // so getPaymentProvider() must resolve to null (mock behavior preserved).
  process.env.FORWARD_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.FORWARD_PRIVATE_KEY = "";
  process.env.FORWARD_PUBLIC_KEY = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
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

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `forward-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Forward Owner",
    company: "Forward Test Org",
    organization_id: `org_forward_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, money: true },
        money: { merchant_processing: true }
      }
    }
  }, { replace: false });
  return { orgId, userId: String(data.user.id) };
}

test("forward webhook signature verification accepts valid Svix-style signatures and rejects everything else", async () => {
  const { verifyForwardWebhookSignature } = await import("../payments/webhooks_forward.js");
  const body = JSON.stringify({ type: "v2.account.created", data: { id: "acct_sig_test" } });
  const id = "msg_signature_test";
  const timestamp = String(Math.floor(Date.now() / 1000));

  const valid = verifyForwardWebhookSignature({
    id, timestamp, body, signatureHeader: signWebhook(id, timestamp, body)
  });
  assert.deepEqual(valid, { ok: true });

  const multi = verifyForwardWebhookSignature({
    id, timestamp, body,
    signatureHeader: `v1,${Buffer.from("not-the-signature").toString("base64")} ${signWebhook(id, timestamp, body)}`
  });
  assert.deepEqual(multi, { ok: true }, "any matching signature among rotated entries verifies");

  const tampered = verifyForwardWebhookSignature({
    id, timestamp, body: `${body} `, signatureHeader: signWebhook(id, timestamp, body)
  });
  assert.equal(tampered.ok, false);

  const wrongSecret = verifyForwardWebhookSignature({
    id, timestamp, body, signatureHeader: signWebhook(id, timestamp, body, Buffer.from("some-other-secret-key-material"))
  });
  assert.equal(wrongSecret.ok, false);

  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 3_600);
  const stale = verifyForwardWebhookSignature({
    id, timestamp: staleTimestamp, body, signatureHeader: signWebhook(id, staleTimestamp, body)
  });
  assert.equal(stale.ok, false);

  const missing = verifyForwardWebhookSignature({ id, timestamp, body, signatureHeader: "" });
  assert.equal(missing.ok, false);
});

test("merchant config defaults to the env-derived provider, round-trips a PATCH, and merges rails", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const initial = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  // No Forward API keys in this suite -> the first org-facing read persists
  // the environment default ("mock") so boarding works on a fresh org.
  assert.equal(initial.merchant_config.provider, "mock");
  assert.equal(initial.merchant_config.forward.account_id, "");
  assert.deepEqual(initial.merchant_config.forward.enabled_rails, { card: false, bank: false, wallets: false, terminals: false });

  const patched = await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    provider: "forward",
    forward: {
      business_id: "biz_test_1",
      application_id: "app_test_1",
      account_id: "acct_test_1",
      processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m",
      boarding_status: "APPROVED",
      processing_enabled: true,
      enabled_rails: { card: true }
    }
  });
  assert.equal(patched.merchant_config.provider, "forward");
  assert.equal(patched.merchant_config.forward.account_id, "acct_test_1");
  assert.equal(patched.merchant_config.forward.processing_enabled, true);
  assert.equal(patched.merchant_config.forward.payouts_enabled, false);
  assert.deepEqual(patched.merchant_config.forward.enabled_rails, { card: true, bank: false, wallets: false, terminals: false });

  const railsOnly = await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    forward: { enabled_rails: { bank: true } }
  });
  assert.deepEqual(railsOnly.merchant_config.forward.enabled_rails, { card: true, bank: true, wallets: false, terminals: false });
  assert.equal(railsOnly.merchant_config.forward.account_id, "acct_test_1", "unrelated fields survive a partial patch");

  const reread = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(reread.merchant_config.provider, "forward");
  assert.equal(reread.merchant_config.forward.boarding_status, "APPROVED");
});

test("forward webhook verifies, routes by account id, stores events idempotently, and updates boarding state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    provider: "forward",
    forward: { business_id: "biz_hook_1", application_id: "app_hook_1", account_id: "acct_hook_1" }
  });

  const post = async (body: string, headers: Record<string, string>) => await (app.inject as any)({
    method: "POST",
    url: "/v1/payments/webhooks/forward",
    payload: body,
    headers: { "content-type": "application/json", ...headers }
  });
  const signedHeaders = (id: string, body: string) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": signWebhook(id, timestamp, body) };
  };

  const badSignature = await post(JSON.stringify({ type: "v2.account.created", data: { id: "acct_hook_1" } }), {
    "svix-id": "msg_bad", "svix-timestamp": String(Math.floor(Date.now() / 1000)), "svix-signature": "v1,AAAA"
  });
  assert.equal(badSignature.statusCode, 401);

  const payoutsBody = JSON.stringify({ type: "v2.account.payouts_enabled", data: { id: "acct_hook_1", payouts_enabled: true, processing_enabled: true } });
  const first = await post(payoutsBody, signedHeaders("msg_hook_payouts_1", payoutsBody));
  assert.equal(first.statusCode, 200);
  assert.equal(JSON.parse(first.body).received, true);

  const duplicate = await post(payoutsBody, signedHeaders("msg_hook_payouts_1", payoutsBody));
  assert.equal(duplicate.statusCode, 200);
  assert.equal(JSON.parse(duplicate.body).duplicate, true);

  const { listDocuments } = await import("../platform/storage.js");
  const events = await listDocuments(orgId, "payment_provider_events");
  assert.equal(events.length, 1, "redelivered svix message is stored once");
  assert.equal((events[0]?.data as any)?.event_type, "v2.account.payouts_enabled");

  const config = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(config.merchant_config.forward.payouts_enabled, true);
  assert.equal(config.merchant_config.forward.processing_enabled, true);
  assert.ok(config.merchant_config.forward.last_event_at);

  const applicationBody = JSON.stringify({ type: "v2.application.status_changed", data: { id: "app_hook_1", status: "NEED_INFORMATION" } });
  const applicationEvent = await post(applicationBody, signedHeaders("msg_hook_application_1", applicationBody));
  assert.equal(applicationEvent.statusCode, 200);
  const afterApplication = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(afterApplication.merchant_config.forward.boarding_status, "NEED_INFORMATION");

  const paymentBody = JSON.stringify({ type: "v2.payment.created", data: { id: "pay_hook_1", account_id: "acct_hook_1", amount: 12_500 } });
  const paymentEvent = await post(paymentBody, signedHeaders("msg_hook_payment_1", paymentBody));
  assert.equal(paymentEvent.statusCode, 200);
  assert.equal((await listDocuments(orgId, "payment_provider_events")).length, 3, "payment events persist even while handlers are stubs");

  const strangerBody = JSON.stringify({ type: "v2.account.created", data: { id: "acct_nobody_knows" } });
  const stranger = await post(strangerBody, signedHeaders("msg_hook_stranger_1", strangerBody));
  assert.equal(stranger.statusCode, 200);
  assert.equal(JSON.parse(stranger.body).ignored, true);
});

test("getPaymentProvider returns null when Forward env keys are absent", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, {
    provider: "forward",
    forward: { account_id: "acct_env_absent" }
  });
  const { getPaymentProvider, getBoardingProvider } = await import("../payments/providers/index.js");
  assert.equal(await getPaymentProvider(orgId), null, "no private key means no processor — callers keep mock behavior");
  assert.equal(await getBoardingProvider(orgId), null);
});
