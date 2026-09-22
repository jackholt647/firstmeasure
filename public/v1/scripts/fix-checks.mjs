/**
 * Drives the 2026-07-29 game-breaker fixes end to end in the real portal:
 *  - images render in the editor canvas (media ref -> URL passthrough)
 *  - mobile-preview icon actually draws a glyph
 *  - "Portal frame" previews the PAGE in portal chrome (not the editor)
 *  - first publish auto-enables + becomes a portal tab (one switch)
 *  - status chips are unambiguous (Live / Hidden, never Live+Off)
 *  - custom portal pages render full height (no clipped scroll box)
 *
 *   node scripts/fix-checks.mjs      (from public/v1; stack on :8011/:3101)
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const EMAIL = process.env.E2E_EMAIL || "web-builder-test-1@example.test";
const PASSWORD = process.env.E2E_PASSWORD || "WebBuilder!Test2026";
const PORTAL_UUID = process.env.PORTAL_UUID || "afcfd0ab-4487-4b8a-8ae7-d3fd0976336c";
const PAGE_TITLE = "Fix Check " + Math.random().toString(36).slice(2, 7);

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
  if (res.status() >= 400 && /\/v1\/(websites|platform\/organizations)/.test(res.url())) {
    let body = ""; try { body = (await res.text()).slice(0, 180); } catch { /* gone */ }
    console.log(`   [http ${res.status()}] ${res.url().replace(API, "")} :: ${body}`);
  }
});

// ---- sign in ----------------------------------------------------------------
await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
const login = await page.evaluate(async ({ api, email, password }) => {
  const r = await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, org: j.organization && j.organization.id };
}, { api: API, email: EMAIL, password: PASSWORD });
check("signed in", login.ok, login);
if (!login.ok) { await browser.close(); process.exit(1); }
const ORG = login.org;

// ---- create a fresh portal-site page via the API ----------------------------
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 });
const setup = await page.evaluate(async ({ org, title }) => {
  const sites = await window.WebsitesAPI.sites.list(org);
  const list = sites.sites || sites;
  const portalSite = list.find((s) => (s.site_kind || (s.data && s.data.site_kind)) === "customer_portal") || list.find((s) => /portal/i.test(s.name || ""));
  if (!portalSite) return { ok: false, reason: "no portal site" };
  const created = await window.WebsitesAPI.pages.create(org, portalSite.id, { title });
  const p = created.page || created;
  return { ok: !!p.id, siteId: portalSite.id, pageId: p.id, enabled: p.enabled, nav: p.nav };
}, { org: ORG, title: PAGE_TITLE });
check("created a portal-site test page (draft, not yet visible)", setup.ok && setup.enabled === false, setup);
if (!setup.ok) { await browser.close(); process.exit(1); }

// ---- open it in the editor --------------------------------------------------
await page.evaluate((siteId) => {
  const cards = Array.from(document.querySelectorAll("#tab_web_editor [data-site-card]"));
  const card = cards.find((c) => c.getAttribute("data-site-card") === siteId);
  card.querySelector("[data-site-open]").click();
}, setup.siteId);
await page.waitForSelector(`#tab_web_editor [data-page-tile="${setup.pageId}"]`, { timeout: 30000 });
await page.click(`#tab_web_editor [data-page-tile="${setup.pageId}"]`);
await page.waitForSelector("#tab_web_editor [data-fmde]", { timeout: 30000 });
await page.waitForTimeout(3000);

// ---- mobile preview icon draws a real glyph ---------------------------------
const icon = await page.evaluate(() => {
  const i = document.querySelector('#tab_web_editor [data-ed-device="mobile"] i');
  if (!i) return { found: false };
  const cs = getComputedStyle(i, "::before");
  return { found: true, cls: i.className, content: cs.content, family: cs.fontFamily };
});
check("mobile preview icon renders a glyph", icon.found && icon.content && icon.content !== "none" && icon.content !== '""',
  { cls: icon.cls, content: icon.content });

