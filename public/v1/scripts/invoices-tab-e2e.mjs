/**
 * Drives the global Invoices tab end-to-end against the local stack:
 * seeds an org with money.invoices enabled, signs a proposal to mint payment
 * obligations, then opens the portal Invoices tab and exercises the
 * needs-invoicing quick flow, detail modal, and production hold with real
 * clicks, capturing screenshots.
 *
 *   node scripts/invoices-tab-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101). Screenshots go to
 * INVOICES_TAB_SHOTS_DIR (or ./invoices-tab-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.INVOICES_TAB_SHOTS_DIR || path.resolve("invoices-tab-shots");
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

// --- seed org + signed proposal ---------------------------------------------
const owner = apiClient();
const orgId = `org_invtab_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Invoices Tab Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "money.invoices": true }
});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/payment_settings`, {
  data: { sales_tax_enabled: false, default_due_days: 14 }
});

const projectId = `project_invtab_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Cedar Shake Reroof", address: "88 Ledger Lane", project_type: "residential",
    contacts: [{ id: "contact_inv", name: "Iris Ledger", email: `iris-${suffix}@example.test`, phone: "555-010-2020", primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const created = await owner.req("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
  title: "Cedar Shake Proposal",
  contacts: [{ role: "customer", name: "Iris Ledger", email: `iris-${suffix}@example.test` }],
  editable: {
    title: "Cedar Shake Proposal",
    pricing: { total: 18000 },
    pages: [
      { id: "pricing", kind: "pricing", lineItems: [{ label: "Cedar shake reroof", amount: 18000 }] },
      { id: "signature", kind: "signature", depositAmount: 6000, completionAmount: 12000 }
    ]
  }
});
const sent = await owner.req("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
  expected_revision: created.proposal.revision,
  recipients: [{ role: "customer", name: "Iris Ledger", email: `iris-${suffix}@example.test` }],
  include_pdf: false, include_portal: true
});
await owner.req("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
  signer_name: "Iris Ledger", signature: { type: "adopt", text: "Iris Ledger" }
});
const uninvoicedSeed = await owner.req("GET", `/v1/payments/organizations/${orgId}/uninvoiced`);
check("seeded obligations appear uninvoiced", uninvoicedSeed?.projects?.[0]?.obligations?.length === 2, uninvoicedSeed?.projects?.[0]?.uninvoiced_cents);

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

await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, password, org }) => {
  await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
}, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });
await page.goto(WEB + "/portal/?tab=invoices", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForSelector(".inv-shell", { timeout: 30000 }).catch(() => null);
await page.waitForFunction(() => !document.querySelector(".inv-shell .fa-circle-notch"), null, { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(1500);

// 1. Tab mounts with summary cards; nothing invoiced yet.
const mounted = await page.evaluate(() => ({
  shell: !!document.querySelector(".inv-shell"),
  cards: [...document.querySelectorAll(".inv-card")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
  topbarTab: !!document.querySelector('[data-tab-id="invoices"], [data-portal-tab="invoices"], a[href*="tab=invoices"]')
}));
console.log("mounted:", JSON.stringify(mounted));
check("invoices tab shell mounts", mounted.shell);
check("summary cards render", mounted.cards.length === 5, mounted.cards);
check("needs-invoicing card shows the signed schedule", mounted.cards.some((text) => /Needs invoicing.*\$6,000/.test(text)), mounted.cards[2]);
await shot("outstanding-empty");

// 2. Needs invoicing view lists the project with the deposit preselected.
await page.click('[data-inv-view="needs_invoicing"]');
await page.waitForTimeout(800);
const needs = await page.evaluate(() => {
  const group = document.querySelector("[data-inv-group]");
  return {
    present: !!group,
    title: group?.querySelector(".inv-proj strong")?.textContent || "",
    checked: [...(group?.querySelectorAll("[data-inv-obligation]:checked") || [])].length,
    unchecked: [...(group?.querySelectorAll("[data-inv-obligation]:not(:checked)") || [])].length
  };
});
console.log("needs:", JSON.stringify(needs));
check("project group renders", needs.present && /Cedar Shake/.test(needs.title), needs.title);
check("ready deposit preselected, scheduled final not", needs.checked === 1 && needs.unchecked === 1, needs);
await shot("needs-invoicing");

// 3. Quick send opens the confirm sheet with the deposit total and Net-14 terms.
await page.click("[data-inv-quick]");
await page.waitForSelector(".inv-modal", { timeout: 10000 });
const sheet = await page.evaluate(() => ({
  total: document.querySelector(".inv-modal-lines .total")?.textContent.replace(/\s+/g, " ") || "",
  recipient: document.querySelector('.inv-modal [data-inv-field="recipient"]')?.value || ""
}));
console.log("sheet:", JSON.stringify(sheet));
check("confirm sheet totals the deposit", /\$6,000/.test(sheet.total), sheet.total);
check("confirm sheet shows payment terms", /14 days/.test(sheet.total), sheet.total);
check("recipient prefilled from the project contact", /iris-/.test(sheet.recipient), sheet.recipient);
await shot("quick-send-sheet");

// 4. Create the invoice as a draft (no email in the local stack) and verify it
//    lands in Outstanding while leaving the final payment uninvoiced.
await page.click('.inv-modal [data-inv-run="draft"]');
await page.waitForFunction(() => !document.querySelector(".inv-modal"), null, { timeout: 20000 });
await page.waitForTimeout(1500);
await page.click('[data-inv-view="outstanding"]');
await page.waitForTimeout(800);
const outstanding = await page.evaluate(() => ({
  rows: [...document.querySelectorAll("tr[data-invoice]")].map((row) => row.textContent.replace(/\s+/g, " ").trim()),
  agingChips: [...document.querySelectorAll("[data-inv-aging]")].map((el) => el.textContent.trim())
}));
console.log("outstanding:", JSON.stringify(outstanding));
check("quick invoice appears in outstanding", outstanding.rows.length === 1 && /INV-/.test(outstanding.rows[0] || ""), outstanding.rows[0]);
check("invoice row carries the derived due status and balance", /\$6,000/.test(outstanding.rows[0] || "") && /Due/i.test(outstanding.rows[0] || ""), outstanding.rows[0]);
check("aging chips render", outstanding.agingChips.length === 6, outstanding.agingChips);
await shot("outstanding-with-invoice");

// 5. Detail modal opens from the row with send/payment/hold/void actions.
await page.click("tr[data-invoice]");
await page.waitForSelector(".inv-modal", { timeout: 10000 });
const detail = await page.evaluate(() => ({
  actions: [...document.querySelectorAll(".inv-modal [data-inv-action]")].map((el) => el.dataset.invAction),
  pdf: document.querySelector('.inv-modal a[href*="/pdf"]') ? true : false,
  routeInvoice: new URLSearchParams(window.location.search).get("invoice") || window.Portal?.navigation?.read?.()?.invoice || ""
}));
console.log("detail:", JSON.stringify(detail));
check("detail exposes send, payment, hold, void, project actions",
  ["send", "payment", "hold", "void", "project"].every((action) => detail.actions.includes(action)), detail.actions);
check("PDF link present", detail.pdf);
check("route carries the invoice id", !!detail.routeInvoice, detail.routeInvoice);
await shot("invoice-detail");

// 6. Toggle a production hold from the detail modal and verify the summary card
//    and row flag update.
await page.click('.inv-modal [data-inv-action="hold"]');
await page.waitForSelector('.inv-modal [data-inv-run="hold"]', { timeout: 10000 });
await page.fill('.inv-modal [data-inv-field="note"]', "Deposit before tear-off");
await page.click('.inv-modal [data-inv-run="hold"]');
await page.waitForFunction(() => !document.querySelector(".inv-modal"), null, { timeout: 20000 });
await page.waitForTimeout(1500);
const held = await page.evaluate(() => ({
  holdCard: document.querySelectorAll(".inv-card")[4]?.textContent.replace(/\s+/g, " ") || "",
  rowFlag: !!document.querySelector("tr[data-invoice] .inv-hold-flag")
}));
console.log("held:", JSON.stringify(held));
check("production hold counted on the summary card", /Production holds\s*1/.test(held.holdCard), held.holdCard);
check("held invoice row shows the hold flag", held.rowFlag);
await shot("production-hold");

// 7. The hold surfaces on the project money summary for work automations.
const moneySummary = await owner.req("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/money-summary`);
check("money summary exposes the hold to work rules",
  moneySummary?.summary?.production_hold_count === 1 && /tear-off/.test(moneySummary?.summary?.production_holds?.[0]?.note || ""),
  moneySummary?.summary?.production_holds);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
