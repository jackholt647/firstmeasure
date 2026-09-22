import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Autopay + unmatched-settlements reconciliation + Phase 0 gap fixes:
 * enrollment guards, runner charge with exact fee/allocation, decline →
 * retry (>=24h spacing) → pause dunning driven through the runner's `now`
 * injection, no-double-charge, unmatched match/dismiss roundtrip, the
 * document-output payment_transactions row (with replay idempotency), and the
 * server-side money.invoices / money.take_payment enforcement.
 */

let app: any = null;
let storageRoot = "";

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const HOUR = 60 * 60 * 1000;

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
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
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-autopay-test-"));
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
  process.env.FORWARD_WEBHOOK_SECRET = "";

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

async function register(client: ReturnType<typeof createSessionClient>, flags: Record<string, unknown> = {}) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `autopay-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Autopay Owner",
    company: "Autopay Test Org",
    organization_id: `org_autopay_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, proposals: true, money: true },
        money: { merchant_processing: true, invoices: true, ...flags }
      }
    }
  }, { replace: false });
  return { orgId };
}

/** $2,500 deposit (due on signature) + $10,000 final. */
async function signedProposalProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "7 Autopay Way",
      title: "Autopay Roof",
      contacts: [{ id: "contact_autopay", role: "customer", name: "Amy Auto", email: "amy-auto@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Autopay Proposal",
    contacts: [{ role: "customer", name: "Amy Auto", email: "amy-auto@example.test" }],
    editable: {
      title: "Autopay Proposal",
      pricing: { total: 12500 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof", quantity: "1", amount: 12500 }] },
        { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000, financedAmount: 0 }
      ]
    }
  });
  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Amy Auto", email: "amy-auto@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  await client.request("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Amy Auto",
    signature: { type: "adopt", text: "Amy Auto" }
  });
}

async function boardMockMerchant(client: ReturnType<typeof createSessionClient>, orgId: string) {
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
  const { getBoardingProvider } = await import("../payments/providers/index.js");
  const boarding = (await getBoardingProvider(orgId))!;
  const application = await boarding.createApplication({
    processing_plan_id: US_PLAN_ID,
    external_account_id: orgId,
    company: { legal_name: "Autopay Test Org LLC" }
  });
  await boarding.submitApplication(application.id);
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    application_id: application.id,
    to: "APPROVED"
  });
}

async function savedMethodFromCard(client: ReturnType<typeof createSessionClient>, orgId: string, contactRef: string, pan: string) {
  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: pan, exp_month: 12, exp_year: 2032, cvc: "123", name: "Amy Auto", zip: "90210" }
  });
  const saved = await client.request("POST", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods`, {
    provider_payment_method_id: tokenized.intent.payment_method_id
  });
  return saved.payment_method;
}

const projectPayments = async (client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) =>
  (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;

const projectObligations = async (client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) =>
  (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/obligations`)).obligations;