const consolidatedControls = await page.evaluate(() => {
  const scope = document.querySelector('#tab_web_editor');
  const toolbar = scope.querySelector('.fmde-toolbar');
  const mobile = toolbar?.querySelector('[data-ed-device="mobile"]');
  const desktop = toolbar?.querySelector('[data-ed-device="desktop"]');
  const webControls = toolbar?.querySelector('[data-ed-web-controls]');
  const publish = toolbar?.querySelector('[data-ed-publish]');
  const history = Array.from(scope.querySelectorAll('.fmde-version-history-btn'));
  const xs = [webControls, mobile, desktop, publish, history[0]].map((el) => el?.getBoundingClientRect().left || 0);
  return {
    topActions: scope.querySelectorAll('.fmwe-editor-top .fmwe-editor-actions').length,
    legacyModes: scope.querySelectorAll('[data-ed-mode]').length,
    histories: history.length,
    controls: [!!webControls, !!mobile, !!desktop, !!publish, history.length === 1],
    webControlsLabel: webControls?.textContent?.trim(),
    webControlsAria: webControls?.getAttribute('aria-label'),
    gutters: webControls && mobile && desktop && publish && history[0] ? {
      webToMobile: mobile.getBoundingClientRect().left - webControls.getBoundingClientRect().right,
      desktopToPublish: publish.getBoundingClientRect().left - desktop.getBoundingClientRect().right,
      publishToHistory: history[0].getBoundingClientRect().left - publish.getBoundingClientRect().right
    } : null,
    ordered: xs.every((x, index) => index === 0 || x >= xs[index - 1])
  };
});
check("web controls live once in the main bar in Web controls / device / Publish / History order",
  consolidatedControls.topActions === 0 && consolidatedControls.legacyModes === 0 && consolidatedControls.histories === 1
    && consolidatedControls.controls.every(Boolean) && consolidatedControls.ordered
    && consolidatedControls.webControlsLabel === '' && consolidatedControls.webControlsAria === 'Web page settings'
    && Object.values(consolidatedControls.gutters || {}).every((gap) => gap >= 14),
  consolidatedControls);

await page.click('#tab_web_editor [data-ed-web-controls]');
const webPageSettings = await page.evaluate(() => ({
  title: document.querySelector('.fmwe-modal-back .fmwe-modal h2')?.textContent?.trim(),
  menu: !!document.querySelector('[data-fmwe-web-controls-menu]')
}));
check("the globe opens Web page settings directly without a delete/discard menu",
  webPageSettings.title === 'Web page settings' && !webPageSettings.menu, webPageSettings);
await page.click('.fmwe-modal-back .fmwe-modal-close');

// ---- upload an image and insert it — must RENDER in the editor --------------
const inserted = await page.evaluate(async ({ org }) => {
  const cnv = document.createElement("canvas");
  cnv.width = 220; cnv.height = 140;
  const g = cnv.getContext("2d");
  g.fillStyle = "#0e9f6e"; g.fillRect(0, 0, 220, 140);
  g.fillStyle = "#fff"; g.font = "bold 26px sans-serif"; g.fillText("IMG", 80, 80);
  const blob = await new Promise((r) => cnv.toBlob(r, "image/png"));
  const file = new File([blob], "fix-check.png", { type: "image/png" });
  const up = await window.PlatformAPI.media.upload(org, file, { ownerType: "website_page", ownerId: "fix-check", collection: "websites" });
  const item = (up && (up.media || up.item)) || up;
  const mediaId = item.id || item.media_id;
  if (!mediaId) return { ok: false, reason: "no media id", raw: JSON.stringify(up).slice(0, 200) };
  const doc = window.__fmweEditor.getDocument();
  const section = doc.root.children[0];
  const node = window.FMDocModel.createNode("image", {
    frame: { x: 40, y: 30, w: 165, h: 105, z: 5, layout: "absolute" },
    props: { media: { media_id: mediaId, variant: "original" }, fit: "cover" }
  });
  const res = window.__fmweEditor.apply({ type: "node.insert", node, parent_id: section.id });
  return { ok: res.ok !== false, mediaId, nodeId: node.id };
}, { org: ORG });
check("image node inserted via the editor", inserted.ok, inserted);
await page.waitForTimeout(2500);
const imgState = await page.evaluate((nodeId) => {
  const el = document.querySelector(`#tab_web_editor [data-node-id="${nodeId}"]`);
  if (!el) return { found: false };
  const img = el.querySelector("img") || (el.tagName === "IMG" ? el : null);
  if (!img) return { found: true, img: false, html: el.outerHTML.slice(0, 160) };
  return { found: true, img: true, src: (img.currentSrc || img.src || "").slice(0, 90), loaded: img.complete && img.naturalWidth > 0 };
}, inserted.nodeId);
check("inserted image actually RENDERS in the editor canvas", imgState.img && imgState.loaded, imgState);

