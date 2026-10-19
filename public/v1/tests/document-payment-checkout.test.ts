/**
 * A customer pays a document through its checkout: a declined card, then
 * another card on the same checkout. The document's output is recorded inside
 * the signing transaction, which on PostgreSQL rolls back everything written
 * in it when it throws; the charge must not be inside it, or the decline's
 * attempt is lost and the next card replays the first attempt's answer.
 *
 * Runs on the default stores, and on PostgreSQL with
 *   node tests/run-embedded-postgres.mjs tests/document-payment-checkout.test.ts
 */
import { putProjectContacts } from "./helpers/project-contacts.js";
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();
let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => (app.inject as any)({
    method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}) }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    if (method === "POST" && url.endsWith("/send")) payload = { consent_contact: "support@example.test", ...(payload as object || {}) };
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const session = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (session || csrfCookie) {
      cookie = [session || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "fm-document-payment-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    FIRSTMEASURE_JOB_WORKERS: "0",
    WORK_SCHEDULER_DISABLED: "1",
    PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    EMAIL_OUTBOUND_DISABLED: "1",
    V1_LOG_LEVEL: "error"
  });
  if (databaseUrl) {
    const reset = new pg.Client({ connectionString: databaseUrl });
    await reset.connect();
    await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
    await reset.query("CREATE SCHEMA public");
    await reset.end();
    // Production runs one connection per Node worker: nothing may need a second one mid-transaction.
    Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  }
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  if (!appSource.includes("registerDocumentsApi")) {
    const { registerDocumentsApi } = await import("../documents/api.js");
    await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  }
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (databaseUrl) {
    await (await import("../platform/sql_store.js")).closeSqlStoresForTests().catch(() => undefined);
    await (await import("../src/database/postgres.js")).closePostgresPools().catch(() => undefined);
  }
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Document Payment Org",
    organization_id: `org_docpay_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true, "documents.payments": true, "documents.esign": true, "platform.customer_portal": true,
      "customer_portal.payments": true, "platform.money": true, "money.take_payment": true, "money.merchant_processing": true
    }
  });
  const { upsertMerchantConfig } = await import("../payments/merchant_config.js");
  await upsertMerchantConfig(orgId, { provider: "mock", forward: { account_id: "acct_mock_docpay", boarding_status: "APPROVED", processing_enabled: true } }, { skipFlag: true });
  return orgId;
}

async function cardToken(orgId: string, number: string) {
  const { createMockAdapter } = await import("../payments/providers/mock.js");
  return (await createMockAdapter(orgId).createPaymentMethodIntent({ type: "card", card: { number, exp_month: 12, exp_year: 2032, cvc: "123" } })).payment_method_id;
}

test("a declined card and then another card on the same document checkout: one charge, one payment", async () => {
  const client = createSessionClient();
  const orgId = await registerOrg(client);
  const projectId = "project_document_checkout_retry";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "233 South Wacker Drive, Chicago, IL 60606", title: "Jordan Smith", project_type: "residential", photos: [] },
    metadata: { kind: "platform_project" }
  });
  await putProjectContacts(client, orgId, projectId, [{ name: "Jordan Smith", email: "jordan@example.test", phone: "555-111-2222" }]);
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal", template_id: "tpl_kitchen_estimate", workflow_id: null, title: "Deposit Agreement",
    params: { customer: { name: "Jordan Smith", email: "jordan@example.test" }, scope_items: [{ id: "item_roof", name: "Roof replacement", quantity: 1, unit: "job", unit_price: 100 }], deposit_cents: 1000, tax_percent: 0 }
  });
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/issue`, {});
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/send`, {
    recipients: [{ name: "Jordan Smith", email: "jordan@example.test", role: "customer" }]
  });
  const publicToken = sent.snapshot.public_token;
  const prepared = await client.request("POST", `/v1/documents/public/${publicToken}/payments/checkout`, { output_key: "deposit_payment", method: "card" });
  const checkoutId = prepared.checkout.id;

  const submit = (token: string) => client.raw("POST", `/v1/documents/public/${publicToken}/outputs/deposit_payment`, {
    value: { intent: "paid", method: "card", payment_method: "card", amount_cents: 1000, payment_method_id: token, checkout_id: checkoutId },
    evidence: { timezone: "America/Chicago", locale: "en-US" }
  });
  const declined = await submit(await cardToken(orgId, "4000000000000002"));
  assert.equal(declined.statusCode, 400, declined.body);
  assert.equal(JSON.parse(declined.body).error, "payment_declined");

  const { checkoutStatusView } = await import("../payments/intake.js");
  const afterDecline = await checkoutStatusView(orgId, checkoutId);
  assert.equal(afterDecline.status, "open", "a decline leaves the checkout open for another card");
  assert.equal(afterDecline.attempts, 1, "the declined attempt is kept even though the document output was refused");

  const paid = await submit(await cardToken(orgId, "4242424242424242"));
  assert.equal(paid.statusCode, 200, paid.body);
  const output = JSON.parse(paid.body).snapshot.outputs.deposit_payment;
  assert.ok(output.payment_id, "the output carries the payment");

  const finished = await checkoutStatusView(orgId, checkoutId);
  assert.equal(finished.status, "succeeded");
  assert.equal(finished.attempts, 2, "the second card was a new attempt, not a replay of the first");
  assert.equal(finished.recorded_payment_id, output.payment_id);
  const payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments
    .filter((payment: any) => payment.direction === "inbound");
  assert.equal(payments.length, 1, "exactly one payment is recorded");
  assert.equal(payments[0].amount_cents, 1000);
});
