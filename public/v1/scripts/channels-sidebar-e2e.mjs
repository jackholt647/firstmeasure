/**
 * End-to-end test of the integrated Channels sidebar mode inside the portal:
 * sets the personal `left_column_channels` preference, signs in, switches the left
 * column to the Channels tab, creates/opens a conversation, and drives the
 * pop-over overlay with real mouse + keyboard input (open, send, close),
 * asserting geometry and state at each step.
 *
 *   node scripts/channels-sidebar-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (nginx :8011 + API :3101).
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const EMAIL = process.env.E2E_EMAIL || "web-builder-test-1@example.test";
const PASSWORD = process.env.E2E_PASSWORD || "WebBuilder!Test2026";

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
}

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
page.on("response", async (res) => {
  if (res.status() >= 400 && /\/v1\//.test(res.url())) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* stream gone */ }
    console.log(`   [http ${res.status()}] ${res.url().replace(API, "")} :: ${body}`);
  }
});
page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR/.test(m.text())) console.log("   [console.error]", m.text().slice(0, 160)); });

// --- sign in through the API so the portal session cookie is set -------------
await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
const login = await page.evaluate(async ({ api, email, password }) => {
  const r = await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, org: j.organization && j.organization.id, error: j.error };
}, { api: API, email: EMAIL, password: PASSWORD });
check("signed in", login.ok, { org: login.org, error: login.error });
if (!login.ok) { await browser.close(); process.exit(1); }
const ORG = login.org;

// --- enable the personal Channels left-column preference ---------------------
const preferenceState = await page.evaluate(async ({ api }) => {
  const url = `${api}/v1/platform/me/preferences`;
  const prior = await fetch(url, { credentials: "include" }).then((r) => r.json());
  const csrf = decodeURIComponent((document.cookie.match(/fm_platform_session_csrf=([^;]+)/) || [])[1] || "");
  const response = await fetch(url, {
    method: "PATCH", credentials: "include",
    headers: { "Content-Type": "application/json", "X-Platform-CSRF": csrf },
    body: JSON.stringify({ left_column_channels: true, left_column_default_mode: "channels" })
  });
  const saved = await response.json();
  return { prior: prior.preferences, enabled: response.ok && saved.preferences?.left_column_channels === true };
}, { api: API });
check("personal Channels left-column preference enabled", preferenceState.enabled);
if (!preferenceState.enabled) { await browser.close(); process.exit(1); }

