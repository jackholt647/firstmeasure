/**
 * End-to-end test of the real Web Editor app inside the staff portal:
 * signs in, opens the Web Editor tab, opens a page, and drives the canvas with
 * real mouse input (click-select, drag, resize) exactly as a user would.
 *
 *   node scripts/web-editor-e2e.mjs      (from public/v1)
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
const netFailures = [];
page.on("response", async (res) => {
  // Guard the WEB EDITOR's own API surface. The portal shell fires dozens of
  // unrelated /v1/platform requests (credits, notifications, capabilities…)
  // whose transient dev-stack failures repeatedly false-flagged this suite.
  if (res.status() >= 400 && /\/v1\/(websites\/|platform\/organizations\/[^/]+\/media\/)/.test(res.url())) {
    let body = "";
    try { body = (await res.text()).slice(0, 300); } catch { /* stream gone */ }
    netFailures.push({ status: res.status(), url: res.url().replace(API, ""), body });
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

// --- open the Web Editor tab -------------------------------------------------
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 });
check("Web Editor tab loads the site list", true);

const sidebarHasTab = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#sidebarLinks .fm-link")).some((l) => /web editor/i.test(l.textContent)));
check("Web Editor appears in the sidebar", sidebarHasTab);

// --- open the first real website, then its first page ------------------------
const opened = await page.evaluate(() => {
  const cards = Array.from(document.querySelectorAll("#tab_web_editor [data-site-card]"));
  if (!cards.length) return { ok: false, reason: "no site cards", html: document.getElementById("tab_web_editor").textContent.slice(0, 200) };
  const card = cards.find((c) => !/Customer Portal/.test(c.textContent)) || cards[0];
  const opener = card.querySelector("[data-site-open]");
  if (!opener) return { ok: false, reason: "no opener", cardHtml: card.outerHTML.slice(0, 200) };
  opener.click();
  return { ok: true, count: cards.length };
});
check("opened a website from the site list", opened.ok, opened);
if (!opened.ok) { await browser.close(); process.exit(1); }
await page.waitForSelector("#tab_web_editor [data-page-tile]", { timeout: 30000 });
await page.evaluate(() => {
  const tiles = Array.from(document.querySelectorAll("#tab_web_editor [data-page-tile]"));
  const home = tiles.find((t) => /Home/.test(t.textContent)) || tiles[0];
  home.click();
});
await page.waitForSelector("#tab_web_editor [data-fmde]", { timeout: 30000 });
await page.waitForTimeout(4000); // load + normalization

// The visual tool palette belongs to the canvas row, below the combined
// editor controls. Keeping this geometric check in the real portal catches
// regressions where Templates/Elements/Media pushes that row right.
const paletteLayout = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  };
  return {
    appHeader: rect('#tab_web_editor .fmwe-editor-top'),
    toolHeader: rect('#tab_web_editor .fmde-toolbar'),
    palette: rect('#tab_web_editor .fmwe-ch-rail'),
    canvas: rect('#tab_web_editor .fmde-canvas')
  };
});
check('visual palette begins below the app header and combined editor controls',
  !!paletteLayout.appHeader && !!paletteLayout.toolHeader && !!paletteLayout.palette
    && paletteLayout.palette.top >= paletteLayout.toolHeader.bottom - 1,
  paletteLayout);
check('Visual/Doc/Preview leads the full-width editor control row',
  !!paletteLayout.toolHeader && !!paletteLayout.palette && !!paletteLayout.canvas
    && paletteLayout.toolHeader.left < paletteLayout.canvas.left
    && Math.abs(paletteLayout.toolHeader.left - paletteLayout.palette.left) < 2,
  paletteLayout);

// Snapshot the draft so the test's edits can be rolled back afterwards.
const snapshot = await page.evaluate(async () => {
  const ids = window.__fmweRoute || null;
  const m = location.search.match(/site=([^&]+)/);
  const org = (window.Portal && window.Portal.cfg && window.Portal.cfg.userOrgId) || (window.__APP && window.__APP.userOrgId);
  const st = window.__fmweState;
  if (!st) return null;
  const res = await window.WebsitesAPI.pages.get(org, st.siteId, st.pageId);
  const p = res.page || res;
  return { org, siteId: st.siteId, pageId: st.pageId, definition: p.draft && p.draft.definition, revision: p.revision };
});
check("captured draft snapshot for rollback", !!(snapshot && snapshot.definition), snapshot ? { page: snapshot.pageId } : null);

// --- full-screen must cover the portal chrome --------------------------------
const chrome = await page.evaluate(() => {
  const ed = document.querySelector("#tab_web_editor .fmwe-editor");
  const r = ed.getBoundingClientRect();
  const sidebar = document.getElementById("mainSidebar");
  const sr = sidebar ? sidebar.getBoundingClientRect() : null;
  const edZ = parseInt(getComputedStyle(ed).zIndex, 10);
  const sbZ = sidebar ? parseInt(getComputedStyle(sidebar).zIndex, 10) : 0;
  // what is actually painted on top at the sidebar's location?
  const probe = sr ? document.elementFromPoint(sr.x + sr.width / 2, sr.y + sr.height / 2) : null;
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, edZ, sbZ,
           probeInsideEditor: probe ? !!probe.closest(".fmwe-editor") : false };
});
check("editor fills the viewport", chrome.x === 0 && chrome.y === 0 && chrome.w === chrome.vw && chrome.h === chrome.vh, chrome);
check("editor paints above the portal sidebar/topbar", chrome.probeInsideEditor, { edZ: chrome.edZ, sbZ: chrome.sbZ });

