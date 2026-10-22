// 1M8-198: a paid credit checkout is credited against what was configured in
// Stripe (Price unit_amount x quantity, before tax), and a genuine mismatch is
// held for an operator instead of being refused silently.
// 1M8-200: the monthly statement counts refunds separately from payments.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nextTestPhone } from "./helpers/platform-fixture.js";
import { checkStripeCheckoutAmount } from "../payments/stripe_checkout_amount.js";
import { creditLedgerEntryKind, creditStatementTotals } from "../platform/credit_statement.js";

let app: any;
let storage: typeof import("../platform/storage.js");
let internalStorage: typeof import("../internal/storage.js");
const sessions = new Map<string, any>();
const control = { unitAmount: 100, tax: 0, discount: 0 };
let seq = 0;
let originalFetch: typeof fetch;

before(async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stripe-credit-fulfillment-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "sqlite", DATABASE_URL: "", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", CUSTOMER_CALL_WORKER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", V1_LOG_LEVEL: "error", STRIPE_TEST_MODE: "1", STRIPE_TEST_SECRET_KEY: "sk_test_fulfillment_fixture", STRIPE_BASE_URL: "https://dev.1m8.ai/portal", FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "measure/index.sqlite") });
  for (const name of ["PLATFORM", "INTERNAL", "CRM", "FIRSTMEASURE", "MESSAGING", "CHANNELS", "CALLS", "PRICEBOOK"]) process.env[name + "_STORAGE_ROOT"] = path.join(root, name.toLowerCase());
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, options: any = {}) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.stripe.com") return new Response("unavailable", { status: 503 });
    const fields = new URLSearchParams(options.body);
    let value: any;
    if (url.pathname === "/v1/customers") value = { id: "cus_fulfillment" };
    else if (url.pathname === "/v1/checkout/sessions") {
      const meta = Object.fromEntries([...fields].filter(([k]) => /^metadata\[/.test(k)).map(([k, v]) => [k.slice(9, -1), v]));
      const qty = Number(fields.get("line_items[0][quantity]"));
      const unit = fields.get("line_items[0][price]") ? control.unitAmount : Number(fields.get("line_items[0][price_data][unit_amount]"));
      const subtotal = qty * unit;
      value = { id: "cs_test_fulfillment_" + (++seq), url: "https://checkout.stripe.com/c/test", mode: "payment", livemode: false, status: "complete", payment_status: "paid", currency: fields.get("line_items[0][price_data][currency]") || "usd", amount_subtotal: subtotal, amount_total: subtotal + control.tax - control.discount, metadata: meta, client_reference_id: meta.user_email, line_price: fields.get("line_items[0][price]") };
      sessions.set(value.id, value);
    } else if (url.pathname.startsWith("/v1/checkout/sessions/")) value = sessions.get(url.pathname.split("/").at(-1)!);
    else value = { id: "cus_fulfillment", invoice_settings: {} };
    return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  app = await (await import("../src/app.js")).buildApp();
  await app.ready();
  storage = await import("../platform/storage.js");
  internalStorage = await import("../internal/storage.js");
});

after(async () => {
  globalThis.fetch = originalFetch;
  await app?.close();
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
});

function client(country: string) {
  let cookie = "", csrf = "";
  return {
    org: "",
    async request(method: string, url: string, payload?: any) {
      const response = await app.inject({ method, url, payload, headers: { cookie, "cf-ipcountry": country, ...(csrf ? { "x-platform-csrf": csrf } : {}) } });
      const set = response.headers["set-cookie"];
      if (set) {
        const pairs = (Array.isArray(set) ? set : [set]).map((v: string) => v.split(";")[0] || "");
        cookie = pairs.join("; ");
        csrf = decodeURIComponent(pairs.find((v: string) => v.startsWith("fm_platform_session_csrf="))?.split("=")[1] || "");
      }
      assert.ok(response.statusCode < 400, response.body);
      return response.json();
    }
  };
}