test("enrollment guards: provider required, saved method must exist, contact must match", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_autopay_guards";
  await signedProposalProject(client, orgId, projectId);

  // No provider boarded yet -> enrollment refuses.
  const noProvider = await client.raw("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: "saved_method_missing"
  });
  assert.equal(noProvider.statusCode, 400);
  assert.equal(JSON.parse(noProvider.body).error, "autopay_provider_required");

  await boardMockMerchant(client, orgId);

  const missingMethod = await client.raw("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: "saved_method_missing"
  });
  assert.equal(missingMethod.statusCode, 400);
  assert.equal(JSON.parse(missingMethod.body).error, "saved_method_not_found");

  const method = await savedMethodFromCard(client, orgId, "contact_autopay", "4242424242424242");
  const wrongContact = await client.raw("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: method.id,
    contact_ref: { id: "contact_somebody_else" }
  });
  assert.equal(wrongContact.statusCode, 400);
  assert.equal(JSON.parse(wrongContact.body).error, "autopay_method_contact_mismatch");

  const enrolled = await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: method.id,
    contact_ref: { id: "contact_autopay", email: "amy-auto@example.test" }
  });
  assert.equal(enrolled.autopay.status, "active");
  assert.equal(enrolled.autopay.saved_method_id, method.id);
  assert.match(enrolled.autopay.method_label, /Visa ending in 4242/);

  const fetched = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`);
  assert.equal(fetched.autopay.status, "active");

  const removed = await client.request("DELETE", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`);
  assert.equal(removed.autopay.saved_method_id, method.id);
  const afterRemove = await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`);
  assert.equal(afterRemove.autopay, null);
});

test("runner charges the due obligation with exact fee + allocation and never double-charges", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_autopay_charge";
  await boardMockMerchant(client, orgId);
  await signedProposalProject(client, orgId, projectId);
  const method = await savedMethodFromCard(client, orgId, "contact_autopay", "4242424242424242");
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: method.id,
    contact_ref: { id: "contact_autopay" }
  });

  const run = await client.request("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
  assert.equal(run.charged.length, 1, `runner charges the due deposit: ${JSON.stringify(run)}`);
  assert.equal(run.charged[0].amount_cents, 250_000);
  assert.equal(run.failed.length, 0);

  const payments = await projectPayments(client, orgId, projectId);
  assert.equal(payments.length, 1);
  const payment = payments[0];
  assert.equal(payment.amount_cents, 250_000);
  assert.equal(payment.provider, "mock");
  // US flat-rate plan: 2 bps of $2,500.00 = 50c + 30c auth fee.
  assert.equal(payment.fee_cents, 80);
  assert.equal(payment.merchant_amount_cents, 249_920);
  assert.equal(payment.method.type, "saved_card");
  assert.equal(payment.metadata.autopay, true);

  const obligations = await projectObligations(client, orgId, projectId);
  const deposit = obligations.find((entry: any) => /deposit/i.test(entry.label));
  assert.equal(deposit.allocated_cents, 250_000, "allocation targets the due deposit obligation exactly");
  assert.equal(deposit.status, "paid");
  const final = obligations.find((entry: any) => /final/i.test(entry.label));
  assert.equal(final.allocated_cents, 0, "the not-yet-due final obligation is untouched");

  // Second pass: the obligation is paid — nothing new charges.
  const rerun = await client.request("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
  assert.equal(rerun.charged.length, 0, "no double charge on a satisfied obligation");
  assert.equal((await projectPayments(client, orgId, projectId)).length, 1);

  // The success path records the payment event trail.
  const events = (await client.request("GET", `/v1/payments/organizations/${orgId}/events?project_id=${projectId}`)).events;
  assert.ok(events.some((event: any) => event.type === "autopay.charged"));
});

test("dunning: decline -> 24h retry spacing -> third failure pauses enrollment; resume with a good card recovers", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_autopay_dunning";
  await boardMockMerchant(client, orgId);
  await signedProposalProject(client, orgId, projectId);
  const badMethod = await savedMethodFromCard(client, orgId, "contact_autopay", "4000000000000002");
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: badMethod.id,
    contact_ref: { id: "contact_autopay" }
  });

  const t0 = Date.now();
  const runAt = (ms: number) => client.request("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {
    now: new Date(ms).toISOString()
  });

  // Attempt 1: decline recorded, enrollment stays active.
  let run = await runAt(t0);
  assert.equal(run.failed.length, 1);
  assert.equal(run.failed[0].decline_category, "generic_decline");
  assert.equal(run.failed[0].paused, false);
  let autopay = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`)).autopay;
  assert.equal(autopay.status, "active");
  assert.equal(autopay.failures.length, 1);
  assert.equal(autopay.failures[0].decline_category, "generic_decline");
  assert.ok(autopay.failures[0].message);

  // Same instant + 1h later: retry spacing (>=24h) blocks a second attempt.
  run = await runAt(t0);
  assert.equal(run.failed.length, 0);
  assert.ok(run.skipped.some((entry: any) => entry.reason === "retry_spacing"));
  run = await runAt(t0 + HOUR);
  assert.equal(run.failed.length, 0);
  assert.ok(run.skipped.some((entry: any) => entry.reason === "retry_spacing"));

  // Attempt 2 after 25h, attempt 3 after 50h -> pause.
  run = await runAt(t0 + 25 * HOUR);
  assert.equal(run.failed.length, 1);
  assert.equal(run.failed[0].paused, false);
  run = await runAt(t0 + 50 * HOUR);
  assert.equal(run.failed.length, 1);
  assert.equal(run.failed[0].paused, true, "third decline pauses the enrollment");
  autopay = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`)).autopay;
  assert.equal(autopay.status, "paused");
  assert.equal(autopay.paused_reason, "max_attempts");
  assert.equal(autopay.failures.length, 3);

  // Paused enrollments never attempt again.
  run = await runAt(t0 + 100 * HOUR);
  assert.equal(run.failed.length, 0);
  assert.equal(run.charged.length, 0);

  // No transaction was ever written for the declined charges.
  assert.equal((await projectPayments(client, orgId, projectId)).length, 0);

  // Events: three failures then the pause marker.
  const events = (await client.request("GET", `/v1/payments/organizations/${orgId}/events?project_id=${projectId}`)).events;
  assert.equal(events.filter((event: any) => event.type === "autopay.charge_failed").length, 3);
  assert.equal(events.filter((event: any) => event.type === "autopay.paused").length, 1);

  // Resume with a good method: attempts reset, next pass charges.
  const goodMethod = await savedMethodFromCard(client, orgId, "contact_autopay", "4242424242424242");
  const resumed = await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: goodMethod.id,
    status: "active"
  });
  assert.equal(resumed.autopay.status, "active");
  assert.equal(resumed.autopay.failures.length, 0, "resume clears the failure list");
  run = await runAt(t0 + 101 * HOUR);
  assert.equal(run.charged.length, 1);
  const payments = await projectPayments(client, orgId, projectId);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].amount_cents, 250_000);
});

test("max_amount_cents skips over-limit obligations", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_autopay_max";
  await boardMockMerchant(client, orgId);
  await signedProposalProject(client, orgId, projectId);
  const method = await savedMethodFromCard(client, orgId, "contact_autopay", "4242424242424242");
  await client.request("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
    saved_method_id: method.id,
    contact_ref: { id: "contact_autopay" },
    max_amount_cents: 100_000
  });
  const run = await client.request("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
  assert.equal(run.charged.length, 0);
  assert.ok(run.skipped.some((entry: any) => entry.reason === "over_max_amount"));
  assert.equal((await projectPayments(client, orgId, projectId)).length, 0);
});

test("unmatched settlements: orphan provider payment -> queue -> match merges provider fields; dismiss clears", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_autopay_unmatched";
  await boardMockMerchant(client, orgId);
  await signedProposalProject(client, orgId, projectId);

  // A real recorded (offline) payment the orphan settlement belongs to.
  const recorded = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    method: { type: "check", label: "Check" }
  });
  const paymentId = recorded.payment.id as string;
  assert.equal(recorded.payment.provider, undefined);

  // Orphan provider payment: no local reference -> shadow record in queue.
  const orphan = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    op: "orphan_payment",
    amount_cents: 250_000
  });
  assert.match(orphan.payment.id, /^pay_mock_/);
  let queue = (await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation/unmatched`)).records;
  assert.equal(queue.length, 1);
  const shadow = queue[0];
  assert.equal(shadow.kind, "provider_payment");
  assert.equal(shadow.status, "pending");
  assert.equal(shadow.amount_cents, 250_000);
  assert.equal(shadow.processor.provider_payment_id, orphan.payment.id);
  assert.ok(shadow.fee_cents > 0, "shadow carries the provider fee");

  // Shadow records stay out of the project payments and collected totals.
  assert.equal((await projectPayments(client, orgId, projectId)).length, 1);

  // Match: provider fields merge onto the real transaction, shadow deleted.
  const matched = await client.request("POST", `/v1/payments/organizations/${orgId}/reconciliation/unmatched/${shadow.id}/match`, {
    payment_id: paymentId
  });
  assert.equal(matched.payment.id, paymentId);
  assert.equal(matched.payment.processor.provider_payment_id, orphan.payment.id);
  assert.equal(matched.payment.fee_cents, shadow.fee_cents);
  assert.equal(matched.payment.merchant_amount_cents, shadow.merchant_amount_cents);
  assert.equal(matched.payment.metadata.reconciled_from_unmatched, shadow.id);
  queue = (await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation/unmatched`)).records;
  assert.equal(queue.length, 0, "matched shadow leaves the queue");
  const { listDocuments } = await import("../platform/storage.js");
  const transactions = (await listDocuments(orgId, "payment_transactions")).map((doc: any) => doc.data);
  assert.equal(transactions.filter((entry: any) => entry.id === shadow.id).length, 0, "shadow record is deleted");

  // Dismiss roundtrip on a second orphan.
  const orphan2 = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    op: "orphan_payment",
    amount_cents: 5_000
  });
  queue = (await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation/unmatched`)).records;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].processor.provider_payment_id, orphan2.payment.id);
  await client.request("POST", `/v1/payments/organizations/${orgId}/reconciliation/unmatched/${queue[0].id}/dismiss`, {
    reason: "test fee sweep"
  });
  queue = (await client.request("GET", `/v1/payments/organizations/${orgId}/reconciliation/unmatched`)).records;
  assert.equal(queue.length, 0);
  const events = (await client.request("GET", `/v1/payments/organizations/${orgId}/events`)).events;
  assert.ok(events.some((event: any) => event.type === "reconciliation.unmatched_matched"));
  assert.ok(events.some((event: any) => event.type === "reconciliation.unmatched_dismissed"));
});

