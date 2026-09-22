/**
 * Payment-intake tokenization slice, driven end-to-end through the real UI:
 *
 *  1. Org WITHOUT a provider — the staff Money take-payment modal behaves
 *     exactly as legacy (fake saved-method stubs, raw-field mock record).
 *  2. Org WITH the mock provider — staff take-payment tokenizes the magic
 *     approved card, charges through the adapter, records fee fields +
 *     allocation; the save-card checkbox persists the method.
 *  3. Declined magic card (4000000000000002) — visible in-modal error, no
 *     transaction.
 *  4. Saved method appears on the next modal open and charging it works.
 *  5. Surcharge line appears when payment settings enable pass-through and
 *     matches the surcharge-quote endpoint to the cent.
 *  6. Customer portal public flow — a due invoice paid through the portal
 *     modal charges through the provider end-to-end.
 *  7. Document-widget checkout — a document payment output paid through the
 *     portal's doc pay-now modal tokenizes and charges through the provider;
 *     declines surface in the modal and write nothing; the legacy org's doc
 *     checkout stays byte-identical (fake stubs + mock_document record).
 *  8. Crew field payments (API, same routes the field app drives) — tokenized
 *     charges land with fee fields + allocation, doc-checkout charges once
 *     (document_output_id dedupe), declines surface structured errors, and
 *     cash recording stays legacy.
 *
 *   node scripts/payment-intake-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101 running the CURRENT dist).
 * Screenshots go to PAYMENT_INTAKE_SHOTS_DIR (or ./payment-intake-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.PAYMENT_INTAKE_SHOTS_DIR || path.resolve("payment-intake-shots");
await mkdir(SHOTS, { recursive: true });

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const APPROVED_PAN = "4242424242424242";
const DECLINED_PAN = "4000000000000002";
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};
const cardFee = (totalCents) => Math.round(totalCents * 2 / 10_000) + 30; // US flat-rate plan

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
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
      if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    }
  };
}

const ownerPassword = "correct horse battery staple";
async function seedOrg(orgSlug, options = {}) {
  const client = apiClient();
  const orgId = `org_${orgSlug}_${suffix}`;
  const email = `owner-${orgSlug}-${suffix}@example.test`;
  await client.req("POST", "/v1/platform/auth/register", {
    email, password: ownerPassword, name: "Intake Owner",
    company: `Intake ${orgSlug} Co`, organization_id: orgId
  });
  await client.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
  await client.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "money.profitability": true, "money.merchant_processing": true }
  });
  if (options.mockProvider) {
    await client.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
    const application = await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
      processing_plan_id: US_PLAN_ID, external_account_id: orgId,
      company: { legal_name: `Intake ${orgSlug} Co LLC` }
    });
    await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${application.application.id}/submit`, {});
    await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
      application_id: application.application.id, to: "APPROVED"
    });
  }
  const seeded = await seedSignedProject(client, orgId, orgSlug, `project_${orgSlug}_${suffix}`);
  return { client, orgId, email, ...seeded };
}

/** Signed-proposal project fixture ($2,500 deposit + $10,000 final). */
async function seedSignedProject(client, orgId, orgSlug, projectId) {
  const contactId = `contact_${orgSlug}`;
  await client.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId, title: "Cedar Deck Build", address: "9 Intake Lane", project_type: "residential",
      contacts: [{ id: contactId, name: "Pat Payer", email: `pat-${orgSlug}-${suffix}@example.test`, primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.req("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Cedar Deck Proposal",
    contacts: [{ id: contactId, role: "customer", name: "Pat Payer", email: `pat-${orgSlug}-${suffix}@example.test` }],
    editable: {
      title: "Cedar Deck Proposal",
      pricing: { total: 12500 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Cedar deck", amount: 12500 }] },
        { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000 }
      ]
    }
  });
  const sent = await client.req("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Pat Payer", email: `pat-${orgSlug}-${suffix}@example.test` }],
    include_pdf: false, include_portal: true
  });
  await client.req("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Pat Payer", signature: { type: "adopt", text: "Pat Payer" }
  });
  return { projectId, contactId, publicToken: String(sent.snapshot.delivery.public_token) };
}

/** Roofing sign-and-pay document ($13,500 total, 30% schedule -> $4,050
 *  deposit due through its doc.pay_now widget). The seeded template's pay
 *  widget submits the default "payment" output key while the document
 *  declares deposit_payment, so the fixture aligns them with a per-instance
 *  node override — exactly what the studio's output-key config field does. */
