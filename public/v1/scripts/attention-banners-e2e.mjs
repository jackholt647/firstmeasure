/**
 * Drives the org-wide attention banner platform end-to-end against the local
 * stack: seeds an org, injects stored banners through the attention API, and
 * asserts all three render surfaces with real clicks:
 *   - topbar bar shows the single highest-priority entry and owns the layout
 *     shift (body.has-attention-topbar + --attention-topbar-offset, applied
 *     exactly once),
 *   - sidebar slot card shows the same winner,
 *   - notification dropdown pins entries above real notifications with no
 *     dismiss control (and an hourglass for "waiting" entries),
 * then exercises per-user topbar dismissal (persists across reload, does NOT
 * hide the non-dismissible surfaces) and the FirstMeasure-promo client-source
 * pipeline (stubbed status; the PHP promo status action is not available in
 * the local stack, so the client source is unit-driven in the page).
 *
 *   node scripts/attention-banners-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (web :8011 + API :3101, dist rebuilt). Screenshots
 * go to ATTENTION_SHOTS_DIR (or ./attention-banners-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.ATTENTION_SHOTS_DIR || path.resolve("attention-banners-shots");
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
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
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

// --- seed org + stored banners ----------------------------------------------
const owner = apiClient();
const orgId = `org_attn_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Attention Owner",
  company: "Attention Banner Demo Co", organization_id: orgId
});
const base = `/v1/platform/organizations/${orgId}`;
await owner.req("POST", `${base}/capabilities/presets/full_platform/apply`, {});
// The money_onboarding attention source emits a priority-100 entry whenever
// platform.money + money.merchant_processing are on with onboarding incomplete
// — it would outrank this harness's synthetic banners, so opt this org out.
await owner.req("PUT", `${base}/capabilities`, { values: { "money.merchant_processing": false } });

const bannerA = {
  id: "attention_e2e_a",
  key: "e2e_dismissible",
  priority: 50,
  surfaces: ["topbar", "sidebar", "notification"],
  title: "Finish setting up payments",
  body: "Connect your bank account to start collecting.",
  cta_label: "Set up",
  tone: "primary",
  frontend_action: { route: { tab: "billing" } },
  state: "active",
  dismissible: { topbar: true, sidebar: false }
};
const bannerB = {
  id: "attention_e2e_b",
  key: "e2e_urgent",
  priority: 90,
  surfaces: ["topbar", "sidebar", "notification"],
  title: "Action required on your account",
  body: "A verification document is missing.",
  cta_label: "Review",
  tone: "orange",
  frontend_action: { route: { tab: "company_settings" } },
  state: "active",
  dismissible: {}
};
const bannerWaiting = {
  id: "attention_e2e_waiting",
  key: "e2e_waiting",
  priority: 20,
  surfaces: ["notification"],
  title: "Verification in review",
  body: "We are reviewing your documents.",
  tone: "neutral",
  state: "waiting",
  dismissible: {}
};
await owner.req("POST", `${base}/attention-banners`, bannerA);
await owner.req("POST", `${base}/attention-banners`, bannerB);
await owner.req("POST", `${base}/attention-banners`, bannerWaiting);
await owner.req("POST", `${base}/notifications`, {
  title: "Regular notification", body: "An ordinary row below the pinned ones."
});
const seeded = await owner.req("GET", `${base}/attention`);
check("API returns the merged feed priority-sorted desc",
  seeded.entries.map((entry) => entry.id).join(",").startsWith("attention_e2e_b,attention_e2e_a"),
  seeded.entries.map((entry) => `${entry.id}:${entry.priority}`));

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
async function login() {
  await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
  await page.evaluate(async ({ api, email, password, org }) => {
    await fetch(api + "/v1/platform/auth/login", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, organization_id: org })
    });
  }, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });
}
async function openPortal() {
  await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
  await page.waitForFunction(() => (window.PlatformBanners?.getState?.().entries || []).length > 0, null, { timeout: 20000 }).catch(() => null);
  await page.waitForTimeout(600);
}

await login();
await openPortal();

// 1. Topbar surface: single bar, highest priority wins, tone + copy + CTA.
const topbar = await page.evaluate(() => {
  const bars = document.querySelectorAll(".fm-attention-topbar");
  const bar = bars[0];
  return {
    count: bars.length,
    id: bar?.dataset.attentionId || "",
    tone: bar ? [...bar.classList].find((cls) => cls.startsWith("tone-")) : "",
    title: bar?.querySelector("[data-attention-title]")?.textContent || "",
    cta: bar?.querySelector("[data-attention-cta]")?.textContent || "",
    dismiss: !!bar?.querySelector("[data-attention-dismiss]")
  };
});
check("exactly one topbar bar renders", topbar.count === 1, topbar.count);
check("topbar shows the priority-90 entry (priority override)",
  topbar.id === "attention_e2e_b" && topbar.title === bannerB.title, topbar);
check("topbar carries the orange tone and CTA label", topbar.tone === "tone-orange" && topbar.cta === "Review", topbar);
check("non-dismissible entry renders no dismiss control", topbar.dismiss === false, topbar.dismiss);

// 2. Layout shift applied exactly once via the body offset var.
const layout = await page.evaluate(() => {
  const bar = document.querySelector(".fm-attention-topbar");
  const barHeight = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
  const offset = parseFloat(getComputedStyle(document.body).getPropertyValue("--attention-topbar-offset")) || 0;
  const main = document.querySelector(".main");
  const mainMargin = main ? parseFloat(getComputedStyle(main).marginTop) : -1;
  const mainTop = main ? Math.round(main.getBoundingClientRect().top) : -1;
  return {
    hasClass: document.body.classList.contains("has-attention-topbar"),
    legacyClass: document.body.classList.contains("has-bonus-promo"),
    barHeight, offset, mainMargin, mainTop,
    legacyBar: !!document.getElementById("promoBonusBar")
  };
});
check("body offset var equals the bar height (shift applied exactly once)",
  layout.hasClass && layout.offset === layout.barHeight && layout.mainMargin === layout.offset, layout);
check("content starts below the bar, not under it", layout.mainTop >= layout.barHeight, layout.mainTop);
check("legacy promo bar mechanics are gone", !layout.legacyClass && !layout.legacyBar, layout);
await shot("topbar-priority-90");

// 3. Sidebar surface shows the same winner.
const sidebar = await page.evaluate(() => {
  const slot = document.getElementById("sidebarAttentionSlot");
  const card = slot?.querySelector(".sidebar-attention-card");
  return {
    hidden: slot?.hidden !== false,
    id: card?.dataset.attentionId || "",
    title: card?.querySelector("strong")?.textContent?.trim() || "",
    chevron: !!card?.querySelector(".sidebar-attention-chevron"),
    insideBottomLinks: !!card?.closest("#sidebarBottomLinks")
  };
});
check("sidebar slot shows the priority-90 entry with a chevron",
  !sidebar.hidden && sidebar.id === "attention_e2e_b" && sidebar.title === bannerB.title && sidebar.chevron, sidebar);
check("sidebar slot is a sibling, not inside #sidebarBottomLinks", sidebar.insideBottomLinks === false);
await shot("sidebar-card");

// 4. Notification dropdown: pinned rows locked on top, no dismiss control.
await page.click("#platformBell");
await page.waitForSelector("#platformNotificationMenu.visible", { timeout: 10000 });
await page.waitForFunction(() => document.querySelectorAll("#platformNotificationList .ptb-note").length > 0, null, { timeout: 10000 });
await page.waitForTimeout(400);
const dropdown = await page.evaluate(() => {
  const list = document.getElementById("platformNotificationList");
  const rows = [...list.querySelectorAll(".ptb-note")];
  return {
    order: rows.map((row) => row.dataset.attentionNoteId || (row.dataset.noteId ? "regular" : "other")),
    pinned: rows.filter((row) => row.classList.contains("ptb-note-pinned")).map((row) => ({
      id: row.dataset.attentionNoteId,
      tone: [...row.classList].find((cls) => cls.startsWith("tone-")),
      dismiss: !!row.querySelector(".ptb-note-dismiss, [data-dismiss-note]"),
      waiting: !!row.querySelector(".ptb-note-pinned-wait")
    })),
    regularHasDismiss: !!list.querySelector("[data-note-id] .ptb-note-dismiss"),
    unreadBadge: document.getElementById("platformNotificationCount")?.textContent || ""
  };
});
check("pinned attention rows sit above the regular notification",
  dropdown.order[0] === "attention_e2e_b" && dropdown.order.indexOf("regular") > dropdown.order.lastIndexOf("attention_e2e_waiting"),
  dropdown.order);
check("pinned rows have no dismiss control ever",
  dropdown.pinned.length === 3 && dropdown.pinned.every((row) => !row.dismiss), dropdown.pinned);
check("regular notification keeps its dismiss control", dropdown.regularHasDismiss === true);
check("waiting entry renders the hourglass indicator",
  dropdown.pinned.find((row) => row.id === "attention_e2e_waiting")?.waiting === true, dropdown.pinned);
check("pinned entries do not inflate the unread count", dropdown.unreadBadge === "1", dropdown.unreadBadge);
await shot("notification-dropdown-pinned");

// 5. Delete the 90 banner: the 50 one takes over the topbar; dismiss it.
await owner.req("DELETE", `${base}/attention-banners/attention_e2e_b`);
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelector(".fm-attention-topbar")?.dataset.attentionId === "attention_e2e_a", null, { timeout: 20000 });
const topbarA = await page.evaluate(() => {
  const bar = document.querySelector(".fm-attention-topbar");
  return {
    id: bar?.dataset.attentionId,
    tone: bar ? [...bar.classList].find((cls) => cls.startsWith("tone-")) : "",
    dismiss: !!bar?.querySelector("[data-attention-dismiss]")
  };
});
check("after deleting the 90 entry the 50 entry takes the topbar",
  topbarA.id === "attention_e2e_a" && topbarA.tone === "tone-primary", topbarA);
check("dismissible topbar entry shows the dismiss X", topbarA.dismiss === true);
await shot("topbar-priority-50");

await page.click("[data-attention-dismiss]");
await page.waitForFunction(() => !document.querySelector(".fm-attention-topbar"), null, { timeout: 15000 });
const afterDismiss = await page.evaluate(() => ({
  bar: !!document.querySelector(".fm-attention-topbar"),
  bodyClass: document.body.classList.contains("has-attention-topbar"),
  sidebarId: document.querySelector("#sidebarAttentionSlot .sidebar-attention-card")?.dataset.attentionId || ""
}));
check("dismissing removes the bar and the layout shift", !afterDismiss.bar && !afterDismiss.bodyClass, afterDismiss);
check("dismissal only hides the dismissible surface: sidebar still shows the entry",
  afterDismiss.sidebarId === "attention_e2e_a", afterDismiss.sidebarId);

// 6. Per-user dismissal persists across reload (server user-state).
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.PlatformBanners?.getState?.().loaded_at, null, { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(800);
const afterReload = await page.evaluate(() => ({
  bar: !!document.querySelector(".fm-attention-topbar"),
  sidebarId: document.querySelector("#sidebarAttentionSlot .sidebar-attention-card")?.dataset.attentionId || ""
}));
check("topbar dismissal persists across reload", afterReload.bar === false, afterReload);
check("non-dismissible sidebar surface persists across reload", afterReload.sidebarId === "attention_e2e_a", afterReload.sidebarId);
const serverState = await owner.req("GET", `${base}/attention?include_dismissed=1`);
const dismissedEntry = serverState.entries.find((entry) => entry.id === "attention_e2e_a");
check("server user-state records the dismissal",
  !!dismissedEntry?.user_state?.dismissed_at
  && JSON.stringify(dismissedEntry.visible_surfaces) === JSON.stringify(["sidebar", "notification"]),
  dismissedEntry?.user_state);
await shot("after-dismiss-reload");

// 7. FirstMeasure promo pipeline: unit-drive a client source exactly the way
//    promo-inject registers (the PHP promo status action is not served by the
//    local stack, so the gating result is stubbed; the pipeline is real).
const promo = await page.evaluate(() => {
  window.__promoCtaClicks = 0;
  window.PlatformBanners.registerClientSource("firstmeasure_promo_stub", () => [{
    id: "attention_firstmeasure_promo_bonus",
    source: "firstmeasure_promo",
    key: "bonus_upfront_match_v1",
    priority: 10,
    surfaces: ["topbar"],
    title: "Get up to $500 in free credits with your limited time offer",
    body: "Offer expires in 05:00:00",
    cta_label: "View Offer",
    tone: "orange",
    state: "active",
    dismissible: { topbar: true },
    onCta: () => { window.__promoCtaClicks += 1; }
  }]);
  const bar = document.querySelector(".fm-attention-topbar");
  return {
    id: bar?.dataset.attentionId || "",
    tone: bar ? [...bar.classList].find((cls) => cls.startsWith("tone-")) : "",
    body: bar?.querySelector("[data-attention-body]")?.textContent || "",
    cta: bar?.querySelector("[data-attention-cta]")?.textContent || ""
  };
});
check("promo client source renders through the shared topbar pipeline",
  promo.id === "attention_firstmeasure_promo_bonus" && promo.tone === "tone-orange" && promo.cta === "View Offer", promo);
check("countdown text flows through the entry body", /05:00:00/.test(promo.body), promo.body);
await page.click("[data-attention-cta]");
const ctaClicks = await page.evaluate(() => window.__promoCtaClicks);
check("promo CTA invokes the client-source onCta callback", ctaClicks === 1, ctaClicks);
const promoLayout = await page.evaluate(() => ({
  offset: parseFloat(getComputedStyle(document.body).getPropertyValue("--attention-topbar-offset")) || 0,
  barHeight: Math.ceil(document.querySelector(".fm-attention-topbar")?.getBoundingClientRect().height || 0)
}));
check("promo bar reuses the single layout-shift mechanism", promoLayout.offset === promoLayout.barHeight && promoLayout.offset > 0, promoLayout);
await shot("promo-client-source");

// 8. Promo dismissal is client-side and re-render leaves nothing behind.
await page.click("[data-attention-dismiss]");
await page.waitForFunction(() => !document.querySelector(".fm-attention-topbar"), null, { timeout: 10000 });
const promoDismissed = await page.evaluate(() => ({
  bar: !!document.querySelector(".fm-attention-topbar"),
  stored: (() => { try { return localStorage.getItem("fm_attention_client_dismissed_v1") || ""; } catch { return ""; } })()
}));
check("promo topbar dismissal is honored and remembered client-side",
  !promoDismissed.bar && promoDismissed.stored.includes("attention_firstmeasure_promo_bonus"), promoDismissed);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