test("document payment output records a payment_transactions row exactly once (replay-safe)", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true,
      "documents.esign": true,
      "documents.payments": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true
    }
  });
  const projectId = "project_autopay_docpay";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "9 Document Pay Lane",
      title: "Document Pay",
      contacts: [{ id: "contact_docpay", name: "Dee Docpay", email: "dee-docpay@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    title: "Doc Pay Proposal",
    params: {
      customer: { name: "Dee Docpay", email: "dee-docpay@example.test" },
      scope_items: [{ id: "item_1", name: "Roof", quantity: 1, unit: "job", unit_price: 12500 }],
      deposit_cents: 250000
    }
  });
  const documentId = created.document.id as string;

  const paid = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/deposit_payment`, {
    value: { amount_cents: 1, payment_method: "card", reference: "pay_doc_1" }
  });
  const outputValue = paid.document.outputs.deposit_payment;
  assert.equal(outputValue.amount_cents, 250_000, "server-computed deposit is authoritative");
  assert.ok(outputValue.payment_id, "the output now records the transaction id");

  let payments = await projectPayments(client, orgId, projectId);
  assert.equal(payments.length, 1, "the document payment writes a payment_transactions row");
  const transaction = payments[0];
  assert.equal(transaction.id, outputValue.payment_id);
  assert.equal(transaction.amount_cents, 250_000);
  assert.equal(transaction.method.type, "mock_document", "legacy/mock document path uses the mock_document method type");
  assert.equal(transaction.metadata.document_output_id, `${documentId}:deposit_payment`);
  assert.equal(transaction.contact_ref.email, "dee-docpay@example.test");

  // The document.payment.received event still emits (now with payment_id).
  const events = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`)).events;
  const received = events.find((event: any) => event.type === "document.payment.received");
  assert.ok(received, "document.payment.received event is preserved");
  assert.equal(received.payload.payment_id, outputValue.payment_id);

  // Replayed output: no duplicate transaction row.
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/outputs/deposit_payment`, {
    value: { amount_cents: 1, payment_method: "card", reference: "pay_doc_replay" }
  });
  payments = await projectPayments(client, orgId, projectId);
  assert.equal(payments.length, 1, "replayed output never double-creates the transaction");
});

test("server-side enforcement: invoice routes 403 without money.invoices, payment routes 403 without money.take_payment", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { invoices: false, take_payment: false });
  const projectId = "project_autopay_enforcement";
  await signedProposalProject(client, orgId, projectId);

  const invoiceDenied = await client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    line_items: [{ description: "Blocked", amount_cents: 1000 }]
  });
  assert.equal(invoiceDenied.statusCode, 403);
  assert.equal(JSON.parse(invoiceDenied.body).error, "app_flag_disabled");

  const quickDenied = await client.raw("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices/quick`, {});
  assert.equal(quickDenied.statusCode, 403);
  assert.equal(JSON.parse(quickDenied.body).error, "app_flag_disabled");

  const paymentDenied = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 10_000,
    method: { type: "card", label: "Card" }
  });
  assert.equal(paymentDenied.statusCode, 403);
  assert.equal(JSON.parse(paymentDenied.body).error, "app_flag_disabled");

  const autopayRunDenied = await client.raw("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
  assert.equal(autopayRunDenied.statusCode, 403);

  // Flip the flags on: the same calls succeed (server gate, not the UI).
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, proposals: true, money: true },
        money: { merchant_processing: true, invoices: true, take_payment: true }
      }
    }
  }, { replace: false });
  const payment = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 10_000,
    method: { type: "card", label: "Card" }
  });
  assert.equal(payment.payment.amount_cents, 10_000);
  const invoices = await client.request("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
    line_items: [{ description: "Allowed", amount_cents: 1000 }]
  });
  assert.ok(invoices.invoice.id);
});