function findWidgetNode(definition, widgetPrefix) {
  const walk = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      if (node?.type === "widget" && String(node?.props?.widget || "").startsWith(widgetPrefix)) return node;
      const child = walk(node?.children);
      if (child) return child;
    }
    return null;
  };
  for (const page of Array.isArray(definition?.pages) ? definition.pages : []) {
    const node = walk(page.children);
    if (node) return node;
  }
  return null;
}
async function seedPaymentDocument(client, orgId, projectId, title) {
  const created = await client.req("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: "tpl_roofing_signature_payment",
    title,
    params: {
      customer: { name: "Pat Payer", email: `pat-doc-${suffix}@example.test` },
      scope_items: [
        { id: "item_roof", name: "Roof replacement", quantity: 1, unit: "job", unit_price: 12500 },
        { id: "item_gutter", name: "Gutter guards", quantity: 2, unit: "run", unit_price: 500 }
      ],
      tax_percent: 0
    }
  });
  const template = (await client.req("GET", `/v1/documents/organizations/${orgId}/templates/tpl_roofing_signature_payment`)).template;
  const payNode = findWidgetNode(template.definition, "doc.pay_now");
  if (!payNode) throw new Error("roofing template has no pay_now widget node");
  await client.req("PATCH", `/v1/documents/organizations/${orgId}/documents/${created.document.id}`, {
    overrides: [{ op: "node.set", node_id: payNode.id, prop: "props.config.output_key", value: "deposit_payment" }]
  });
  await client.req("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/issue`, {});
  const sent = await client.req("POST", `/v1/documents/organizations/${orgId}/documents/${created.document.id}/send`, {
    recipients: [{ name: "Pat Payer", email: `pat-doc-${suffix}@example.test`, role: "customer" }]
  });
  return { documentId: String(created.document.id), publicToken: String(sent.snapshot.public_token) };
}

const legacy = await seedOrg("intake_legacy");
const provider = await seedOrg("intake_mock", { mockProvider: true });

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
}
async function login(email, org) {
  await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, organization_id: org })
    });
  }, { api: API, email, password: ownerPassword, org });
}
async function openTakePayment(projectId) {
  await page.goto(`${WEB}/portal/?project=${encodeURIComponent(projectId)}&projectTab=money`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Portal?.currentUser && !!window.Portal?.navigation?.navigate, null, { timeout: 30000 });
  // Early navigation can be stolen by route normalization (pipeline board /
  // viewer tab); re-assert the money tab through the navigation API, then
  // dispatch the click directly and retry until the intake modal mounts (the
  // button no-ops while a load is busy).
  await page.waitForTimeout(1200);
  // Let the money tab finish loading on its own — re-navigating while the
  // project view is mid-load re-triggers applyCurrent() and can wedge it.
  // Known intermittent thief: the project Documents overlay auto-opens over
  // the viewer on deep link and swallows the money tab. Recovery = Escape to
  // dismiss overlays, then a FULL reload (fresh SPA boot) — never blanket
  // in-page clicking, which can hit topbar controls and navigate away.
  let haveButton = false;
  for (let nav = 0; nav < 6 && !haveButton; nav += 1) {
    if (nav > 0) {
      // Freshly-restarted servers can transiently answer "record was not
      // found" while indexes warm — give those a beat before reloading.
      const notFound = await page.evaluate(() => /requested platform record was not found/i.test(document.body?.textContent || ""));
      if (notFound) await page.waitForTimeout(5000);
      await page.goto(`${WEB}/portal/?project=${encodeURIComponent(projectId)}&projectTab=money`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => !!window.Portal?.currentUser && !!window.Portal?.navigation?.navigate, null, { timeout: 30000 });
      await page.waitForTimeout(1200);
    }
    haveButton = await page.waitForSelector("[data-money-take-payment]", { timeout: 12000, state: "attached" })
      .then(() => true).catch(() => false);
    if (!haveButton) {
      await page.keyboard.press("Escape");
      // Route normalization can flip the viewer to another project tab: the
      // deep-linked money tab is not in the viewer's availableTabs until app
      // flags stream in, so the shell rewrites the route to the default
      // (map). Recovery: clear any stray top-level tab via the navigation
      // API, then KEEP clicking the viewer's own Money tab (scoped through
      // its tab strip so a topbar [data-tab] can never be hit) as soon as it
      // renders, until the take-payment button exists.
      await page.evaluate((id) => {
        window.Portal.navigation.navigate({ tab: null, project: id, projectTab: "money" });
      }, projectId);
      haveButton = await page.waitForFunction(() => {
        if (document.querySelector("[data-money-take-payment]")) return true;
        const viewerMoneyTab = [...document.querySelectorAll('[data-tab="money"]')].find((btn) =>
          btn.parentElement?.querySelector('[data-tab="map"], [data-tab="photos"], [data-tab="overview"]'));
        if (viewerMoneyTab && !viewerMoneyTab.classList.contains("active")) viewerMoneyTab.click();
        return false;
      }, null, { timeout: 15000, polling: 500 }).then(() => true).catch(() => false);
    }
  }
  // Phase 2: the button no-ops while a load is busy — click and retry until
  // the modal mounts, without any further navigation.
  let mounted = false;
  for (let attempt = 0; attempt < 15 && haveButton && !mounted; attempt += 1) {
    await page.evaluate(() => document.querySelector("[data-money-take-payment]")?.click());
    mounted = await page.waitForSelector("[data-money-payment-intake] .fmpi-modal", { timeout: 2000 })
      .then(() => true).catch(() => false);
  }
  if (!mounted) {
    await shot("mount-failure");
    const debug = await page.evaluate(() => ({
      url: location.href,
      mount: !!document.querySelector("[data-money-payment-intake]"),
      modalAnywhere: !!document.querySelector(".fmpi-modal"),
      button: !!document.querySelector("[data-money-take-payment]"),
      intakeApi: typeof window.PaymentsAPI?.intake?.config,
      fmpi: typeof window.FirstMatePaymentIntake?.mount
    }));
    throw new Error("take-payment intake modal never mounted: " + JSON.stringify(debug));
  }
  await page.waitForTimeout(700); // provider-config fetch may re-mount
}
// The project shell keeps board/viewer panels layered near the modal, which
// intercepts Playwright's pointer actionability checks — drive the modal by
// dispatching real DOM events on the live nodes instead.
async function domClick(pageRef, selector) {
  await pageRef.waitForSelector(selector, { timeout: 15000, state: "attached" });
  await pageRef.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`missing ${s}`);
    el.click();
  }, selector);
}
async function domFill(pageRef, selector, value) {
  await pageRef.waitForSelector(selector, { timeout: 15000, state: "attached" });
  await pageRef.evaluate(({ s, v }) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`missing ${s}`);
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, { s: selector, v: value });
}
async function fillCard(pageRef, pan, { amount, zip = "90210" } = {}) {
  // Method selection re-renders the modal (clearing the amount input), so
  // choose the method FIRST, then type the amount and card fields.
  await domClick(pageRef, '[data-fmpi-method="card"]');
  if (amount !== undefined) await domFill(pageRef, "[data-fmpi-custom-amount]", amount);
  await domFill(pageRef, '[data-fmpi-field="cardName"]', "Pat Payer");
  await domFill(pageRef, '[data-fmpi-field="cardNumber"]', pan);
  await domFill(pageRef, '[data-fmpi-field="expMonth"]', "12");
  await domFill(pageRef, '[data-fmpi-field="expYear"]', "2032");
  await domFill(pageRef, '[data-fmpi-field="cvc"]', "123");
  await domFill(pageRef, '[data-fmpi-field="zip"]', zip);
}
async function submitAndWait(pageRef, outcome) {
  const enabled = await pageRef.evaluate(() => !document.querySelector("[data-fmpi-submit]")?.disabled);
  if (!enabled) throw new Error("submit button is disabled");
  await domClick(pageRef, "[data-fmpi-submit]");
  // The processing spinner reuses the .fmpi-success container class — wait
  // for the success view's h3 (checkmark screen) specifically.
  if (outcome === "success") await pageRef.waitForFunction(() => !!document.querySelector(".fmpi-success h3"), null, { timeout: 25000 });
  else await pageRef.waitForFunction(() => !!document.querySelector(".fmpi-error"), null, { timeout: 25000 });
}
const projectPayments = (org, projectId, client) =>
  client.req("GET", `/v1/payments/organizations/${org}/projects/${projectId}/payments`).then((r) => r.payments);