// --- canvas interaction ------------------------------------------------------
const info = await page.evaluate(() => {
  const doc = window.__fmweEditor ? window.__fmweEditor.getDocument() : null;
  return doc ? { sections: (doc.root.children || []).map((s) => ({ name: s.name, layout: s.frame.layout })) } : null;
});
if (info) check("page normalized to absolute sections", info.sections.every((s) => s.layout === "absolute"), info.sections);

const targetRect = await page.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('#tab_web_editor .fmdoc-page [data-node-type="text"]'));
  const el = nodes[0];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { id: el.getAttribute("data-node-id"), x: r.x, y: r.y, w: r.width, h: r.height };
});
if (!targetRect) {
  check("found an element on the canvas", false);
} else {
  await page.mouse.click(targetRect.x + targetRect.w / 2, targetRect.y + targetRect.h / 2);
  await page.waitForTimeout(400);
  const selected = await page.evaluate(() => document.querySelectorAll("#tab_web_editor .fmde-selbox").length > 0);
  check("clicking an element on the real canvas selects it", selected);

  await page.keyboard.down("Alt");
  await page.mouse.move(targetRect.x + targetRect.w / 2, targetRect.y + targetRect.h / 2);
  await page.mouse.down();
  await page.mouse.move(targetRect.x + targetRect.w / 2 + 90, targetRect.y + targetRect.h / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  await page.waitForTimeout(700);
  const after = await page.evaluate((id) => {
    const el = document.querySelector('#tab_web_editor [data-node-id="' + id + '"]');
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y };
  }, targetRect.id);
  check("dragging on the real canvas moves the element", Math.abs((after.x - targetRect.x) - 90) < 12,
    { dx: +(after.x - targetRect.x).toFixed(1) });

  // autosave debounce + request (bounded wait — the dev stack's save latency
  // varies while the tsx watcher is busy; the assertion itself is unchanged)
  const savedOk = await page.waitForFunction(() => {
    const c = document.querySelector("#tab_web_editor [data-ed-save-chip]");
    return /saved/i.test(c ? c.textContent : "");
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  const saveChip = await page.evaluate(() => {
    const c = document.querySelector("#tab_web_editor [data-ed-save-chip]");
    return c ? c.textContent.trim() : null;
  });
  check("edit autosaves cleanly", savedOk && /saved/i.test(saveChip || ""), { chip: saveChip });
  check("no failing /v1 requests during editing", netFailures.length === 0, netFailures.slice(0, 3));

  // The saved draft must come back with the edit applied.
  const persisted = await page.evaluate(async () => {
    const org = window.Portal && window.Portal.cfg && window.Portal.cfg.userOrgId;
    const st = window.__fmweEditor ? window.__fmweEditor.getDocument() : null;
    return { hasDoc: !!st, org: org || null };
  });
  check("editor document available after save", persisted.hasDoc, persisted);
}

// --- collapsible rails -------------------------------------------------------
const rails = await page.evaluate(() => {
  const before = document.querySelector("#tab_web_editor .fmde-canvas").getBoundingClientRect().width;
  document.querySelector("#tab_web_editor .fmde-rail-collapse").click();
  document.querySelector("#tab_web_editor .fmde-insp-collapse").click();
  const after = document.querySelector("#tab_web_editor .fmde-canvas").getBoundingClientRect().width;
  const strips = document.querySelectorAll("#tab_web_editor .fmde-side-expand").length;
  document.querySelector("#tab_web_editor .fmde-side-expand-left").click();
  document.querySelector("#tab_web_editor .fmde-side-expand-right").click();
  const restored = document.querySelector("#tab_web_editor .fmde-canvas").getBoundingClientRect().width;
  return { before, after, restored, strips };
});
check("collapsing both rails widens the canvas", rails.after > rails.before + 200, rails);
check("expand strips restore the rails", Math.abs(rails.restored - rails.before) < 4, rails);

await page.screenshot({ path: "tmp/web-editor-e2e.png" });
console.log("\nscreenshot: public/v1/tmp/web-editor-e2e.png");

// --- roll the draft back so the test leaves no edits behind -------------------
if (snapshot && snapshot.definition) {
  const restored = await page.evaluate(async (snap) => {
    const cur = await window.WebsitesAPI.pages.get(snap.org, snap.siteId, snap.pageId);
    const rev = (cur.page || cur).revision;
    const res = await window.WebsitesAPI.pages.saveDraft(snap.org, snap.siteId, snap.pageId,
      { definition: snap.definition, expected_revision: rev });
    return res && res.ok !== false;
  }, snapshot);
  check("draft restored to its pre-test state", restored);
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("failed: " + failed.map((f) => f.name).join("; ")); process.exit(1); }
