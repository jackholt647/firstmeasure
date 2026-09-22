/**
 * Drives the internal Staff Console "Boarding Ops" view end-to-end against the
 * local stack: seeds three orgs at different mock-boarding stages (draft,
 * under review, approved), logs into the staff console as an internal admin,
 * asserts the cross-org pipeline table + status filters, opens the approved
 * org's detail (application summary + provider event timeline), assigns the
 * interchange-plus mock plan, flips the provider mock -> forward -> mock, and
 * verifies every mutation through the /v1/payments/admin API. Also proves the
 * console is unreachable for non-staff: org-user actors get 403 from the API,
 * anonymous visitors are bounced to the staff login, and a non-admin internal
 * user gets no Boarding Ops nav at all.
 *
 *   node scripts/boarding-admin-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101, dist rebuilt). Screenshots
 * go to BOARDING_ADMIN_SHOTS_DIR (or ./boarding-admin-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.BOARDING_ADMIN_SHOTS_DIR || path.resolve("boarding-admin-shots");
await mkdir(SHOTS, { recursive: true });

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const INTERCHANGE_PLUS_PLAN = "partppl_mock_interchange_plus";
const FLAT_RATE_PLAN = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const STAFF_EMAIL = `boarding-admin-${suffix}@1m8.ai`;
const STAFF_PASSWORD = "correct horse battery staple";
const TECH_EMAIL = `boarding-tech-${suffix}@1m8.ai`;

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
    async req(method, url, body, headers = {}) {
      const res = await fetch(API + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
          ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}),
          ...headers
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const pair = raw.split(";")[0];
        jar.set(pair.split("=")[0], pair);
        if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
      }
      const text = await res.text();
      if (res.status >= 400) {
        const error = new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
        error.status = res.status;
        throw error;
      }
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    }
  };
}

async function staffApi(method, url, body) {
  const res = await fetch(API + url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Internal-User-Email": STAFF_EMAIL,
      "X-Internal-User-Name": "Boarding Admin"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* keep null */ }
  return { status: res.status, data };
}

// --- seed staff users + three orgs at different boarding stages --------------
const seeder = apiClient();
await seeder.req("POST", "/v1/internal/users", {
  email: STAFF_EMAIL, name: "Boarding Admin", role: "admin", password: STAFF_PASSWORD, training_complete: true
});
await seeder.req("POST", "/v1/internal/users", {
  email: TECH_EMAIL, name: "Boarding Tech", role: "technician", password: STAFF_PASSWORD, training_complete: true
});