// ── 1. Legacy org: modal behaves exactly as before ---------------------------
await login(legacy.email, legacy.orgId);
await openTakePayment(legacy.projectId);
const legacyState = await page.evaluate(() => ({
  fakeSaved: !!document.querySelector('[data-fmpi-saved="test_card_on_file"]'),
  surchargeLine: !!document.querySelector("[data-fmpi-surcharge]"),
  forwardElement: !!document.querySelector("[data-fmpi-forward-element]")
}));
check("legacy org shows the hardcoded saved-method stub (fakeSavedMethods intact)", legacyState.fakeSaved, legacyState);
check("legacy org renders no surcharge line and no provider element", !legacyState.surchargeLine && !legacyState.forwardElement);
await fillCard(page, APPROVED_PAN, { amount: "150.00" });
await shot("legacy-card-filled");
await submitAndWait(page, "success");
const legacyPayments = await projectPayments(legacy.orgId, legacy.projectId, legacy.client);
const legacyPayment = legacyPayments[0];
check("legacy submit records the mock payment (no provider fields)",
  legacyPayments.length === 1 && legacyPayment.amount_cents === 15_000
  && legacyPayment.provider === undefined && legacyPayment.fee_cents === undefined
  && legacyPayment.method?.type === "card",
  { amount: legacyPayment?.amount_cents, provider: legacyPayment?.provider, fee: legacyPayment?.fee_cents });
await shot("legacy-success");

// ── 2. Provider org: approved magic card + save checkbox ---------------------
await login(provider.email, provider.orgId);
await openTakePayment(provider.projectId);
const providerFirstOpen = await page.evaluate(() => ({
  fakeSaved: !!document.querySelector('[data-fmpi-saved="test_card_on_file"]'),
  savedButtons: document.querySelectorAll("[data-fmpi-saved]").length
}));
check("provider org never shows fake saved-method stubs", !providerFirstOpen.fakeSaved && providerFirstOpen.savedButtons === 0, providerFirstOpen);
await fillCard(page, APPROVED_PAN, { amount: "2500.00" });
await domClick(page, "[data-fmpi-save]");
await shot("provider-card-filled");
await submitAndWait(page, "success");
let payments = await projectPayments(provider.orgId, provider.projectId, provider.client);
const deposit = payments.find((p) => p.amount_cents === 250_000);
check("approved magic card charges through the provider with exact fee fields",
  payments.length === 1 && !!deposit && deposit.provider === "mock"
  && deposit.fee_cents === cardFee(250_000) && deposit.fee_cents === 80
  && deposit.merchant_amount_cents === 249_920
  && /^pay_mock_/.test(deposit.processor?.provider_payment_id || ""),
  { fee: deposit?.fee_cents, merchant: deposit?.merchant_amount_cents, provider: deposit?.provider });