// --- load the portal: Channels tab appears, standalone app icon does not -----
await page.goto(WEB + "/portal/index.php", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sidebar.channels-tab-enabled #sidebarChannelsTab", { state: "visible", timeout: 60000 });
const tabRow = await page.evaluate(() => {
  const tab = document.getElementById("sidebarChannelsTab");
  const r = tab.getBoundingClientRect();
  const standalone = Array.from(document.querySelectorAll("#sidebarLinks .fm-link"))
    .some((l) => /channels/i.test(l.textContent));
  return { w: Math.round(r.width), h: Math.round(r.height), standalone };
});
check("Channels mode tab is visible in the left column", tabRow.w > 40 && tabRow.h > 20, tabRow);
check("standalone Channels app icon removed from the app list", !tabRow.standalone);

// Remember which app panel is active underneath before any channel opens.
const baselineTab = await page.evaluate(() => document.querySelector("#mainPanels .tab-panel.active, #mainPanels [id^=tab_].active")?.id || "");

// --- switch the rail to Channels with a real click ---------------------------
await page.click("#sidebarChannelsTab");
await page.waitForSelector("#sidebarChannelsList .fm-ch--list .fm-ch-sidebar", { timeout: 30000 });
const railInfo = await page.evaluate(() => {
  const rail = document.querySelector("#sidebarChannelsList .fm-ch-sidebar");
  const r = rail.getBoundingClientRect();
  const sidebar = document.getElementById("mainSidebar").getBoundingClientRect();
  return {
    w: Math.round(r.width), h: Math.round(r.height),
    insideSidebar: r.left >= sidebar.left && r.right <= sidebar.right + 1,
    items: document.querySelectorAll("#sidebarChannelsList .fm-ch-side-item").length,
    appsPanelHidden: document.getElementById("sidebarAppsPanel").hidden
  };
});
check("channel rail renders inside the global left column", railInfo.w > 120 && railInfo.h > 100 && railInfo.insideSidebar, railInfo);

// --- create a scratch channel through the rail's + button --------------------
const chName = `e2e-pop-${Date.now().toString(36)}`;
await page.waitForSelector("#sidebarChannelsList .fm-ch-side-head", { timeout: 30000 });
await page.evaluate(() => {
  const heads = Array.from(document.querySelectorAll("#sidebarChannelsList .fm-ch-side-head"));
  const chHead = heads.find((h) => /channels/i.test(h.textContent));
  chHead.querySelector("button").click();
});
await page.waitForSelector(".fm-ch-modal [data-field=name]", { timeout: 15000 });
await page.fill(".fm-ch-modal [data-field=name]", chName);
await page.click(".fm-ch-modal-foot .fm-ch-btn.primary");

// Creating the channel selects it, which in list mode must pop the overlay.
await page.waitForSelector(".fm-channels-overlay:not([hidden])", { timeout: 30000 });
await page.waitForTimeout(600); // let the pop-in transition finish
const overlayGeom = await page.evaluate(() => {
  const card = document.querySelector(".fm-channels-overlay-card");
  const r = card.getBoundingClientRect();
  const main = document.querySelector("main.main").getBoundingClientRect();
  const topbar = document.getElementById("platformTopbar");
  const topbarH = topbar && topbar.offsetParent ? topbar.getBoundingClientRect().height : 0;
  const cs = getComputedStyle(card);
  const composer = document.querySelector(".fm-channels-overlay .fm-ch-composer textarea");
  const probe = document.elementFromPoint(main.left + main.width / 2, main.top + topbarH + (main.height - topbarH) / 2);
  return {
    x: Math.round(r.x - main.left), y: Math.round(r.y - (main.top + topbarH)),
    w: Math.round(r.width), mw: Math.round(main.width),
    h: Math.round(r.height), mh: Math.round(main.height - topbarH),
    opacity: cs.opacity, transform: cs.transform,
    hasComposer: !!composer,
    probeInOverlay: probe ? !!probe.closest(".fm-channels-overlay") : false,
    title: document.querySelector(".fm-channels-overlay-title")?.textContent.trim() || ""
  };
});
check("overlay pops over the main area (fills space under the topbar)",
  overlayGeom.x === 0 && overlayGeom.y === 0 && Math.abs(overlayGeom.w - overlayGeom.mw) <= 1 && Math.abs(overlayGeom.h - overlayGeom.mh) <= 1,
  overlayGeom);
check("pop-in animation settled (opacity 1, no residual transform)", overlayGeom.opacity === "1" && (overlayGeom.transform === "none" || /matrix\(1, 0, 0, 1, 0, 0\)/.test(overlayGeom.transform)));
check("overlay paints on top of the app underneath", overlayGeom.probeInOverlay);
check("overlay header shows the channel name", overlayGeom.title.includes(chName), { title: overlayGeom.title });

// --- send a message with real typing ----------------------------------------
await page.click(".fm-channels-overlay .fm-ch-composer textarea");
const msgText = `popover smoke ${Date.now().toString(36)}`;
await page.keyboard.type(msgText);
await page.keyboard.press("Enter");
await page.waitForFunction((t) => Array.from(document.querySelectorAll(".fm-channels-overlay .fm-ch-msg-body"))
  .some((n) => n.textContent.includes(t)), msgText, { timeout: 15000 });
check("message typed in the overlay composer appears in the conversation", true, { text: msgText });

// Background app must still be mounted while the overlay is open.
const stillMounted = await page.evaluate((id) => !!(id && document.getElementById(id)), baselineTab);
check("previous app stays mounted underneath the overlay", baselineTab === "" || stillMounted, { baselineTab });

// --- close with the back button ----------------------------------------------
await page.click(".fm-channels-overlay-back");
await page.waitForFunction(() => {
  const root = document.querySelector(".fm-channels-overlay");
  return root && root.hidden;
}, undefined, { timeout: 5000 });
const afterClose = await page.evaluate((id) => {
  const main = document.querySelector("main.main").getBoundingClientRect();
  const probe = document.elementFromPoint(main.left + main.width / 2, main.top + main.height / 2);
  return {
    probeInOverlay: probe ? !!probe.closest(".fm-channels-overlay") : false,
    baselineVisible: id ? !!document.getElementById(id)?.offsetParent : null,
    activeRailItems: document.querySelectorAll("#sidebarChannelsList .fm-ch-side-item.active").length
  };
}, baselineTab);
check("back button pops the overlay out and reveals the app underneath", !afterClose.probeInOverlay && afterClose.baselineVisible !== false, afterClose);
check("rail highlight clears when the conversation closes", afterClose.activeRailItems === 0, afterClose);

// --- reopen from the rail (steady-state open path) ---------------------------
await page.click(`#sidebarChannelsList .fm-ch-side-item:has-text("${chName}")`);
await page.waitForSelector(".fm-channels-overlay.open", { timeout: 15000 });
await page.waitForFunction((t) => Array.from(document.querySelectorAll(".fm-channels-overlay .fm-ch-msg-body"))
  .some((n) => n.textContent.includes(t)), msgText, { timeout: 15000 });
check("reopening from the rail restores the conversation with its history", true);

// --- actively picking an app closes the conversation overlay -----------------
await page.click("#sidebarAppsTab");
const appPick = await page.evaluate(() => {
  const link = Array.from(document.querySelectorAll("#sidebarLinks .fm-link")).find((l) => l.offsetParent);
  if (!link) return null;
  return { tab: link.dataset.tab, label: link.textContent.trim() };
});
await page.click(`#sidebarLinks .fm-link[data-tab="${appPick.tab}"]`);
await page.waitForFunction(() => {
  const root = document.querySelector(".fm-channels-overlay");
  return root && root.hidden;
}, undefined, { timeout: 5000 });
const afterAppPick = await page.evaluate((tab) => {
  const main = document.querySelector("main.main").getBoundingClientRect();
  const probe = document.elementFromPoint(main.left + main.width / 2, main.top + main.height / 2);
  const panel = document.getElementById(`tab_${tab}`);
  return {
    probeInOverlay: probe ? !!probe.closest(".fm-channels-overlay") : false,
    panelActive: !!panel?.classList.contains("active"),
    panelVisible: !!panel?.offsetParent,
    railActive: document.querySelectorAll("#sidebarChannelsList .fm-ch-side-item.active").length
  };
}, appPick.tab);
check("clicking an app closes the open conversation and shows that app",
  !afterAppPick.probeInOverlay && afterAppPick.panelActive && afterAppPick.panelVisible,
  { picked: appPick, ...afterAppPick });
check("rail highlight clears after an app click closes the conversation", afterAppPick.railActive === 0);

// --- cleanup: archive scratch channel, restore prior flag values -------------
const cleanup = await page.evaluate(async ({ org, name, prior }) => {
  const out = { archived: false, restored: false };
  try {
    const data = await window.ChannelsAPI.channels.list(org);
    const scratch = (data.channels || []).find((c) => c.name === name);
    if (scratch) { await window.ChannelsAPI.channels.archive(org, scratch.id); out.archived = true; }
  } catch (e) { out.archiveError = String(e && e.message); }
  try {
    const csrf = decodeURIComponent((document.cookie.match(/fm_platform_session_csrf=([^;]+)/) || [])[1] || "");
    await fetch(`${location.origin.replace(/:\d+$/, ":3101")}/v1/platform/me/preferences`, {
      method: "PATCH", credentials: "include",
      headers: { "Content-Type": "application/json", "X-Platform-CSRF": csrf },
      body: JSON.stringify({ left_column_channels: prior.left_column_channels, left_column_default_mode: prior.left_column_default_mode })
    });
    out.restored = true;
  } catch (e) { out.restoreError = String(e && e.message); }
  return out;
}, { org: ORG, name: chName, prior: preferenceState.prior });
check("cleanup: scratch channel archived and preference restored", cleanup.archived && cleanup.restored, cleanup);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
