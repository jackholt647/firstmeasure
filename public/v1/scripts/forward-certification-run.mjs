/**
 * Forward certification runner: drives the certification test cases through
 * FirstMate (real UI for card entry, our API for the rest) against Forward's
 * SANDBOX and records every Forward id for the certification sheet.
 *
 *   node scripts/forward-certification-run.mjs <phase> [...]     (from public/v1)
 *
 * Phases:
 *   cards    CNP00-CNP07: each brand's success and failure card, typed into
 *            Forward's element in the staff "Take a payment" form.
 *   cit      RC04-RC07: customer-initiated payments (cards saved for MIT).
 *   mit      RC00-RC03: autopay charges the saved cards (merchant-initiated,
 *            recurring) for invoices of the sheet's amounts.
 *   void     V00: a payment refunded in full before it settles is voided.
 *   refunds  R00 (full) and R01 (partial, $9.00) on settled payments from
 *            earlier runs (run after Forward settles them).
 *   boarding AP00-AP04: business, application, hosted link, MCCs, plans.
 *
 * Environment:
 *   CERT_BASE         web + API origin (default https://dev.1m8.ai)
 *   CERT_API          API origin when different (local stack: http://127.0.0.1:3101)
 *   CERT_SANDBOX_ORG  signup-sandbox test org instance id (dev, password-less)
 *   CERT_ORG_ID       that test org's organization id
 *   CERT_LOGIN_FILE   or a JSON {email,password,orgId} (local stack)
 *   CERT_EVIDENCE     evidence JSON file (merged across runs)
 *   CERT_SHOTS        screenshot directory
 */
import { chromium } from "playwright-core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = (process.env.CERT_BASE || "https://dev.1m8.ai").replace(/\/+$/, "");
const API = (process.env.CERT_API || BASE).replace(/\/+$/, "");
const SHOTS = process.env.CERT_SHOTS || path.resolve("forward-cert-shots");
const EVIDENCE = process.env.CERT_EVIDENCE || path.join(SHOTS, "evidence.json");
const phases = process.argv.slice(2);
await mkdir(SHOTS, { recursive: true });

const CARDS = {
  VISA: { success: "4242424242424242", failure: "4242424242431155", cvc: "123" },
  MASTERCARD: { success: "5555555555554444", failure: "5555555555566737", cvc: "123" },
  DISCOVER: { success: "6011601160116611", failure: "6011601160106737", cvc: "123" },
  AMEX: { success: "370353285191289", failure: "341374155646737", cvc: "1234" }
};
const CNP_CASES = [
  ["CNP00", "VISA", 1000, "success"], ["CNP01", "VISA", 555, "failure"],
  ["CNP02", "MASTERCARD", 1100, "success"], ["CNP03", "MASTERCARD", 666, "failure"],
  ["CNP04", "DISCOVER", 1200, "success"], ["CNP05", "DISCOVER", 777, "failure"],
  ["CNP06", "AMEX", 1300, "success"], ["CNP07", "AMEX", 888, "failure"]
];
const RC_AMOUNTS = { VISA: 1281, MASTERCARD: 1933, DISCOVER: 2650, AMEX: 1385 };
const RC_CIT = [["RC04", "VISA"], ["RC05", "MASTERCARD"], ["RC06", "DISCOVER"], ["RC07", "AMEX"]];
const RC_MIT = [["RC00", "VISA"], ["RC01", "MASTERCARD"], ["RC02", "DISCOVER"], ["RC03", "AMEX"]];

let evidence = {};
try { evidence = JSON.parse(await readFile(EVIDENCE, "utf8")); } catch { evidence = {}; }
evidence.cases ||= {};
const save = async () => writeFile(EVIDENCE, JSON.stringify({ ...evidence, updated_at: new Date().toISOString(), base: BASE }, null, 2));
const record = async (id, data) => { evidence.cases[id] = { ...data, at: new Date().toISOString() }; await save(); console.log(id, JSON.stringify(data)); };