const depositSummary = await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/projects/${provider.projectId}/obligations`);
const depositObligation = depositSummary.obligations.find((o) => /deposit/i.test(o.label));
check("charge allocation fully satisfies the deposit obligation",
  depositObligation && depositObligation.allocated_cents === 250_000, depositObligation?.allocated_cents);
const savedList = (await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/customers/${provider.contactId}/payment-methods`)).payment_methods;
check("save-card checkbox persisted the payment method",
  savedList.length === 1 && savedList[0].brand === "Visa" && savedList[0].last4 === "4242"
  && /^pm_mock_/.test(savedList[0].provider_payment_method_id), savedList[0]);
await shot("provider-approved-success");

// ── 3. Declined magic card: visible error, no transaction --------------------
await openTakePayment(provider.projectId);
await fillCard(page, DECLINED_PAN, { amount: "50.00" });
await submitAndWait(page, "error");
const declineError = await page.evaluate(() => document.querySelector(".fmpi-error")?.textContent || "");
check("declined magic card surfaces the decline message in the modal",
  /declined/i.test(declineError), declineError);
payments = await projectPayments(provider.orgId, provider.projectId, provider.client);
check("declined charge writes no transaction", payments.length === 1, payments.length);
const declinedInputs = await page.evaluate(() => ({
  cardNumber: document.querySelector('[data-fmpi-field="cardNumber"]')?.value || "",
  cvc: document.querySelector('[data-fmpi-field="cvc"]')?.value || ""
}));
check("card number + CVC inputs are cleared after tokenization", declinedInputs.cardNumber === "" && declinedInputs.cvc === "", declinedInputs);
await shot("provider-declined");

// ── 4. Saved method on next open + charging it works --------------------------
await openTakePayment(provider.projectId);
const savedButton = await page.evaluate(() => {
  const btn = document.querySelector("[data-fmpi-saved]");
  return btn ? { id: btn.dataset.fmpiSaved, label: btn.textContent.replace(/\s+/g, " ").trim() } : null;
});
check("saved method appears on the next modal open",
  !!savedButton && savedButton.id === savedList[0].id && /Visa ending in 4242/.test(savedButton.label), savedButton);
await domClick(page, "[data-fmpi-saved]");
await domFill(page, "[data-fmpi-custom-amount]", "100.00");
await page.waitForFunction(() => { const b = document.querySelector("[data-fmpi-submit]"); return !!b && !b.disabled; }, null, { timeout: 10000 });
await shot("provider-saved-selected");
await submitAndWait(page, "success");
payments = await projectPayments(provider.orgId, provider.projectId, provider.client);
const savedCharge = payments.find((p) => p.amount_cents === 10_000);
check("charging the saved method works with exact fee math",
  payments.length === 2 && !!savedCharge && savedCharge.fee_cents === cardFee(10_000)
  && savedCharge.merchant_amount_cents === 10_000 - cardFee(10_000)
  && savedCharge.method?.type === "saved_card",
  { fee: savedCharge?.fee_cents, type: savedCharge?.method?.type });

// ── 5. Surcharge line matches the endpoint ------------------------------------
await provider.client.req("PUT", `/v1/platform/organizations/${provider.orgId}/branch/default/modules/payment_settings`, {
  data: { surcharge_enabled: true, surcharge_mode: "card_only" }
});
const quote = (await provider.client.req("GET",
  `/v1/payments/organizations/${provider.orgId}/surcharge-quote?amount_cents=10000&method=card`)).quote;
check("surcharge-quote endpoint prices 3% on card", quote.surcharge_cents === 300 && quote.total_cents === 10_300, quote);
await openTakePayment(provider.projectId);
await fillCard(page, APPROVED_PAN, { amount: "100.00" });
await page.waitForSelector("[data-fmpi-surcharge]", { timeout: 15000 });
const surchargeLine = await page.evaluate(() => document.querySelector("[data-fmpi-surcharge]")?.textContent.replace(/\s+/g, " ") || "");
check("surcharge line renders the quoted amount and total",
  surchargeLine.includes("$3.00") && surchargeLine.includes("$103.00"), surchargeLine);
await shot("provider-surcharge-line");
await submitAndWait(page, "success");
payments = await projectPayments(provider.orgId, provider.projectId, provider.client);
const surcharged = payments.find((p) => p.amount_cents === 10_300);
check("charged total includes the pass-through surcharge with metadata split",
  !!surcharged && surcharged.metadata?.surcharge_cents === 300 && surcharged.metadata?.base_amount_cents === 10_000
  && surcharged.fee_cents === cardFee(10_300),
  { amount: surcharged?.amount_cents, surcharge: surcharged?.metadata?.surcharge_cents, fee: surcharged?.fee_cents });
await provider.client.req("PUT", `/v1/platform/organizations/${provider.orgId}/branch/default/modules/payment_settings`, {
  data: { surcharge_enabled: false }
});

