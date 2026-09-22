/**
 * Kitchen Remodel portal walkthrough: seeds the scope via the field Add Work
 * route, signs the base estimate, then drives the customer portal Selections
 * workflow with real clicks and captures screenshots.
 *
 *   node scripts/kitchen-portal-e2e.mjs   (from public/v1; local stack running)
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.FIELD_WORK_SHOTS_DIR || path.resolve("kitchen-shots");
await mkdir(SHOTS, { recursive: true });

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

async function browserPath() {
  for (const c of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]) {
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

// --- seed org + project + kitchen scope --------------------------------------
const owner = apiClient();
const orgId = `org_kitchendemo_${suffix}`;
await owner.req("POST", "/v1/platform/auth/register", {
  email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
  name: "Owner User", company: "Kitchen Demo Co", organization_id: orgId
});
const projectId = `project_kitchendemo_${suffix}`;
const today = new Date().toISOString().slice(0, 10);

// Field supervisor for the Add Work instantiation path.
const fieldEmail = `field-${suffix}@example.test`;
const created = await owner.req("POST", `/v1/platform/organizations/${orgId}/users`, {
  data: { email: fieldEmail, password: "field user password 1", name: "Sam Rivera", status: "active", role: "viewer", send_invite: false }
});
const fieldUserId = String(created.document.id);
await owner.req("PATCH", `/v1/workforce/organizations/${orgId}/users/${fieldUserId}/profile`, {
  access_role_ids: ["supervisor"],
  application_access: {
    management: { enabled: false, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "supervisor", permissions: {} }
  }
});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Jane Homeowner", address: "42 Remodel Road", project_type: "residential",
    contacts: [{ id: "contact_jane", name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222", primary: true }],
    photos: [],
    events: [{ id: "ev_kitchen", kind: "project_work", event_type_default_id: "project_work", status: "scheduled", assigned_user_ids: [fieldUserId], start_date: today, end_date: today, all_day: true, schedule_granularity: "date" }]
  },
  metadata: { kind: "platform_project" }
});
await owner.req("GET", `/v1/documents/organizations/${orgId}/catalog`);

const field = apiClient();
await field.req("POST", "/v1/platform/auth/login", { email: fieldEmail, password: "field user password 1", organization_id: orgId });
const added = await field.req("POST", `/v1/workforce/organizations/${orgId}/crew/projects/${projectId}/workflows/scopes/kitchen_remodel`, {});
check("kitchen scope launchable from Add Work", !!added?.ok);

// Base estimate issued → sign it via its public link (API).
const docs1 = await owner.req("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
const estimateRef = (docs1.documents || []).find((doc) => doc.title === "Kitchen Remodel Estimate");
check("base estimate issued", !!estimateRef);
const estimate = (await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${estimateRef.id}`)).document;
const estimateToken = String(estimate.delivery.public_token);
await owner.req("POST", `/v1/documents/public/${estimateToken}/outputs/sig_customer`, {
  value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
});
const docs2 = await owner.req("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
const selectionsRef = (docs2.documents || []).find((doc) => doc.title === "Kitchen Finish Selections");
check("selections issued after estimate signed", !!selectionsRef);

const portal = (await owner.req("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`)).portal;
const portalUuid = String(portal.public_uuid || portal.preview_uuid);
const portalPath = portal.public_uuid ? `/customer_portal/?id=${encodeURIComponent(portalUuid)}` : `/customer_portal/preview.php?id=${encodeURIComponent(portalUuid)}`;

// --- drive the customer portal ----------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, deviceScaleFactor: 2 })).newPage();

let shotIndex = 16;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file });
  console.log("shot:", file);
}

await page.goto(WEB + portalPath, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const selectionsTab = page.locator("button, a, [role=tab]").filter({ hasText: /^Selections$/ }).first();
check("portal shows Selections tab", (await selectionsTab.count()) > 0);
await selectionsTab.click().catch(() => null);
await page.waitForSelector(".fmdw-choice-card, [data-fmdw-scg-option]", { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(2000);
await shot("portal-selections-choices");

// Upsell: walnut floors + quartz counters + pot filler.
for (const optionId of ["floor_walnut", "counter_quartz", "extra_pot_filler"]) {
  const option = page.locator(`[data-fmdw-scg-option="${optionId}"]`).first();
  if (await option.count()) { await option.click(); await page.waitForTimeout(600); }
  else check(`option ${optionId} clickable`, false);
}
await page.waitForTimeout(1500);
await shot("portal-selections-upgraded");

// Continue to review, then to sign.
const advance = async () => {
  const next = page.locator("button").filter({ hasText: /Continue|Next|Review/ }).last();
  if (await next.count()) { await next.click(); await page.waitForTimeout(2500); return true; }
  return false;
};
await advance();
await shot("portal-selections-review");
await advance();
await page.waitForTimeout(1500);
await shot("portal-selections-sign");

// Verify the authoritative delta server-side, then finish signing via API.
const selections = (await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${selectionsRef.id}`)).document;
const selToken = String(selections.delivery.public_token);
const pricing = await owner.req("POST", `/v1/documents/public/${selToken}/pricing`, {});
check("portal picks solidified to the $4,830 delta", pricing.totals.total_cents === 483000, pricing.totals.total_cents);
await owner.req("POST", `/v1/documents/public/${selToken}/outputs/sig_customer`, {
  value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
});
const finalDoc = (await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${selectionsRef.id}`)).document;
check("selections completed on signature", finalDoc.status === "completed", finalDoc.status);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(4500);
const selectionsTab2 = page.locator("button, a, [role=tab]").filter({ hasText: /^Selections$/ }).first();
if (await selectionsTab2.count()) { await selectionsTab2.click().catch(() => null); await page.waitForTimeout(2500); }
await shot("portal-selections-signed");

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
