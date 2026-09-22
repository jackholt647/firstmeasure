/**
 * Drives the SMS/10DLC registration wizard end-to-end against the local stack
 * (web :8011 + API :3101) after its migration onto the shared
 * FirstMateSetupWizard shell:
 *
 *  - the wizard opens from Company Settings -> SMS on the shell (fm-wizard
 *    chrome, 250px rail, 5 steps, 18px pane padding reconciliation)
 *  - opening/stepping writes workflow=10dlc / workflow_step route keys
 *    (byte-compatible with the pre-migration route values)
 *  - the compliance-profile draft autosaves through the shell (POST then
 *    PATCH) with the original footer status strings
 *  - per-step validation gating blocks Next with the SMS status message
 *  - needs-attention rail states with the custom "Needs N item(s)" labels
 *  - the summary footer swaps to Submit Registration (disabled while issues
 *    remain) and the foot note shows "Finish before submitting: ..."
 *  - a failed autosave blocks Escape-close (network abort), then close works
 *  - deep link ?workflow=10dlc&workflow_step=features reopens on that step
 *  - number search renders results from a mocked available-numbers response
 *  - a synthetic submitted profile renders the locked/read-only mode: summary
 *    banner, Refresh Status footer, disabled inputs on earlier steps
 *
 * No Telnyx submission endpoints are ever exercised: submit-brand,
 * submit-campaign, appeal-campaign, select-number and the OTP routes are
 * hard-aborted at the network layer as a safety net, and the locked-mode
 * scenario is driven entirely from a mocked GET /sms/setup response.
 *
 *   node scripts/sms-wizard-e2e.mjs      (from public/v1)
 *
 * Screenshots go to SMS_WIZARD_SHOTS_DIR (or ./sms-wizard-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.SMS_WIZARD_SHOTS_DIR || path.resolve("sms-wizard-shots");
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

// --- seed an org with SMS settings enabled -----------------------------------
const owner = apiClient();
const orgId = `org_smswiz_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "SMS Wizard Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.sms_settings": true }
});
check("seed: org registered with sms_settings capability", true, orgId);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("shot:", file);
}

// Safety net: the harness must never reach a Telnyx registration/purchase/OTP
// endpoint even if a click slips through. Abort them all at the network layer.
let blockedSubmitCalls = 0;
await page.route(/\/sms\/compliance-profiles\/[^/]+\/(submit-brand|submit-campaign|appeal-campaign|select-number|sole-proprietor)/, (route) => {
  blockedSubmitCalls += 1;
  console.log("   [blocked]", route.request().method(), route.request().url());
  route.abort();
});
// Number search never hits the provider: serve a deterministic result set.
await page.route(/\/sms\/compliance-profiles\/[^/]+\/available-numbers/, (route) => {
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true, mock: true, area_code: "206",
      numbers: [
        { phone_number: "+12065550142", display_number: "(206) 555-0142", locality: "Seattle", region: "WA", features: ["sms", "mms"], monthly_cost: "1.10", setup_cost: "0.00", currency: "USD" },
        { phone_number: "+12065550188", display_number: "(206) 555-0188", locality: "Seattle", region: "WA", features: ["sms", "mms"], monthly_cost: "1.10", setup_cost: "0.00", currency: "USD" }
      ]
    })
  });
});

const routeParams = () => page.evaluate(() => {
  const params = new URLSearchParams(window.location.search);
  return { workflow: params.get("workflow") || "", workflow_step: params.get("workflow_step") || "" };
});
const wizardState = () => page.evaluate(() => {
  const backdrop = document.querySelector('[data-fm-wizard="sms-workflow"]');
  const active = backdrop?.querySelector(".fm-wizard-step.active");
  const pane = backdrop?.querySelector(".fm-wizard-pane");
  return {
    open: !!backdrop,
    fmShell: !!backdrop?.querySelector(".fm-wizard"),
    stepCount: backdrop ? backdrop.querySelectorAll(".fm-wizard-step").length : 0,
    railWidth: (() => {
      const rail = backdrop?.querySelector(".fm-wizard-rail");
      return rail ? Math.round(rail.getBoundingClientRect().width) : 0;
    })(),
    panePadding: pane ? getComputedStyle(pane).padding : "",
    activeStep: active ? (active.dataset.fmStep || "") : "",
    title: backdrop?.querySelector(".fm-wizard-title strong")?.textContent.trim() || "",
    subtitle: backdrop?.querySelector(".fm-wizard-subtitle")?.textContent.trim() || "",
    note: backdrop?.querySelector("[data-fm-note]")?.textContent.trim() || "",
    modalRegistered: !!(window.Portal?.modals?.snapshot?.() || []).find((m) => m.id === "sms-workflow")
  };
});
const noteIs = (expected) => page.waitForFunction((want) =>
  (document.querySelector('[data-fm-wizard="sms-workflow"] [data-fm-note]')?.textContent || "").trim() === want,
expected, { timeout: 15000 });
const activeStepIs = (id) => page.waitForFunction((want) =>
  document.querySelector('[data-fm-wizard="sms-workflow"] .fm-wizard-step.active')?.getAttribute("data-fm-step") === want,
id, { timeout: 10000 });
const fill = async (field, value) => {
  const selector = `[data-fm-wizard="sms-workflow"] [data-sms-field="${field}"]`;
  await page.fill(selector, "");
  if (value) await page.type(selector, value, { delay: 5 });
};

await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, password, org }) => {
  await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
}, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });

// --- 1. Company Settings -> SMS, open the wizard on the shell ----------------
await page.goto(WEB + "/portal/?tab=company_settings&sub=sms", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#smsStartSetup", { timeout: 45000 });
await shot("sms-pane");
await page.click("#smsStartSetup");
await page.waitForSelector('[data-fm-wizard="sms-workflow"] .fm-wizard', { timeout: 15000 });
const opened = await wizardState();
check("wizard opens with the shared shell (fm-wizard chrome)", opened.open && opened.fmShell, opened);
check("rail renders the 5 SMS steps at 250px", opened.stepCount === 5 && opened.railWidth === 250, { steps: opened.stepCount, rail: opened.railWidth });
check("pane padding reconciliation applies (18px)", opened.panePadding === "18px", opened.panePadding);
check("head shows 10DLC Setup / SMS registration workflow", opened.title === "10DLC Setup" && opened.subtitle === "SMS registration workflow", { title: opened.title, subtitle: opened.subtitle });
check("wizard opens on the business step", opened.activeStep === "business", opened.activeStep);
check("wizard registered with Portal.modals as sms-workflow", opened.modalRegistered);
check("initial foot note kept the original copy", opened.note === "Draft autosaves as you move through the workflow.", opened.note);
const routeOpen = await routeParams();
check("open writes workflow=10dlc (byte-compatible) + workflow_step", routeOpen.workflow === "10dlc" && routeOpen.workflow_step === "business", routeOpen);
await shot("wizard-business");

// --- 2. Draft autosave through the shell (POST creates the profile) ----------
await fill("brand.displayName", "SMS Wizard Demo Co");
await fill("brand.companyName", "SMS Wizard Demo Co LLC");
await fill("brand.ein", "12-3456789");
await fill("brand.website", "https://smswizarddemo.example.com");
await noteIs("Autosaved.");
check("business draft autosaves with the original status string", true);

// --- 3. Validation gating on Next --------------------------------------------
await fill("brand.website", "");
await page.click("#smsNext");
await page.waitForFunction(() =>
  (document.querySelector('[data-fm-wizard="sms-workflow"] [data-fm-note]')?.textContent || "").startsWith("Finish this step:"), null, { timeout: 10000 });
const gated = await wizardState();
check("Next is blocked with the SMS 'Finish this step' message", gated.activeStep === "business" && /Valid website/.test(gated.note), gated.note);
await fill("brand.website", "https://smswizarddemo.example.com");
await noteIs("Autosaved.");

// --- 4. Advance through contact; route keys follow ---------------------------
await page.click("#smsNext");
await activeStepIs("contact");
const routeContact = await routeParams();
check("advancing writes workflow_step=contact", routeContact.workflow === "10dlc" && routeContact.workflow_step === "contact", routeContact);
await fill("brand.email", "support@smswizarddemo.example.com");
await fill("brand.phone", "2065550123");
await fill("brand.street", "600 Pine St");
await fill("brand.city", "Seattle");
await fill("brand.state", "WA");
await fill("brand.postalCode", "98101");
await noteIs("Autosaved.");
await shot("wizard-contact");

// --- 5. Needs-attention rail state + summary footer gating -------------------
// Skip the features confirmation, jump straight to Summary from the rail.
await page.click('[data-fm-wizard="sms-workflow"] [data-fm-step="features"]');
await activeStepIs("features");
await shot("wizard-features");
await page.click('[data-fm-wizard="sms-workflow"] [data-fm-step="summary"]');
await activeStepIs("summary");
const summaryGate = await page.evaluate(() => {
  const backdrop = document.querySelector('[data-fm-wizard="sms-workflow"]');
  const features = backdrop?.querySelector('[data-fm-step="features"]');
  return {
    featuresClass: features?.className || "",
    featuresLabel: features?.querySelector(".fm-wizard-step-status")?.textContent.trim() || "",
    submitDisabled: backdrop?.querySelector("#smsSubmitMock")?.disabled === true,
    note: backdrop?.querySelector("[data-fm-note]")?.textContent.trim() || ""
  };
});
check("passed step with issues shows needs-attention rail state", /needs-attention/.test(summaryGate.featuresClass), summaryGate.featuresClass);
check("rail keeps the custom 'Needs N item(s)' label", /^Needs \d+ item/.test(summaryGate.featuresLabel), summaryGate.featuresLabel);
check("summary Submit Registration is disabled while issues remain", summaryGate.submitDisabled);
check("foot note swaps to 'Finish before submitting: ...'", summaryGate.note.startsWith("Finish before submitting:"), summaryGate.note);
await shot("wizard-summary-gated");

// --- 6. Confirm features, then mocked number search --------------------------
await page.click('[data-fm-wizard="sms-workflow"] [data-fm-step="features"]');
await activeStepIs("features");
await page.click('[data-fm-wizard="sms-workflow"] [data-sms-feature-confirm]');
await page.click("#smsNext");
await activeStepIs("number");
await page.type('[data-fm-wizard="sms-workflow"] [data-sms-field="campaign.selectedNumberAreaCode"]', "206", { delay: 30 });
await page.waitForSelector('[data-fm-wizard="sms-workflow"] .sms-number-option', { timeout: 15000 });
const numbers = await page.evaluate(() => ({
  options: document.querySelectorAll('[data-fm-wizard="sms-workflow"] .sms-number-option').length,
  note: (document.querySelector('[data-fm-wizard="sms-workflow"] [data-fm-note]')?.textContent || "").trim()
}));
check("number search renders the mocked results", numbers.options === 2, numbers);
check("number search drives the richer status through ctx.setStatus", numbers.note === "Choose a number.", numbers.note);
await shot("wizard-number-results");

// --- 7. Failed autosave blocks close ------------------------------------------
let abortedSaves = 0;
await page.route(/\/sms\/compliance-profiles(\/[^/?]+)?(\?.*)?$/, (route) => {
  const method = route.request().method();
  if (method === "PATCH" || method === "POST") {
    abortedSaves += 1;
    route.abort();
    return;
  }
  route.fallback();
});
await page.fill('[data-fm-wizard="sms-workflow"] [data-sms-field="campaign.selectedNumberAreaCode"]', "20");
await page.keyboard.press("Escape");
await page.waitForFunction(() => {
  const note = (document.querySelector('[data-fm-wizard="sms-workflow"] [data-fm-note]')?.textContent || "").trim();
  return note && note !== "Autosave pending..." && note !== "Saving draft..." && note !== "Autosaved.";
}, null, { timeout: 15000 });
const blockedClose = await wizardState();
check("Escape close is blocked while the draft save fails", blockedClose.open && abortedSaves > 0, { open: blockedClose.open, abortedSaves, note: blockedClose.note });
await page.unroute(/\/sms\/compliance-profiles(\/[^/?]+)?(\?.*)?$/);

// --- 8. Escape now closes and clears the route keys --------------------------
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="sms-workflow"]'), null, { timeout: 10000 });
await page.waitForFunction(() => !new URLSearchParams(window.location.search).get("workflow"), null, { timeout: 10000 });
const routeClosed = await routeParams();
check("Escape closes the wizard and clears the workflow keys", !routeClosed.workflow && !routeClosed.workflow_step, routeClosed);
check("modal stack empty after close", await page.evaluate(() => (window.Portal?.modals?.snapshot?.() || []).length === 0));

// --- 9. Deep link reopens at the requested step ------------------------------
let deepLinkOpen = false;
for (let attempt = 0; attempt < 3 && !deepLinkOpen; attempt += 1) {
  await page.goto(WEB + "/portal/?tab=company_settings&sub=sms&workflow=10dlc&workflow_step=features", { waitUntil: "domcontentloaded" });
  deepLinkOpen = await page.waitForSelector('[data-fm-wizard="sms-workflow"] .fm-wizard', { timeout: 20000 }).then(() => true).catch(() => false);
}
check("deep link opens the wizard overlay", deepLinkOpen);
await activeStepIs("features").catch(() => null);
const deepLink = await wizardState();
check("deep link reopens at workflow_step=features", deepLink.open && deepLink.activeStep === "features", deepLink.activeStep);
check("only one wizard overlay exists", await page.evaluate(() => document.querySelectorAll(".fm-wizard-backdrop").length === 1));
await shot("wizard-deeplink-features");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="sms-workflow"]'), null, { timeout: 10000 });

// --- 10. Locked/read-only mode from a synthetic submitted profile ------------
// The submitted state is synthesized at the network layer so no registration
// endpoint is ever invoked; this mirrors a profile after submit-brand.
const submittedProfile = {
  id: "smsprof_e2e_locked",
  status: "brand_submitted",
  brand_status: "pending",
  campaign_status: "",
  phone_number_status: "",
  provider_refs: { telnyx_brand_id: "brand-e2e-locked" },
  events: [{ type: "brand_submitted", at: new Date().toISOString() }],
  brand: {
    displayName: "SMS Wizard Demo Co",
    companyName: "SMS Wizard Demo Co LLC",
    entityType: "PRIVATE_PROFIT",
    vertical: "CONSTRUCTION",
    ein: "12-3456789",
    website: "https://smswizarddemo.example.com",
    email: "support@smswizarddemo.example.com",
    phone: "+12065550123",
    firstName: "Owner",
    lastName: "User",
    street: "600 Pine St",
    city: "Seattle",
    state: "WA",
    postalCode: "98101"
  },
  campaign: {
    enabledFeatures: ["crm_conversations", "operations"],
    featuresConfirmed: true,
    messageFlowConfirmed: true,
    consentAcknowledged: true,
    selectedNumber: "+12065550142",
    selectedNumberDisplay: "(206) 555-0142",
    selectedNumberAreaCode: "206"
  }
};
await page.route(/\/sms\/setup(\?.*)?$/, (route) => {
  route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      organization: { id: "msgorg_e2e", platform_org_id: orgId },
      profiles: [submittedProfile],
      telnyx: { configured: true, live_mode: false, webhook_url: "", webhook_public_key_configured: false, organization_profiles: true }
    })
  });
});
await page.goto(WEB + "/portal/?tab=company_settings&sub=sms", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#smsStartSetup", { timeout: 45000 });
const lockedPane = await page.evaluate(() => ({
  button: document.querySelector("#smsStartSetup")?.textContent.trim() || "",
  rowAction: document.querySelector("[data-open-sms-profile]")?.textContent.trim() || ""
}));
check("submitted profile renders View on the pane row", /Open Registration/.test(lockedPane.button) && /View/.test(lockedPane.rowAction), lockedPane);
await page.click("#smsStartSetup");
await page.waitForSelector('[data-fm-wizard="sms-workflow"] .fm-wizard', { timeout: 15000 });
await activeStepIs("summary");
const lockedSummary = await page.evaluate(() => {
  const backdrop = document.querySelector('[data-fm-wizard="sms-workflow"]');
  return {
    banner: !!backdrop?.querySelector(".sms-submitted-panel"),
    bannerTitle: backdrop?.querySelector(".sms-submitted-panel h4")?.textContent.trim() || "",
    refreshButton: !!backdrop?.querySelector("#smsRefreshStatus"),
    submitButton: !!backdrop?.querySelector("#smsSubmitMock"),
    summaryRail: backdrop?.querySelector('[data-fm-step="summary"] .fm-wizard-step-status')?.textContent.trim() || ""
  };
});
check("locked mode opens on the summary submitted banner", lockedSummary.banner && lockedSummary.bannerTitle === "SMS registration submitted", lockedSummary.bannerTitle);
check("locked summary footer offers Refresh Status, no Submit", lockedSummary.refreshButton && !lockedSummary.submitButton, lockedSummary);
check("summary rail shows the custom Submitted label", lockedSummary.summaryRail === "Submitted", lockedSummary.summaryRail);
await shot("wizard-locked-summary");
await page.click('[data-fm-wizard="sms-workflow"] [data-fm-step="business"]');
await activeStepIs("business");
const lockedBusiness = await page.evaluate(() => {
  const inputs = [...document.querySelectorAll('[data-fm-wizard="sms-workflow"] [data-sms-field]')];
  return { total: inputs.length, disabled: inputs.filter((el) => el.disabled).length };
});
check("locked business step renders every field read-only", lockedBusiness.total > 0 && lockedBusiness.disabled === lockedBusiness.total, lockedBusiness);
await shot("wizard-locked-business");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="sms-workflow"]'), null, { timeout: 10000 });

check("no Telnyx registration endpoint was ever reached", blockedSubmitCalls === 0, blockedSubmitCalls);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
