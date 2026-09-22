import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Mock payment provider lifecycle — the whole Forward integration driven
 * end-to-end with NO Forward API keys: boarding + underwriting simulation,
 * fee-bearing mock payments, synthesized v2.* webhook projections, payout
 * settlement with auto-clearing, refund dedupe, dispute projection, and the
 * finance-summary read model.
 */

let app: any = null;
let storageRoot = "";

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const CAN_PLAN_ID = "partppl_3HpoagfDHkidHgm5jNA6Y0UhuAk";
const INTERCHANGE_PLUS_PLAN_ID = "partppl_mock_interchange_plus";

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-mock-test-"));
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
  // The whole point: NO Forward credentials anywhere.
  process.env.FORWARD_WEBHOOK_SECRET = "";
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
    email: `mock-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Mock Owner",
    company: "Mock Provider Test Org",
    organization_id: `org_mock_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, proposals: true, money: true },
        money: { merchant_processing: true, invoices: true }
      }
    }
  }, { replace: false });
  return { orgId, userId: String(data.user.id) };
}

/** Signed-proposal fixture (mirrors payments-api.test.ts): $2,500 deposit + $10,000 final. */
async function signedProposalProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "42 Mock Provider Way",
      title: "Mock Provider Roof",
      contacts: [{ id: "contact_mock", role: "customer", name: "Molly Mock", email: "molly-mock@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Mock Proposal",
    contacts: [{ role: "customer", name: "Molly Mock", email: "molly-mock@example.test" }],
    editable: {
      title: "Mock Proposal",
      pricing: { total: 12500 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof", quantity: "1", amount: 12500 }] },
        { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000, financedAmount: 0 }
      ]
    }
  });
  const sent = await client.request("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Molly Mock", email: "molly-mock@example.test" }],
    include_pdf: false,
    include_portal: true
  });
  await client.request("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Molly Mock",
    signature: { type: "adopt", text: "Molly Mock" }
  });
  return { publicToken: String(sent.snapshot.delivery.public_token) };
}

async function boardMockMerchant(client: ReturnType<typeof createSessionClient>, orgId: string) {
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
  const { getBoardingProvider } = await import("../payments/providers/index.js");
  const boarding = await getBoardingProvider(orgId);
  assert.ok(boarding, "mock boarding adapter resolves without Forward env keys");
  const application = await boarding!.createApplication({
    processing_plan_id: US_PLAN_ID,
    external_account_id: orgId,
    company: { legal_name: "Mock Provider Test Org LLC" }
  });
  await boarding!.submitApplication(application.id);
  await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    application_id: application.id,
    to: "APPROVED"
  });
  return { boarding: boarding!, applicationId: application.id };
}