function apiClient() {
  const jar = new Map();
  let csrf = "";
  const req = async (method, url, body) => {
    const res = await fetch(API + url, {
      method,
      headers: {
        Origin: BASE,
        "Content-Type": "application/json",
        ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    for (const raw of res.headers.getSetCookie?.() || []) {
      const pair = raw.split(";")[0];
      jar.set(pair.split("=")[0], pair);
      if (/_csrf=/.test(pair)) csrf = decodeURIComponent(pair.split("=")[1] || "");
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* raw */ }
    if (res.status >= 400) throw Object.assign(new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`), { status: res.status, data });
    return data;
  };
  return { req };
}

async function signIn(api) {
  if (process.env.CERT_SANDBOX_ORG) {
    // The sandbox login answers with a redirect only, so the organization id is passed in.
    await api.req("POST", `/v1/signup-sandbox/test-orgs/${process.env.CERT_SANDBOX_ORG}/login`, {});
    return process.env.CERT_ORG_ID;
  }
  const login = JSON.parse(await readFile(process.env.CERT_LOGIN_FILE, "utf8"));
  await api.req("POST", "/v1/platform/auth/login", { email: login.email, password: login.password, organization_id: login.orgId });
  return login.orgId;
}

const api = apiClient();
const orgId = await signIn(api);
if (!orgId) throw new Error("could not resolve the organization after sign-in");
evidence.org_id = orgId;
const readiness = (await api.req("GET", `/v1/payments/organizations/${orgId}/payments-readiness`)).readiness;
console.log("organization", orgId, "readiness", JSON.stringify(readiness));
if (!readiness.ready && phases.some((p) => ["cards", "cit", "mit", "void"].includes(p))) throw new Error("organization is not ready to take payments");

async function newProject(label) {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const projectId = `project_cert_${label}_${suffix}`.toLowerCase();
  await api.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: `Forward certification ${label}`, address: "233 South Wacker Drive, Chicago, IL 60606" },
    metadata: { kind: "platform_project" }
  });
  const contactId = evidence.contact_id || `contact_cert_${suffix}`;
  evidence.contact_id = contactId;
  await api.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}/contacts`, {
    contacts: [{ id: contactId, role: "customer", name: "Jordan Smith", email: "jordan.cert@example.test", phone: "3125550100", primary: true }]
  });
  return projectId;
}

async function checkoutView(checkoutId) {
  return (await api.req("GET", `/v1/payments/organizations/${orgId}/payment-checkouts/${checkoutId}`)).checkout;
}

async function browserPath() {
  for (const candidate of ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome"]) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  throw new Error("no Chrome/Edge found");
}

let browser = null;
let page = null;
let lastCheckoutId = "";
async function ensureBrowser() {
  if (page) return page;
  browser = await chromium.launch({ executablePath: await browserPath(), headless: process.env.CERT_HEADED ? false : true });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  page = await context.newPage();
  page.on("response", async (response) => {
    if (response.request().method() === "POST" && /\/payment-checkouts$/.test(new URL(response.url()).pathname)) {
      const body = await response.json().catch(() => null);
      if (body?.checkout?.id) lastCheckoutId = body.checkout.id;
    }
  });
  await page.goto(`${BASE}/portal/login.php`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, sandboxOrg, login }) => {
    if (sandboxOrg) {
      await fetch(`${api}/v1/signup-sandbox/test-orgs/${sandboxOrg}/login`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
    } else {
      await fetch(`${api}/v1/platform/auth/login`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: login.email, password: login.password, organization_id: login.orgId }) });
    }
  }, { api: API, sandboxOrg: process.env.CERT_SANDBOX_ORG || "", login: process.env.CERT_LOGIN_FILE ? JSON.parse(await readFile(process.env.CERT_LOGIN_FILE, "utf8")) : null });
  return page;
}

// The project opens in its own window frame (?projectWindow=...); the Money tab and the payment form live there.
async function openTakePayment(projectId) {
  await page.goto(`${BASE}/portal/?project=${encodeURIComponent(projectId)}&projectTab=money`, { waitUntil: "domcontentloaded" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const win = page.frames().find((frame) => frame.url().includes("projectWindow="));
    if (win) {
      const opened = await win.evaluate(() => {
        if (document.querySelector("[data-money-payment-intake] .fmpi-modal")) return true;
        const button = document.querySelector("[data-money-take-payment]");
        if (button && !button.disabled) button.click();
        else [...document.querySelectorAll('[data-tab="money"]')].find((tab) => !tab.classList.contains("active"))?.click();
        return false;
      }).catch(() => false);
      if (opened || await win.waitForSelector("[data-money-payment-intake] .fmpi-modal", { timeout: 1500 }).then(() => true).catch(() => false)) return win;
    } else {
      await page.waitForTimeout(1500);
    }
  }
  throw new Error("Take a payment did not open");
}

async function payByCard(projectId, { amount, pan, cvc, save = false, waitMs = 60000 }) {
  lastCheckoutId = "";
  const win = await openTakePayment(projectId);
  await win.evaluate(() => document.querySelector('[data-fmpi-method="card"]').click());
  await win.evaluate((value) => {
    const input = document.querySelector("[data-fmpi-custom-amount]");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, (amount / 100).toFixed(2));
  await page.waitForTimeout(1500);
  const frame = win.frameLocator("iframe[data-forward-element]");
  const type = async (locator, value) => { await locator.click(); await locator.press("Control+A"); await locator.press("Backspace"); await locator.pressSequentially(value, { delay: 20 }); };
  await frame.getByPlaceholder("1234 1234 1234 1234").waitFor({ timeout: 45000 });
  await type(frame.getByPlaceholder("1234 1234 1234 1234"), pan);
  await type(frame.getByPlaceholder("MM / YY"), "1230");
  await type(frame.getByPlaceholder("CVC"), cvc);
  await frame.locator("select").first().selectOption({ label: "United States" }).catch(() => frame.locator("select").first().selectOption("US"));
  await type(frame.getByPlaceholder(/postal code/i), "60606");
  if (save) await win.evaluate(() => { const box = document.querySelector("[data-fmpi-save]"); if (box && !box.checked) box.click(); });
  await win.waitForFunction(() => document.querySelector("[data-fmpi-submit]") && !document.querySelector("[data-fmpi-submit]").disabled, null, { timeout: 20000 });
  await win.evaluate(() => document.querySelector("[data-fmpi-submit]").click());
  const outcome = await win.waitForFunction(() => {
    if (document.querySelector(".fmpi-success h3")) return { ok: true };
    const error = document.querySelector("[data-fmpi-forward-error]:not([hidden])");
    if (error && error.textContent.trim()) return { ok: false, error: error.textContent.trim() };
    return false;
  }, null, { timeout: waitMs, polling: 300 }).then((handle) => handle.jsonValue());
  return { outcome, checkoutId: lastCheckoutId };
}

try {
  if (phases.includes("cards")) {
    await ensureBrowser();
    const projectId = await newProject("cnp");
    for (const [caseId, brand, amount, expected] of CNP_CASES) {
      if (evidence.cases[caseId]?.pass) { console.log(caseId, "already recorded"); continue; }
      const { outcome, checkoutId } = await payByCard(projectId, { amount, pan: CARDS[brand][expected], cvc: CARDS[brand].cvc });
      await page.screenshot({ path: path.join(SHOTS, `${caseId}.png`) });
      const checkout = checkoutId ? await checkoutView(checkoutId) : null;
      await record(caseId, {
        brand, amount_cents: amount, expected, outcome,
        payment_method_id: checkout?.payment_method_id, our_payment_id: checkout?.recorded_payment_id || checkout?.payment_id,
        payment_intent_id: checkout?.provider_intent_id,
        payment_id: checkout?.provider_payment_id || checkout?.last_provider_payment_id,
        result: expected === "success" ? (outcome.ok ? "Success (captured)" : "UNEXPECTED FAILURE") : (outcome.ok ? "UNEXPECTED SUCCESS" : `Declined: ${outcome.error}`),
        pass: (expected === "success") === outcome.ok
      });
    }
  }

  if (phases.includes("cit")) {
    await ensureBrowser();
    const projectId = await newProject("cit");
    evidence.cit_project_id = projectId;
    for (const [caseId, brand] of RC_CIT) {
      if (evidence.cases[caseId]?.pass) { console.log(caseId, "already recorded"); continue; }
      const { outcome, checkoutId } = await payByCard(projectId, { amount: RC_AMOUNTS[brand], pan: CARDS[brand].success, cvc: CARDS[brand].cvc, save: true });
      await page.screenshot({ path: path.join(SHOTS, `${caseId}.png`) });
      const checkout = checkoutId ? await checkoutView(checkoutId) : null;
      await record(caseId, {
        brand, amount_cents: RC_AMOUNTS[brand], initiated_by: checkout?.initiated_by, card_not_present_type: checkout?.scheduled ? "recurring" : "ecommerce",
        payment_method_id: checkout?.payment_method_id, payment_intent_id: checkout?.provider_intent_id, payment_id: checkout?.provider_payment_id, our_payment_id: checkout?.recorded_payment_id || checkout?.payment_id,
        api_response: outcome.ok ? "captured" : outcome.error, pass: outcome.ok && checkout?.initiated_by === "customer"
      });
    }
  }

  if (phases.includes("mit")) {
    const saved = (await api.req("GET", `/v1/payments/organizations/${orgId}/customers/${encodeURIComponent(evidence.contact_id)}/payment-methods`)).payment_methods;
    for (const [caseId, brand] of RC_MIT) {
      if (evidence.cases[caseId]?.pass) { console.log(caseId, "already recorded"); continue; }
      const method = saved.find((entry) => entry.type === "card" && (brand === "AMEX" ? /^(amex|american_?express)/ : new RegExp("^" + brand.toLowerCase())).test(String(entry.brand).toLowerCase().replace(/\s+/g, "")));
      if (!method) { await record(caseId, { brand, error: "no saved card of this brand (run the cit phase first)", pass: false }); continue; }
      const projectId = await newProject(`mit-${brand}`);
      const invoice = await api.req("POST", `/v1/payments/organizations/${orgId}/projects/${projectId}/invoices`, {
        line_items: [{ type: "manual", description: `Recurring installment ${caseId}`, amount_cents: RC_AMOUNTS[brand] }], tax_enabled: false
      });
      await api.req("POST", `/v1/payments/organizations/${orgId}/invoices/${invoice.invoice.id}/mark-due`, { due_at: new Date(Date.now() - 3_600_000).toISOString() });
      await api.req("PUT", `/v1/payments/organizations/${orgId}/projects/${projectId}/autopay`, {
        saved_method_id: method.id, contact_ref: { id: evidence.contact_id }, customer_authorized: true, authorization_note: "Forward certification MIT case"
      });
      const run = await api.req("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
      const charged = run.charged.find((entry) => entry.project_id === projectId);
      const payment = charged ? (await api.req("GET", `/v1/payments/organizations/${orgId}/payments/${charged.payment_id}`)).payment : null;
      const checkout = payment?.processor?.checkout_id ? await checkoutView(payment.processor.checkout_id) : null;
      await record(caseId, {
        brand, amount_cents: RC_AMOUNTS[brand], initiated_by: checkout?.initiated_by, scheduled: checkout?.scheduled,
        payment_method_id: checkout?.payment_method_id, payment_intent_id: checkout?.provider_intent_id, payment_id: checkout?.provider_payment_id,
        api_response: payment ? `captured (${payment.status})` : JSON.stringify(run).slice(0, 300),
        pass: !!payment && checkout?.initiated_by === "merchant" && checkout?.scheduled === true
      });
    }
  }

  if (phases.includes("void")) {
    await ensureBrowser();
    const projectId = await newProject("void");
    const { outcome, checkoutId } = await payByCard(projectId, { amount: 1000, pan: CARDS.VISA.success, cvc: "123" });
    const checkout = await checkoutView(checkoutId);
    const refunded = await api.req("POST", `/v1/payments/organizations/${orgId}/payments/${checkout.recorded_payment_id || checkout.payment_id}/refunds`, { reason: "requested_by_customer" });
    await record("V00", {
      amount_cents: 1000, payment_intent_id: checkout.provider_intent_id, payment_id: checkout.provider_payment_id, charged: outcome.ok,
      action: refunded.provider_action, result: refunded.payment?.status, pass: outcome.ok && refunded.provider_action === "voided" && refunded.payment?.status === "voided"
    });
  }

  if (phases.includes("timeout")) {
    // Error handling: Forward's sandbox "timeout" card (sheet notes, Visa ending 1122). Our request gives up after
    // FORWARD_REQUEST_TIMEOUT_MS; the checkout must then be looked up at Forward, never charged twice.
    await ensureBrowser();
    const projectId = await newProject("timeout");
    const started = Date.now();
    const { outcome, checkoutId } = await payByCard(projectId, { amount: 1000, pan: "4242424242431122", cvc: "123", waitMs: 180000 }).catch((error) => ({ outcome: { ok: false, error: String(error?.message || error) }, checkoutId: lastCheckoutId }));
    await page.screenshot({ path: path.join(SHOTS, "ERR-timeout.png") });
    const checkout = checkoutId ? await checkoutView(checkoutId) : null;
    const payments = (await api.req("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`)).payments.filter((p) => p.direction === "inbound");
    await record("ERR-timeout", {
      seconds: Math.round((Date.now() - started) / 1000), outcome, checkout_status: checkout?.status, attempts: checkout?.attempts, last_error: checkout?.last_error,
      payment_intent_id: checkout?.provider_intent_id, provider_payment_id: checkout?.provider_payment_id || checkout?.last_provider_payment_id,
      payments_recorded: payments.length, pass: payments.length <= 1 && (outcome.ok ? payments.length === 1 : payments.length === 0)
    });
  }

  if (phases.includes("refunds")) {
    // R00 needs a payment Forward has settled (an unsettled one is voided instead); R01 refunds $9.00 of another.
    const candidates = ["CNP02", "CNP04", "CNP06", "RC05", "RC06", "RC07", "CNP00"].map((id) => [id, evidence.cases[id]]).filter(([, c]) => c?.our_payment_id);
    const used = new Set([evidence.cases.R00?.from, evidence.cases.R01?.from].filter(Boolean));
    const next = () => candidates.find(([id]) => !used.has(id));
    for (const [caseId, amount] of [["R00", null], ["R01", 900]]) {
      if (evidence.cases[caseId]?.pass) { console.log(caseId, "already recorded"); continue; }
      const pick = next();
      if (!pick) { console.log(caseId, "no payment left to refund"); continue; }
      const [from, source] = pick; used.add(from);
      const result = await api.req("POST", `/v1/payments/organizations/${orgId}/payments/${source.our_payment_id}/refunds`, { ...(amount ? { amount_cents: amount } : {}), reason: "requested_by_customer" }).catch((error) => ({ error: error.message }));
      await record(caseId, {
        from, amount_cents: source.amount_cents, refund_cents: amount || source.amount_cents, payment_intent_id: source.payment_intent_id, payment_id: source.payment_id,
        action: result.provider_action, refund_id: result.refund?.processor?.provider_refund_id || result.refund?.provider_refund_id, result: result.payment?.status || result.error,
        pass: result.provider_action === "refunded"
      });
    }
  }

  if (phases.includes("boarding")) {
    const mccs = await api.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/mccs`);
    await record("AP03", { mccs: mccs.mccs, pass: Array.isArray(mccs.mccs) && mccs.mccs.length > 0 });
    const plans = await api.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/processing-plans`);
    await record("AP04", { plans: plans.processing_plans.map((plan) => ({ id: plan.id, name: plan.name })), pass: plans.processing_plans.length > 0 });
  }
} catch (error) {
  console.log("ERROR", error?.stack || error);
  if (page) await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => null);
  process.exitCode = 1;
} finally {
  await save();
  if (browser) await browser.close();
}
const cases = Object.entries(evidence.cases);
console.log(`\n${cases.filter(([, c]) => c.pass).length}/${cases.length} recorded cases pass; evidence: ${EVIDENCE}`);