// ---- palette drag cancellation + real empty-image/section targets ----------
const emptySlot = await page.evaluate(() => {
  const doc = window.__fmweEditor.getDocument();
  const section = doc.root.children[0];
  const node = FMDocModel.createNode("image", { name: "Empty media slot", frame: { x: 260, y: 35, w: 145, h: 92, z: 8 }, props: { media: null, fit: "cover", alt: "" } });
  window.__fmweEditor.apply({ type: "node.insert", node, parent_id: section.id });
  return { id: node.id, sectionId: section.id };
});
await page.click('#tab_web_editor [data-ch-tab="media"]');
await page.waitForSelector(`#tab_web_editor [data-ch-up-item="${inserted.mediaId}"]`, { timeout: 20000 });
const dragPoints = await page.evaluate(({ mediaId, slotId, sectionId }) => {
  const thumb = document.querySelector(`[data-ch-up-item="${mediaId}"]`).getBoundingClientRect();
  const slot = document.querySelector(`[data-node-id="${slotId}"]`).getBoundingClientRect();
  const section = window.__fmweSectionRect(sectionId);
  return {
    from: { x: thumb.x + thumb.width / 2, y: thumb.y + thumb.height / 2 },
    slot: { x: slot.x + slot.width / 2, y: slot.y + slot.height / 2 },
    section: { x: section.right - 12, y: section.bottom - 12 }
  };
}, { mediaId: inserted.mediaId, slotId: emptySlot.id, sectionId: emptySlot.sectionId });

await page.mouse.move(dragPoints.from.x, dragPoints.from.y);
await page.mouse.down();
await page.mouse.move(dragPoints.slot.x, dragPoints.slot.y, { steps: 8 });
await page.keyboard.press("Escape");
await page.mouse.up();
await page.waitForTimeout(250);
const escapedDrag = await page.evaluate((slotId) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === slotId) { node = item; return; } (item.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return { empty: !node?.props?.media, ghost: !!document.querySelector('.fmwe-drag-ghost'), highlight: !!document.querySelector('.fmwe-fill-target,.fmwe-fill-target-box') };
}, emptySlot.id);
check("Escape aborts an active media drag", escapedDrag.empty && !escapedDrag.ghost && !escapedDrag.highlight, escapedDrag);

await page.mouse.move(dragPoints.from.x, dragPoints.from.y);
await page.mouse.down();
await page.mouse.move(dragPoints.slot.x, dragPoints.slot.y, { steps: 6 });
await page.mouse.move(dragPoints.from.x, dragPoints.from.y, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(250);
const trayAbort = await page.evaluate((slotId) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === slotId) { node = item; return; } (item.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return { empty: !node?.props?.media, ghost: !!document.querySelector('.fmwe-drag-ghost') };
}, emptySlot.id);
check("releasing a media drag back over the tray aborts it", trayAbort.empty && !trayAbort.ghost, trayAbort);

