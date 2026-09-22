/**
 * Screenshot pass for the remaining Work surfaces:
 *  - customer portal: pending proposal + canceled work card
 *  - Doc Studio: Workflows subtab list + workflow editor
 *
 *   node scripts/work-screens-e2e.mjs   (from public/v1; local stack running)
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
  for (const c of ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]) {
    try { await access(c); return c; } catch { /* next */ }
  }
  throw new Error("no browser");
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

// --- seed org + project + one live proposal + one canceled contract ---------
const owner = apiClient();
const orgId = `org_workscreens_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Work Screens Demo Co", organization_id: orgId
});
// Doc Studio is capability-gated; enable the document engine + studio.
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.documents": true, "documents.templates_studio": true }
}).catch((error) => console.log("capabilities:", String(error).slice(0, 200)));

const projectId = `project_workscreens_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Jane Homeowner", address: "100 Document Lane", project_type: "residential",
    contacts: [{ id: "contact_jane", name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222", primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});

async function makeDocument(type, title, params) {
  const created = await owner.req("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, { document_type: type, title, params });
  const id = String(created.document.id);
  await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${id}/issue`, {});
  const sent = await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${id}/send`, {
    recipients: [{ name: "Jane Homeowner", phone: "555-111-2222", role: "customer" }],
    include_portal: true
  });
  return { id, token: String(sent.snapshot.public_token || ""), texted: sent.texted };
}

const proposal = await makeDocument("proposal", "Roof Replacement Proposal", {
  customer: { name: "Jane Homeowner", email: "jane@example.test" },
  scope_items: [
    { id: "item_roof", name: "Roof replacement", description: "Tear-off and re-shingle", quantity: 1, unit: "job", unit_price: 12500 }
  ],
  deposit_cents: 250000,
  tax_percent: 7
});
check("SMS delivery path recorded on send", Array.isArray(proposal.texted) && proposal.texted.length > 0, proposal.texted);

const contract = await makeDocument("contract", "Original Roof Contract", { body: "Old terms.", effective_date: "2026-08-01" });
await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${contract.id}/void`, {
  reason: "Customer requested a new estimate",
  customer_visibility: "visible"
});

const portal = (await owner.req("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`)).portal;
const portalUuid = String(portal.public_uuid || portal.preview_uuid);
const portalPath = portal.public_uuid ? `/customer_portal/?id=${encodeURIComponent(portalUuid)}` : `/customer_portal/preview.php?id=${encodeURIComponent(portalUuid)}`;
console.log("portal:", portalPath);

// --- drive the browser -------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

let shotIndex = 12;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
}

// Customer portal: proposal group tab + canceled card.
await page.goto(WEB + portalPath, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const proposalTab = page.locator("button, a, [role=tab]").filter({ hasText: /^Proposals$/ }).first();
if (await proposalTab.count()) { await proposalTab.click().catch(() => null); await page.waitForTimeout(2500); }
await shot("customer-portal-proposal");
// The canceled contract renders in its own Documents group tab.
const documentsTab = page.locator("button, a, [role=tab]").filter({ hasText: /^Documents$/ }).first();
if (await documentsTab.count()) { await documentsTab.click().catch(() => null); await page.waitForTimeout(2500); }
await shot("customer-portal-documents");
const canceledCard = await page.locator(".cp-doc-card.is-canceled").count();
check("portal shows canceled work card", canceledCard > 0);
const canceledLabel = await page.locator(".cp-doc-card-status.canceled").first().textContent().catch(() => "");
check("canceled card labeled Canceled", /canceled/i.test(String(canceledLabel)), canceledLabel);

// Doc Studio: workflows subtab.
await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, password, org }) => {
  await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
}, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
// App flags load async after first paint; wait for them, then take the routed tab.
await page.waitForFunction(() => {
  try { return window.Portal.appFlags.current()?.documents?.templates_studio === true; } catch { return false; }
}, null, { timeout: 30000 }).catch(() => null);
await page.goto(WEB + "/portal/?tab=documents_studio", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForSelector(".fmdx-shell", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);
const workflowsTab = page.locator(".fmdx-subtab").filter({ hasText: "Workflows" }).first();
const hasWorkflowsTab = await workflowsTab.count();
check("studio has Workflows subtab", hasWorkflowsTab > 0);
if (hasWorkflowsTab) {
  await workflowsTab.click();
  await page.waitForTimeout(2000);
  const wfDebug = await page.evaluate(async ({ org }) => {
    try {
      const res = await window.DocumentsAPI.workflows.list(org);
      return { ok: true, keys: Object.keys(res || {}), count: (res.workflows || res.items || []).length };
    } catch (error) { return { ok: false, error: String(error && error.message || error).slice(0, 200) }; }
  }, { org: orgId });
  console.log("workflows.list debug:", JSON.stringify(wfDebug));
  await page.waitForTimeout(500);
  await shot("studio-workflows-list");
  const firstCard = page.locator("[data-workflow-card] [data-wf-open]").first();
  if (await firstCard.count()) {
    await firstCard.click();
    await page.waitForSelector("[data-wf-json]", { timeout: 15000 }).catch(() => null);
    await page.waitForTimeout(1500);
    await shot("studio-workflow-editor");
    check("workflow editor shows steps + JSON", (await page.locator("[data-wf-json]").count()) > 0);
  } else {
    check("workflow editor shows steps + JSON", false, "no workflow cards");
  }
} else {
  const tabsSeen = await page.evaluate(() => [...document.querySelectorAll(".fmdx-subtab")].map((el) => el.textContent.trim()));
  console.log("subtabs:", JSON.stringify(tabsSeen));
  await shot("studio-missing-workflows");
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