test("mock boarding lifecycle: plans, application state machine, underwriting advance, account + config flags", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });

  const { getBoardingProvider, getPaymentProvider } = await import("../payments/providers/index.js");
  const boarding = await getBoardingProvider(orgId);
  assert.ok(boarding);
  assert.equal(boarding!.provider, "mock");
  assert.equal(await getPaymentProvider(orgId), null, "no account yet -> no payments adapter");

  const plans = await boarding!.listProcessingPlans();
  assert.deepEqual(plans.map((plan) => plan.id).sort(), [INTERCHANGE_PLUS_PLAN_ID, CAN_PLAN_ID, US_PLAN_ID].sort());
  const usPlan = plans.find((plan) => plan.id === US_PLAN_ID)!;
  assert.equal((usPlan.raw as any).type, "flat_rate");
  assert.equal((usPlan.raw as any).fees.card.rate_bps, 2);
  assert.equal((usPlan.raw as any).fees.card.auth_fee_cents, 30);
  const icPlus = plans.find((plan) => plan.id === INTERCHANGE_PLUS_PLAN_ID)!;
  assert.equal((icPlus.raw as any).type, "interchange_plus");

  const business = await boarding!.createBusiness({ name: "Mock Provider Test Org" });
  assert.match(business.id, /^biz_mock_/);
  const application = await boarding!.createApplication({
    business_id: business.id,
    processing_plan_id: US_PLAN_ID,
    external_account_id: orgId,
    company: { legal_name: "Mock Provider Test Org LLC", mcc: "1761" },
    owners: [{ name: "Mock Owner", signer: true, ownership_percent: 100 }]
  });
  assert.match(application.id, /^app_mock_/);
  assert.equal(application.status, "DRAFT");

  let config = (await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`)).merchant_config;
  assert.equal(config.forward.application_id, application.id, "application.created event stamps the config");
  assert.equal(config.forward.processing_plan_id, US_PLAN_ID);

  const submitted = await boarding!.submitApplication(application.id);
  assert.equal(submitted.status, "UNDER_REVIEW");
  config = (await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`)).merchant_config;
  assert.equal(config.forward.boarding_status, "UNDER_REVIEW");

  const needInfo = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    application_id: application.id,
    to: "NEED_INFORMATION",
    documents_requested: [{ type: "bank_statement", description: "Most recent bank statement" }]
  });
  assert.equal(needInfo.application.status, "NEED_INFORMATION");
  assert.equal(needInfo.merchant_config.forward.boarding_status, "NEED_INFORMATION");
  const reread = await boarding!.getApplication(application.id);
  assert.equal(reread.documents_requested.length, 1);
  assert.equal((reread.documents_requested[0] as any).type, "bank_statement");
  await boarding!.updateApplication(application.id, { company: { website: "https://mock.example.test" } });

  const approved = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    application_id: application.id,
    to: "APPROVED"
  });
  assert.equal(approved.application.status, "APPROVED");
  assert.match(approved.account.id, /^acct_mock_/);
  assert.equal(approved.account.external_account_id, orgId);
  assert.equal(approved.merchant_config.forward.boarding_status, "APPROVED");
  assert.equal(approved.merchant_config.forward.account_id, approved.account.id);
  assert.equal(approved.merchant_config.forward.processing_enabled, true);
  assert.equal(approved.merchant_config.forward.payouts_enabled, true, "payouts_enabled event lands after account.created");

  const bankAccounts = await boarding!.listBankAccounts();
  assert.equal(bankAccounts.length, 1);
  assert.equal(bankAccounts[0]!.status, "ACTIVE");
  assert.equal(bankAccounts[0]!.validation_status, "VALIDATED");
  assert.equal(bankAccounts[0]!.business_id, approved.account.business_id);
  const browserBankAccounts = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/bank-accounts`);
  assert.equal(browserBankAccounts.count, 1);
  assert.equal(browserBankAccounts.bank_accounts[0].business_id, approved.account.business_id);
  assert.equal(browserBankAccounts.payout_bank_account_id, bankAccounts[0]!.id);

  const provider = await getPaymentProvider(orgId);
  assert.ok(provider, "approved mock merchant resolves a payments adapter with no env keys");
  assert.equal(provider!.provider, "mock");

  const { listDocuments } = await import("../platform/storage.js");
  const events = (await listDocuments(orgId, "payment_provider_events")).map((doc: any) => doc.data);
  const eventTypes = events.map((event: any) => event.event_type);
  for (const expected of ["v2.application.created", "v2.application.submitted", "v2.application.need_information", "v2.application.approved", "v2.account.created", "v2.account.payouts_enabled"]) {
    assert.ok(eventTypes.includes(expected), `synthesized ${expected} is stored for replay`);
  }
  assert.ok(events.every((event: any) => event.provider === "mock"));
});

test("mock payments: fee capture, decline simulation, payout settlement auto-clears, finance summary, disputes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_money";
  await signedProposalProject(client, orgId, projectId);

  // Take the deposit against the real obligation through the existing flow.
  const deposit = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    method: { type: "card", label: "Card" }
  });
  const paymentId = deposit.payment.id as string;
  assert.equal(deposit.allocations.length, 1);
  assert.equal(deposit.allocations[0].amount_cents, 250_000);

  const { getPaymentProvider } = await import("../payments/providers/index.js");
  const provider = (await getPaymentProvider(orgId))!;
  const intent = await provider.createPaymentIntent({
    amount_cents: 250_000,
    reference_id: paymentId,
    user_fields: { payment_id: paymentId, project_id: projectId }
  });
  assert.match(intent.id, /^pi_mock_/);
  const charge = await provider.createPayment(intent.id, { payment_method_id: "pm_mock_visa" });
  assert.equal(charge.status, "captured");
  // US flat-rate plan: 2 bps of $2,500.00 = 50c, + 30c auth fee.
  assert.equal((charge.raw as any).fee, 80);
  assert.equal((charge.raw as any).merchant_amount, 249_920);

  // The synthesized v2.payment.* events project fee fields onto OUR record.
  let payment = (await client.request("GET", `/v1/payments/organizations/${orgId}/payments/${paymentId}`)).payment;
  assert.equal(payment.provider, "mock");
  assert.equal(payment.fee_cents, 80);
  assert.equal(payment.merchant_amount_cents, 249_920);
  assert.equal(payment.provider_status, "captured");
  assert.equal(payment.processor.provider_payment_id, charge.id);

  // Decline simulation: token suffix controls the outcome; nothing projects.
  const declineIntent = await provider.createPaymentIntent({ amount_cents: 10_000 });
  const declined = await provider.createPayment(declineIntent.id, { payment_method_id: "pm_mock_declined" });
  assert.equal(declined.status, "failed");
  assert.equal(declined.decline_reason, "generic_decline");
  const cvvIntent = await provider.createPaymentIntent({ amount_cents: 10_000 });
  const cvvFailed = await provider.createPayment(cvvIntent.id, { payment_method_id: "pm_mock_cvv_fail" });
  assert.equal(cvvFailed.decline_reason, "cvv_failure");
  const projectPayments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(projectPayments.length, 1, "declined charges never touch project transactions");

  // Pre-settlement finance summary: money captured but not yet swept.
  let summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/finance-summary`)).summary;
  assert.equal(summary.balance_pending_cents, 249_920);
  assert.equal(summary.in_transit_cents, 0);
  assert.equal(summary.paid_out_30d_cents, 0);

  // Settle: batch captured mock payments into a payout and complete it.
  const settled = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "settle" });
  assert.match(settled.payout.id, /^po_mock_/);

  const payouts = (await client.request("GET", `/v1/payments/organizations/${orgId}/payouts`)).payouts;
  assert.equal(payouts.length, 1);
  const payout = payouts[0];
  assert.equal(payout.status, "completed");
  assert.equal(payout.amount_cents, 249_920);
  assert.equal(payout.fee_cents, 80);
  assert.deepEqual(payout.transaction_ids, [paymentId]);
  assert.ok(payout.expected_arrival_at);
  assert.ok(payout.arrived_at);

  const detail = await client.request("GET", `/v1/payments/organizations/${orgId}/payouts/${payout.id}`);
  assert.equal(detail.transactions.length, 1);
  assert.equal(detail.transactions[0].id, paymentId);
  assert.equal(detail.transactions[0].project_id, projectId);
  assert.equal(detail.transactions[0].project_title, "Mock Provider Roof");

  // Payout arrival auto-set the manual cleared_at reconciliation flag.
  payment = (await client.request("GET", `/v1/payments/organizations/${orgId}/payments/${paymentId}`)).payment;
  assert.ok(payment.cleared_at, "payout completion auto-clears member transactions");
  assert.equal(payment.payout_id, payout.id);
  assert.equal(payment.reconciliation.state, "cleared");

  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/finance-summary`)).summary;
  assert.equal(summary.balance_pending_cents, 0);
  assert.equal(summary.in_transit_cents, 0);
  assert.equal(summary.paid_out_30d_cents, 249_920);
  assert.equal(summary.fees_30d_cents, 80);
  assert.equal(summary.gross_30d_cents, 250_000);
  assert.equal(summary.effective_rate_bps, 3);
  assert.equal(summary.next_expected_payout, null);
  assert.equal(summary.disputes_open_count, 0);

  // Dispute event projection: identify the payment by OUR id.
  const disputed = await client.request("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    op: "dispute",
    payment_id: paymentId,
    amount_cents: 100_000,
    reason: "product_not_received"
  });
  assert.match(disputed.dispute.id, /^dp_mock_/);
  const disputes = (await client.request("GET", `/v1/payments/organizations/${orgId}/disputes`)).disputes;
  assert.equal(disputes.length, 1);
  assert.equal(disputes[0].status, "created");
  assert.equal(disputes[0].amount_cents, 100_000);
  assert.equal(disputes[0].reason, "product_not_received");
  assert.equal(disputes[0].transaction_id, paymentId);
  assert.equal(disputes[0].project_id, projectId);
  assert.equal(disputes[0].provider_dispute_id, disputed.dispute.id);
  summary = (await client.request("GET", `/v1/payments/organizations/${orgId}/finance-summary`)).summary;
  assert.equal(summary.disputes_open_count, 1);
});

test("refund events dedupe against API-originated refunds and mirror provider-originated ones", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_refunds";
  await signedProposalProject(client, orgId, projectId);

  const deposit = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    method: { type: "card", label: "Card" }
  });
  const paymentId = deposit.payment.id as string;

  const { getPaymentProvider } = await import("../payments/providers/index.js");
  const provider = (await getPaymentProvider(orgId))!;
  const intent = await provider.createPaymentIntent({
    amount_cents: 250_000,
    reference_id: paymentId,
    user_fields: { payment_id: paymentId }
  });
  const charge = await provider.createPayment(intent.id, { payment_method_id: "pm_mock_visa" });

  const refundCount = async () => (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`))
    .payments.filter((entry: any) => entry.kind === "customer_refund").length;

  // 1) Refund initiated through OUR API, already carrying the provider refund
  //    id — the later v2.refund.created event must not double-create it.
  await client.request("POST", `/v1/payments/organizations/${orgId}/payments/${paymentId}/refunds`, {
    amount_cents: 50_000,
    processor: { provider: "mock", provider_refund_id: "ref_mock_manual_1" }
  });
  assert.equal(await refundCount(), 1);
  const { ingestForwardEvent } = await import("../payments/webhooks_forward.js");
  const duplicateEvent = {
    type: "v2.refund.created",
    data: {
      id: "ref_mock_manual_1",
      payment_id: charge.id,
      amount: 50_000,
      user_fields: { payment_id: paymentId }
    }
  };
  await ingestForwardEvent(orgId, "mockmsg_refund_dedupe_1", "v2.refund.created", duplicateEvent as any, { provider: "mock" });
  assert.equal(await refundCount(), 1, "provider echo of our own refund is deduped by provider refund id");

  // 2) Provider-originated refund (no record of ours yet) mirrors into the
  //    existing refund flow exactly once, replay-safe by message id.
  const providerRefund = await provider.createRefund(intent.id, { amount_cents: 25_000, reason: "goodwill" });
  assert.equal(await refundCount(), 2);
  const refunds = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`))
    .payments.filter((entry: any) => entry.kind === "customer_refund");
  const mirrored = refunds.find((entry: any) => entry.processor?.provider_refund_id === providerRefund.id);
  assert.ok(mirrored, "mirrored refund records the provider refund id for future dedupe");
  assert.equal(mirrored.amount_cents, 25_000);
  assert.equal(mirrored.metadata.provider_originated, true);

  const original = (await client.request("GET", `/v1/payments/organizations/${orgId}/payments/${paymentId}`)).payment;
  assert.equal(original.status, "partially_refunded");
  assert.equal(original.refunded_cents, 75_000);

  // Replaying the same synthesized message id is a no-op.
  const replay = await ingestForwardEvent(orgId, "mockmsg_refund_dedupe_1", "v2.refund.created", duplicateEvent as any, { provider: "mock" });
  assert.equal(replay.stored, false);
  assert.equal(await refundCount(), 2);
});

async function scanStorageForText(needles: string[]) {
  const { readdir, readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const hits: string[] = [];
  async function walk(dir: string) {
    let entries: any[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(json|txt|log|sqlite)?$/i.test(entry.name)) {
        const text = await readFile(full, "utf8").catch(() => "");
        for (const needle of needles) if (text.includes(needle)) hits.push(`${full}: ${needle}`);
      }
    }
  }
  await walk(storageRoot);
  return hits;
}

test("payment-method intents: mock tokenization derives tokens, maps magic declines, never persists PAN/CVC", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);

  const approvedPan = "4242424242424242";
  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: approvedPan, exp_month: 12, exp_year: 2032, cvc: "123", name: "Molly Mock", zip: "90210" }
  });
  assert.match(tokenized.intent.payment_method_id, /^pm_mock_/);
  assert.ok(tokenized.intent.client_secret);
  assert.equal(tokenized.payment_method.brand, "Visa");
  assert.equal(tokenized.payment_method.last4, "4242");
  assert.equal(tokenized.payment_method.exp_month, 12);
  assert.equal(tokenized.payment_method.exp_year, 2032);

  // Magic decline numbers map to suffixed tokens (see MOCK_MAGIC_CARDS).
  const expectations: Array<[string, RegExp]> = [
    ["4000000000000002", /_declined$/],
    ["4000000000000127", /_cvv_fail$/],
    ["4000000000000010", /_avs_fail$/],
    ["4000000000009995", /_insufficient$/],
    ["4000000000000069", /_expired$/]
  ];
  for (const [pan, pattern] of expectations) {
    const result = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
      type: "card",
      card: { number: pan, exp_month: 1, exp_year: 2031, cvc: "999" }
    });
    assert.match(result.intent.payment_method_id, pattern, `magic ${pan}`);
  }

  // Mastercard brand detection + bank tokenization keeps only last4.
  const mastercard = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "5555555555554444", exp_month: 6, exp_year: 2030, cvc: "321" }
  });
  assert.equal(mastercard.payment_method.brand, "Mastercard");
  const bank = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "bank",
    bank: { routing: "021000021", account: "000123456789", account_type: "checking", name: "Molly Mock" }
  });
  assert.equal(bank.payment_method.type, "bank");
  assert.equal(bank.payment_method.last4, "6789");

  // The whole storage root must be free of every PAN and CVC we submitted.
  const hits = await scanStorageForText([
    approvedPan, "5555555555554444", "000123456789", "4000000000000002",
    "4000000000000127", "4000000000000010", "4000000000009995", "4000000000000069",
    "\"cvc\""
  ]);
  assert.deepEqual(hits, [], "PAN/CVC must never be persisted");
});

test("provider charge path: tokenized POST /payments charges, records fees + allocation; declines write nothing", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_intake";
  await signedProposalProject(client, orgId, projectId);

  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123", zip: "90210" }
  });
  const token = tokenized.intent.payment_method_id as string;

  const charged = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    kind: "customer_payment",
    direction: "inbound",
    status: "settled",
    method: { type: "card", label: "Card" },
    contact_ref: { id: "contact_mock", name: "Molly Mock" },
    payment_method_id: token
  });
  assert.equal(charged.payment.status, "settled");
  assert.equal(charged.payment.amount_cents, 250_000);
  assert.equal(charged.payment.provider, "mock");
  // US flat-rate plan: 2 bps of $2,500.00 = 50c + 30c auth fee.
  assert.equal(charged.payment.fee_cents, 80);
  assert.equal(charged.payment.merchant_amount_cents, 249_920);
  assert.match(charged.payment.processor.provider_payment_id, /^pay_mock_/);
  assert.match(charged.payment.processor.provider_intent_id, /^pi_mock_/);
  assert.equal(charged.allocations.length, 1);
  assert.equal(charged.allocations[0].amount_cents, 250_000);
  assert.equal(charged.charge.provider_payment_id, charged.payment.processor.provider_payment_id);

  // No unmatched shadow record survives the charge; only OUR transaction.
  const { listDocuments } = await import("../platform/storage.js");
  const transactions = (await listDocuments(orgId, "payment_transactions")).map((doc: any) => doc.data);
  assert.equal(transactions.filter((entry: any) => String(entry.id).startsWith("payment_provider_")).length, 0);
  const projectPayments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(projectPayments.length, 1);

  // Decline: structured error, NO transaction.
  const declinedToken = (await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4000000000000002", exp_month: 12, exp_year: 2032, cvc: "123" }
  })).intent.payment_method_id as string;
  const declined = await client.raw("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 10_000,
    method: { type: "card", label: "Card" },
    payment_method_id: declinedToken
  });
  assert.equal(declined.statusCode, 400);
  const declinedBody = JSON.parse(declined.body);
  assert.equal(declinedBody.error, "payment_declined");
  assert.equal(declinedBody.details.decline_category, "generic_decline");
  assert.ok(declinedBody.message);
  const afterDecline = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(afterDecline.length, 1, "declined charges never write a transaction");
});

test("saved methods: CRUD endpoints, save-on-charge, charging a saved method", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_saved";
  await signedProposalProject(client, orgId, projectId);
  const contactRef = "contact_mock";

  // save_payment_method on a tokenized charge persists the method.
  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 11, exp_year: 2031, cvc: "123" }
  });
  const charged = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    method: { type: "card", label: "Card" },
    contact_ref: { id: contactRef, name: "Molly Mock" },
    payment_method_id: tokenized.intent.payment_method_id,
    save_payment_method: true
  });
  assert.ok(charged.saved_method, "save_payment_method persists the method");
  assert.equal(charged.saved_method.brand, "Visa");
  assert.equal(charged.saved_method.last4, "4242");

  let listed = (await client.request("GET", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods`)).payment_methods;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].provider, "mock");
  assert.equal(listed[0].provider_payment_method_id, tokenized.intent.payment_method_id);
  assert.match(listed[0].label, /Visa ending in 4242/);

  // Charging the saved method (saved_method_id) goes through the provider.
  const savedCharge = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 100_000,
    method: { type: "card", label: "Saved card" },
    contact_ref: { id: contactRef },
    saved_method_id: listed[0].id
  });
  assert.equal(savedCharge.payment.fee_cents, 50);
  assert.equal(savedCharge.payment.merchant_amount_cents, 99_950);
  assert.equal(savedCharge.payment.method.type, "saved_card");

  // Direct POST endpoint + intake-config exposure + DELETE.
  const another = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "5555555555554444", exp_month: 5, exp_year: 2033, cvc: "222" }
  });
  await client.request("POST", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods`, {
    provider_payment_method_id: another.intent.payment_method_id
  });
  listed = (await client.request("GET", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods`)).payment_methods;
  assert.equal(listed.length, 2);
  const intakeConfig = await client.request("GET", `/v1/payments/organizations/${orgId}/payment-intake-config?contact_ref=${contactRef}`);
  assert.equal(intakeConfig.provider, "mock");
  assert.equal(intakeConfig.tokenization.mode, "mock");
  assert.equal(intakeConfig.saved_methods.length, 2);
  assert.ok(intakeConfig.saved_methods.every((method: any) => method.type === "card" && method.provider_payment_method_id));
  const removed = await client.request("DELETE", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods/${listed[0].id}`);
  assert.equal(removed.payment_method.id, listed[0].id);
  listed = (await client.request("GET", `/v1/payments/organizations/${orgId}/customers/${contactRef}/payment-methods`)).payment_methods;
  assert.equal(listed.length, 1);
});

test("surcharge: settings flags, quote endpoint (3% capped, bank free), charge applies pass-through", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_surcharge";
  await signedProposalProject(client, orgId, projectId);

  // Default: disabled — quotes are zero even with a provider.
  let quote = (await client.request("GET", `/v1/payments/organizations/${orgId}/surcharge-quote?amount_cents=250000&method=card`)).quote;
  assert.equal(quote.surcharge_cents, 0);
  assert.equal(quote.enabled, false);

  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/payment_settings`, {
    data: { surcharge_enabled: true, surcharge_mode: "card_only" }
  });
  const settings = (await client.request("GET", `/v1/payments/organizations/${orgId}/invoices`)).settings;
  assert.equal(settings.surcharge_enabled, true);
  assert.equal(settings.surcharge_mode, "card_only");

  quote = (await client.request("GET", `/v1/payments/organizations/${orgId}/surcharge-quote?amount_cents=250000&method=card`)).quote;
  assert.equal(quote.surcharge_cents, 7_500, "3% of $2,500");
  assert.equal(quote.total_cents, 257_500);
  const bankQuote = (await client.request("GET", `/v1/payments/organizations/${orgId}/surcharge-quote?amount_cents=250000&method=bank`)).quote;
  assert.equal(bankQuote.surcharge_cents, 0, "card_only mode never surcharges bank rails");
  const capped = (await client.request("GET", `/v1/payments/organizations/${orgId}/surcharge-quote?amount_cents=10000000&method=card`)).quote;
  assert.equal(capped.surcharge_cents, 50_000, "mock surcharge respects the $500 cap");

  // Tokenized charge: surcharge rides on top, metadata records the split.
  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123" }
  });
  const charged = await client.request("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId,
    amount_cents: 250_000,
    method: { type: "card", label: "Card" },
    payment_method_id: tokenized.intent.payment_method_id
  });
  assert.equal(charged.payment.amount_cents, 257_500);
  assert.equal(charged.payment.metadata.surcharge_cents, 7_500);
  assert.equal(charged.payment.metadata.base_amount_cents, 250_000);
  assert.equal(charged.charge.surcharge_cents, 7_500);
  // Fee follows the charged total: 2 bps of $2,575 = 52c (rounded) + 30c.
  assert.equal(charged.payment.fee_cents, Math.round(257_500 * 2 / 10_000) + 30);
});

