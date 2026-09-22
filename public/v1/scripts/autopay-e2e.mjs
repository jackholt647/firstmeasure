/**
 * Autopay slice, driven end-to-end through the real Money-app UI:
 *
 *  1. Org with the mock provider + a saved card — the payment-schedule panel
 *     shows the Autopay affordance; real clicks enroll (pick saved method).
 *  2. POST /autopay/run charges the due deposit; API shows the exact fee +
 *     allocation and the UI shows the deposit card as paid with the autopay
 *     chip active.
 *  3. Decline path: a second project enrolled with a declined magic card runs
 *     to the 3-attempt pause; the UI shows the Paused chip + last decline and
 *     the Resume button (after swapping to a good method) reactivates it.
 *
 *   node scripts/autopay-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101 running the CURRENT dist).
 * Screenshots go to AUTOPAY_SHOTS_DIR (or ./autopay-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.AUTOPAY_SHOTS_DIR || path.resolve("autopay-shots");
await mkdir(SHOTS, { recursive: true });

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const APPROVED_PAN = "4242424242424242";
const DECLINED_PAN = "4000000000000002";
const HOUR = 60 * 60 * 1000;
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

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
const client = apiClient();
const orgId = `org_autopay_e2e_${suffix}`;
const email = `owner-autopay-${suffix}@example.test`;

async function seedProject(slug) {
  const projectId = `project_autopay_${slug}_${suffix}`;
  const contactId = `contact_autopay_${slug}`;
  const contactEmail = `auto-${slug}-${suffix}@example.test`;
  await client.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId, title: `Autopay ${slug} Roof`, address: `${slug} Autopay Way`, project_type: "residential",
      contacts: [{ id: contactId, name: "Amy Auto", email: contactEmail, primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.req("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
    title: "Autopay Proposal",
    contacts: [{ id: contactId, role: "customer", name: "Amy Auto", email: contactEmail }],
    editable: {
      title: "Autopay Proposal",
      pricing: { total: 12500 },
      pages: [
        { id: "pricing", kind: "pricing", lineItems: [{ label: "Roof", amount: 12500 }] },
        { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000 }
      ]
    }
  });
  const sent = await client.req("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
    expected_revision: created.proposal.revision,
    recipients: [{ role: "customer", name: "Amy Auto", email: contactEmail }],
    include_pdf: false, include_portal: true
  });
  await client.req("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
    signer_name: "Amy Auto", signature: { type: "adopt", text: "Amy Auto" }
  });
  return { projectId, contactId };
}

async function savedMethodFromCard(contactId, pan) {
  const tokenized = await client.req("POST", `/v1/payments/organizations/${orgId}/payment-method-intents`, {
    type: "card",
    card: { number: pan, exp_month: 12, exp_year: 2032, cvc: "123", name: "Amy Auto", zip: "90210" }
  });
  const saved = await client.req("POST", `/v1/payments/organizations/${orgId}/customers/${contactId}/payment-methods`, {
    provider_payment_method_id: tokenized.intent.payment_method_id
  });
  return saved.payment_method;
}

// --- seed --------------------------------------------------------------------
await client.req("POST", "/v1/platform/auth/register", {
  email, password: ownerPassword, name: "Autopay Owner",
  company: "Autopay E2E Co", organization_id: orgId
});
await client.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await client.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "money.profitability": true, "money.merchant_processing": true }
});
await client.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
const application = await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
  processing_plan_id: US_PLAN_ID, external_account_id: orgId,
  company: { legal_name: "Autopay E2E Co LLC" }
});
await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${application.application.id}/submit`, {});
await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
  application_id: application.application.id, to: "APPROVED"
});

const main = await seedProject("main");
const dunning = await seedProject("dunning");
const mainMethod = await savedMethodFromCard(main.contactId, APPROVED_PAN);
const badMethod = await savedMethodFromCard(dunning.contactId, DECLINED_PAN);

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
async function login() {
  await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, organization_id: org })
    });
  }, { api: API, email, password: ownerPassword, org: orgId });
}
// Money tab open + wait for the schedule panel. Route normalization can steal
// early navigation (openTakePayment lesson: navigate({tab:null,...}) clears
// stray top-level route keys that would otherwise pin another view).
async function openMoneyTab(projectId, waitSelector = "[data-money-autopay]") {
  // Proven pattern from payment-intake-e2e: full page.goto reload retries beat
  // in-page nudging when the SPA wedges mid-load; verify the session first so
  // a dropped cookie can't send us to a blank shell.
  const sessionOk = await page.evaluate(async (api) => {
    try {
      const res = await fetch(api + "/v1/platform/auth/session", { credentials: "include" });
      return res.ok;
    } catch { return false; }
  }, API).catch(() => false);
  if (!sessionOk) await login();
  let found = false;
  for (let nav = 0; nav < 4 && !found; nav += 1) {
    await page.goto(`${WEB}/portal/?project=${encodeURIComponent(projectId)}&projectTab=money`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !!window.Portal?.currentUser && !!window.Portal?.navigation?.navigate, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    // Let the money tab render on its own, clear stray route keys once if the
    // schedule panel is missing, then wait for the target selector (the
    // autopay card renders after async intake-config + enrollment fetches).
    let scheduleReady = await page.waitForSelector(".mn-left-schedule", { timeout: 15000, state: "attached" })
      .then(() => true).catch(() => false);
    if (!scheduleReady) {
      await page.evaluate((id) => {
        window.Portal.navigation.navigate({ tab: null, project: id, projectTab: "money" });
      }, projectId);
      scheduleReady = await page.waitForSelector(".mn-left-schedule", { timeout: 10000, state: "attached" })
        .then(() => true).catch(() => false);
    }
    if (!scheduleReady) continue; // full reload retry
    found = await page.waitForSelector(waitSelector, { timeout: 20000, state: "attached" })
      .then(() => true).catch(() => false);
  }
  if (!found) {
    await shot("money-tab-failure");
    const debug = await page.evaluate(async (id) => {
      const out = {
        url: location.href,
        schedule: !!document.querySelector(".mn-left-schedule"),
        autopay: !!document.querySelector("[data-money-autopay]"),
        api: typeof window.PaymentsAPI?.autopay?.get
      };
      const org = window.Portal?.organizationId || window.Portal?.currentUser?.organization_id;
      out.org = org || null;
      try {
        const cfg = await window.PaymentsAPI.intake.config(org, {});
        out.intakeProbe = { provider: cfg?.provider ?? null, methods: (cfg?.saved_methods || []).length };
      } catch (e) { out.intakeProbe = { error: String(e?.message || e).slice(0, 160) }; }
      try {
        const ap = await window.PaymentsAPI.autopay.get(org, id);
        out.autopayProbe = { status: ap?.autopay?.status ?? ap?.status ?? null };
      } catch (e) { out.autopayProbe = { error: String(e?.message || e).slice(0, 160) }; }
      return out;
    }, projectId);
    throw new Error(`money tab never showed ${waitSelector}: ${JSON.stringify(debug)}`);
  }
}
async function domClick(selector) {
  await page.waitForSelector(selector, { timeout: 15000, state: "attached" });
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) throw new Error(`missing ${s}`);
    el.click();
  }, selector);
}

// ── 1. Enroll through the UI ---------------------------------------------------
await login();
await openMoneyTab(main.projectId);
const setupState = await page.evaluate(() => ({
  text: document.querySelector("[data-money-autopay]")?.textContent.replace(/\s+/g, " ").trim() || "",
  openButton: !!document.querySelector("[data-money-autopay-open]")
}));
check("autopay affordance appears in the payment-schedule panel", /Autopay/.test(setupState.text) && setupState.openButton, setupState);
await shot("autopay-offer");
await domClick("[data-money-autopay-open]");
await page.waitForSelector("[data-money-autopay-method]", { timeout: 10000, state: "attached" });
const enrollForm = await page.evaluate(() => {
  const select = document.querySelector("[data-money-autopay-method]");
  return {
    options: [...(select?.options || [])].map((option) => ({ value: option.value, label: option.textContent.trim() })),
    maxInput: !!document.querySelector("[data-money-autopay-max]")
  };
});
check("enroll control lists the customer's saved method",
  enrollForm.options.length === 1 && enrollForm.options[0].value === mainMethod.id
  && /Visa ending in 4242/.test(enrollForm.options[0].label) && enrollForm.maxInput, enrollForm);
await shot("autopay-enroll-form");
await domClick("[data-money-autopay-enroll]");
await page.waitForFunction(() => {
  const chip = document.querySelector("[data-money-autopay-status]");
  return chip && /Active/i.test(chip.textContent || "");
}, null, { timeout: 15000 });
const enrolledChip = await page.evaluate(() => document.querySelector("[data-money-autopay]")?.textContent.replace(/\s+/g, " ").trim() || "");
check("enrolled chip shows the method label and next due obligation",
  /Active/.test(enrolledChip) && /Visa ending in 4242/.test(enrolledChip) && /Next: Deposit/i.test(enrolledChip), enrolledChip);
await shot("autopay-enrolled");
const serverAutopay = (await client.req("GET", `/v1/payments/organizations/${orgId}/projects/${main.projectId}/autopay`)).autopay;
check("enrollment persisted server-side", serverAutopay?.status === "active" && serverAutopay?.saved_method_id === mainMethod.id, serverAutopay);

// ── 2. Run the pass via API, assert allocation + paid UI state -----------------
const run = await client.req("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {});
const mainCharge = run.charged.find((entry) => entry.project_id === main.projectId);
check("runner charges the due deposit through the provider", !!mainCharge && mainCharge.amount_cents === 250_000, run);
const payment = (await client.req("GET", `/v1/payments/organizations/${orgId}/payments/${mainCharge.payment_id}`)).payment;
check("autopay charge carries exact provider fee fields",
  payment.provider === "mock" && payment.fee_cents === 80 && payment.merchant_amount_cents === 249_920
  && payment.method?.type === "saved_card" && payment.metadata?.autopay === true,
  { fee: payment.fee_cents, merchant: payment.merchant_amount_cents, type: payment.method?.type });
const obligations = (await client.req("GET", `/v1/payments/organizations/${orgId}/projects/${main.projectId}/obligations`)).obligations;
const deposit = obligations.find((entry) => /deposit/i.test(entry.label));
check("allocation satisfies the deposit obligation to the cent", deposit.allocated_cents === 250_000 && deposit.status === "paid", deposit);

await openMoneyTab(main.projectId);
const paidUi = await page.evaluate(() => {
  const cards = [...document.querySelectorAll(".mn-schedule-list .mn-due-card")];
  const depositCard = cards.find((card) => /deposit/i.test(card.textContent || ""));
  return {
    depositCard: depositCard ? depositCard.textContent.replace(/\s+/g, " ").trim() : "",
    autopay: document.querySelector("[data-money-autopay]")?.textContent.replace(/\s+/g, " ").trim() || ""
  };
});
check("UI shows the deposit as paid after the autopay run",
  /Paid/i.test(paidUi.depositCard) && /\$2,500(\.00)? taken/.test(paidUi.depositCard), paidUi.depositCard);
check("autopay chip stays active and advances to the next open obligation",
  /Active/.test(paidUi.autopay) && /Next: Final Payment/i.test(paidUi.autopay), paidUi.autopay);
await shot("autopay-paid");

// ── 3. Decline path: pause after 3 attempts, UI failure state, resume ----------
await client.req("PUT", `/v1/payments/organizations/${orgId}/projects/${dunning.projectId}/autopay`, {
  saved_method_id: badMethod.id,
  contact_ref: { id: dunning.contactId }
});
const t0 = Date.now();
for (const offset of [0, 25 * HOUR, 50 * HOUR]) {
  await client.req("POST", `/v1/payments/organizations/${orgId}/autopay/run`, { now: new Date(t0 + offset).toISOString() });
}
const pausedAutopay = (await client.req("GET", `/v1/payments/organizations/${orgId}/projects/${dunning.projectId}/autopay`)).autopay;
check("three declines pause the enrollment with a failure trail",
  pausedAutopay.status === "paused" && pausedAutopay.paused_reason === "max_attempts" && pausedAutopay.failures.length === 3, {
    status: pausedAutopay.status, failures: pausedAutopay.failures.length
  });
const dunningPayments = (await client.req("GET", `/v1/payments/organizations/${orgId}/projects/${dunning.projectId}/payments`)).payments;
check("declined autopay attempts never write transactions", dunningPayments.length === 0, dunningPayments.length);

await openMoneyTab(dunning.projectId);
const pausedUi = await page.evaluate(() => ({
  chip: document.querySelector("[data-money-autopay-status]")?.textContent.trim() || "",
  failure: document.querySelector("[data-money-autopay-failure]")?.textContent.replace(/\s+/g, " ").trim() || "",
  resume: !!document.querySelector("[data-money-autopay-resume]")
}));
check("paused UI shows the failure state with the last decline and a resume button",
  /Paused/i.test(pausedUi.chip) && /declined/i.test(pausedUi.failure) && pausedUi.resume, pausedUi);
await shot("autopay-paused");

// Swap the enrollment to a good card, then resume through the UI button.
const goodMethod = await savedMethodFromCard(dunning.contactId, APPROVED_PAN);
await client.req("PUT", `/v1/payments/organizations/${orgId}/projects/${dunning.projectId}/autopay`, {
  saved_method_id: goodMethod.id,
  status: "paused"
});
await openMoneyTab(dunning.projectId);
await domClick("[data-money-autopay-resume]");
await page.waitForFunction(() => {
  const chip = document.querySelector("[data-money-autopay-status]");
  return chip && /Active/i.test(chip.textContent || "");
}, null, { timeout: 15000 });
const resumedAutopay = (await client.req("GET", `/v1/payments/organizations/${orgId}/projects/${dunning.projectId}/autopay`)).autopay;
check("resume button reactivates the enrollment", resumedAutopay.status === "active", resumedAutopay.status);
await shot("autopay-resumed");
const recoveryRun = await client.req("POST", `/v1/payments/organizations/${orgId}/autopay/run`, {
  now: new Date(t0 + 100 * HOUR).toISOString()
});
const recovered = recoveryRun.charged.find((entry) => entry.project_id === dunning.projectId);
check("resumed enrollment charges on the next pass", !!recovered && recovered.amount_cents === 250_000, recoveryRun);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