await page.mouse.move(dragPoints.from.x, dragPoints.from.y);
await page.mouse.down();
await page.mouse.move(dragPoints.slot.x, dragPoints.slot.y, { steps: 8 });
const emptyTargetHighlighted = await page.evaluate((slotId) => document.querySelector(`[data-node-id="${slotId}"]`)?.classList.contains('fmwe-fill-target') || false, emptySlot.id);
await page.mouse.up();
await page.waitForTimeout(450);
const filledSlot = await page.evaluate(({ slotId, mediaId }) => {
  let node = null;
  (function walk(item) { if (!item || node) return; if (item.id === slotId) { node = item; return; } (item.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return { type: node?.type, mediaId: node?.props?.media?.media_id, matches: node?.props?.media?.media_id === mediaId };
}, { slotId: emptySlot.id, mediaId: inserted.mediaId });
check("empty template image slots highlight and accept dropped media", emptyTargetHighlighted && filledSlot.type === "image" && filledSlot.matches, { highlighted: emptyTargetHighlighted, ...filledSlot });

await page.mouse.move(dragPoints.from.x, dragPoints.from.y);
await page.mouse.down();
await page.mouse.move(dragPoints.section.x, dragPoints.section.y, { steps: 8 });
const sectionHighlight = await page.evaluate(() => ({ sectionBox: !!document.querySelector('.fmwe-fill-target-box'), page: !!document.querySelector('.fmdoc-page.fmwe-fill-target') }));
await page.mouse.up();
await page.waitForTimeout(450);
const sectionFill = await page.evaluate(({ sectionId, mediaId }) => {
  const section = window.__fmweEditor.getDocument().root.children.find((item) => item.id === sectionId);
  return { type: section?.style?.fill?.type, mediaId: section?.style?.fill?.media?.media_id, matches: section?.style?.fill?.media?.media_id === mediaId };
}, { sectionId: emptySlot.sectionId, mediaId: inserted.mediaId });
check("website media drops highlight and fill the specific section, never the page wrapper", sectionHighlight.sectionBox && !sectionHighlight.page && sectionFill.matches, { highlight: sectionHighlight, fill: sectionFill });

// ---- autosave, then shared Preview replaces the old Live/portal-frame path --
await page.waitForFunction(() => /saved/i.test((document.querySelector("#tab_web_editor [data-ed-save-chip]") || {}).textContent || ""), null, { timeout: 15000 });
await page.getByRole('button', { name: 'Preview', exact: true }).click();
await page.waitForTimeout(1200);
const frame = await page.evaluate(() => {
  const canvas = document.querySelector("#tab_web_editor [data-ed-canvas]");
  return {
    previewMode: !!document.querySelector('#tab_web_editor .fmde-mode-preview'),
    page: !!canvas.querySelector('.fmdoc-page'),
    imgInPreview: (() => { const im = canvas.querySelector("img"); return !!(im && im.complete && im.naturalWidth > 0); })()
  };
});
check("shared Preview renders the web page", frame.previewMode && frame.page, frame);
check("image renders in shared Preview", frame.imgInPreview, frame);
await page.getByRole('button', { name: 'Visual', exact: true }).click();
await page.waitForTimeout(500);

// ---- publish via the UI: auto-enable + auto portal tab ----------------------
await page.click("#tab_web_editor [data-ed-publish]");
await page.waitForSelector(".fmwe-modal", { timeout: 10000 });
const confirmCopy = await page.evaluate(() => document.querySelector(".fmwe-modal").textContent.replace(/\s+/g, " ").trim());
check("first-publish copy explains the portal tab", /appear as a tab in your customer portal/i.test(confirmCopy), { copy: confirmCopy.slice(0, 140) });
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll(".fmwe-modal button")).find((b) => /publish v1/i.test(b.textContent));
  btn.click();
});
await page.waitForTimeout(3000);
const afterPublish = await page.evaluate(async ({ org, siteId, pageId }) => {
  // One retry: the local stack occasionally drops a request while the dev
  // server's watcher restarts.
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await window.WebsitesAPI.pages.get(org, siteId, pageId);
      const p = res.page || res;
      return { published: p.published_version, enabled: p.enabled, header: !!(p.nav && p.nav.header) };
    } catch (error) {
      if (attempt >= 2) return { error: String(error && error.message || error) };
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}, { ...setup, org: ORG });
check("publishing auto-enables the page and makes it a portal tab", afterPublish.published === 1 && afterPublish.enabled === true && afterPublish.header === true, afterPublish);

// ---- chips: Live when visible, Hidden when off — never both -----------------
const chipNow = await page.evaluate(() => (document.querySelector("#tab_web_editor .fmwe-chip") || {}).textContent || "");
check("editor chip reads Live after publish (no 'Off')", /live/i.test(chipNow) && !/off/i.test(chipNow), { chip: chipNow });
await page.evaluate(async ({ org, siteId, pageId }) => {
  const res = await window.WebsitesAPI.pages.get(org, siteId, pageId);
  const p = res.page || res;
  await window.WebsitesAPI.pages.patch(org, siteId, pageId, { enabled: false, nav: { ...(p.nav || {}), header: false }, expected_revision: p.revision });
}, { ...setup, org: ORG });
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 });
await page.evaluate((siteId) => {
  document.querySelector(`#tab_web_editor [data-site-card="${siteId}"] [data-site-open]`).click();
}, setup.siteId);
await page.waitForSelector(`#tab_web_editor [data-page-tile="${setup.pageId}"]`, { timeout: 30000 });
const hiddenChip = await page.evaluate((pageId) => {
  const tile = document.querySelector(`#tab_web_editor [data-page-tile="${pageId}"]`);
  return Array.from(tile.querySelectorAll(".fmwe-chip")).map((c) => c.textContent.trim()).join("|");
}, setup.pageId);
check("hidden page reads 'Hidden' — one chip, no Live+Off pairing", /hidden/i.test(hiddenChip) && !/live/i.test(hiddenChip) && !/\boff\b/i.test(hiddenChip), { chips: hiddenChip });

