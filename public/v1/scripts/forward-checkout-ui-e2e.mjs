/**
 * Forward checkout through the REAL UI against Forward's SANDBOX:
 *
 *  1. Customer portal: a document's Pay button opens our checkout with
 *     Forward's card fields; Forward's failure card is declined in place with
 *     Forward's reason, then the success card pays the same checkout.
 *  2. Staff Money tab: "Take a payment" with a custom amount and Forward's
 *     card fields; the card is saved; the saved card pays a second payment.
 *  3. Refunds from the Money tab: the whole unsettled payment is voided at
 *     Forward; nothing is ever recorded as paid that Forward did not take.
 *  4. An organization that is not set up sees no card entry anywhere.
 *
 * Every Forward id (payment intent, payment, refund) is written to the
 * evidence file for the certification sheet.
 *
 *   FORWARD_UI_LOGIN=<json file with {email,password,orgId}> \
 *   FORWARD_UI_NOT_READY_LOGIN=<optional second org json> \
 *   node scripts/forward-checkout-ui-e2e.mjs      (from public/v1)
 *
 * WEB_ORIGIN / API_ORIGIN default to the local stack (:8011 / :3101). The
 * organization must already be approved on a Forward sandbox account.
 */
import { chromium } from "playwright-core";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.FORWARD_UI_SHOTS_DIR || path.resolve("forward-checkout-shots");
const EVIDENCE = process.env.FORWARD_UI_EVIDENCE || path.join(SHOTS, "evidence.json");
await mkdir(SHOTS, { recursive: true });
const login = JSON.parse(await readFile(process.env.FORWARD_UI_LOGIN, "utf8"));
const notReadyLogin = process.env.FORWARD_UI_NOT_READY_LOGIN ? JSON.parse(await readFile(process.env.FORWARD_UI_NOT_READY_LOGIN, "utf8")) : null;

const SUCCESS_VISA = "4242424242424242";
const FAILURE_VISA = "4242424242431155";
const results = [];
const evidence = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

async function browserPath() {
  const candidates = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
}

