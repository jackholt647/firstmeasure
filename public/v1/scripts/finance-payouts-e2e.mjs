/**
 * Drives the Financials app "Payouts" view end-to-end against the local stack:
 * boards a mock merchant (provider "mock" + money.merchant_processing), signs a
 * proposal to mint obligations, takes provider-backed mock payments (one
 * declined), settles them into a payout, opens a dispute, then exercises the
 * Payouts view with real clicks: summary tiles vs the finance-summary
 * endpoint, status filter chips, the payout drilldown with fee/net math,
 * project links, the disputes table, and the capability gate.
 *
 *   node scripts/finance-payouts-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101). Screenshots go to
 * FINANCE_PAYOUTS_SHOTS_DIR (or ./finance-payouts-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.FINANCE_PAYOUTS_SHOTS_DIR || path.resolve("finance-payouts-shots");
await mkdir(SHOTS, { recursive: true });

const US_PLAN_ID = "partppl_3HpoNDtV6PtzrHasDxATGCIww6m";
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};
const parseMoney = (text) => Math.round(Number(String(text ?? "").replace(/[^0-9.-]/g, "")) * 100);

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

// --- seed org + boarded mock merchant ---------------------------------------
const owner = apiClient();
const orgId = `org_fpay_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Payout Owner",
  company: "Finance Payouts Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "money.profitability": true, "money.merchant_processing": true }
});
await owner.req("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
const applicationCreated = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications`, {
  processing_plan_id: US_PLAN_ID,
  external_account_id: orgId,
  company: { legal_name: "Finance Payouts Demo Co LLC" }
});
await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-boarding/applications/${applicationCreated.application.id}/submit`, {});
const approved = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
  application_id: applicationCreated.application.id, to: "APPROVED"
});
check("mock merchant boards to APPROVED with payouts enabled",
  approved?.merchant_config?.forward?.payouts_enabled === true, approved?.merchant_config?.forward?.boarding_status);

// --- signed proposal -> obligations -----------------------------------------
const projectId = `project_fpay_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Slate Roof Restoration", address: "12 Batch Street", project_type: "residential",
    contacts: [{ id: "contact_fpay", name: "Sweep Marlow", email: `sweep-${suffix}@example.test`, primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const created = await owner.req("POST", `/v1/proposals/organizations/${orgId}/projects/${projectId}/proposals`, {
  title: "Slate Roof Proposal",
  contacts: [{ role: "customer", name: "Sweep Marlow", email: `sweep-${suffix}@example.test` }],
  editable: {
    title: "Slate Roof Proposal",
    pricing: { total: 12500 },
    pages: [
      { id: "pricing", kind: "pricing", lineItems: [{ label: "Slate restoration", amount: 12500 }] },
      { id: "signature", kind: "signature", depositAmount: 2500, completionAmount: 10000 }
    ]
  }
});
const sent = await owner.req("POST", `/v1/proposals/organizations/${orgId}/proposals/${created.proposal.id}/send`, {
  expected_revision: created.proposal.revision,
  recipients: [{ role: "customer", name: "Sweep Marlow", email: `sweep-${suffix}@example.test` }],
  include_pdf: false, include_portal: true
});
await owner.req("POST", `/v1/proposals/public/${sent.snapshot.delivery.public_token}/sign`, {
  signer_name: "Sweep Marlow", signature: { type: "adopt", text: "Sweep Marlow" }
});

// --- provider-backed mock payments (2 captured + 1 declined) -----------------
async function takeMockPayment(amountCents, methodToken) {
  const recorded = await owner.req("POST", `/v1/payments/organizations/${orgId}/payments`, {
    project_id: projectId, amount_cents: amountCents, method: { type: "card", label: "Card" }
  });
  const paymentId = recorded.payment.id;
  const charge = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
    op: "charge", payment_id: paymentId, project_id: projectId,
    amount_cents: amountCents, payment_method_id: methodToken
  });
  return { paymentId, charge: charge.charge };
}
const paymentA = await takeMockPayment(250_000, "pm_mock_visa"); // deposit, fee 80
const paymentB = await takeMockPayment(100_000, "pm_mock_visa"); // partial final, fee 50
check("mock charges capture", paymentA.charge.status === "captured" && paymentB.charge.status === "captured",
  { a: paymentA.charge.status, b: paymentB.charge.status });
const declined = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
  op: "charge", amount_cents: 50_000, payment_method_id: "pm_mock_declined"
});
check("declined mock charge fails with a decline category",
  declined.charge.status === "failed" && declined.charge.decline_reason === "generic_decline", declined.charge.decline_reason);
const projectPayments = await owner.req("GET", `/v1/payments/organizations/${orgId}/projects/${projectId}/payments`);
check("declined charge never touches project transactions", projectPayments.payments.length === 2, projectPayments.payments.length);

const preSummary = (await owner.req("GET", `/v1/payments/organizations/${orgId}/finance-summary`)).summary;
check("pre-settle summary: captured net awaits sweep",
  preSummary.balance_pending_cents === 349_870 && preSummary.in_transit_cents === 0 && preSummary.paid_out_30d_cents === 0,
  preSummary);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
// "Respond at Forward" opens the merchant portal in a new tab — stub
// window.open and count login-url requests so nothing actually navigates.
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
  await page.screenshot({ path: file });
  console.log("shot:", file);
}
async function login(email, org) {
  await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, organization_id: org })
    });
  }, { api: API, email, password: ownerPassword, org });
}
async function openPayoutsView() {
  await page.goto(WEB + "/portal/?tab=financials&financialView=payouts", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
  await page.waitForSelector(".fn-shell", { timeout: 30000 });
  await page.waitForSelector('[data-fn-tile="balance_pending"]', { timeout: 30000 }).catch(() => null);
  await page.waitForTimeout(800);
}

await login(ownerEmail, orgId);
await openPayoutsView();

// 1. Capability-gated tab renders and the payouts view is active.
const tabState = await page.evaluate(() => ({
  payoutsTab: !!document.querySelector('[data-fn-view="payouts"]'),
  active: document.querySelector('[data-fn-view="payouts"]')?.classList.contains("active") === true,
  tiles: [...document.querySelectorAll("[data-fn-tile]")].length
}));
check("payouts tab appears in the view switcher and is active", tabState.payoutsTab && tabState.active, tabState);
check("six summary tiles render", tabState.tiles === 6, tabState.tiles);

// 2. Pre-settle: pending-sweep tile matches the endpoint; empty payout state.
const preUi = await page.evaluate(() => ({
  pending: document.querySelector('[data-fn-tile="balance_pending"] strong')?.textContent || "",
  inTransit: document.querySelector('[data-fn-tile="in_transit"] strong')?.textContent || "",
  emptyText: [...document.querySelectorAll(".fn-empty")].map((el) => el.textContent.replace(/\s+/g, " ").trim()).join(" | ")
}));
check("pending-sweep tile matches finance-summary", parseMoney(preUi.pending) === preSummary.balance_pending_cents, preUi.pending);
check("no-payouts empty state explains processing go-live",
  /Payouts will appear once payment processing is live/.test(preUi.emptyText), preUi.emptyText.slice(0, 120));
await shot("payouts-pre-settle");

// --- settle into a payout + open a dispute ----------------------------------
const settled = await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, { op: "settle" });
check("settle op produces a completed payout", /^po_mock_/.test(settled.payout.id) && settled.payout.status === "completed", settled.payout.id);
await owner.req("POST", `/v1/payments/organizations/${orgId}/merchant-mock/advance`, {
  op: "dispute", payment_id: paymentA.paymentId, amount_cents: 40_000, reason: "product_not_received"
});
const summary = (await owner.req("GET", `/v1/payments/organizations/${orgId}/finance-summary`)).summary;
const payoutList = (await owner.req("GET", `/v1/payments/organizations/${orgId}/payouts`)).payouts;
const payout = payoutList[0];

// 3. Refresh the view (real click) and compare every tile with the endpoint.
await page.click('[data-fn-action="refresh"]');
await page.waitForFunction(() => {
  const strong = document.querySelector('[data-fn-tile="paid_out_30d"] strong');
  return strong && strong.textContent.replace(/[^0-9]/g, "") !== "000";
}, null, { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(600);
const tiles = await page.evaluate(() => {
  const read = (key) => ({
    value: document.querySelector(`[data-fn-tile="${key}"] strong`)?.textContent.trim() || "",
    small: document.querySelector(`[data-fn-tile="${key}"] small`)?.textContent.trim() || ""
  });
  return {
    pending: read("balance_pending"), inTransit: read("in_transit"), paid: read("paid_out_30d"),
    fees: read("fees_30d"), next: read("next_payout"), disputes: read("open_disputes")
  };
});
check("tile: pending sweep drains to summary value", parseMoney(tiles.pending.value) === summary.balance_pending_cents, tiles.pending.value);
check("tile: in transit matches summary", parseMoney(tiles.inTransit.value) === summary.in_transit_cents, tiles.inTransit.value);
check("tile: paid out 30d matches summary", parseMoney(tiles.paid.value) === summary.paid_out_30d_cents, tiles.paid.value);
check("tile: fees 30d matches summary with effective rate", parseMoney(tiles.fees.value) === summary.fees_30d_cents
  && tiles.fees.small.includes(`${(summary.effective_rate_bps / 100).toFixed(2)}%`), tiles.fees);
check("tile: next payout empty after full settlement", tiles.next.value === "—" && /No payout scheduled/.test(tiles.next.small), tiles.next);
check("tile: open disputes counts the new dispute", Number(tiles.disputes.value) === summary.disputes_open_count && summary.disputes_open_count === 1, tiles.disputes.value);

// 4. Payout row renders with the completed status and totals.
const row = await page.evaluate(() => {
  const tr = document.querySelector("tr[data-fn-payout]");
  return tr ? {
    id: tr.querySelector(".fn-payout-id strong")?.textContent.trim(),
    badge: tr.querySelector(".fn-badge")?.textContent.trim(),
    badgeGood: tr.querySelector(".fn-badge")?.classList.contains("good") === true,
    cells: [...tr.querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim()),
    count: document.querySelectorAll("tr[data-fn-payout]").length
  } : null;
});
check("payout row appears after settle", !!row && row.count === 1, row?.count);
check("payout row shows provider id + completed badge", row?.id === settled.payout.id && row?.badge === "completed" && row?.badgeGood, row?.id);
check("payout row amount and fees match the read model",
  parseMoney(row?.cells?.[2]) === payout.amount_cents && parseMoney(row?.cells?.[3]) === payout.fee_cents
  && payout.amount_cents === 349_870 && payout.fee_cents === 130, { amount: row?.cells?.[2], fee: row?.cells?.[3] });
check("payout row shows arrival dates and 2 member transactions",
  !/Not arrived/.test(row?.cells?.[5] || "") && row?.cells?.[6] === "2", { arrived: row?.cells?.[5], tx: row?.cells?.[6] });
await shot("payouts-settled");

// 5. Filter chips actually filter (click failed -> empty, completed -> row, all).
await page.click('[data-fn-payout-filter="failed"]');
await page.waitForTimeout(300);
const failedFilter = await page.evaluate(() => ({
  rows: document.querySelectorAll("tr[data-fn-payout]").length,
  empty: /No payouts match this filter/.test(document.querySelector(".fn-card .fn-empty")?.textContent || ""),
  active: document.querySelector('[data-fn-payout-filter="failed"]')?.classList.contains("active") === true
}));
check("failed chip filters the completed payout out", failedFilter.rows === 0 && failedFilter.empty && failedFilter.active, failedFilter);
await page.click('[data-fn-payout-filter="completed"]');
await page.waitForTimeout(300);
const completedFilter = await page.evaluate(() => document.querySelectorAll("tr[data-fn-payout]").length);
check("completed chip shows the payout again", completedFilter === 1, completedFilter);
await shot("payouts-filtered");
await page.click('[data-fn-payout-filter="all"]');
await page.waitForTimeout(300);

// 6. Drilldown: click the row, verify payout stats and member fee/net math.
await page.click("tr[data-fn-payout]");
await page.waitForSelector(".fn-modal", { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll(".fn-modal .fn-table tbody tr").length > 0, null, { timeout: 15000 });
const detail = await page.evaluate(() => ({
  title: document.querySelector(".fn-modal-head strong")?.textContent.trim() || "",
  stats: [...document.querySelectorAll(".fn-modal-stat")].map((el) => el.textContent.replace(/\s+/g, " ").trim()),
  rows: [...document.querySelectorAll(".fn-modal .fn-table tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim())),
  projectLinks: [...document.querySelectorAll(".fn-modal [data-fn-open-project]")].map((el) => el.textContent.trim())
}));
check("drilldown opens with the payout id", detail.title.includes(settled.payout.id), detail.title);
check("drilldown stats show amount to bank + fees",
  parseMoney((detail.stats[0] || "").replace("Amount to bank", "")) === 349_870
  && parseMoney((detail.stats[1] || "").replace("Processing fees", "")) === 130, detail.stats.slice(0, 2));
check("drilldown lists both member transactions", detail.rows.length === 2, detail.rows.length);
const depositRow = detail.rows.find((cells) => parseMoney(cells[3]) === 250_000);
const partialRow = detail.rows.find((cells) => parseMoney(cells[3]) === 100_000);
check("member fee/net math: $2,500 gross -> 80c fee -> $2,499.20 net",
  !!depositRow && parseMoney(depositRow[4]) === 80 && parseMoney(depositRow[5]) === 249_920, depositRow);
check("member fee/net math: $1,000 gross -> 50c fee -> $999.50 net",
  !!partialRow && parseMoney(partialRow[4]) === 50 && parseMoney(partialRow[5]) === 99_950, partialRow);
check("member transactions link their project", detail.projectLinks.length === 2 && detail.projectLinks.every((t) => /Slate Roof Restoration/.test(t)), detail.projectLinks);
await shot("payout-drilldown");

// 7. Dispute row renders with status, amount, reason, opened date + project link.
await page.click("[data-fn-close-payout]");
await page.waitForFunction(() => !document.querySelector(".fn-modal"), null, { timeout: 10000 });
const disputeRow = await page.evaluate(() => {
  const tr = document.querySelector("tr[data-fn-dispute]");
  return tr ? {
    cells: [...tr.querySelectorAll("td")].map((td) => td.textContent.replace(/\s+/g, " ").trim()),
    badgeWarn: tr.querySelector(".fn-badge")?.classList.contains("warn") === true,
    projectLink: tr.querySelector("[data-fn-open-project]")?.dataset.fnOpenProject || ""
  } : null;
});
check("dispute row shows status, amount, and reason",
  !!disputeRow && disputeRow.cells[0] === "created" && disputeRow.badgeWarn
  && parseMoney(disputeRow.cells[1]) === 40_000 && /product not received/.test(disputeRow.cells[2]), disputeRow?.cells);
check("dispute row links the payment and project",
  disputeRow?.cells?.[4] === paymentA.paymentId && disputeRow?.projectLink === projectId,
  { payment: disputeRow?.cells?.[4], project: disputeRow?.projectLink });

// 7b. Respond at Forward: dispute responses are portal-only on Forward's side
//     — the button mints a single-use SSO login URL and opens a new tab
//     (stubbed; we never navigate to the mock portal domain).
const respondButton = await page.evaluate(() => document.querySelector("tr[data-fn-dispute] [data-fn-dispute-respond]")?.textContent.replace(/\s+/g, " ").trim() || "");
check("open dispute row shows the Respond at Forward button", /Respond at Forward/.test(respondButton), respondButton);
const loginRequestsBefore = loginUrlRequests;
await page.click("tr[data-fn-dispute] [data-fn-dispute-respond]");
await page.waitForFunction(() => (window.__openedUrls || []).length > 0, null, { timeout: 20000 });
const portalUrl = await page.evaluate(() => window.__openedUrls[window.__openedUrls.length - 1]);
check("Respond at Forward fires the login-url request and opens the portal link",
  loginUrlRequests > loginRequestsBefore && /^https:\/\/portal\.mock\.local\/auth\/magic-link\?code=/.test(portalUrl || ""),
  { requests: loginUrlRequests - loginRequestsBefore, url: (portalUrl || "").slice(0, 48) });
await shot("disputes-section");

// 8. Project link navigates to the project money route.
await page.click("tr[data-fn-dispute] [data-fn-open-project]");
await page.waitForTimeout(1200);
const route = await page.evaluate(() => window.Portal?.navigation?.read?.() || {});
check("project link routes to the project money tab", route.project === projectId && route.projectTab === "money", route);

// 9. Capability gate: an org without merchant_processing never sees the tab.
const gatedOwner = apiClient();
const gatedOrgId = `org_fpay_gated_${suffix}`;
const gatedEmail = `gated-${suffix}@example.test`;
await gatedOwner.req("POST", "/v1/platform/auth/register", {
  email: gatedEmail, password: ownerPassword, name: "Gated Owner",
  company: "Gated Payouts Co", organization_id: gatedOrgId
});
await gatedOwner.req("POST", `/v1/platform/organizations/${gatedOrgId}/capabilities/presets/full_platform/apply`, {});
// full_platform turns everything on — switch merchant processing back off to
// exercise the gate.
await gatedOwner.req("PUT", `/v1/platform/organizations/${gatedOrgId}/capabilities`, {
  values: { "money.profitability": true, "money.merchant_processing": false }
});
await login(gatedEmail, gatedOrgId);
await page.goto(WEB + "/portal/?tab=financials&financialView=payouts", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".fn-tabs", { timeout: 30000 });
await page.waitForTimeout(1500);
const gated = await page.evaluate(() => ({
  payoutsTab: !!document.querySelector('[data-fn-view="payouts"]'),
  activeView: document.querySelector(".fn-tabs button.active")?.dataset.fnView || ""
}));
check("without merchant_processing the payouts tab is hidden and the route falls back",
  !gated.payoutsTab && gated.activeView === "projects", gated);
await shot("capability-gated");

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