// list view: single "In portal" toggle for the portal site
const listView = await page.evaluate(() => {
  const listBtn = Array.from(document.querySelectorAll("#tab_web_editor [data-we-view]")).find((b) => b.querySelector(".fa-list"));
  listBtn.click();
  return new Promise((res) => setTimeout(() => {
    const heads = Array.from(document.querySelectorAll("#tab_web_editor table th")).map((t) => t.textContent.trim());
    res({ heads, portalToggles: document.querySelectorAll("#tab_web_editor [data-portal-toggle]").length,
          splitToggles: document.querySelectorAll("#tab_web_editor [data-enabled-toggle], #tab_web_editor [data-nav-toggle]").length });
  }, 800));
});
check("portal list view has ONE 'In portal' control (no separate Enabled)", listView.heads.includes("In portal") && !listView.heads.includes("Enabled") && listView.portalToggles > 0 && listView.splitToggles === 0, listView);

// flip it back on through that single toggle
await page.evaluate((pageId) => {
  const row = document.querySelector(`#tab_web_editor [data-page-row="${pageId}"]`);
  row.querySelector("[data-portal-toggle]").click();
}, setup.pageId);
await page.waitForTimeout(1800);
const reEnabled = await page.evaluate(async ({ org, siteId, pageId }) => {
  const res = await window.WebsitesAPI.pages.get(org, siteId, pageId);
  const p = res.page || res;
  return { enabled: p.enabled, header: !!(p.nav && p.nav.header) };
}, { ...setup, org: ORG });
check("single toggle re-enables page + portal tab together", reEnabled.enabled === true && reEnabled.header === true, reEnabled);

// ---- customer portal: tab appears, page renders FULL height -----------------
await page.goto(WEB + "/customer_portal/?id=" + PORTAL_UUID, { waitUntil: "domcontentloaded" });
await page.waitForFunction((title) =>
  Array.from(document.querySelectorAll(".cp-tabs button")).some((b) => b.textContent.trim() === title), PAGE_TITLE, { timeout: 30000 });
await page.evaluate((title) => {
  Array.from(document.querySelectorAll(".cp-tabs button")).find((b) => b.textContent.trim() === title).click();
}, PAGE_TITLE);
await page.waitForSelector(".cp-custom-page .fmdoc-page", { timeout: 30000 });
await page.waitForTimeout(2500); // image load + refit
const portalRender = await page.evaluate(() => {
  const stage = document.querySelector(".cp-custom-page");
  const pageEl = stage.querySelector(".fmdoc-page");
  const img = stage.querySelector("img");
  const cs = getComputedStyle(stage);
  return {
    stageH: stage.clientHeight, scrollH: stage.scrollHeight,
    clipped: stage.scrollHeight > stage.clientHeight + 2,
    overflowY: cs.overflowY,
    pageH: pageEl ? pageEl.getBoundingClientRect().height : 0,
    imgLoaded: !!(img && img.complete && img.naturalWidth > 0)
  };
});
check("portal page renders full height — no clipped scroll box", !portalRender.clipped && portalRender.overflowY !== "auto" && portalRender.overflowY !== "scroll", portalRender);
check("portal page shows real content height", portalRender.pageH > 120, { pageH: portalRender.pageH });
check("image renders on the customer portal", portalRender.imgLoaded, { imgLoaded: portalRender.imgLoaded });

// ---- cleanup ----------------------------------------------------------------
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 });
const cleaned = await page.evaluate(async ({ org, siteId, pageId }) => {
  try { await window.WebsitesAPI.pages.remove(org, siteId, pageId, {}); return true; } catch (e) { return String(e); }
}, { ...setup, org: ORG });
check("test page cleaned up", cleaned === true, cleaned === true ? undefined : { cleaned });

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("failed: " + failed.map((f) => f.name).join("; ")); process.exit(1); }