async function seedOrg(label, stage) {
  const client = apiClient();
  const orgId = `org_boadm_${label}_${suffix}`;
  const ownerEmail = `${label}-owner-${suffix}@example.test`;
  await client.req("POST", "/v1/platform/auth/register", {
    email: ownerEmail, password: STAFF_PASSWORD, name: `${label} Owner`,
    company: `Boarding ${label} Co`, organization_id: orgId
  });
  await client.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
  await client.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "money.merchant_processing": true } });
  await client.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
  const created = await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
    business: { name: `Boarding ${label} Co` },
    company: { legal_name: `Boarding ${label} Co LLC`, mcc: "1761" },
    processing_plan_id: FLAT_RATE_PLAN
  });
  const applicationId = created.application.id;
  if (stage !== "draft") {
    await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationId}/submit`, {});
  }
  if (stage === "approved") {
    await client.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });
  }
  return { orgId, ownerEmail, applicationId, client };
}

const draftOrg = await seedOrg("draft", "draft");
const reviewOrg = await seedOrg("review", "under_review");
const approvedOrg = await seedOrg("approved", "approved");
console.log("seeded:", draftOrg.orgId, reviewOrg.orgId, approvedOrg.orgId);

// --- API-level guard checks before the browser drive -------------------------
const anonymous = await staffApi("GET", "/v1/payments/admin/merchant-configs");
check("seeded staff admin can list the pipeline", anonymous.status === 200 && anonymous.data?.ok === true, anonymous.status);

const orgActorRes = await fetch(API + "/v1/payments/admin/merchant-configs", {
  headers: { "X-Internal-User-Email": draftOrg.ownerEmail }
});
check("org-user actor is rejected with 403", orgActorRes.status === 403, orgActorRes.status);

const noActorRes = await fetch(API + "/v1/payments/admin/merchant-configs");
check("anonymous API caller is rejected with 401", noActorRes.status === 401, noActorRes.status);

const techRes = await fetch(API + "/v1/payments/admin/merchant-configs", {
  headers: { "X-Internal-User-Email": TECH_EMAIL }
});
check("non-admin internal user is rejected with 403", techRes.status === 403, techRes.status);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
page.on("dialog", (dialog) => dialog.accept());
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log("shot:", file);
}

async function staffConsoleLogin(email) {
  await page.goto(WEB + "/measure/internal/backend_login.php", { waitUntil: "domcontentloaded" });
  if (page.url().includes("backend_login.php")) {
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', STAFF_PASSWORD);
    await Promise.all([
      page.waitForURL((url) => !String(url).includes("backend_login.php"), { timeout: 30000 }),
      page.click('#btnSubmit, button[type="submit"]')
    ]);
  }
  await page.waitForSelector("#portalPluginNav", { timeout: 30000 });
}

// 1. Anonymous visitors are bounced to the staff login.
await page.goto(WEB + "/measure/internal/", { waitUntil: "domcontentloaded" });
check("anonymous console visit redirects to staff login", page.url().includes("backend_login.php"), page.url());

// 2. Staff admin login -> Boarding Ops nav exists; open the console.
await staffConsoleLogin(STAFF_EMAIL);
const navPresent = await page.$("#nav-boarding-ops");
check("Boarding Ops nav button present for staff admin", !!navPresent);
await page.click("#nav-boarding-ops");
await page.waitForSelector("#boTable tbody tr", { timeout: 30000 });
await shot("pipeline-all");

const rowInfo = await page.evaluate((orgIds) => {
  const rows = [...document.querySelectorAll("#boRows tr")];
  const byOrg = {};
  for (const tr of rows) {
    const org = tr.getAttribute("data-bo-org");
    byOrg[org] = tr.textContent.replace(/\s+/g, " ").trim();
  }
  return {
    count: rows.length,
    seeded: orgIds.map((id) => byOrg[id] || ""),
    emoji: /[\u{1F300}-\u{1FAFF}]/u.test(document.getElementById("view-boarding-ops")?.textContent || "")
  };
}, [draftOrg.orgId, reviewOrg.orgId, approvedOrg.orgId]);
check("pipeline lists all three seeded orgs", rowInfo.seeded.every(Boolean), rowInfo.seeded.map((text) => text.slice(0, 60)));
check("draft org row shows DRAFT chip + mock badge", /DRAFT/.test(rowInfo.seeded[0]) && /mock/.test(rowInfo.seeded[0]), rowInfo.seeded[0]);
check("review org row shows UNDER REVIEW chip", /UNDER REVIEW/.test(rowInfo.seeded[1]), rowInfo.seeded[1]);
check("approved org row shows APPROVED + enabled badges", /APPROVED/.test(rowInfo.seeded[2]) && /enabled/.test(rowInfo.seeded[2]), rowInfo.seeded[2]);
check("no emoji in the boarding ops view", !rowInfo.emoji);

// 3. Status filter chips narrow the pipeline server-side.
await page.click('[data-bo-status="APPROVED"]');
await page.waitForFunction((orgId) => {
  const rows = [...document.querySelectorAll("#boRows tr")];
  return rows.length > 0 && rows.every((tr) => (tr.querySelector(".bo-chip")?.textContent || "").trim() === "APPROVED")
    && rows.some((tr) => tr.getAttribute("data-bo-org") === orgId);
}, approvedOrg.orgId, { timeout: 15000 });
const filtered = await page.evaluate((ids) => ({
  rows: document.querySelectorAll("#boRows tr").length,
  hasDraft: !!document.querySelector(`[data-bo-org="${ids[0]}"]`),
  hasApproved: !!document.querySelector(`[data-bo-org="${ids[1]}"]`)
}), [draftOrg.orgId, approvedOrg.orgId]);
check("Approved filter hides non-approved orgs", !filtered.hasDraft && filtered.hasApproved, filtered);
await shot("pipeline-approved-filter");
await page.click('[data-bo-status=""]');
await page.waitForSelector(`[data-bo-org="${draftOrg.orgId}"]`, { timeout: 15000 });

// 4. Detail panel: application summary + event timeline.
await page.click(`[data-bo-org="${approvedOrg.orgId}"]`);
await page.waitForSelector("#boPlanSelect", { timeout: 15000 });
const detail = await page.evaluate(() => ({
  heading: document.querySelector("#boDetailPanel h3")?.textContent.trim() || "",
  kv: document.querySelector("#boDetailPanel .bo-kv")?.textContent.replace(/\s+/g, " ").trim() || "",
  chips: document.querySelector("#boDetailPanel > div")?.textContent.replace(/\s+/g, " ").trim() || "",
  timeline: [...document.querySelectorAll("#boTimeline .bo-event-type")].map((el) => el.textContent.trim()),
  planOptions: [...(document.getElementById("boPlanSelect")?.options || [])].map((o) => o.value)
}));
check("detail heading shows the org name", detail.heading === "Boarding approved Co", detail.heading);
check("application summary shows id + APPROVED status", /app_mock/.test(detail.kv) && /APPROVED/.test(detail.kv), detail.kv.slice(0, 120));
check("detail badges show processing + payouts enabled", /processing enabled/.test(detail.chips) && /payouts enabled/.test(detail.chips), detail.chips);
check("event timeline lists v2.* provider events", detail.timeline.length >= 3 && detail.timeline.every((t) => t.startsWith("v2.")), detail.timeline.slice(0, 5));
check("plan select offers the interchange-plus mock plan", detail.planOptions.includes(INTERCHANGE_PLUS_PLAN), detail.planOptions);
await shot("detail-approved");

// 5. Assign the interchange-plus plan (approved mock org -> applied immediately).
await page.selectOption("#boPlanSelect", INTERCHANGE_PLUS_PLAN);
await page.click("#boAssignPlanBtn");
await page.waitForFunction(() => /applied|updated/i.test(document.getElementById("boPlanNote")?.textContent || ""), null, { timeout: 20000 });
const afterPlan = await staffApi("GET", `/v1/payments/admin/merchant-configs/${approvedOrg.orgId}`);
check("interchange-plus plan applied on the merchant config", afterPlan.data?.merchant_config?.forward?.processing_plan_id === INTERCHANGE_PLUS_PLAN, afterPlan.data?.merchant_config?.forward?.processing_plan_id);
await shot("plan-assigned");

// 6. Provider switch mock -> forward (confirm dialog auto-accepted) -> back.
await page.waitForSelector("#boProviderSelect", { timeout: 15000 });
await page.selectOption("#boProviderSelect", "forward");
await page.click("#boProviderBtn");
await page.waitForFunction(() => /Provider set to forward/i.test(document.getElementById("boProviderNote")?.textContent || ""), null, { timeout: 20000 });
const afterSwitch = await staffApi("GET", `/v1/payments/admin/merchant-configs/${approvedOrg.orgId}`);
check("provider switched to forward via the console", afterSwitch.data?.merchant_config?.provider === "forward", afterSwitch.data?.merchant_config?.provider);
await shot("provider-forward");

await page.waitForSelector("#boProviderSelect", { timeout: 15000 });
await page.selectOption("#boProviderSelect", "mock");
await page.click("#boProviderBtn");
await page.waitForFunction(() => /Provider set to mock/i.test(document.getElementById("boProviderNote")?.textContent || ""), null, { timeout: 20000 });
const backToMock = await staffApi("GET", `/v1/payments/admin/merchant-configs/${approvedOrg.orgId}`);
check("provider switched back to mock", backToMock.data?.merchant_config?.provider === "mock", backToMock.data?.merchant_config?.provider);

// 7. Non-admin internal user: console loads but Boarding Ops is absent and the
// admin API rejects them.
await ctx.clearCookies();
await staffConsoleLogin(TECH_EMAIL);
const techView = await page.evaluate(async () => {
  const navBtn = document.getElementById("nav-boarding-ops");
  const viewEl = document.getElementById("view-boarding-ops");
  let adminNamespace = null;
  let apiError = "";
  try {
    adminNamespace = !!(window.PaymentsAPI && window.PaymentsAPI.admin);
    if (adminNamespace) await window.PaymentsAPI.admin.merchantConfigs.list();
  } catch (error) {
    apiError = String(error && error.status ? error.status : error);
  }
  return { nav: !!navBtn, view: !!viewEl, adminNamespace, apiError };
});
check("non-admin staff sees no Boarding Ops nav or view", !techView.nav && !techView.view, techView);
check("non-admin staff blocked by the admin API (403)", techView.adminNamespace === false || techView.apiError.includes("403"), techView);
await shot("tech-no-boarding-ops");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