// ── 6. Customer portal: pay a due invoice through the provider ----------------
const obligations = (await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/projects/${provider.projectId}/obligations`)).obligations;
const finalObligation = obligations.find((o) => /final/i.test(o.label));
const finalOpen = finalObligation.amount_cents - finalObligation.allocated_cents;
const invoice = await provider.client.req("POST", `/v1/payments/organizations/${provider.orgId}/projects/${provider.projectId}/invoices`, {
  obligation_ids: [finalObligation.id]
});
await provider.client.req("POST", `/v1/payments/organizations/${provider.orgId}/invoices/${invoice.invoice.id}/mark-due`, {});
const portal = (await provider.client.req("GET", `/v1/platform/organizations/${provider.orgId}/projects/${provider.projectId}/customer-portal`)).portal;
const portalUuid = String(portal.public_uuid || portal.preview_uuid);
const portalPath = portal.public_uuid ? `/customer_portal/?id=${encodeURIComponent(portalUuid)}` : `/customer_portal/preview.php?id=${encodeURIComponent(portalUuid)}`;
const portalPage = await ctx.newPage();
portalPage.on("pageerror", (e) => console.log("   [portal pageerror]", e.message));
// Deterministic wait: the due card must be the FINAL obligation (deposit is
// already charged+allocated staff-side). A transient failure of the portal
// payload's per-proposal workflow enrichment can momentarily degrade the
// panel to the snapshot-side deposit fallback — reload until the live
// obligation card renders, and report how many attempts it took.
const finalCardSelector = `[data-payment-obligation="${finalObligation.id}"]`;
let portalAttempts = 0;
let haveFinalCard = false;
for (; portalAttempts < 4 && !haveFinalCard; portalAttempts += 1) {
  await portalPage.goto(WEB + portalPath, { waitUntil: "domcontentloaded" });
  await portalPage.waitForSelector('[data-tab="payments"]', { timeout: 30000 });
  await portalPage.click('[data-tab="payments"]');
  haveFinalCard = await portalPage.waitForSelector(finalCardSelector, { timeout: 15000 })
    .then(() => true).catch(() => false);
  if (!haveFinalCard) {
    const debug = await portalPage.evaluate(() => ({
      dueCards: [...document.querySelectorAll(".cp-payment-due-card")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
      payButtons: [...document.querySelectorAll("[data-payment-proposal]")].map((el) => el.dataset.paymentObligation || "(none)")
    }));
    console.log(`   [portal retry ${portalAttempts + 1}] final-obligation card missing`, JSON.stringify(debug));
  }
}
check("portal renders the live final-obligation card (deposit already settled staff-side)",
  haveFinalCard, { attempts: portalAttempts });
const dueCard = await portalPage.evaluate((selector) =>
  document.querySelector(selector)?.closest(".cp-payment-due-card")?.textContent.replace(/\s+/g, " ") || "", finalCardSelector);
check("portal shows the due invoice with the open balance", dueCard.includes((finalOpen / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })), { dueCard, finalOpen });
const depositCardShown = await portalPage.evaluate(() =>
  [...document.querySelectorAll(".cp-payment-due-card")].some((el) => /Due with signed contract/.test(el.textContent)));
check("the settled deposit is never presented as due", !depositCardShown);
await portalPage.click(finalCardSelector);
await portalPage.waitForSelector(".fmpi-modal", { timeout: 20000 });
await portalPage.waitForTimeout(500);
const portalModal = await portalPage.evaluate(() => ({
  amount: document.querySelector(".fmpi-amount strong")?.textContent.trim() || "",
  fakeSaved: !!document.querySelector('[data-fmpi-saved="test_card_on_file"]')
}));
check("portal modal opens on the exact obligation balance without fake stubs",
  Math.round(Number(portalModal.amount.replace(/[^0-9.]/g, "")) * 100) === finalOpen && !portalModal.fakeSaved, portalModal);
await portalPage.click('[data-fmpi-method="card"]');
await portalPage.fill('[data-fmpi-field="cardName"]', "Pat Payer");
await portalPage.fill('[data-fmpi-field="cardNumber"]', APPROVED_PAN);
await portalPage.fill('[data-fmpi-field="expMonth"]', "12");
await portalPage.fill('[data-fmpi-field="expYear"]', "2032");
await portalPage.fill('[data-fmpi-field="cvc"]', "123");
await portalPage.fill('[data-fmpi-field="zip"]', "90210");
await portalPage.screenshot({ path: path.join(SHOTS, "90-portal-card-filled.png") });
await portalPage.click("[data-fmpi-submit]");
await portalPage.waitForSelector(".fmpi-success h3", { timeout: 30000 });
await portalPage.screenshot({ path: path.join(SHOTS, "91-portal-success.png") });
payments = await projectPayments(provider.orgId, provider.projectId, provider.client);
const portalPayment = payments.find((p) => p.amount_cents === finalOpen);
check("portal payment charged through the provider with exact fee fields",
  payments.length === 4 && !!portalPayment && portalPayment.provider === "mock"
  && portalPayment.fee_cents === cardFee(finalOpen)
  && portalPayment.merchant_amount_cents === finalOpen - cardFee(finalOpen)
  && /^pay_mock_/.test(portalPayment.processor?.provider_payment_id || ""),
  { amount: portalPayment?.amount_cents, fee: portalPayment?.fee_cents });
const invoicesAfter = (await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/projects/${provider.projectId}/invoices`)).invoices;
check("the due invoice settles to paid", invoicesAfter.find((i) => i.id === invoice.invoice.id)?.status === "paid",
  invoicesAfter.map((i) => i.status));