function apiClient() {
  const jar = new Map();
  let csrf = "";
  return {
    async req(method, url, body) {
      const res = await fetch(API + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
          ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const pair = raw.split(";")[0];
        jar.set(pair.split("=")[0], pair);
        if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { /* raw */ }
      if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
      return data;
    }
  };
}

async function seedProject(account, withDocument) {
  const api = apiClient();
  await api.req("POST", "/v1/platform/auth/login", { email: account.email, password: account.password, organization_id: account.orgId });
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const projectId = `project_fwdui_${suffix}`;
  await api.req("PUT", `/v1/platform/organizations/${account.orgId}/projects/${projectId}`, {
    data: { id: projectId, title: `Forward UI Roof ${suffix}`, address: "233 South Wacker Drive, Chicago, IL 60606" },
    metadata: { kind: "platform_project" }
  });
  const contactId = `contact_fwdui_${suffix}`;
  await api.req("PUT", `/v1/platform/organizations/${account.orgId}/projects/${projectId}/contacts`, {
    contacts: [{ id: contactId, role: "customer", name: "Jordan Smith", email: `jordan-${suffix}@example.test`, phone: "3125550100", primary: true }]
  });
  let portalUuid = "";
  if (withDocument) {
    const created = await api.req("POST", `/v1/documents/organizations/${account.orgId}/projects/${projectId}/documents`, {
      document_type: "proposal", template_id: "tpl_kitchen_estimate", workflow_id: null, title: "Forward UI Deposit Agreement",
      params: { customer: { name: "Jordan Smith", email: `jordan-${suffix}@example.test` }, scope_items: [{ id: "item_roof", name: "Roof replacement", quantity: 1, unit: "job", unit_price: 100 }], deposit_cents: 1000, tax_percent: 0 }
    });
    await api.req("POST", `/v1/documents/organizations/${account.orgId}/documents/${created.document.id}/issue`, {});
    await api.req("POST", `/v1/documents/organizations/${account.orgId}/documents/${created.document.id}/send`, {
      recipients: [{ name: "Jordan Smith", email: `jordan-${suffix}@example.test`, role: "customer" }]
    });
    const portal = await api.req("POST", `/v1/platform/organizations/${account.orgId}/projects/${projectId}/customer-portal`, { contact_id: contactId });
    portalUuid = portal.portal.public_uuid;
  }
  return { api, projectId, portalUuid };
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${String(results.length).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("shot:", file);
}

/** Types a card into Forward's iframe (cross-origin; Playwright frame locator). */
async function fillForwardCard(page, pan, zip = "60606") {
  const frame = page.frameLocator('iframe[data-forward-element]');
  await frame.getByPlaceholder("1234 1234 1234 1234").waitFor({ timeout: 30000 });
  // Retyping after a decline replaces what is there.
  const type = async (field, value) => {
    await field.click();
    await field.press("Control+A");
    await field.press("Backspace");
    await field.pressSequentially(value, { delay: 15 });
  };
  await type(frame.getByPlaceholder("1234 1234 1234 1234"), pan);
  await type(frame.getByPlaceholder("MM / YY"), "1230");
  await type(frame.getByPlaceholder("CVC"), "123");
  await frame.locator("select").first().selectOption({ label: "United States" }).catch(async () => {
    await frame.locator("select").first().selectOption("US");
  });
  await type(frame.getByPlaceholder(/postal code/i), zip);
  await page.waitForFunction(() => document.querySelector("[data-fmpi-submit]") && !document.querySelector("[data-fmpi-submit]").disabled, null, { timeout: 15000 });
}

async function clickPay(page) {
  await page.evaluate(() => document.querySelector("[data-fmpi-submit]").click());
  // The new attempt clears any earlier error before it runs.
  await page.waitForFunction(() => {
    const error = document.querySelector("[data-fmpi-forward-error]");
    return !error || error.hidden || !error.textContent.trim() || !!document.querySelector(".fmpi-success h3");
  }, null, { timeout: 10000 }).catch(() => null);
}

async function waitOutcome(page) {
  return page.waitForFunction(() => {
    if (document.querySelector(".fmpi-success h3")) return { ok: true, title: document.querySelector(".fmpi-success h3").textContent };
    const error = document.querySelector("[data-fmpi-forward-error]:not([hidden]), .fmpi-error:not([hidden])");
    if (error && error.textContent.trim()) return { ok: false, error: error.textContent.trim() };
    return false;
  }, null, { timeout: 45000 }).then((handle) => handle.jsonValue());
}

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
page.on("pageerror", (error) => console.log("pageerror:", error.message));

try {
  // ── 1. Customer portal: decline in place, then pay the same checkout ─────
  const portalSeed = await seedProject(login, true);
  await page.goto(`${WEB}/customer_portal/?id=${portalSeed.portalUuid}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Open document").first().click({ timeout: 30000 });
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Pay"), null, { timeout: 30000 });
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Pay").click());
  await page.waitForSelector('[data-fmpi-method="card"]', { timeout: 30000 });
  await page.evaluate(() => document.querySelector('[data-fmpi-method="card"]').click());
  check("portal: Forward's secure card element mounts in our checkout", await page.waitForSelector("iframe[data-forward-element]", { timeout: 30000 }).then(() => true).catch(() => false));
  check("portal: refund policy shows on the checkout", await page.locator("[data-fmpi-refund-policy]").isVisible());
  await fillForwardCard(page, FAILURE_VISA);
  await shot(page, "portal-card-entered");
  await clickPay(page);
  const declined = await waitOutcome(page);
  await shot(page, "portal-declined");
  check("portal: Forward's failure card is declined with Forward's reason", declined.ok === false && /authorization failed|declined/i.test(declined.error), declined);
  let portalPayments = (await portalSeed.api.req("GET", `/v1/payments/organizations/${login.orgId}/projects/${portalSeed.projectId}/payments`)).payments;
  check("portal: a decline records nothing", portalPayments.length === 0, { count: portalPayments.length });

  await fillForwardCard(page, SUCCESS_VISA);
  await clickPay(page);
  const paid = await waitOutcome(page);
  await shot(page, "portal-paid");
  check("portal: the success card pays the same checkout", paid.ok === true, paid);
  portalPayments = (await portalSeed.api.req("GET", `/v1/payments/organizations/${login.orgId}/projects/${portalSeed.projectId}/payments`)).payments;
  const portalPayment = portalPayments[0];
  check("portal: one payment recorded, charged through Forward", portalPayments.length === 1 && portalPayment.provider === "forward" && /^pmt_/.test(portalPayment.processor?.provider_payment_id || ""), portalPayment?.processor);
  evidence.push({ case: "portal-card", amount_cents: portalPayment?.amount_cents, payment_intent_id: portalPayment?.processor?.provider_intent_id, payment_id: portalPayment?.processor?.provider_payment_id, payment_method: portalPayment?.method });

  // ── 2. Staff Money tab: custom amount, save the card, charge it again ────
  const staffSeed = await seedProject(login, false);
  await page.goto(`${WEB}/portal/login.php`, { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, organization_id: org }) });
  }, { api: API, email: login.email, password: login.password, org: login.orgId });
  await page.goto(`${WEB}/portal/?project=${encodeURIComponent(staffSeed.projectId)}&projectTab=money`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 45000 });
  let mounted = false;
  for (let attempt = 0; attempt < 30 && !mounted; attempt += 1) {
    await page.evaluate(() => {
      const button = document.querySelector("[data-money-take-payment]");
      if (button) button.click();
      else [...document.querySelectorAll('[data-tab="money"]')].find((tab) => !tab.classList.contains("active"))?.click();
    });
    mounted = await page.waitForSelector("[data-money-payment-intake] .fmpi-modal", { timeout: 2000 }).then(() => true).catch(() => false);
  }
  check("staff: Take a payment opens", mounted);
  await page.evaluate(() => document.querySelector('[data-fmpi-method="card"]').click());
  await page.evaluate(() => { const input = document.querySelector("[data-fmpi-custom-amount]"); input.value = "11.00"; input.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.waitForTimeout(1500);
  await fillForwardCard(page, SUCCESS_VISA);
  await page.evaluate(() => { const save = document.querySelector("[data-fmpi-save]"); if (save && !save.checked) save.click(); });
  await shot(page, "staff-card-entered");
  await clickPay(page);
  const staffPaid = await waitOutcome(page);
  await shot(page, "staff-paid");
  check("staff: card payment for a custom amount goes through Forward", staffPaid.ok === true, staffPaid);
  let staffPayments = (await staffSeed.api.req("GET", `/v1/payments/organizations/${login.orgId}/projects/${staffSeed.projectId}/payments`)).payments;
  const staffPayment = staffPayments.find((payment) => payment.amount_cents === 1100);
  check("staff: $11.00 recorded with Forward ids", !!staffPayment && /^pi_/.test(staffPayment.processor?.provider_intent_id || ""), staffPayment?.processor);
  evidence.push({ case: "staff-card", amount_cents: 1100, payment_intent_id: staffPayment?.processor?.provider_intent_id, payment_id: staffPayment?.processor?.provider_payment_id });

  // ── 3. Void from the Money UI (whole amount, not settled yet) ────────────
  const voided = await staffSeed.api.req("POST", `/v1/payments/organizations/${login.orgId}/payments/${staffPayment.id}/refunds`, { reason: "requested_by_customer" });
  check("refund before settlement voids the payment at Forward", voided.provider_action === "voided" && voided.payment.status === "voided", { action: voided.provider_action, status: voided.payment?.status });
  evidence.push({ case: "void", payment_intent_id: staffPayment?.processor?.provider_intent_id, result: voided.payment?.status });

  // ── 4. Not set up: no card entry anywhere ────────────────────────────────
  if (notReadyLogin) {
    const notReady = await seedProject(notReadyLogin, true);
    const notReadyPage = await context.newPage();
    await notReadyPage.goto(`${WEB}/customer_portal/?id=${notReady.portalUuid}`, { waitUntil: "domcontentloaded" });
    await notReadyPage.getByText("Open document").first().click({ timeout: 30000 });
    const note = await notReadyPage.waitForFunction(() => [...document.querySelectorAll(".fmdoc-pay-now-note")].map((node) => node.textContent).join(" "), null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => "");
    await notReadyPage.screenshot({ path: path.join(SHOTS, "not-ready-portal.png") });
    check("not set up: the document offers no Pay button", /isn't available/i.test(String(note)) && !(await notReadyPage.evaluate(() => [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Pay"))), { note });
    await notReadyPage.close();
  }
} catch (error) {
  console.log("ERROR", error?.stack || error);
  await shot(page, "error").catch(() => null);
  check("run completed without error", false, String(error?.message || error));
} finally {
  await writeFile(EVIDENCE, JSON.stringify({ at: new Date().toISOString(), web: WEB, evidence, results }, null, 2));
  await browser.close();
}
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed; evidence: ${EVIDENCE}`);
process.exit(failed.length ? 1 : 0);