test("public portal flow: intake config, tokenized mock-deposit charges through the provider, declines record nothing", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_portal";
  const { publicToken } = await signedProposalProject(client, orgId, projectId);

  const config = await client.request("GET", `/v1/proposals/public/${publicToken}/payments/intake-config`);
  assert.equal(config.provider, "mock");
  assert.equal(config.tokenization.mode, "mock");

  const tokenized = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/payment-method-intent`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123", name: "Molly Mock", zip: "90210" }
  });
  assert.match(tokenized.intent.payment_method_id, /^pm_mock_/);

  const paid = await client.request("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {
    payment_method: "card",
    payment_method_id: tokenized.intent.payment_method_id,
    save_payment_method: true
  });
  assert.equal(paid.payment.amount_cents, 250_000);
  assert.equal(paid.payment.provider, "mock");
  assert.equal(paid.payment.fee_cents, 80);
  assert.equal(paid.payment.merchant_amount_cents, 249_920);
  assert.equal(paid.allocations.length, 1);
  assert.equal(paid.snapshot.customer_payment.status, "deposit_paid");
  assert.equal(paid.snapshot.customer_payment.mock, false);

  // save_payment_method persisted the card for the proposal contact and the
  // intake config now lists it.
  const configAfter = await client.request("GET", `/v1/proposals/public/${publicToken}/payments/intake-config`);
  assert.equal(configAfter.saved_methods.length, 1);
  assert.equal(configAfter.saved_methods[0].last4, "4242");

  // Declined magic card: structured error, no new transaction.
  const declinedToken = (await client.request("POST", `/v1/proposals/public/${publicToken}/payments/payment-method-intent`, {
    type: "card",
    card: { number: "4000000000000002", exp_month: 12, exp_year: 2032, cvc: "123" }
  })).intent.payment_method_id as string;
  const declined = await client.raw("POST", `/v1/proposals/public/${publicToken}/payments/mock-deposit`, {
    payment_method: "card",
    amount_cents: 5_000,
    payment_method_id: declinedToken
  });
  assert.equal(declined.statusCode, 400);
  const declinedBody = JSON.parse(declined.body);
  assert.equal(declinedBody.error, "payment_declined");
  assert.equal(declinedBody.details.decline_category, "generic_decline");
  const payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.length, 1);

  // Legacy behavior stays available: no token -> mock record path unchanged.
  const legacyOrgClient = createSessionClient();
  const { orgId: legacyOrgId } = await register(legacyOrgClient);
  const { publicToken: legacyToken } = await signedProposalProject(legacyOrgClient, legacyOrgId, "project_mock_legacy");
  const legacyPaid = await legacyOrgClient.request("POST", `/v1/proposals/public/${legacyToken}/payments/mock-deposit`, {
    payment_method: "card"
  });
  assert.equal(legacyPaid.payment.method.type, "mock_customer_portal");
  assert.equal(legacyPaid.payment.provider, undefined);
  assert.equal(legacyPaid.snapshot.customer_payment.mock, true);
  const legacyConfig = await legacyOrgClient.request("GET", `/v1/proposals/public/${legacyToken}/payments/intake-config`);
  assert.equal(legacyConfig.provider, null);
});

const DOC_SCOPE_ITEMS = [
  { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 12500 },
  { id: "item_gutter", name: "Gutter guards", description: "Leaf protection", quantity: 2, unit: "run", unit_price: 500 }
];
const mockCardFee = (totalCents: number) => Math.round(totalCents * 2 / 10_000) + 30; // US flat-rate plan

async function applyDocumentCapabilities(client: ReturnType<typeof createSessionClient>, orgId: string) {
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true,
      "documents.esign": true,
      "documents.payments": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true,
      "platform.money": true,
      "money.take_payment": true,
      "money.merchant_processing": true
    }
  });
}

/** Roofing sign-and-pay document (30% deposit schedule -> $4,050 deposit on a $13,500 total). */
async function paymentDocument(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string, title: string) {
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: "tpl_roofing_signature_payment",
    title,
    params: {
      customer: { name: "Molly Mock", email: "molly-mock@example.test" },
      scope_items: DOC_SCOPE_ITEMS,
      tax_percent: 0
    }
  });
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/issue`, {});
  const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/send`, {
    recipients: [{ name: "Molly Mock", email: "molly-mock@example.test", role: "customer" }]
  });
  return { documentId: created.document.id as string, publicToken: String(sent.snapshot.public_token) };
}

test("document engine: tokenized payment output charges once through the provider (idempotent), declines fail the output, legacy stays mock", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  await applyDocumentCapabilities(client, orgId);
  const projectId = "project_mock_doc_output";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "7 Document Checkout Way",
      title: "Mock Document Checkout",
      contacts: [{ id: "contact_mock", role: "customer", name: "Molly Mock", email: "molly-mock@example.test", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const { documentId, publicToken } = await paymentDocument(client, orgId, projectId, "Tokenized Checkout Agreement");

  // The DOCUMENT-token intake config mirrors the proposal-token one.
  const config = await client.request("GET", `/v1/documents/public/${publicToken}/payments/intake-config`);
  assert.equal(config.provider, "mock");
  assert.equal(config.tokenization.mode, "mock");
  assert.equal(config.saved_methods.length, 0);

  // Tokenize over the document token, then record the payment output with it.
  const tokenized = await client.request("POST", `/v1/documents/public/${publicToken}/payments/payment-method-intent`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123", name: "Molly Mock", zip: "90210" }
  });
  assert.match(tokenized.intent.payment_method_id, /^pm_mock_/);
  const paid = await client.request("POST", `/v1/documents/public/${publicToken}/outputs/deposit_payment`, {
    value: { payment_method: "card", payment_method_id: tokenized.intent.payment_method_id, save_payment_method: true },
    evidence: { timezone: "America/Los_Angeles", locale: "en-US" }
  });
  assert.equal(paid.snapshot.outputs.deposit_payment.amount_cents, 405_000, "server charges the scheduled 30% deposit");
  assert.ok(paid.snapshot.outputs.deposit_payment.payment_id);
  assert.equal(paid.snapshot.outputs.deposit_payment.provider, "mock");

  let payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.length, 1);
  const charged = payments[0];
  assert.equal(charged.id, paid.snapshot.outputs.deposit_payment.payment_id);
  assert.equal(charged.amount_cents, 405_000);
  assert.equal(charged.provider, "mock");
  assert.equal(charged.fee_cents, mockCardFee(405_000));
  assert.equal(charged.merchant_amount_cents, 405_000 - mockCardFee(405_000));
  assert.match(charged.processor.provider_payment_id, /^pay_mock_/);
  assert.equal(charged.metadata.document_output_id, `${documentId}:deposit_payment`);
  assert.equal(charged.kind, "customer_payment");

  // save_payment_method persisted the card for the document's customer.
  const configAfter = await client.request("GET", `/v1/documents/public/${publicToken}/payments/intake-config`);
  assert.equal(configAfter.saved_methods.length, 1);
  assert.equal(configAfter.saved_methods[0].last4, "4242");

  // Idempotency: replaying the same output write finds the prior provider
  // charge through metadata.document_output_id — no second charge, ever.
  const replay = await client.request("POST", `/v1/documents/public/${publicToken}/outputs/deposit_payment`, {
    value: { payment_method: "card", payment_method_id: tokenized.intent.payment_method_id },
    evidence: {}
  });
  assert.equal(replay.snapshot.outputs.deposit_payment.payment_id, charged.id, "replay resolves to the same transaction");
  payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.length, 1, "replayed output never double-charges");

  // Declined magic card on a fresh document: structured 400, output not
  // recorded, no transaction.
  const second = await paymentDocument(client, orgId, projectId, "Declined Checkout Agreement");
  const declinedToken = (await client.request("POST", `/v1/documents/public/${second.publicToken}/payments/payment-method-intent`, {
    type: "card",
    card: { number: "4000000000000002", exp_month: 12, exp_year: 2032, cvc: "123" }
  })).intent.payment_method_id as string;
  const declined = await client.raw("POST", `/v1/documents/public/${second.publicToken}/outputs/deposit_payment`, {
    value: { payment_method: "card", payment_method_id: declinedToken },
    evidence: {}
  });
  assert.equal(declined.statusCode, 400);
  const declinedBody = JSON.parse(declined.body);
  assert.equal(declinedBody.error, "payment_declined");
  assert.equal(declinedBody.details.decline_category, "generic_decline");
  payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.length, 1, "declined document checkout writes nothing");
  const declinedSnapshot = await client.request("GET", `/v1/documents/public/${second.publicToken}`);
  assert.equal(declinedSnapshot.snapshot.outputs?.deposit_payment, undefined, "declined charge fails the output write");

  // Legacy org (no provider): the document mock-record path is unchanged.
  const legacyClient = createSessionClient();
  const { orgId: legacyOrgId } = await register(legacyClient);
  await applyDocumentCapabilities(legacyClient, legacyOrgId);
  const legacyProjectId = "project_mock_doc_legacy";
  await legacyClient.request("PUT", `/v1/platform/organizations/${legacyOrgId}/projects/${legacyProjectId}`, {
    data: { id: legacyProjectId, address: "8 Legacy Lane", title: "Legacy Document", contacts: [{ id: "contact_mock", name: "Molly Mock", email: "molly-mock@example.test", primary: true }] },
    metadata: { kind: "platform_project" }
  });
  const legacyDoc = await paymentDocument(legacyClient, legacyOrgId, legacyProjectId, "Legacy Checkout Agreement");
  const legacyConfig = await legacyClient.request("GET", `/v1/documents/public/${legacyDoc.publicToken}/payments/intake-config`);
  assert.equal(legacyConfig.provider, null);
  const legacyPaid = await legacyClient.request("POST", `/v1/documents/public/${legacyDoc.publicToken}/outputs/deposit_payment`, {
    value: { payment_method: "ach", amount_cents: 0 },
    evidence: {}
  });
  assert.equal(legacyPaid.snapshot.outputs.deposit_payment.amount_cents, 405_000);
  const legacyPayments = (await legacyClient.request("GET", `/v1/payments/organizations/${legacyOrgId}/projects/${legacyProjectId}/payments`)).payments;
  assert.equal(legacyPayments.length, 1);
  assert.equal(legacyPayments[0].method.type, "mock_document");
  assert.equal(legacyPayments[0].provider, undefined);
  assert.equal(legacyPayments[0].fee_cents, undefined);
});

test("crew field payments: tokenized charges run through the provider (fees + allocation), declines write nothing, cash/check stays legacy", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await boardMockMerchant(client, orgId);
  const projectId = "project_mock_crew";
  await signedProposalProject(client, orgId, projectId);
  // Management actors reach crew project facades through production scope,
  // which requires at least one scheduled work event on the project.
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "42 Mock Provider Way",
      title: "Mock Provider Roof",
      contacts: [{ id: "contact_mock", role: "customer", name: "Molly Mock", email: "molly-mock@example.test", primary: true }],
      events: [{ id: "event_crew_work", kind: "project_work", status: "scheduled", title: "Install", start: new Date().toISOString() }]
    },
    metadata: { kind: "platform_project" }
  });
  const crewBase = `/v1/workforce/organizations/${orgId}/crew`;

  // Tokenized field payment charges through the SAME intake charge helpers.
  const tokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123", zip: "90210" }
  });
  const charged = await client.request("POST", `${crewBase}/projects/${projectId}/payments`, {
    amount_cents: 250_000,
    method: { kind: "card" },
    contact_ref: { id: "contact_mock", name: "Molly Mock" },
    payment_method_id: tokenized.intent.payment_method_id,
    save_payment_method: true
  });
  assert.equal(charged.payment.kind, "field_payment");
  assert.equal(charged.payment.status, "settled");
  assert.equal(charged.payment.amount_cents, 250_000);
  assert.equal(charged.payment.provider, "mock");
  assert.equal(charged.payment.fee_cents, mockCardFee(250_000));
  assert.equal(charged.payment.merchant_amount_cents, 250_000 - mockCardFee(250_000));
  assert.match(charged.payment.processor.provider_payment_id, /^pay_mock_/);
  assert.equal(charged.payment.metadata.source, "crew_app");
  assert.equal(charged.payment.metadata.recording_method, "card");
  assert.equal(charged.allocations.length, 1);
  assert.equal(charged.allocations[0].amount_cents, 250_000, "auto_next_due allocation satisfies the deposit obligation");
  assert.equal(charged.payment_summary.paid_cents, 250_000);
  const savedList = (await client.request("GET", `/v1/payments/organizations/${orgId}/customers/contact_mock/payment-methods`)).payment_methods;
  assert.equal(savedList.length, 1, "save_payment_method persists the card for the contact");

  // Charging the saved method also works through the crew route.
  const savedCharge = await client.request("POST", `${crewBase}/projects/${projectId}/payments`, {
    amount_cents: 50_000,
    method: { kind: "card" },
    contact_ref: { id: "contact_mock" },
    saved_method_id: savedList[0].id
  });
  assert.equal(savedCharge.payment.fee_cents, mockCardFee(50_000));
  assert.equal(savedCharge.payment.method.type, "saved_card");

  // Decline: structured error, no transaction.
  const declinedToken = (await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4000000000000002", exp_month: 12, exp_year: 2032, cvc: "123" }
  })).intent.payment_method_id as string;
  const declined = await client.raw("POST", `${crewBase}/projects/${projectId}/payments`, {
    amount_cents: 10_000,
    method: { kind: "card" },
    payment_method_id: declinedToken
  });
  assert.equal(declined.statusCode, 400);
  const declinedBody = JSON.parse(declined.body);
  assert.equal(declinedBody.error, "payment_declined");
  assert.equal(declinedBody.details.decline_category, "generic_decline");
  let payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.length, 2, "declined crew charge writes nothing");

  // Legacy behavior is untouched: cash records exactly as before, and raw
  // card data without a token is still rejected.
  const cash = await client.request("POST", `${crewBase}/projects/${projectId}/payments`, {
    amount_cents: 5_000,
    method: { kind: "cash" }
  });
  assert.equal(cash.payment.method.kind, "cash");
  assert.equal(cash.payment.provider, undefined);
  assert.deepEqual(cash.payment.processor, {});
  const cardSpoof = await client.raw("POST", `${crewBase}/projects/${projectId}/payments`, {
    amount_cents: 5_000,
    method: { kind: "card" }
  });
  assert.equal(cardSpoof.statusCode, 400);
  assert.equal(JSON.parse(cardSpoof.body).error, "crew_payment_method_unsupported");

  // Doc-checkout (field signatures) token branch: charge + output record with
  // NO duplicate transaction (metadata.document_output_id dedupe).
  await applyDocumentCapabilities(client, orgId);
  const doc = await paymentDocument(client, orgId, projectId, "On-site Checkout Agreement");
  const docTokenized = await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4242424242424242", exp_month: 12, exp_year: 2032, cvc: "123" }
  });
  const docTotal = 1_350_000; // walk(scope_items): $13,500 in cents
  const paidDoc = await client.request("POST", `${crewBase}/projects/${projectId}/signatures/${doc.documentId}/payments/deposit_payment`, {
    amount_cents: docTotal,
    method: { kind: "card" },
    contact_ref: { id: "contact_mock", name: "Molly Mock" },
    payment_method_id: docTokenized.intent.payment_method_id
  });
  assert.equal(paidDoc.payment.kind, "deposit", "kind follows output.obligation exactly like the legacy record path");
  assert.equal(paidDoc.payment.amount_cents, docTotal);
  assert.equal(paidDoc.payment.provider, "mock");
  assert.equal(paidDoc.payment.fee_cents, mockCardFee(docTotal));
  assert.equal(paidDoc.payment.metadata.source, "crew_document_checkout");
  assert.equal(paidDoc.payment.metadata.document_output_id, `${doc.documentId}:deposit_payment`);
  assert.equal(paidDoc.document.outputs.deposit_payment.payment_id, paidDoc.payment.id, "document output records the charged transaction");
  payments = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(payments.filter((entry: any) => entry.metadata?.document_output_id === `${doc.documentId}:deposit_payment`).length, 1);
  assert.equal(payments.filter((entry: any) => String(entry.id).startsWith("payment_doc_")).length, 0, "no shadow mock transaction rides along the provider charge");

  // Declined doc checkout: structured error, nothing recorded.
  const declineDoc = await paymentDocument(client, orgId, projectId, "Declined On-site Agreement");
  const docDeclinedToken = (await client.request("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: "4000000000000002", exp_month: 12, exp_year: 2032, cvc: "123" }
  })).intent.payment_method_id as string;
  const docDeclined = await client.raw("POST", `${crewBase}/projects/${projectId}/signatures/${declineDoc.documentId}/payments/deposit_payment`, {
    amount_cents: docTotal,
    method: { kind: "card" },
    payment_method_id: docDeclinedToken
  });
  assert.equal(docDeclined.statusCode, 400);
  assert.equal(JSON.parse(docDeclined.body).error, "payment_declined");
  const afterDocDecline = (await client.request("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments;
  assert.equal(afterDocDecline.filter((entry: any) => entry.metadata?.document_output_id === `${declineDoc.documentId}:deposit_payment`).length, 0);
});

test("interchange-plus mock plan changes the computed fee (plan-switch support)", async () => {
  const { mockCardFeeCents } = await import("../payments/providers/mock.js");
  assert.equal(mockCardFeeCents(US_PLAN_ID, 250_000), 80, "flat rate: 2 bps + 30c");
  assert.equal(mockCardFeeCents(CAN_PLAN_ID, 250_000), 80);
  assert.equal(mockCardFeeCents(INTERCHANGE_PLUS_PLAN_ID, 250_000), 4_260, "interchange-plus mock: 150 bps assumed interchange + 20 bps markup + 10c");
});