const finalAfter = (await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/projects/${provider.projectId}/obligations`))
  .obligations.find((o) => o.id === finalObligation.id);
check("final obligation is fully allocated to the cent",
  finalAfter.allocated_cents === finalObligation.amount_cents, finalAfter.allocated_cents);

// ── 7. Document-widget checkout in the portal ---------------------------------
// A fresh project keeps transaction counts clean. The document tab id depends
// on the document's presentation, so the harness clicks through the portal
// tabs until the doc pay-now button renders.
async function openDocumentPayModal(portalRef, portalUrl) {
  await portalRef.goto(portalUrl, { waitUntil: "domcontentloaded" });
  await portalRef.waitForSelector("[data-tab]", { timeout: 30000 });
  const tabIds = await portalRef.evaluate(() =>
    [...document.querySelectorAll("[data-tab]")].map((el) => el.dataset.tab));
  let payButton = false;
  for (const tabId of tabIds) {
    await portalRef.evaluate((id) => document.querySelector(`[data-tab="${id}"]`)?.click(), tabId);
    payButton = await portalRef.waitForSelector(".fmdoc-pay-now-button", { timeout: 4000 })
      .then(() => true).catch(() => false);
    if (payButton) break;
  }
  if (!payButton) throw new Error(`doc pay-now button never rendered (tabs: ${tabIds.join(",")})`);
  await portalRef.evaluate(() => document.querySelector(".fmdoc-pay-now-button")?.click());
  // openDocumentPayment resolves the intake config BEFORE opening the modal.
  await portalRef.waitForSelector(".fmpi-modal", { timeout: 20000 });
  await portalRef.waitForTimeout(400);
}
async function portalUrlFor(client, orgId, projectId) {
  const portal = (await client.req("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`)).portal;
  const uuid = String(portal.public_uuid || portal.preview_uuid);
  return WEB + (portal.public_uuid
    ? `/customer_portal/?id=${encodeURIComponent(uuid)}`
    : `/customer_portal/preview.php?id=${encodeURIComponent(uuid)}`);
}
const docProjectId = `project_docpay_${suffix}`;
await provider.client.req("PUT", `/v1/platform/organizations/${provider.orgId}/projects/${docProjectId}`, {
  data: {
    id: docProjectId, title: "Doc Checkout Build", address: "11 Document Way", project_type: "residential",
    contacts: [{ id: "contact_docpay", name: "Pat Payer", email: `pat-doc-${suffix}@example.test`, primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const providerDoc = await seedPaymentDocument(provider.client, provider.orgId, docProjectId, "Tokenized Doc Checkout");
const docIntakeConfig = await provider.client.req("GET", `/v1/documents/public/${providerDoc.publicToken}/payments/intake-config`);
check("document-token intake config resolves the provider", docIntakeConfig.provider === "mock" && docIntakeConfig.tokenization?.mode === "mock", docIntakeConfig.provider);

const docPage = await ctx.newPage();
docPage.on("pageerror", (e) => console.log("   [doc pageerror]", e.message));
const providerDocPortalUrl = await portalUrlFor(provider.client, provider.orgId, docProjectId);
await openDocumentPayModal(docPage, providerDocPortalUrl);
const docModalState = await docPage.evaluate(() => ({
  amount: document.querySelector(".fmpi-amount strong")?.textContent.trim() || "",
  fakeSaved: !!document.querySelector('[data-fmpi-saved="test_card_on_file"]')
}));
check("doc checkout modal opens on the scheduled deposit without fake stubs",
  Math.round(Number(docModalState.amount.replace(/[^0-9.]/g, "")) * 100) === 405_000 && !docModalState.fakeSaved, docModalState);
await fillCard(docPage, APPROVED_PAN, {});
await docPage.screenshot({ path: path.join(SHOTS, "92-doc-card-filled.png") });
await submitAndWait(docPage, "success");
await docPage.screenshot({ path: path.join(SHOTS, "93-doc-success.png") });
let docPayments = await projectPayments(provider.orgId, docProjectId, provider.client);
const docCharge = docPayments.find((p) => p.amount_cents === 405_000);
check("doc-widget payment charged through the provider with exact fee fields",
  docPayments.length === 1 && !!docCharge && docCharge.provider === "mock"
  && docCharge.fee_cents === cardFee(405_000)
  && docCharge.merchant_amount_cents === 405_000 - cardFee(405_000)
  && /^pay_mock_/.test(docCharge.processor?.provider_payment_id || "")
  && docCharge.metadata?.document_output_id === `${providerDoc.documentId}:deposit_payment`,
  { amount: docCharge?.amount_cents, fee: docCharge?.fee_cents, ref: docCharge?.metadata?.document_output_id });
const docSnapshot = await provider.client.req("GET", `/v1/documents/public/${providerDoc.publicToken}`);
check("document output records the charged transaction",
  docSnapshot.snapshot.outputs?.deposit_payment?.payment_id === docCharge?.id
  && docSnapshot.snapshot.outputs?.deposit_payment?.provider === "mock",
  docSnapshot.snapshot.outputs?.deposit_payment?.payment_id);

// Decline on a fresh document (own project so the paid document above can
// never shadow the pay button): in-modal error, output + transactions untouched.
const declineProjectId = `project_docpay2_${suffix}`;
await provider.client.req("PUT", `/v1/platform/organizations/${provider.orgId}/projects/${declineProjectId}`, {
  data: {
    id: declineProjectId, title: "Doc Decline Build", address: "13 Document Way", project_type: "residential",
    contacts: [{ id: "contact_docpay", name: "Pat Payer", email: `pat-doc-${suffix}@example.test`, primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const declineDoc = await seedPaymentDocument(provider.client, provider.orgId, declineProjectId, "Declined Doc Checkout");
await openDocumentPayModal(docPage, await portalUrlFor(provider.client, provider.orgId, declineProjectId));
await fillCard(docPage, DECLINED_PAN, {});
await submitAndWait(docPage, "error");
const docDeclineError = await docPage.evaluate(() => document.querySelector(".fmpi-error")?.textContent || "");
check("declined doc checkout surfaces the decline in the modal", /declined/i.test(docDeclineError), docDeclineError);
const declinePayments = await projectPayments(provider.orgId, declineProjectId, provider.client);
check("declined doc checkout writes no transaction", declinePayments.length === 0, declinePayments.length);
const declineSnapshot = await provider.client.req("GET", `/v1/documents/public/${declineDoc.publicToken}`);
check("declined doc checkout never records the output",
  declineSnapshot.snapshot.outputs?.deposit_payment === undefined);
await docPage.screenshot({ path: path.join(SHOTS, "94-doc-declined.png") });

// Legacy org parity: the doc checkout modal keeps the fake stubs and the
// mock_document record path, byte-identical.
const legacyDocProjectId = `project_docpay_legacy_${suffix}`;
await legacy.client.req("PUT", `/v1/platform/organizations/${legacy.orgId}/projects/${legacyDocProjectId}`, {
  data: {
    id: legacyDocProjectId, title: "Legacy Doc Build", address: "12 Legacy Way", project_type: "residential",
    contacts: [{ id: "contact_docpay", name: "Pat Payer", email: `pat-doc-${suffix}@example.test`, primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const legacyDoc = await seedPaymentDocument(legacy.client, legacy.orgId, legacyDocProjectId, "Legacy Doc Checkout");
const legacyDocConfig = await legacy.client.req("GET", `/v1/documents/public/${legacyDoc.publicToken}/payments/intake-config`);
check("legacy org document intake config stays provider:null", legacyDocConfig.provider === null);
await openDocumentPayModal(docPage, await portalUrlFor(legacy.client, legacy.orgId, legacyDocProjectId));
const legacyDocModal = await docPage.evaluate(() => ({
  fakeSaved: !!document.querySelector('[data-fmpi-saved="test_card_on_file"]'),
  forwardElement: !!document.querySelector("[data-fmpi-forward-element]")
}));
check("legacy doc checkout modal keeps the hardcoded stub and no provider element",
  legacyDocModal.fakeSaved && !legacyDocModal.forwardElement, legacyDocModal);
await fillCard(docPage, APPROVED_PAN, {});
await submitAndWait(docPage, "success");
const legacyDocPayments = await projectPayments(legacy.orgId, legacyDocProjectId, legacy.client);
const legacyDocPayment = legacyDocPayments[0];
check("legacy doc checkout records the mock_document payment with no provider fields",
  legacyDocPayments.length === 1 && legacyDocPayment.amount_cents === 405_000
  && legacyDocPayment.method?.type === "mock_document"
  && legacyDocPayment.provider === undefined && legacyDocPayment.fee_cents === undefined,
  { amount: legacyDocPayment?.amount_cents, type: legacyDocPayment?.method?.type });
await docPage.screenshot({ path: path.join(SHOTS, "95-doc-legacy-success.png") });

// ── 8. Crew field payments (API — the same routes the field app drives) -------
const crewSeed = await seedSignedProject(provider.client, provider.orgId, "crew_mock", `project_crew_${suffix}`);
// Management actors reach crew facades through production scope: the project
// needs a scheduled work event.
await provider.client.req("PUT", `/v1/platform/organizations/${provider.orgId}/projects/${crewSeed.projectId}`, {
  data: {
    id: crewSeed.projectId, title: "Cedar Deck Build", address: "9 Intake Lane", project_type: "residential",
    contacts: [{ id: crewSeed.contactId, name: "Pat Payer", email: `pat-crew_mock-${suffix}@example.test`, primary: true }],
    events: [{ id: "event_crew_work", kind: "project_work", status: "scheduled", title: "Install", start: new Date().toISOString() }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const crewBase = `/v1/workforce/organizations/${provider.orgId}/crew`;
const orgIntakeConfig = await provider.client.req("GET", `/v1/payments/organizations/${provider.orgId}/payment-intake-config?contact_ref=${crewSeed.contactId}`);
check("org intake config (the crew mount's resolver) exposes the provider",
  orgIntakeConfig.provider === "mock" && orgIntakeConfig.tokenization?.mode === "mock", orgIntakeConfig.provider);
const crewToken = (await provider.client.req("POST", `/v1/payments/organizations/${provider.orgId}/payment-method-intents`, {
  type: "card", card: { number: APPROVED_PAN, exp_month: 12, exp_year: 2032, cvc: "123", zip: "90210" }
})).intent.payment_method_id;
const crewCharge = await provider.client.req("POST", `${crewBase}/projects/${crewSeed.projectId}/payments`, {
  amount_cents: 250_000,
  method: { kind: "card" },
  contact_ref: { id: crewSeed.contactId, name: "Pat Payer" },
  payment_method_id: crewToken
});
check("tokenized crew field payment charges with exact fee fields + allocation",
  crewCharge.payment.kind === "field_payment" && crewCharge.payment.provider === "mock"
  && crewCharge.payment.fee_cents === cardFee(250_000)
  && crewCharge.payment.merchant_amount_cents === 250_000 - cardFee(250_000)
  && crewCharge.payment.metadata?.source === "crew_app"
  && crewCharge.allocations?.length === 1 && crewCharge.allocations[0].amount_cents === 250_000,
  { fee: crewCharge.payment?.fee_cents, allocations: crewCharge.allocations?.length });
const crewDeclinedToken = (await provider.client.req("POST", `/v1/payments/organizations/${provider.orgId}/payment-method-intents`, {
  type: "card", card: { number: DECLINED_PAN, exp_month: 12, exp_year: 2032, cvc: "123" }
})).intent.payment_method_id;
const crewDeclined = await provider.client.req("POST", `${crewBase}/projects/${crewSeed.projectId}/payments`, {
  amount_cents: 10_000, method: { kind: "card" }, payment_method_id: crewDeclinedToken
}).then(() => null).catch((error) => String(error.message));
check("declined crew charge surfaces the structured payment_declined error",
  !!crewDeclined && /payment_declined/.test(crewDeclined) && /declined/i.test(crewDeclined), crewDeclined);
let crewPayments = await projectPayments(provider.orgId, crewSeed.projectId, provider.client);
check("declined crew charge writes no transaction", crewPayments.length === 1, crewPayments.length);
// Crew doc-checkout (field signatures route) with a tokenized card.
const crewDoc = await seedPaymentDocument(provider.client, provider.orgId, crewSeed.projectId, "On-site Checkout");
const crewDocToken = (await provider.client.req("POST", `/v1/payments/organizations/${provider.orgId}/payment-method-intents`, {
  type: "card", card: { number: APPROVED_PAN, exp_month: 12, exp_year: 2032, cvc: "123" }
})).intent.payment_method_id;
const crewDocCharge = await provider.client.req("POST", `${crewBase}/projects/${crewSeed.projectId}/signatures/${crewDoc.documentId}/payments/deposit_payment`, {
  amount_cents: 1_350_000, method: { kind: "card" }, payment_method_id: crewDocToken,
  contact_ref: { id: crewSeed.contactId, name: "Pat Payer" }
});
crewPayments = await projectPayments(provider.orgId, crewSeed.projectId, provider.client);
check("crew doc checkout charges once (document_output_id dedupe) and records the output",
  crewDocCharge.payment.provider === "mock" && crewDocCharge.payment.fee_cents === cardFee(1_350_000)
  && crewDocCharge.document?.outputs?.deposit_payment?.payment_id === crewDocCharge.payment.id
  && crewPayments.filter((p) => p.metadata?.document_output_id === `${crewDoc.documentId}:deposit_payment`).length === 1
  && crewPayments.filter((p) => String(p.id).startsWith("payment_doc_")).length === 0,
  { fee: crewDocCharge.payment?.fee_cents, count: crewPayments.length });
// Legacy parity: cash recording is untouched on both orgs; raw card without a
// token is still rejected.
const crewCash = await provider.client.req("POST", `${crewBase}/projects/${crewSeed.projectId}/payments`, {
  amount_cents: 5_000, method: { kind: "cash" }
});
check("crew cash recording stays legacy (no provider fields)",
  crewCash.payment.method?.kind === "cash" && crewCash.payment.provider === undefined
  && crewCash.payment.fee_cents === undefined, crewCash.payment?.method);
const crewCardSpoof = await provider.client.req("POST", `${crewBase}/projects/${crewSeed.projectId}/payments`, {
  amount_cents: 5_000, method: { kind: "card" }
}).then(() => null).catch((error) => String(error.message));
check("raw card without a token is still rejected (crew_payment_method_unsupported)",
  !!crewCardSpoof && /crew_payment_method_unsupported/.test(crewCardSpoof), crewCardSpoof);

// ── 9. PAN never persisted server-side ----------------------------------------
async function grepStorage(root, needles) {
  const hits = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        const text = await readFile(full, "utf8").catch(() => "");
        for (const needle of needles) if (text.includes(needle)) hits.push(full);
      }
    }
  }
  await walk(root);
  return hits;
}
const storageRoot = path.resolve("storage", "platform", "organizations");
const panHits = [];
for (const org of [legacy.orgId, provider.orgId]) {
  panHits.push(...await grepStorage(path.join(storageRoot, org), [APPROVED_PAN, DECLINED_PAN]));
}
check("magic card numbers never persist in either org's stored documents", panHits.length === 0, panHits.slice(0, 3));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