async function register(country: string, email: string) {
  const c = client(country);
  const registration = await c.request("POST", "/v1/platform/auth/register", { email, password: "fulfillment-password-123", phone: nextTestPhone(), company: "Fulfillment fixture" });
  c.org = registration.organization.id;
  return c;
}

const action = (c: any, body: any) => c.request("POST", "/v1/platform/portal-action", body);

test("amount check accepts configured totals and holds genuine mismatches", () => {
  const meta = { credit_currency: "USD", paid_minor: "25000" };
  assert.equal(checkStripeCheckoutAmount({ currency: "usd", amount_total: 25000 }, meta, "USD", 250).accept, true);
  assert.equal(checkStripeCheckoutAmount({ currency: "usd", amount_subtotal: 25000, amount_total: 27063 }, meta, "USD", 250).accept, true, "tax on top");
  assert.equal(checkStripeCheckoutAmount({ currency: "usd", amount_subtotal: 25000, amount_total: 20000 }, meta, "USD", 250).accept, true, "discount after subtotal");
  const above = checkStripeCheckoutAmount({ currency: "usd", amount_subtotal: 26000, amount_total: 26000 }, meta, "USD", 250);
  assert.equal(above.accept, true);
  assert.equal(above.accept && above.warning, "configured_amount_above_credit_value");
  assert.deepEqual(checkStripeCheckoutAmount({ currency: "usd", amount_subtotal: 24000, amount_total: 24000 }, meta, "USD", 250), { accept: false, code: "amount_below_credit_value", expected_minor: 25000, configured_minor: 24000 });
  assert.equal(checkStripeCheckoutAmount({ currency: "gbp", amount_total: 25000 }, meta, "USD", 250).accept, false);
  assert.equal(checkStripeCheckoutAmount({ currency: "usd", amount_total: 25000 }, { ...meta, credit_currency: "EUR" }, "EUR", 250).accept, false);
  // Sessions created before paid_minor existed fall back to paid_dollars.
  assert.equal(checkStripeCheckoutAmount({ currency: "usd", amount_total: 5000 }, { paid_dollars: "50" }, "USD", 60).accept, true);
});

test("US Price ID checkout with tax added is credited once", async () => {
  const c = await register("US", "tax@fulfillment.example.test");
  Object.assign(control, { unitAmount: 100, tax: 731, discount: 0 });
  const created = await action(c, { action: "stripe_create_checkout", qty: 90 });
  assert.equal(created.success, true, JSON.stringify(created));
  const session = sessions.get(created.session.id);
  assert.ok(session.line_price, "US checkout uses the configured Price ID");
  assert.equal(session.amount_total, 9731);
  const first = await action(c, { action: "stripe_fulfill_session", session_id: session.id });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(first.credited, 90);
  const again = await action(c, { action: "stripe_fulfill_session", session_id: session.id });
  assert.equal(again.duplicate, true);
  const ledger = (await storage.readGlobal(c.org)).data.credits_ledger as any[];
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].delta, 90);
});

test("a Price above the credit value is credited with an operator warning", async () => {
  const c = await register("US", "above@fulfillment.example.test");
  Object.assign(control, { unitAmount: 105, tax: 0, discount: 0 });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const created = await action(c, { action: "stripe_create_checkout", qty: 40 });
    const result = await action(c, { action: "stripe_fulfill_session", session_id: created.session.id });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.credited, 40);
  } finally { console.warn = warn; }
  assert.ok(warnings.some((line) => line.includes("stripe_checkout_amount_warning") && line.includes("configured_amount_above_credit_value")));
});

