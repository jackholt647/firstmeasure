/**
 * Full Money onboarding user journey against the local stack:
 *
 *  - fresh org WITHOUT platform.money
 *  - real UI: open the More Apps catalog, Add Money
 *      -> money.merchant_processing auto-enabled by the appSetup handler
 *      -> the shared-shell wizard opens (workflow=money_onboarding)
 *  - fill the Business step, continue to Owners, ABANDON (close the wizard)
 *  - all three attention surfaces show the money entry (orange, correct copy,
 *    no dismiss control anywhere)
 *  - reload; click the SIDEBAR banner -> wizard reopens at the abandoned step
 *    with fields restored from the server draft
 *  - complete Owners / Volumes / Bank (021000021 / 000123456789) / Review,
 *    then "Continue to Forward's secure application" -> the wizard hands off
 *    to the HOSTED application (window.open stubbed; mock aapplink URL
 *    persisted on merchant config) and the pane shows the waiting-on-you
 *    hosted card; banners flip to the "finish on Forward's secure page" copy
 *  - "Simulate hosted submission" (mock op hosted_submit) -> UNDER_REVIEW ->
 *    banners collapse to pinned-notification-only "waiting" with the hourglass
 *  - advance underwriting to APPROVED via the sandbox sim box -> the
 *    payouts-enabled end state removes ALL banner entries
 *
 *   node scripts/money-onboarding-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101, dist rebuilt). Screenshots
 * go to MONEY_ONBOARDING_SHOTS_DIR (or ./money-onboarding-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.MONEY_ONBOARDING_SHOTS_DIR || path.resolve("money-onboarding-shots");
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

// --- seed org WITHOUT platform.money -----------------------------------------
const owner = apiClient();
const orgId = `org_moneyonb_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Money Onboarding Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
// Pin the stored provider to mock (Boarding-Ops-style override) so the journey
// runs against the in-process simulator even when the local stack carries real
// FORWARD env keys (which would otherwise be the env default). The PATCH needs
// platform.money on, so set it, pin, then switch Money off for the journey.
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.money": false, "money.merchant_processing": false }
});
const attention0 = await owner.req("GET", `/v1/platform/organizations/${orgId}/attention`);
check("seed: no money attention entry while platform.money is off",
  !attention0.entries.some((entry) => entry.id === "attention_money_onboarding"),
  attention0.entries.map((entry) => entry.id));

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
// The hosted hand-off opens Forward's application in a new tab — stub
// window.open so the run never leaves the portal and we can assert the URL.
await page.addInitScript(() => {
  window.__openedUrls = [];
  window.open = (url) => { window.__openedUrls.push(String(url || "")); return null; };
});
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("shot:", file);
}
const WIZ = '[data-fm-wizard="money-onboarding"]';
const issuesText = () => page.evaluate(() => document.querySelector(".fm-wizard-issues")?.textContent.replace(/\s+/g, " ").trim() || "");
const refreshBanners = () => page.evaluate(async () => {
  const org = window.Portal?.cfg?.userOrgId || window.__APP?.userOrgId;
  if (window.PlatformBanners?.load && org) await window.PlatformBanners.load(org);
});

async function login() {
  await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, organization_id: org })
    });
  }, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });
}

await login();
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForFunction(() => !!window.Portal?.capabilities?.current?.(), null, { timeout: 25000 });
await page.waitForSelector('[data-launcher="more"]', { timeout: 25000 });
await page.waitForTimeout(1500); // let boot-time renderTabs() re-renders settle

// --- 1. Add Money from the real More Apps catalog ----------------------------
// Boot-time renderTabs() can rebuild the launcher (closing the popover), so
// retry the open until the Money tile is actually visible.
let catalogOpen = false;
for (let attempt = 0; attempt < 4 && !catalogOpen; attempt += 1) {
  await page.click('[data-launcher="more"]');
  catalogOpen = await page.waitForSelector('.fm-more-apps-popover:not([hidden]) [data-catalog-app="platform.money"]', { timeout: 6000, state: "visible" })
    .then(() => true).catch(() => false);
  if (!catalogOpen) await page.waitForTimeout(800);
}
check("More Apps catalog offers Money while it is off", catalogOpen);
await shot("more-apps-money");
await page.click('[data-catalog-app="platform.money"]');
await page.waitForSelector("[data-app-catalog-add]", { timeout: 15000 });
await page.click("[data-app-catalog-add]");

// The appSetup handler enables merchant processing and opens the wizard.
await page.waitForSelector(`${WIZ} .fm-wizard`, { timeout: 30000 });
const postAdd = await page.evaluate(() => ({
  merchantProcessing: window.Portal?.capabilities?.value?.("money.merchant_processing", false) === true,
  moneyOn: window.Portal?.capabilities?.value?.("platform.money", false) === true,
  workflow: new URLSearchParams(window.location.search).get("workflow") || "",
  activeStep: document.querySelector(`[data-fm-wizard="money-onboarding"] .fm-wizard-step.active`)?.dataset.fmStep || "",
  steps: document.querySelectorAll('[data-fm-wizard="money-onboarding"] .fm-wizard-step').length
}));
check("adding Money enables platform.money AND money.merchant_processing", postAdd.moneyOn && postAdd.merchantProcessing, postAdd);
check("Money wizard opens on the shared shell (workflow=money_onboarding, 5 steps, business first)",
  postAdd.workflow === "money_onboarding" && postAdd.activeStep === "business" && postAdd.steps === 5, postAdd);
const serverCaps = await owner.req("GET", `/v1/platform/organizations/${orgId}/capabilities`);
check("server capability state reflects money.merchant_processing on",
  serverCaps?.effective_by_key?.["money.merchant_processing"] === true
  || serverCaps?.capabilities?.effective_by_key?.["money.merchant_processing"] === true,
  Object.keys(serverCaps || {}));
await shot("wizard-opened-post-add");

// --- 2. Fill Business, continue to Owners, then ABANDON ----------------------
await page.fill('[data-mp-field="company.ein"]', "12-3456789");
await page.fill('[data-mp-field="company.business_start_date"]', "2016-05-01");
await page.fill('[data-mp-field="company.description"]', "Residential roofing and gutters");
await page.fill('[data-mp-field="address.address1"]', "77 Money Lane");
await page.fill('[data-mp-field="address.city"]', "Austin");
await page.fill('[data-mp-field="address.state"]', "TX");
await page.fill('[data-mp-field="address.postal_code"]', "78701");
await page.click(`${WIZ} [data-fm-next]`);
await page.waitForSelector('[data-mp-owner="0"]', { timeout: 15000 });
check("Business step continues to Owners", true);
// Give the flush-save (draft create) a beat, then abandon.
await page.waitForFunction(() => /Autosaved|autosaves/i.test(document.querySelector("[data-fm-note]")?.textContent || ""), null, { timeout: 10000 }).catch(() => null);
await page.click(`${WIZ} [data-fm-close]`);
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="money-onboarding"]'), null, { timeout: 15000 });
const draftConfig = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("abandoning after step 1 left a server-side draft application",
  /^app_/.test(draftConfig?.merchant_config?.forward?.application_id || ""), draftConfig?.merchant_config?.forward);

// --- 3. All three banner surfaces show the money entry -----------------------
await refreshBanners();
await page.waitForFunction(() => document.querySelector(".fm-attention-topbar")?.dataset.attentionId === "attention_money_onboarding", null, { timeout: 20000 });
const surfaces = await page.evaluate(() => {
  const bar = document.querySelector(".fm-attention-topbar");
  const card = document.querySelector("#sidebarAttentionSlot .sidebar-attention-card");
  return {
    topbarTone: bar ? [...bar.classList].find((cls) => cls.startsWith("tone-")) : "",
    topbarTitle: bar?.querySelector("[data-attention-title]")?.textContent || "",
    topbarBody: bar?.querySelector("[data-attention-body]")?.textContent || "",
    topbarDismiss: !!bar?.querySelector("[data-attention-dismiss]"),
    sidebarId: card?.dataset.attentionId || "",
    sidebarTitle: card?.querySelector("strong")?.textContent?.trim() || ""
  };
});
check("topbar shows the orange money banner with the required copy",
  surfaces.topbarTone === "tone-orange"
  && /Finish setting up payments/.test(surfaces.topbarTitle)
  && /complete your onboarding to start taking payments/i.test(surfaces.topbarBody), surfaces);
check("topbar banner has NO dismiss control (persistent until done)", surfaces.topbarDismiss === false);
check("sidebar card shows the same money entry",
  surfaces.sidebarId === "attention_money_onboarding" && /Finish setting up payments/.test(surfaces.sidebarTitle), surfaces);
await page.click("#platformBell");
await page.waitForSelector("#platformNotificationMenu.visible", { timeout: 10000 });
await page.waitForFunction(() => !!document.querySelector('#platformNotificationList [data-attention-note-id="attention_money_onboarding"]'), null, { timeout: 10000 });
const pinned = await page.evaluate(() => {
  const row = document.querySelector('#platformNotificationList [data-attention-note-id="attention_money_onboarding"]');
  return {
    pinned: row?.classList.contains("ptb-note-pinned"),
    dismiss: !!row?.querySelector(".ptb-note-dismiss, [data-dismiss-note]"),
    waiting: !!row?.querySelector(".ptb-note-pinned-wait")
  };
});
check("pinned notification row present with no dismiss control and no hourglass while active",
  pinned.pinned === true && pinned.dismiss === false && pinned.waiting === false, pinned);
await page.keyboard.press("Escape");
await shot("banners-active");

// --- 4. Reload; click the SIDEBAR banner -> wizard resumes at Owners ---------
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("#sidebarAttentionSlot .sidebar-attention-card", { state: "attached", timeout: 25000 });
// Some views hold the sidebar in compact (icon-rail) mode where the card is
// collapsed; expand it like a user would before clicking the banner.
const cardVisible = await page.isVisible("#sidebarAttentionSlot .sidebar-attention-card");
if (!cardVisible) {
  await page.evaluate(() => window.Portal?.sidebarMode?.setExpanded?.(true));
  await page.waitForSelector("#sidebarAttentionSlot .sidebar-attention-card", { state: "visible", timeout: 10000 })
    .catch(async () => { await page.click("#sidebarCompactToggle").catch(() => null); });
}
await page.click("#sidebarAttentionSlot .sidebar-attention-card");
await page.waitForSelector(`${WIZ} .fm-wizard`, { timeout: 30000 });
const resumed = await page.evaluate(() => ({
  activeStep: document.querySelector('[data-fm-wizard="money-onboarding"] .fm-wizard-step.active')?.dataset.fmStep || "",
  workflowStep: new URLSearchParams(window.location.search).get("workflow_step") || "",
  ownerRow: !!document.querySelector('[data-mp-owner="0"]')
}));
check("sidebar banner click reopens the wizard at the abandoned step (owners)",
  resumed.activeStep === "owners" && resumed.workflowStep === "owners" && resumed.ownerRow, resumed);
// Server-draft restore: hop back to Business and confirm the fields came back.
await page.click(`${WIZ} [data-fm-step="business"]`);
await page.waitForSelector('[data-mp-field="company.ein"]', { timeout: 10000 });
const restored = await page.evaluate(() => ({
  ein: document.querySelector('[data-mp-field="company.ein"]')?.value || "",
  description: document.querySelector('[data-mp-field="company.description"]')?.value || "",
  address1: document.querySelector('[data-mp-field="address.address1"]')?.value || ""
}));
check("business fields restored from the server draft",
  restored.ein === "12-3456789" && restored.description === "Residential roofing and gutters" && restored.address1 === "77 Money Lane", restored);
await shot("wizard-resumed");
await page.click(`${WIZ} [data-fm-step="owners"]`);
await page.waitForSelector('[data-mp-owner="0"]', { timeout: 10000 });

// --- 5. Complete owners / volumes / bank / review + submit -------------------
await page.fill('[data-mp-owner-field="0:name"]', "Rita Ridge");
await page.fill('[data-mp-owner-field="0:email"]', `rita-${suffix}@example.test`);
await page.fill('[data-mp-owner-field="0:dob"]', "1980-06-15");
await page.fill('[data-mp-owner-ssn="0"]', "123-45-6789");
await page.fill('[data-mp-owner-field="0:ownership_percent"]', "100");
await page.check('[data-mp-owner-signer="0"]');
await page.click(`${WIZ} [data-fm-next]`);
await page.waitForSelector('[data-mp-field="volumes.annual_volume"]', { timeout: 15000 });
await page.fill('[data-mp-field="volumes.annual_volume"]', "250000");
await page.fill('[data-mp-field="volumes.avg_ticket"]', "8000");
await page.fill('[data-mp-field="volumes.high_ticket"]', "25000");
await page.click(`${WIZ} [data-fm-next]`);
await page.waitForSelector('[data-mp-field="bank_account.routing_number"]', { timeout: 15000 });
check("bank account number input is password-typed",
  await page.evaluate(() => document.querySelector("[data-mp-bank-account-number]")?.type === "password"));
await page.fill('[data-mp-field="bank_account.routing_number"]', "021000021");
await page.fill("[data-mp-bank-account-number]", "000123456789");
await page.click(`${WIZ} [data-fm-next]`);
await page.waitForSelector("[data-mp-plans]", { timeout: 15000 });
await page.check('input[name="mpPlan"][value="partppl_3HpoNDtV6PtzrHasDxATGCIww6m"]');
const finalStepLabel = await page.evaluate(() => document.querySelector('[data-fm-wizard="money-onboarding"] [data-fm-next]')?.textContent.replace(/\s+/g, " ").trim() || "");
check("final step CTA reads 'Continue to Forward's secure application'",
  /Continue to Forward's secure application/.test(finalStepLabel), finalStepLabel);
await shot("wizard-review");
await page.click(`${WIZ} [data-fm-next]`);
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="money-onboarding"]'), null, { timeout: 30000 });
check("hosted hand-off closes the wizard", true);
const openedFromWizard = await page.evaluate(() => window.__openedUrls || []);
check("hand-off opened Forward's hosted application in a new tab (mock aapplink URL)",
  openedFromWizard.some((url) => /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(url)), openedFromWizard);
// The close returns the user where they came from (dashboard); open the
// Payments pane the way a user checking status would.
await page.goto(WEB + "/portal/?tab=company_settings&sub=payments", { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-mp-hosted-card]", { timeout: 30000 });
const hostedCard = await page.evaluate(() => ({
  copy: document.querySelector("[data-mp-hosted-card]")?.textContent.replace(/\s+/g, " ").trim() || "",
  reopen: !!document.querySelector("[data-mp-open-forward]"),
  simulate: !!document.querySelector("[data-mp-hosted-submit]")
}));
check("Payments pane shows the waiting-at-Forward hosted card (link button + copy)",
  hostedCard.reopen && /Finish your application on Forward's secure page/.test(hostedCard.copy)
  && /Signatures and bank verification happen/.test(hostedCard.copy), hostedCard.copy.slice(0, 140));
check("sandbox sim box offers Simulate hosted submission", hostedCard.simulate);
const handoffConfig = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("mock hosted link persisted on merchant config (still DRAFT)",
  /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(handoffConfig?.merchant_config?.forward?.application_link_url || "")
  && handoffConfig?.merchant_config?.forward?.boarding_status === "DRAFT",
  { link: handoffConfig?.merchant_config?.forward?.application_link_url, status: handoffConfig?.merchant_config?.forward?.boarding_status });
const appDetail = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${encodeURIComponent(handoffConfig.merchant_config.forward.application_id)}`);
check("bank account landed on the application (mock raw slot)",
  appDetail?.application?.raw?.bank_account?.routing_number === "021000021"
  && appDetail?.application?.raw?.bank_account?.account_number === "000123456789", appDetail?.application?.raw?.bank_account);
await shot("hosted-handoff");

// --- 5b. Banners flip to the finish-on-Forward copy while waiting on the user
await refreshBanners();
await page.waitForFunction(() => /Forward's secure page/.test(document.querySelector(".fm-attention-topbar [data-attention-title]")?.textContent || ""), null, { timeout: 20000 });
check("topbar banner shows the hosted-handoff copy while the hosted step is pending", true);

// --- 5c. Simulate the merchant finishing the hosted workflow -----------------
await page.click("[data-mp-hosted-submit]");
await page.waitForSelector("[data-mp-tracker-card]", { timeout: 30000 });
check("hosted submission flips the pane to the status tracker", true);
const submittedApp = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("boarding status is UNDER_REVIEW after the hosted submission",
  submittedApp?.merchant_config?.forward?.boarding_status === "UNDER_REVIEW", submittedApp?.merchant_config?.forward?.boarding_status);

// --- 6. Waiting state: pinned-notification-only with the hourglass -----------
await refreshBanners();
await page.waitForFunction(() => !document.querySelector(".fm-attention-topbar"), null, { timeout: 20000 });
const waitingSurfaces = await page.evaluate(() => ({
  topbar: !!document.querySelector(".fm-attention-topbar"),
  sidebar: !!document.querySelector("#sidebarAttentionSlot .sidebar-attention-card")
}));
check("topbar and sidebar banners collapse after submit", !waitingSurfaces.topbar && !waitingSurfaces.sidebar, waitingSurfaces);
await page.click("#platformBell");
await page.waitForSelector("#platformNotificationMenu.visible", { timeout: 10000 });
await page.waitForFunction(() => !!document.querySelector('#platformNotificationList [data-attention-note-id="attention_money_onboarding"]'), null, { timeout: 10000 });
const waitingRow = await page.evaluate(() => {
  const row = document.querySelector('#platformNotificationList [data-attention-note-id="attention_money_onboarding"]');
  return {
    pinned: row?.classList.contains("ptb-note-pinned"),
    waiting: !!row?.querySelector(".ptb-note-pinned-wait"),
    text: row?.textContent.replace(/\s+/g, " ").trim() || ""
  };
});
check("pinned notification shows the waiting (hourglass) under-review entry",
  waitingRow.pinned === true && waitingRow.waiting === true && /under review/i.test(waitingRow.text), waitingRow);
await page.keyboard.press("Escape");
await shot("banners-waiting");

// --- 7. Approve via the sandbox sim box -> all banner entries gone -----------
await page.click('[data-mp-advance="APPROVED"]');
await page.waitForSelector("[data-mp-approved]", { timeout: 30000 });
check("sandbox approval shows the approved card", true);
const approvedConfig = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("payouts enabled after mock approval", approvedConfig?.merchant_config?.forward?.payouts_enabled === true, approvedConfig?.merchant_config?.forward);
await refreshBanners();
await page.waitForFunction(() => !document.querySelector(".fm-attention-topbar") && !document.querySelector("#sidebarAttentionSlot .sidebar-attention-card"), null, { timeout: 20000 });
const finalFeed = await owner.req("GET", `/v1/platform/organizations/${orgId}/attention`);
check("approved + payouts removes the money attention entry entirely",
  !finalFeed.entries.some((entry) => entry.id === "attention_money_onboarding"),
  finalFeed.entries.map((entry) => entry.id));
await page.click("#platformBell");
await page.waitForSelector("#platformNotificationMenu.visible", { timeout: 10000 }).catch(() => null);
await page.waitForTimeout(600);
const finalPinned = await page.evaluate(() => !!document.querySelector('#platformNotificationList [data-attention-note-id="attention_money_onboarding"]'));
check("no pinned money notification remains", finalPinned === false);
await shot("end-state-approved");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
