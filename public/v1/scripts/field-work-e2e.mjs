/**
 * Drives the field Work tab end-to-end against the local stack:
 * seeds an org + field supervisor + project + sent documents through the API,
 * signs in as the field user, opens the project's Work tab, exercises the
 * manage menu + cancel flow with real clicks, and captures screenshots.
 *
 *   node scripts/field-work-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101). Screenshots go to
 * FIELD_WORK_SHOTS_DIR (or ./field-work-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.FIELD_WORK_SHOTS_DIR || path.resolve("field-work-shots");
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

// --- tiny cookie-jar API client ---------------------------------------------
function apiClient() {
  const jar = new Map();
  let csrf = "";
  const cookieHeader = () => [...jar.values()].join("; ");
  return {
    async req(method, url, body) {
      const res = await fetch(API + url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(jar.size ? { cookie: cookieHeader() } : {}),
          ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const raw of res.headers.getSetCookie?.() || []) {
        const pair = raw.split(";")[0];
        const name = pair.split("=")[0];
        jar.set(name, pair);
        if (name === "fm_platform_session_csrf") csrf = decodeURIComponent(pair.split("=")[1] || "");
      }
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
      return json;
    }
  };
}

const SCOPE_ITEMS = [
  { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 12500 },
  { id: "item_gutter", name: "Gutter guards", description: "Leaf protection", quantity: 2, unit: "run", unit_price: 500 }
];

// --- seed org, field user, project, documents --------------------------------
const owner = apiClient();
const orgId = `org_fieldwork_${suffix}`;
await owner.req("POST", "/v1/platform/auth/register", {
  email: `owner-${suffix}@example.test`,
  password: "correct horse battery staple",
  name: "Owner User",
  company: "Field Work Demo Co",
  organization_id: orgId
});
console.log("org:", orgId);

const fieldEmail = `field-${suffix}@example.test`;
const fieldPassword = "field user password 1";
const createdUser = await owner.req("POST", `/v1/platform/organizations/${orgId}/users`, {
  data: { email: fieldEmail, password: fieldPassword, name: "Sam Rivera", status: "active", role: "viewer", send_invite: false }
});
const fieldUserId = String(createdUser.document.id);
await owner.req("PATCH", `/v1/workforce/organizations/${orgId}/users/${fieldUserId}/profile`, {
  access_role_ids: ["supervisor"],
  application_access: {
    management: { enabled: false, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "supervisor", permissions: {} }
  }
});

const projectId = `project_fieldwork_${suffix}`;
const today = new Date().toISOString().slice(0, 10);
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId,
    title: "Jane Homeowner",
    address: "100 Document Lane",
    project_type: "residential",
    stage: "production",
    contacts: [{ id: "contact_jane", name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222", primary: true }],
    photos: [],
    events: [{
      id: "ev_fieldwork_visit",
      kind: "project_work",
      event_type_default_id: "project_work",
      status: "scheduled",
      assigned_user_ids: [fieldUserId],
      start_date: today,
      end_date: today,
      all_day: true,
      schedule_granularity: "date"
    }]
  },
  metadata: { kind: "platform_project" }
});

async function makeDocument(type, title, params) {
  const created = await owner.req("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: type, title, params
  });
  const id = String(created.document.id);
  await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${id}/issue`, {});
  const sent = await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${id}/send`, {
    recipients: [{ name: "Jane Homeowner", role: "customer" }],
    include_portal: true
  });
  return { id, token: String(sent.snapshot.public_token || "") };
}

const proposal = await makeDocument("proposal", "Roof Replacement Proposal", {
  customer: { name: "Jane Homeowner", email: "jane@example.test" },
  scope_items: SCOPE_ITEMS,
  deposit_cents: 250000,
  tax_percent: 7,
  payment_schedule: [
    { label: "Deposit", amount_cents: 250000, due_rule: "at_signing" },
    { label: "Final payment", amount_cents: 1194500, due_rule: "on_completion" }
  ]
});
const oldContract = await makeDocument("contract", "Original Roof Contract", {
  body: "Old terms the customer changed their mind about.",
  effective_date: today
});
console.log("documents:", proposal.id, oldContract.id);

// --- drive the field UI ------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message.slice(0, 200)));

let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
}

await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
const login = await page.evaluate(async ({ api, email, password, org }) => {
  const r = await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}, { api: API, email: fieldEmail, password: fieldPassword, org: orgId });
check("field user signed in", login.status === 200, login.status);

await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
// Field-only users are routed to the crew overview home once /me resolves.
await page.waitForFunction(() => location.search.includes("crew_overview"), null, { timeout: 20000 }).catch(() => null);
await page.waitForSelector("text=Ongoing projects", { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(1500);
await shot("field-home");

const projectCard = page.locator("text=Jane Homeowner").first();
await projectCard.waitFor({ timeout: 15000 });
await projectCard.click();
await page.waitForSelector("text=100 Document Lane", { timeout: 15000 }).catch(() => null);
await page.waitForTimeout(2500);
check("project modal opened", (await page.locator("text=100 Document Lane").count()) > 0);
await shot("project-open");

// Open the Work tab (icon tabs on mobile — match by title/aria or text).
const clickedWork = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll("button,[role=tab],a,li,div[class*=tab]")]
    .filter((el) => {
      const label = (el.getAttribute("title") || el.getAttribute("aria-label") || el.textContent || "").trim();
      return label === "Work" && el.getClientRects().length > 0;
    });
  const target = candidates[candidates.length - 1];
  if (!target) return false;
  target.click();
  return true;
});
check("work tab opened", clickedWork);
await page.waitForSelector(".fm-sig-card", { timeout: 15000 }).catch(() => null);
await page.waitForTimeout(1200);
await shot("work-tab-list");

// Cards show waiting chips.
const chipText = await page.evaluate(() => [...document.querySelectorAll(".fm-chip")].map((el) => el.textContent.trim()));
check("waiting chips render", chipText.some((t) => /Customer signature/i.test(t)) && chipText.some((t) => /Payment/i.test(t)), chipText);

// Open the manage menu on the Original Roof Contract card.
const contractCard = page.locator(".fm-sig-card", { hasText: "Original Roof Contract" }).first();
await contractCard.waitFor({ timeout: 10000 });
await contractCard.locator("[data-work-menu]").click();
await page.waitForSelector(".fm-work-sheet", { timeout: 5000 });
await shot("manage-menu");

// Cancel it.
await page.locator("[data-manage-cancel]").click();
await page.waitForSelector("[data-cancel-confirm]", { timeout: 5000 });
await page.locator("[data-cancel-reason]").fill("Customer requested a new estimate");
await shot("cancel-sheet");
await page.locator("[data-cancel-confirm]").click();
await page.waitForTimeout(2500);
await page.waitForSelector(".fm-sig-card", { timeout: 10000 }).catch(() => null);
await shot("after-cancel");

const canceledCard = await page.locator(".fm-sig-card.is-canceled", { hasText: "Original Roof Contract" }).count();
check("contract shows as canceled in list", canceledCard > 0);

// The customer's old link is dead.
const dead = await fetch(`${API}/v1/documents/public/${oldContract.token}`);
check("canceled document public link 404s", dead.status === 404, dead.status);
const deadSign = await fetch(`${API}/v1/documents/public/${oldContract.token}/outputs/sig_customer`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ value: { type: "typed", text: "Jane", signer_name: "Jane" } })
});
check("signing through canceled link rejected", deadSign.status >= 400, deadSign.status);

// The live proposal still works and shows the manage menu inside the detail view.
const proposalCard = page.locator(".fm-sig-card", { hasText: "Roof Replacement Proposal" }).first();
await proposalCard.click();
await page.waitForTimeout(3500);
await shot("proposal-detail");
const detailMenu = page.locator("[data-detail-menu]").first();
const hasDetailMenu = await detailMenu.count();
check("detail view has manage menu", hasDetailMenu > 0);
if (hasDetailMenu) {
  await detailMenu.click();
  await page.waitForSelector(".fm-work-sheet", { timeout: 5000 });
  await shot("detail-manage-menu");
  await page.locator("[data-manage-close]").click();
}

// --- Phase 4: Add Work library, delivery choice, replace flow ---------------
await page.locator("[data-signature-back]").click();
await page.waitForSelector(".fm-sig-card", { timeout: 10000 });
await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")]
    .filter((el) => (el.getAttribute("aria-label") || el.textContent || "").trim().includes("Add Work") && el.getClientRects().length > 0);
  buttons[buttons.length - 1]?.click();
});
await page.waitForSelector("[data-library-search]", { timeout: 10000 });
await shot("add-work-library");
await page.locator("[data-library-search]").fill("roof");
await page.waitForTimeout(600);
const roofEntry = page.locator("[data-library-scope]", { hasText: "Roofing Proposal" }).first();
const roofFound = await roofEntry.count();
check("roofing proposal searchable in library", roofFound > 0);
await shot("add-work-search-roof");
if (roofFound) {
  await roofEntry.click();
  await page.waitForSelector(".fm-work-sheet", { timeout: 20000 }).catch(() => null);
  const sheetShown = await page.locator("[data-delivery-device]").count();
  check("delivery choice sheet after create", sheetShown > 0);
  await shot("delivery-choice-sheet");
  const replaceOffer = await page.locator("[data-delivery-replace]").count();
  check("replace-earlier-work offer listed", replaceOffer > 0);
  if (sheetShown) {
    await page.locator("[data-delivery-portal]").click();
    await page.waitForTimeout(2500);
    await page.waitForSelector(".fm-sig-card", { timeout: 10000 }).catch(() => null);
    await shot("after-send-to-portal");
    const newCard = await page.locator(".fm-sig-card", { hasText: "Roofing Options & Approval" }).count();
    check("new roofing work appears in list", newCard > 0);
  }
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
