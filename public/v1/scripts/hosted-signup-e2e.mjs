/**
 * Drives the hosted-first signup harness ("Forward test mode") end-to-end
 * against the local stack: seeds a mock-provider org, opens the Payments
 * settings pane, and verifies the express card skips FirstMate's wizard
 * entirely — one click creates the minimal draft + hosted application link
 * (window.open stubbed, mock aapplink URL asserted), the pane flips to the
 * hosted-link card, the merchant-portal button mints a magic-link SSO URL,
 * and the flow composes with the sandbox lifecycle ops (hosted submission ->
 * UNDER_REVIEW -> APPROVED) without ever opening the wizard.
 *
 *   node scripts/hosted-signup-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101). Screenshots go to
 * HOSTED_SIGNUP_SHOTS_DIR (or ./hosted-signup-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.HOSTED_SIGNUP_SHOTS_DIR || path.resolve("hosted-signup-shots");
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
const orgId = `org_hostedsignup_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Hosted Signup Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "money.merchant_processing": true }
});
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
const seeded = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("seed: merchant config provider is mock", seeded?.merchant_config?.provider === "mock", seeded?.merchant_config?.provider);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
// Hosted hand-off + portal SSO open new tabs — stub window.open so the run
// stays in the portal and the opened URLs can be asserted.
await page.addInitScript(() => {
  window.__openedUrls = [];
  window.open = (url) => { window.__openedUrls.push(String(url || "")); return null; };
});
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("shot:", file);
}

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

// 1. Intro card intact + express test-mode card offered beside it.
const initial = await page.evaluate(() => ({
  intro: document.querySelector("[data-mp-intro]")?.textContent.replace(/\s+/g, " ").trim() || "",
  setupButton: document.querySelector("[data-mp-setup]")?.textContent.trim() || "",
  express: document.querySelector("[data-mp-express]")?.textContent.replace(/\s+/g, " ").trim() || "",
  signupButton: document.querySelector("[data-mp-express-signup]")?.textContent.trim() || "",
  portalButton: !!document.querySelector("[data-mp-express-portal]"),
  emoji: /[\u{1F300}-\u{1FAFF}]/u.test(document.querySelector("[data-merchant-processing]")?.textContent || "")
}));
check("intro card and wizard entry are untouched", /Accept card and bank payments/.test(initial.intro) && /Set up payments/.test(initial.setupButton), initial.setupButton);
check("express test-mode card renders", /Forward test mode/.test(initial.express), initial.express.slice(0, 90));
check("express card offers signup + portal buttons", /Sign up on Forward/.test(initial.signupButton) && initial.portalButton, initial.signupButton);
check("no emoji in the merchant section", !initial.emoji);
await shot("intro-with-express-card");

// 2. One click: draft + hosted link created, hosted card takes over, no wizard.
await page.click("[data-mp-express-signup]");
await page.waitForSelector("[data-mp-hosted-card]", { timeout: 20000 });
const afterSignup = await page.evaluate(() => ({
  openedUrls: window.__openedUrls,
  hostedCopy: document.querySelector("[data-mp-hosted-card]")?.textContent.replace(/\s+/g, " ").trim() || "",
  wizardOpen: !!document.querySelector('[data-fm-wizard="money-onboarding"]'),
  reopenLabel: document.querySelector("[data-mp-express-signup]")?.textContent.trim() || ""
}));
check("hosted link opened in a new tab (mock aapplink URL)", afterSignup.openedUrls.some((u) => /^https:\/\/application\.mock\.local\/aapplink_mock_/.test(u)), afterSignup.openedUrls);
check("pane flips to the hosted-link card", /Finish your application on Forward's secure page/.test(afterSignup.hostedCopy), afterSignup.hostedCopy.slice(0, 90));
check("wizard was never opened", !afterSignup.wizardOpen);
check("express button now reopens the application", /Reopen Forward application/.test(afterSignup.reopenLabel), afterSignup.reopenLabel);
const config1 = await owner.req("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
check("draft application + link persisted on merchant config",
  !!config1?.merchant_config?.forward?.application_id && /aapplink_mock_/.test(config1?.merchant_config?.forward?.application_link_url || ""),
  { application_id: config1?.merchant_config?.forward?.application_id });
check("boarding status is DRAFT", config1?.merchant_config?.forward?.boarding_status === "DRAFT", config1?.merchant_config?.forward?.boarding_status);
await shot("hosted-card-after-express-signup");

// 3. Merchant portal SSO from the express card (portal-only features live there).
const urlsBefore = (await page.evaluate(() => window.__openedUrls)).length;
await page.click("[data-mp-express-portal]");
await page.waitForFunction((count) => window.__openedUrls.length > count, urlsBefore, { timeout: 20000 });
const portalUrls = await page.evaluate(() => window.__openedUrls);
check("portal button mints a magic-link SSO URL", /^https:\/\/portal\.mock\.local\/auth\/magic-link\?code=/.test(portalUrls[portalUrls.length - 1]), portalUrls[portalUrls.length - 1]);
await shot("portal-sso-opened");

// 4. Composes with the sandbox lifecycle: hosted submission -> review tracker.
await page.click("[data-mp-hosted-submit]");
await page.waitForSelector("[data-mp-tracker-card]", { timeout: 20000 });
const review = await page.evaluate(() => ({
  badge: document.querySelector("[data-mp-status-badge]")?.textContent.trim() || "",
  expressStillOffered: !!document.querySelector("[data-mp-express-portal]")
}));
check("hosted submission moves the pane to UNDER REVIEW", /UNDER REVIEW/i.test(review.badge), review.badge);
check("portal access still offered while under review", review.expressStillOffered);
await shot("under-review");

// 5. Approve via sandbox -> active card with the standard portal entry point.
await page.click('[data-mp-advance="APPROVED"]');
await page.waitForSelector("[data-mp-approved]", { timeout: 20000 });
const approved = await page.evaluate(() => ({
  head: document.querySelector("[data-mp-approved] .mp-card-head")?.textContent.replace(/\s+/g, " ").trim() || "",
  manageBank: !!document.querySelector("[data-mp-manage-bank]")
}));
check("approval lands on the active-processing card", /Payment processing is active/.test(approved.head), approved.head.slice(0, 60));
check("approved card keeps the Manage at Forward portal entry", approved.manageBank);
await shot("approved");

await browser.close();
const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
