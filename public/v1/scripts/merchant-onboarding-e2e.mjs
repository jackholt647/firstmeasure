/**
 * Drives the Company Settings -> Payments merchant-onboarding slice
 * end-to-end against the local stack: seeds an org with
 * money.merchant_processing enabled and the mock provider, opens the
 * Payments settings pane, walks the application wizard — now hosted on the
 * shared FirstMateSetupWizard shell (fm-wizard modal, workflow
 * "money_onboarding") — business info, owners with signer enforcement,
 * volumes, the payout bank-account step, plan selection, then the HOSTED
 * hand-off ("Continue to Forward's secure application" — window.open stubbed,
 * mock aapplink URL asserted) and the "Simulate hosted submission" sandbox op,
 * then advances mock underwriting NEED_INFORMATION -> respond-and-continue-at-
 * Forward -> hosted resubmission -> APPROVED via the in-UI sandbox box
 * (including the approved card's bank-account row + Manage at Forward SSO),
 * asserting the visible status at each step.
 *
 *   node scripts/merchant-onboarding-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101). Screenshots go to
 * MERCHANT_ONBOARDING_SHOTS_DIR (or ./merchant-onboarding-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.MERCHANT_ONBOARDING_SHOTS_DIR || path.resolve("merchant-onboarding-shots");
await mkdir(SHOTS, { recursive: true });

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

// --- seed org with merchant processing + mock provider -----------------------
const owner = apiClient();
const orgId = `org_merchonb_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Merchant Onboarding Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "money.merchant_processing": true }
});
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
const seeded = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("seed: merchant config provider is mock", seeded?.merchant_config?.provider === "mock", seeded?.merchant_config);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
// Hosted hand-off + portal SSO open new tabs — stub window.open so the run
// stays in the portal and the URLs can be asserted; count login-url requests.
await page.addInitScript(() => {
  window.__openedUrls = [];
  window.open = (url) => { window.__openedUrls.push(String(url || "")); return null; };
});
let loginUrlRequests = 0;
page.on("request", (request) => { if (request.url().includes("/merchant-portal/login-url")) loginUrlRequests += 1; });
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("shot:", file);
}
const mpText = (selector) => page.evaluate((sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, " ").trim() || "", selector);

async function openPaymentsPane() {
  await page.goto(WEB + "/portal/?tab=company_settings&sub=payments", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
  await page.waitForSelector("[data-merchant-processing] .cs-section", { timeout: 30000 });
  await page.waitForFunction(() => {
    const pane = document.querySelector("[data-merchant-processing]");
    return pane && !pane.querySelector(".fa-spinner");
  }, null, { timeout: 30000 });
}

await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, password, org }) => {
  await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
}, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });
await openPaymentsPane();

// 1. Existing pane preserved + not-configured intro card.
const initial = await page.evaluate(() => ({
  defaultsHeading: document.querySelector("[data-payment-defaults] h3")?.textContent.trim() || "",
  defaultsSave: !!document.querySelector("[data-payment-defaults] [data-payment-settings-save]"),
  intro: document.querySelector("[data-mp-intro]")?.textContent.replace(/\s+/g, " ").trim() || "",
  setupButton: document.querySelector("[data-mp-setup]")?.textContent.trim() || "",
  emoji: /[\u{1F300}-\u{1FAFF}]/u.test(document.querySelector("[data-merchant-processing]")?.textContent || "")
}));
check("existing Payment Settings section untouched", initial.defaultsHeading === "Payment Settings" && initial.defaultsSave, initial.defaultsHeading);
check("not-configured intro card renders", /Accept card and bank payments/.test(initial.intro), initial.intro.slice(0, 80));
check("Set up payments button present", /Set up payments/.test(initial.setupButton), initial.setupButton);
check("no emoji in the merchant section", !initial.emoji);
await shot("not-configured");

// 2. Start the wizard; opens on the shared shell with step 1 prefilled.
await page.click("[data-mp-setup]");
await page.waitForSelector('[data-fm-wizard="money-onboarding"] .fm-wizard', { timeout: 15000 });
const step1 = await page.evaluate(() => ({
  legalName: document.querySelector('[data-mp-field="company.legal_name"]')?.value || "",
  activeStep: document.querySelector('[data-fm-wizard="money-onboarding"] .fm-wizard-step.active')?.dataset.fmStep || "",
  stepCount: document.querySelectorAll('[data-fm-wizard="money-onboarding"] .fm-wizard-step').length,
  workflow: new URLSearchParams(window.location.search).get("workflow") || "",
  mccOptions: [...(document.querySelector('[data-mp-field="company.mcc"]')?.options || [])].map((o) => o.value)
}));
check("wizard opens on the shared shell at the Business step", step1.activeStep === "business" && step1.stepCount === 5, step1);
check("open writes workflow=money_onboarding to the route", step1.workflow === "money_onboarding", step1.workflow);
check("legal name prefilled from org record", step1.legalName === "Merchant Onboarding Demo Co", step1.legalName);
check("MCC select offers 1761 and 5039", step1.mccOptions.includes("1761") && step1.mccOptions.includes("5039"), step1.mccOptions);
await shot("wizard-step1-prefilled");

// Continue with a hole (no EIN) -> validation issue keeps us on step 1.
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector(".fm-wizard-issues", { timeout: 10000 });
check("step 1 validation blocks missing EIN", /EIN/.test(await mpText(".fm-wizard-issues")), await mpText(".fm-wizard-issues"));

await page.fill('[data-mp-field="company.ein"]', "12-3456789");
await page.fill('[data-mp-field="company.business_start_date"]', "2015-04-01");
await page.fill('[data-mp-field="company.phone"]', "555-010-3030");
await page.fill('[data-mp-field="company.email"]', `billing-${suffix}@example.test`);
await page.fill('[data-mp-field="company.website"]', "https://merchantdemo.example.test");
await page.fill('[data-mp-field="address.address1"]', "500 Shingle Street");
await page.fill('[data-mp-field="address.city"]', "Austin");
await page.fill('[data-mp-field="address.state"]', "TX");
await page.fill('[data-mp-field="address.postal_code"]', "78701");

// Description left empty -> its own validation block.
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForFunction(() => /description/i.test(document.querySelector(".fm-wizard-issues")?.textContent || ""), null, { timeout: 10000 });
check("step 1 validation blocks missing business description", /description/i.test(await mpText(".fm-wizard-issues")), await mpText(".fm-wizard-issues"));
await page.fill('[data-mp-field="company.description"]', "Residential roofing and siding contractor");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector('[data-mp-owner="0"]', { timeout: 10000 });

// 3. Owners step: two owners, signer exclusivity enforced by the UI.
await page.fill('[data-mp-owner-field="0:name"]', "Rita Ridge");
await page.fill('[data-mp-owner-field="0:email"]', `rita-${suffix}@example.test`);
await page.fill('[data-mp-owner-field="0:phone"]', "555-010-4040");
await page.fill('[data-mp-owner-field="0:dob"]', "1980-06-15");
await page.fill('[data-mp-owner-ssn="0"]', "123-45-6789");
await page.fill('[data-mp-owner-field="0:ownership_percent"]', "60");
await page.fill('[data-mp-owner-field="0:address.address1"]', "12 Gable Way");
await page.fill('[data-mp-owner-field="0:address.city"]', "Austin");
await page.fill('[data-mp-owner-field="0:address.state"]', "TX");
await page.fill('[data-mp-owner-field="0:address.postal_code"]', "78702");
await page.check('[data-mp-owner-signer="0"]');
await page.waitForTimeout(300);
check("owner SSN input is password-typed", await page.evaluate(() => document.querySelector('[data-mp-owner-ssn="0"]')?.type === "password"));

await page.click("[data-mp-owner-add]");
await page.waitForSelector('[data-mp-owner="1"]', { timeout: 10000 });
check("SSN value survives re-render in memory", await page.evaluate(() => document.querySelector('[data-mp-owner-ssn="0"]')?.value === "123-45-6789"));
await page.fill('[data-mp-owner-field="1:name"]', "Sam Soffit");
await page.fill('[data-mp-owner-field="1:email"]', `sam-${suffix}@example.test`);
await page.fill('[data-mp-owner-field="1:dob"]', "1985-09-20");
await page.fill('[data-mp-owner-ssn="1"]', "987-65-4321");
await page.fill('[data-mp-owner-field="1:ownership_percent"]', "40");
await page.check('[data-mp-owner-signer="1"]');
await page.waitForTimeout(400);
const signers = await page.evaluate(() => ({
  owner0: document.querySelector('[data-mp-owner-signer="0"]')?.checked,
  owner1: document.querySelector('[data-mp-owner-signer="1"]')?.checked
}));
check("checking a second signer unchecks the first (exactly one)", signers.owner0 === false && signers.owner1 === true, signers);
await shot("wizard-step2-owners");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector('[data-mp-field="volumes.annual_volume"]', { timeout: 10000 });

// 4. Volumes step.
await page.fill('[data-mp-field="volumes.annual_volume"]', "250000");
await page.fill('[data-mp-field="volumes.avg_ticket"]', "8000");
await page.fill('[data-mp-field="volumes.high_ticket"]', "25000");
await page.fill('[data-mp-field="volumes.card_present_percent"]', "70");
await shot("wizard-step3-volumes");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector('[data-mp-field="bank_account.routing_number"]', { timeout: 10000 });

// 4b. Bank account step: routing checksum enforced, account number password-typed.
check("bank account number input is password-typed", await page.evaluate(() => document.querySelector("[data-mp-bank-account-number]")?.type === "password"));
await page.fill('[data-mp-field="bank_account.routing_number"]', "021000022");
await page.fill("[data-mp-bank-account-number]", "000123456789");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForFunction(() => /routing/i.test(document.querySelector(".fm-wizard-issues")?.textContent || ""), null, { timeout: 10000 });
check("bank step rejects an invalid ABA routing number", /routing/i.test(await mpText(".fm-wizard-issues")), await mpText(".fm-wizard-issues"));
await page.fill('[data-mp-field="bank_account.routing_number"]', "021000021");
await shot("wizard-step4-bank");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector("[data-mp-plans]", { timeout: 10000 });

// 5. Review + plan selection + submit.
const review = await page.evaluate(() => ({
  summary: document.querySelector('[data-fm-wizard="money-onboarding"] .mp-kv')?.textContent.replace(/\s+/g, " ").trim() || "",
  plans: [...document.querySelectorAll(".mp-plan")].map((el) => el.textContent.replace(/\s+/g, " ").trim())
}));
check("review summarizes owners and volumes", /Rita Ridge \(60%\)/.test(review.summary) && /Sam Soffit/.test(review.summary) && /\$250,000/.test(review.summary), review.summary.slice(0, 160));
check("review shows the business description", /Residential roofing and siding contractor/.test(review.summary), review.summary.slice(0, 200));
check("plan list shows the mock processing plans with fees", review.plans.length >= 2 && review.plans.some((text) => /Standard Flat Rate Plan - US/.test(text) && /bps/.test(text)), review.plans);
check("review shows the payout account routing number", /021000021/.test(review.summary), review.summary.slice(-120));
await page.check('input[name="mpPlan"][value="partppl_3HpoNDtV6PtzrHasDxATGCIww6m"]');
const finalCta = await page.evaluate(() => document.querySelector('[data-fm-wizard="money-onboarding"] [data-fm-next]')?.textContent.replace(/\s+/g, " ").trim() || "");
check("final step CTA hands off to Forward's secure application", /Continue to Forward's secure application/.test(finalCta), finalCta);
await shot("wizard-step5-review");
await page.click('[data-fm-wizard="money-onboarding"] [data-fm-next]');
await page.waitForSelector("[data-mp-hosted-card]", { timeout: 20000 });
check("wizard closes after the hand-off and clears the workflow route", await page.evaluate(() =>
  !document.querySelector('[data-fm-wizard="money-onboarding"]')
  && !new URLSearchParams(window.location.search).get("workflow")));

// 5b. Hosted hand-off: new tab opened with the mock aapplink, waiting card
//     with the reopen button, link persisted on merchant config (still DRAFT).
const handoff = await page.evaluate(() => ({
  opened: window.__openedUrls || [],
  copy: document.querySelector("[data-mp-hosted-card]")?.textContent.replace(/\s+/g, " ").trim() || "",
  reopen: !!document.querySelector("[data-mp-open-forward]"),
  simulate: !!document.querySelector("[data-mp-hosted-submit]")
}));
check("hand-off opened the mock hosted application URL",
  handoff.opened.some((url) => /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(url)), handoff.opened);
check("hosted card shows the waiting copy + Reopen application button",
  handoff.reopen && /Finish your application on Forward's secure page/.test(handoff.copy), handoff.copy.slice(0, 120));
const handoffConfig = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("hosted link persisted on merchant config while still DRAFT",
  /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(handoffConfig?.merchant_config?.forward?.application_link_url || "")
  && handoffConfig?.merchant_config?.forward?.boarding_status === "DRAFT", handoffConfig?.merchant_config?.forward?.boarding_status);
// Reopen force-mints a fresh link (Forward can invalidate stored links
// before their stamped expiry) and persists the new URL on merchant config.
await page.click("[data-mp-open-forward]");
await page.waitForFunction((count) => (window.__openedUrls || []).length > count, handoff.opened.length, { timeout: 15000 });
const reopened = await page.evaluate(() => window.__openedUrls[window.__openedUrls.length - 1]);
const reopenedConfig = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("Reopen application mints and persists a fresh link URL",
  /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(reopened)
  && reopenedConfig?.merchant_config?.forward?.application_link_url === reopened, reopened);
await shot("hosted-handoff");

// 5c. Simulate the merchant completing Forward's hosted workflow.
check("Simulate hosted submission button present in the sandbox box", handoff.simulate);
await page.click("[data-mp-hosted-submit]");
await page.waitForSelector("[data-mp-tracker-card]", { timeout: 20000 });

// 6. Submitted: tracker with Under review current + sandbox box present.
const submitted = await page.evaluate(() => ({
  badge: document.querySelector("[data-mp-status-badge]")?.textContent.trim() || "",
  submittedDone: document.querySelectorAll(".mp-step")[0]?.className.includes("done"),
  reviewCurrent: document.querySelectorAll(".mp-step")[1]?.className.includes("current"),
  sandbox: !!document.querySelector("[data-mp-sandbox]")
}));
check("status badge shows UNDER REVIEW after submit", /UNDER REVIEW/i.test(submitted.badge), submitted.badge);
check("tracker: Submitted done, Under review current", submitted.submittedDone && submitted.reviewCurrent, submitted);
check("sandbox simulation box visible for mock provider", submitted.sandbox);
await shot("status-under-review");

// 7. Advance to NEED_INFORMATION via the sandbox box; docs + response affordance.
await page.click('[data-mp-advance="NEED_INFORMATION"]');
await page.waitForSelector("[data-mp-docs]", { timeout: 20000 });
const needInfo = await page.evaluate(() => ({
  badge: document.querySelector("[data-mp-status-badge]")?.textContent.trim() || "",
  docs: [...document.querySelectorAll(".mp-doc")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
  decisionWarn: !!document.querySelector(".mp-step.warn"),
  textarea: !!document.querySelector("#mpInfoResponse"),
  resubmit: !!document.querySelector("[data-mp-resubmit]")
}));
check("need-information badge renders", /NEED INFORMATION/i.test(needInfo.badge), needInfo.badge);
check("requested documents listed", needInfo.docs.length === 2 && needInfo.docs.some((text) => /bank statements/i.test(text)), needInfo.docs);
check("tracker decision node flips to warning state", needInfo.decisionWarn);
check("response textarea + resubmit affordance present", needInfo.textarea && needInfo.resubmit, needInfo);
await shot("status-need-information");

// 8. Respond -> the CTA routes through Forward's hosted page (docs upload
//    there); the status stays NEED_INFORMATION until the hosted resubmission.
const openedBeforeResubmit = await page.evaluate(() => (window.__openedUrls || []).length);
await page.fill("#mpInfoResponse", "Uploaded the last 3 months of statements and the signer's license via email.");
await page.click("[data-mp-resubmit]");
await page.waitForFunction((count) => (window.__openedUrls || []).length > count, openedBeforeResubmit, { timeout: 20000 });
const resubmitOpened = await page.evaluate(() => window.__openedUrls[window.__openedUrls.length - 1]);
check("respond CTA opens Forward's hosted application for the document upload",
  /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(resubmitOpened || ""), resubmitOpened);
const appAfterResubmit = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${encodeURIComponent((await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`)).merchant_config.forward.application_id)}`);
check("response text stored on the application", /statements/.test(appAfterResubmit?.application?.raw?.user_fields?.information_response || ""), appAfterResubmit?.application?.raw?.user_fields?.information_response);
check("status stays NEED INFORMATION until the hosted resubmission", appAfterResubmit?.application?.status === "NEED_INFORMATION", appAfterResubmit?.application?.status);
check("business description landed on the application", appAfterResubmit?.application?.raw?.company?.description === "Residential roofing and siding contractor", appAfterResubmit?.application?.raw?.company?.description);
// The merchant finishes on Forward's page -> simulate the hosted resubmission.
await page.click("[data-mp-hosted-submit]");
await page.waitForFunction(() => /UNDER REVIEW/i.test(document.querySelector("[data-mp-status-badge]")?.textContent || ""), null, { timeout: 20000 });
check("hosted resubmission returns the application to UNDER REVIEW", true);
await shot("status-resubmitted");

// 9. Advance to APPROVED -> summary card with account id, plan, badges, rails.
await page.click('[data-mp-advance="APPROVED"]');
await page.waitForSelector("[data-mp-approved]", { timeout: 20000 });
const approved = await page.evaluate(() => ({
  accountId: document.querySelector("[data-mp-account-id]")?.textContent.trim() || "",
  planName: document.querySelector("[data-mp-plan-name]")?.textContent.trim() || "",
  processing: document.querySelector("[data-mp-processing-badge]")?.textContent.replace(/\s+/g, " ").trim() || "",
  payouts: document.querySelector("[data-mp-payouts-badge]")?.textContent.replace(/\s+/g, " ").trim() || "",
  rails: [...document.querySelectorAll("[data-mp-rail]")].map((el) => el.dataset.mpRail)
}));
check("approved card shows the mock account id", /^acct_mock/.test(approved.accountId), approved.accountId);
check("approved card resolves the plan name", /Standard Flat Rate Plan - US/.test(approved.planName), approved.planName);
check("processing + payouts badges read enabled", /enabled/i.test(approved.processing) && /enabled/i.test(approved.payouts), [approved.processing, approved.payouts]);
check("four rail toggles render", approved.rails.join(",") === "card,bank,wallets,terminals", approved.rails);

// 9a. Bank account row: status from the bank-accounts route + portal SSO.
await page.waitForFunction(() => !/Loading/.test(document.querySelector("[data-mp-bank-status]")?.textContent || ""), null, { timeout: 20000 });
const bankRow = await page.evaluate(() => ({
  status: document.querySelector("[data-mp-bank-status]")?.textContent.replace(/\s+/g, " ").trim() || "",
  ok: document.querySelector("[data-mp-bank-status]")?.classList.contains("ok") === true,
  manage: document.querySelector("[data-mp-manage-bank]")?.textContent.replace(/\s+/g, " ").trim() || ""
}));
check("approved card shows the bank-account row with the validated mock account",
  /Mock Bank/.test(bankRow.status) && /6789/.test(bankRow.status) && /validated/i.test(bankRow.status) && bankRow.ok, bankRow.status);
check("Manage at Forward button present on the bank row", /Manage at Forward/.test(bankRow.manage), bankRow.manage);
const openedBeforeManage = await page.evaluate(() => (window.__openedUrls || []).length);
const loginRequestsBefore = loginUrlRequests;
await page.click("[data-mp-manage-bank]");
await page.waitForFunction((count) => (window.__openedUrls || []).length > count, openedBeforeManage, { timeout: 20000 });
const portalUrl = await page.evaluate(() => window.__openedUrls[window.__openedUrls.length - 1]);
check("Manage at Forward requests a single-use portal login URL",
  loginUrlRequests > loginRequestsBefore && /^https:\/\/portal\.mock\.local\/auth\/magic-link\?code=/.test(portalUrl || ""),
  { requests: loginUrlRequests - loginRequestsBefore, url: (portalUrl || "").slice(0, 48) });

// 9b. Approved + mock: settle/dispute sandbox buttons appear; settle with no
//     payments shows the graceful empty message; dispute disables with a hint.
const sandboxButtons = await page.evaluate(() => ({
  settle: document.querySelector("[data-mp-settle]")?.textContent.replace(/\s+/g, " ").trim() || "",
  dispute: document.querySelector("[data-mp-dispute]")?.textContent.replace(/\s+/g, " ").trim() || ""
}));
check("settle + dispute buttons render once approved", /Settle payout batch/.test(sandboxButtons.settle) && /Create test dispute/.test(sandboxButtons.dispute), sandboxButtons);
await page.click("[data-mp-settle]");
await page.waitForFunction(() => /No unsettled payments yet/.test(document.querySelector("[data-mp-sandbox-note]")?.textContent || ""), null, { timeout: 15000 });
check("settle with no payments shows the graceful empty message", true);
await page.waitForFunction(() => document.querySelector("[data-mp-dispute]")?.disabled === true, null, { timeout: 15000 }).catch(() => null);
const disputeState = await page.evaluate(() => ({
  disabled: document.querySelector("[data-mp-dispute]")?.disabled,
  hint: document.querySelector("[data-mp-dispute]")?.title || ""
}));
check("dispute button disabled with hint when no payments exist", disputeState.disabled === true && /test payment/i.test(disputeState.hint), disputeState);
await shot("status-approved");

// 10. Toggle the card rail on and confirm it persists through merchantConfig.patch.
await page.click('label.li-switch-row:has([data-mp-rail="card"]) .li-slider');
await page.waitForTimeout(1200);
const configAfterRail = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("card rail toggle persisted via merchant-config PATCH", configAfterRail?.merchant_config?.forward?.enabled_rails?.card === true, configAfterRail?.merchant_config?.forward?.enabled_rails);
await shot("rails-toggled");

// 11. Sandbox box hidden entirely when provider is "forward".
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "forward" });
await openPaymentsPane();
await page.waitForSelector("[data-mp-approved]", { timeout: 20000 });
check("sandbox box hidden for provider forward", await page.evaluate(() => !document.querySelector("[data-mp-sandbox]")));
await shot("forward-no-sandbox");
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
