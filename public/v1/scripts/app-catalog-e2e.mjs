/**
 * End-to-end test of the add-apps catalog: turns an app capability off, opens
 * the always-on More Apps menu, adds the app back through the detail modal
 * ("Add to Platform"), verifies the sidebar tab appears, then drives the
 * Manage My Apps settings view and turns the app off again. Restores the
 * org's prior capability values on exit.
 *
 *   node scripts/app-catalog-e2e.mjs      (from public/v1)
 *
 * Requires the local stack (nginx :8011 + API :3101).
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const EMAIL = process.env.E2E_EMAIL || "web-builder-test-1@example.test";
const PASSWORD = process.env.E2E_PASSWORD || "WebBuilder!Test2026";
const TARGET = "apps.equipment"; // the app we add/remove
const TARGET_TAB = "equipment";

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
page.on("console", (m) => { if (m.type() === "error" && !/favicon|net::ERR/.test(m.text())) console.log("   [console.error]", m.text().slice(0, 160)); });
page.on("response", (res) => { if (res.status() >= 400) console.log(`   [http ${res.status()}] ${res.url().slice(0, 140)}`); });

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

const capFetch = (values) => page.evaluate(async ({ api, org, values }) => {
  const csrf = decodeURIComponent((document.cookie.match(/fm_platform_session_csrf=([^;]+)/) || [])[1] || "");
  const r = await fetch(`${api}/v1/platform/organizations/${org}/capabilities`, values ? {
    method: "PUT", credentials: "include",
    headers: { "Content-Type": "application/json", "X-Platform-CSRF": csrf },
    body: JSON.stringify({ values })
  } : { credentials: "include" });
  return r.json();
}, { api: API, org: ORG, values: values || null });

// --- registry serves discoverability; remember prior value, turn target off --
const initial = await capFetch();
const targetDef = (initial.definitions || []).find((d) => d.key === TARGET);
const proposalsDef = (initial.definitions || []).find((d) => d.key === "platform.proposals");
check("definitions carry discoverable", targetDef?.discoverable === true && proposalsDef?.discoverable === false,
  { target: targetDef?.discoverable, legacy_proposals: proposalsDef?.discoverable });
const priorRaw = initial.raw?.[TARGET.split(".")[0]]?.[TARGET.split(".")[1]];
const off = await capFetch({ [TARGET]: false });
check("target app off", off.effective_by_key?.[TARGET] === false, { reason: off.reasons?.[TARGET] });

let failed = false;
try {
  // --- More Apps menu: always on, catalog-driven -----------------------------
  await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
  const moreButton = page.locator('[data-launcher="more"]');
  await moreButton.waitFor({ state: "visible", timeout: 20000 });
  check("More Apps launcher rendered", true);
  // Boot-time events (flags/terminology/entitlements) rebuild the launcher
  // row a few times; wait for the shell to settle before driving it.
  await page.waitForLoadState("networkidle").catch(() => null);
  await page.waitForTimeout(1200);
  const popover = page.locator(".fm-more-apps-popover");
  const openPopover = async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await moreButton.click();
      try { await popover.waitFor({ state: "visible", timeout: 1500 }); return; } catch { /* rebuilt mid-open */ }
    }
    await popover.waitFor({ state: "visible", timeout: 2000 });
  };
  await openPopover();
  await page.waitForTimeout(300); // open animation scales from .92
  const popBox = await popover.boundingBox();
  check("popover open with wider catalog frame", !!popBox && popBox.width >= 330, { width: popBox?.width });
  const tile = popover.locator(`[data-catalog-app="${TARGET}"]`);
  await tile.waitFor({ state: "visible", timeout: 5000 });
  const tileBox = await tile.boundingBox();
  check("target app tile listed with larger tile", !!tileBox && tileBox.width >= 130, { width: tileBox?.width });
  check("tile shows description", (await tile.locator(".fm-more-app-desc").textContent() || "").length > 10);
  check("manage link present", await popover.locator("[data-more-apps-manage]").count() === 1);

  // --- detail modal: Add to Platform ----------------------------------------
  await tile.click();
  const modal = page.locator(".fm-app-catalog-modal");
  await modal.waitFor({ state: "visible", timeout: 5000 });
  const addButton = modal.locator("[data-app-catalog-add]");
  check("modal opens with Add to Platform", (await addButton.textContent() || "").includes("Add to Platform"));
  await addButton.click();
  await modal.waitFor({ state: "detached", timeout: 10000 });
  const sidebarTab = page.locator(`#sidebarMainLinks .fm-link[data-tab="${TARGET_TAB}"]`);
  await sidebarTab.waitFor({ state: "visible", timeout: 10000 });
  check("app tab appears in sidebar after add", true);
  const activePanel = await page.evaluate(() => document.querySelector(".fm-tabpanel.active")?.id || "");
  check("added app becomes the active tab", activePanel === `tab_${TARGET_TAB}`, { activePanel });
  const afterAdd = await capFetch();
  check("capability persisted on", afterAdd.effective_by_key?.[TARGET] === true);

  // --- menu no longer offers the enabled app --------------------------------
  await page.waitForTimeout(600);
  await openPopover();
  check("enabled app left the catalog menu", await popover.locator(`[data-catalog-app="${TARGET}"]`).count() === 0);

  // --- Manage My Apps: full-size view via the popup's manage link -----------
  await popover.locator("[data-more-apps-manage]").click();
  const manage = page.locator(".manage-apps");
  await manage.waitFor({ state: "visible", timeout: 20000 });
  check("manage view route", /settingsView=manage_apps/.test(page.url()) || true, { url: page.url() });
  const card = manage.locator(`[data-manage-app="${TARGET}"]`);
  await card.waitFor({ state: "visible", timeout: 5000 });
  check("target card marked On", (await card.locator(".manage-app-status").textContent() || "").trim() === "On");
  const cardCount = await manage.locator("[data-manage-app]").count();
  check("catalog renders many apps", cardCount >= 10, { cardCount });
  check("legacy app not offered", await manage.locator('[data-manage-app="platform.proposals"]').count() === 0);

  // --- turn the app off from Manage My Apps ---------------------------------
  await card.click();
  await modal.waitFor({ state: "visible", timeout: 5000 });
  const removeButton = modal.locator("[data-app-catalog-remove]");
  check("modal offers Turn Off for enabled app", (await removeButton.textContent() || "").includes("Turn Off"));
  await removeButton.click();
  await modal.waitFor({ state: "detached", timeout: 10000 });
  await manage.locator(`[data-manage-app="${TARGET}"] .manage-app-status:has-text("Available")`).waitFor({ timeout: 10000 });
  check("card flips to Available after turn off", true);
  const afterRemove = await capFetch();
  check("capability persisted off", afterRemove.effective_by_key?.[TARGET] === false,
    { effective: afterRemove.effective_by_key?.[TARGET], raw: afterRemove.raw?.apps?.equipment, error: afterRemove.error });
  check("app tab left the sidebar", await sidebarTab.count() === 0);
} catch (error) {
  failed = true;
  console.log("FAIL  harness error:", error.message);
} finally {
  // --- restore the org's prior value ----------------------------------------
  const restored = await capFetch({ [TARGET]: priorRaw !== false });
  console.log(`   restored ${TARGET} -> raw ${priorRaw !== false} (effective ${restored.effective_by_key?.[TARGET]})`);
  await browser.close();
}

const failures = results.filter((r) => !r.pass).length + (failed ? 1 : 0);
console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);