test("a paid session below the credit value is held for review, alerted once and not credited", async () => {
  const c = await register("US", "below@fulfillment.example.test");
  Object.assign(control, { unitAmount: 90, tax: 0, discount: 0 });
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  let sessionId = "";
  try {
    const created = await action(c, { action: "stripe_create_checkout", qty: 50 });
    sessionId = created.session.id;
    const held = await action(c, { action: "stripe_fulfill_session", session_id: sessionId });
    assert.equal(held.success, false);
    assert.equal(held.needs_review, true);
    assert.equal(held.code, "amount_below_credit_value");
    assert.match(held.customer_message, /team has been alerted/);
    const retried = await action(c, { action: "stripe_fulfill_session", session_id: sessionId });
    assert.equal(retried.needs_review, true);
  } finally { console.warn = warn; }
  assert.equal(warnings.filter((line) => line.includes("\"event\":\"stripe_checkout_payment_review\"")).length, 1, "one alert per session");
  const data = (await storage.readGlobal(c.org)).data as any;
  assert.equal((data.credits_ledger ?? []).length, 0);
  assert.equal(data.stripe_payment_reviews[sessionId].status, "open");
  assert.equal(data.stripe_payment_reviews[sessionId].attempts, 2);
  assert.equal(data.stripe_payment_reviews[sessionId].configured_minor, 4500);
  const queued = (await internalStorage.listInternalDocuments("stripe_payment_reviews")).map((doc: any) => doc.data ?? doc);
  assert.ok(queued.some((review: any) => review.session_id === sessionId && review.org_id === c.org && review.expected_minor === 5000));
});

test("statement classification keeps refunds out of payments", () => {
  const entries = [
    { reason: "stripe_checkout_paid", delta: 100 },
    { reason: "stripe_auto_topup", delta: 50 },
    { reason: "purchase", delta: 20 },
    { reason: "stripe_manual_fulfill", delta: 30 },
    { reason: "cancellation_refund", delta: 25 },
    { reason: "customer_cancelled_inside_grace_period", delta: 7 },
    { reason: "instant_no_coverage_refund", delta: 2 },
    { reason: "order_refund", delta: 9, meta: { source_charge: { reason: "order_submitted" } } },
    { reason: "coupon_redeem", delta: 10 },
    { reason: "order_submitted", delta: -25 }
  ];
  assert.deepEqual(entries.map(creditLedgerEntryKind), ["payment", "payment", "payment", "payment", "refund", "refund", "refund", "refund", "credit", "charge"]);
  const totals = creditStatementTotals(entries);
  assert.equal(totals.total_payments, 4);
  assert.equal(totals.total_refunds, 4);
  assert.equal(totals.refunds_in, 43);
  assert.equal(totals.payments_in, 200);
  assert.equal(totals.total_in, 210);
  assert.equal(totals.total_out, 25);
  assert.equal(totals.net_change, 228);
});

test("monthly statement endpoint reports four payments and two refunds, not six payments", async () => {
  const c = await register("US", "statement@fulfillment.example.test");
  const ts = new Date().toISOString();
  const now = new Date();
  await storage.saveGlobal(c.org, { data: { credits_ledger: [
    { id: "l1", ts, reason: "stripe_checkout_paid", delta: 100 },
    { id: "l2", ts, reason: "stripe_auto_topup", delta: 50 },
    { id: "l3", ts, reason: "stripe_auto_topup", delta: 50 },
    { id: "l4", ts, reason: "purchase", delta: 25 },
    { id: "l5", ts, reason: "order_submitted", delta: -25 },
    { id: "l6", ts, reason: "cancellation_refund", delta: 25 },
    { id: "l7", ts, reason: "order_submitted", delta: -7 },
    { id: "l8", ts, reason: "customer_cancelled_inside_grace_period", delta: 7 }
  ] } });
  const statement = await action(c, { action: "org_monthly_statement", month: now.getUTCMonth() + 1, year: now.getUTCFullYear() });
  assert.equal(statement.total_payments, 4);
  assert.equal(statement.total_refunds, 2);
  assert.equal(statement.refunds_in, 32);
  assert.equal(statement.total_in, 225);
  assert.equal(statement.total_out, 32);
  assert.equal(statement.net_change, 225);
  assert.equal(statement.refunds.length, 2);
});
