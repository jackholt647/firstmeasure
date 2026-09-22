/**
 * Drives the Web Editor's Canva-style page-editor chrome end to end in the
 * real portal: far-left icon rail (7 tabs, full labels), animated slide-out
 * panels (templates / elements / media / text / brand / QR), the slim markup
 * dock, section-management chrome (mini-buttons + pill + popovers),
 * drag-from-panel inserts, media→image-fill drops, add-section pill, pages
 * strip, bottom bar and the PhotoMarkup session — plus a no-overlap geometry
 * audit across the whole template registry.
 *
 *   node scripts/web-editor-chrome.mjs      (from public/v1)
 *
 * Requires the local stack (nginx :8011 + tsx API :3101). Creates one scratch
 * page on the first public site and deletes it afterwards.
 */
import { chromium } from "playwright-core";
import { access } from "node:fs/promises";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const EMAIL = process.env.E2E_EMAIL || "web-builder-test-1@example.test";
const PASSWORD = process.env.E2E_PASSWORD || "WebBuilder!Test2026";
const PAGE_TITLE = "Chrome Check " + Math.random().toString(36).slice(2, 7);

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

// ---- scratch page on the first public site ----------------------------------
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor [data-site-card]", { timeout: 60000 });
const setup = await page.evaluate(async ({ org, title }) => {
  const sites = await window.WebsitesAPI.sites.list(org);
  const list = sites.sites || sites;
  const site = list.find((s) => (s.site_kind || "") === "public") || list.find((s) => !/portal/i.test(s.name || ""));
  if (!site) return { ok: false, reason: "no public site" };
  const created = await window.WebsitesAPI.pages.create(org, site.id, { title });
  const p = created.page || created;
  return { ok: !!p.id, siteId: site.id, pageId: p.id };
}, { org: ORG, title: PAGE_TITLE });
check("created a scratch page", setup.ok, setup);
if (!setup.ok) { await browser.close(); process.exit(1); }

// Seed real branding through the global PATCH API so the Brand Kit panel has
// saved colors to show (merged organization < global < branch, like
// settings/company.js).
const seeded = await page.evaluate(async ({ org }) => {
  try {
    await window.PlatformAPI.orgs.patchGlobal(org, { branding: { colors: { primary: "#123456" } } });
    return true;
  } catch (e) { return String(e); }
}, { org: ORG });
check("seeded branding.colors.primary via global PATCH", seeded === true, seeded === true ? undefined : { seeded });

// ---- open it in the editor --------------------------------------------------
// Reload the tab so the site list is fresh (the tsx watcher occasionally drops
// one request mid-restart), then wait for this site's card specifically.
await page.goto(WEB + "/portal/index.php?tab=web_editor", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#tab_web_editor .fmwe-shell", { timeout: 60000 });
let openedSite = false;
for (let attempt = 0; attempt < 30 && !openedSite; attempt += 1) {
  openedSite = await page.evaluate((siteId) => {
    const open = document.querySelector(`#tab_web_editor [data-site-card="${siteId}"] [data-site-open]`);
    if (open) { open.click(); return true; }
    document.querySelector("#tab_web_editor [data-we-retry]")?.click(); // dropped request mid watcher-restart
    return false;
  }, setup.siteId);
  if (!openedSite) await page.waitForTimeout(1000);
}
check("opened the scratch page's site", openedSite);
if (!openedSite) { await browser.close(); process.exit(1); }
await page.waitForSelector(`#tab_web_editor [data-page-tile="${setup.pageId}"]`, { timeout: 30000 });
await page.click(`#tab_web_editor [data-page-tile="${setup.pageId}"]`);
await page.waitForSelector("#tab_web_editor [data-fmde]", { timeout: 30000 });
await page.waitForSelector("#tab_web_editor [data-ch-rail]", { timeout: 15000 });
await page.waitForTimeout(3500); // mount + view-layout normalization

const doc = () => page.evaluate(() => window.__fmweEditor.getDocument());
const rootKids = async () => (await doc()).root.children;

// ---- 1. rail: exactly 7 tabs, real FA glyphs, labels fully visible ----------
const rail = await page.evaluate(() => {
  const expected = ["templates", "elements", "widgets", "media", "text", "brand", "markup"];
  const btns = Array.from(document.querySelectorAll("#tab_web_editor [data-ch-tab]"));
  const seen = btns.map((b) => b.dataset.chTab);
  const glyphs = btns.map((b) => {
    const i = b.querySelector("i");
    const content = i ? getComputedStyle(i, "::before").content : "none";
    return { tab: b.dataset.chTab, cls: i && i.className, ok: !!content && content !== "none" && content !== '""' };
  });
  const labels = btns.map((b) => {
    const span = b.querySelector("span");
    return {
      tab: b.dataset.chTab,
      text: span ? span.textContent : "",
      // Fully visible: no horizontal truncation (wrapping to two lines is
      // fine — "QR codes" may wrap) and never an ellipsis.
      fits: !!span && span.scrollWidth <= span.clientWidth + 1
        && getComputedStyle(span).textOverflow !== "ellipsis"
    };
  });
  const forbidden = btns.some((b) => /projects|apps|tools|timer/i.test(b.textContent));
  return { order: seen, expectedOrder: expected.join(",") === seen.join(","), glyphs, labels, forbidden };
});
check("rail renders exactly 7 tabs in order, including website Widgets", rail.expectedOrder && rail.order.length === 7, rail.order);
check("every rail icon draws a real FA glyph", rail.glyphs.every((g) => g.ok), rail.glyphs.filter((g) => !g.ok));
check("every rail label renders fully (no ellipsis truncation)", rail.labels.every((l) => l.fits), rail.labels.filter((l) => !l.fits));
check("no Projects/Apps/Tools/timer buttons", !rail.forbidden);

await page.click('#tab_web_editor [data-ch-tab="widgets"]');
await page.waitForTimeout(350);
const websiteWidgets = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('#tab_web_editor [data-ch-widget-item]'));
  const appointmentForms = (window.__fmweState?.catalog?.lead_forms || []).filter((form) => form.enabled !== false && String(form.mode || '').toLowerCase() === 'appointment');
  const schedulingIds = new Set(appointmentForms.map((form) => `el_web_form_${String(form.id || '').replace(/[^a-z0-9]+/gi, '_')}`));
  const schedulingItems = items.filter((item) => schedulingIds.has(item.dataset.chWidgetItem));
  return {
    tiled: getComputedStyle(document.querySelector('#tab_web_editor [data-ch-widget-grid]')).gridTemplateColumns.split(' ').length === 4,
    embed: items.some((item) => item.dataset.chWidgetItem === 'el_web_page_embed'),
    appointmentForms: appointmentForms.length,
    schedulingItems: schedulingItems.length
  };
});
check("website Widgets uses the shared four-column tiled panel", websiteWidgets.tiled, websiteWidgets);
check("website Widgets offers embedded pages as a functional section", websiteWidgets.embed, websiteWidgets);
check("configured appointment forms appear as customer scheduling widgets",
  websiteWidgets.schedulingItems === websiteWidgets.appointmentForms, websiteWidgets);
await page.click('#tab_web_editor [data-ch-tab="widgets"]');
await page.waitForTimeout(250);

// ---- 2. panel open/close + collapse handle + animation ----------------------
const panelTransition = await page.evaluate(() => {
  const panel = document.querySelector("#tab_web_editor [data-ch-panel]");
  const cs = getComputedStyle(panel);
  return { property: cs.transitionProperty, duration: cs.transitionDuration };
});
check("slide-out panel has a CSS width transition",
  /flex-basis|all/.test(panelTransition.property) && /(0\.[1-9]|[1-9])/.test(panelTransition.duration), panelTransition);

await page.click('#tab_web_editor [data-ch-tab="templates"]');
await page.waitForTimeout(450);
let panelState = await page.evaluate(() => ({
  open: !document.querySelector("#tab_web_editor [data-ch-panel]").classList.contains("hidden"),
  width: document.querySelector("#tab_web_editor [data-ch-panel]").getBoundingClientRect().width,
  active: document.querySelector('#tab_web_editor [data-ch-tab="templates"]').classList.contains("active"),
  cards: document.querySelectorAll("#tab_web_editor [data-ch-tpl-card]").length
}));
check("templates panel opens with active rail icon", panelState.open && panelState.active && panelState.width > 350, panelState);
check("template registry renders section + page cards", panelState.cards >= 11, { cards: panelState.cards });
await page.click('#tab_web_editor [data-ch-tab="templates"]');
await page.waitForTimeout(350);
panelState = await page.evaluate(() => {
  const panel = document.querySelector("#tab_web_editor [data-ch-panel]");
  return { hidden: panel.classList.contains("hidden"), width: panel.getBoundingClientRect().width };
});
check("clicking the active icon closes the panel (animates to zero width)", panelState.hidden && panelState.width < 4, panelState);
await page.click('#tab_web_editor [data-ch-tab="elements"]');
await page.waitForTimeout(350);
await page.click("#tab_web_editor [data-ch-collapse]");
await page.waitForTimeout(350);
panelState = await page.evaluate(() => !document.querySelector("#tab_web_editor [data-ch-panel]").classList.contains("hidden"));
check("collapse handle closes the panel", panelState === false);

// ---- 3. templates: insert a section -----------------------------------------
await page.click('#tab_web_editor [data-ch-tab="templates"]');
await page.waitForTimeout(500);
const beforeTpl = (await rootKids()).length;
await page.click('#tab_web_editor [data-ch-tpl-card="tpl_hero"]');
await page.waitForTimeout(900);
const afterTpl = await page.evaluate(() => {
  const d = window.__fmweEditor.getDocument();
  const kids = d.root.children;
  const last = kids[kids.length - 1];
  return {
    count: kids.length,
    layout: last.frame && last.frame.layout,
    h: last.frame && last.frame.h,
    w: last.frame && last.frame.w,
    id: last.id,
    kidsNumeric: (last.children || []).every((k) => ["x", "y", "w", "h"].every((key) => typeof (k.frame || {})[key] === "number")),
    selected: window.__fmweEditor.selection()
  };
});
check("section template appends to root.children", afterTpl.count === beforeTpl + 1, { before: beforeTpl, after: afterTpl.count });
check("inserted section is normalized-shaped (absolute, numeric h, w auto)",
  afterTpl.layout === "absolute" && typeof afterTpl.h === "number" && afterTpl.w === "auto" && afterTpl.kidsNumeric,
  { layout: afterTpl.layout, h: afterTpl.h, w: afterTpl.w, kidsNumeric: afterTpl.kidsNumeric });
check("inserted section is selected", afterTpl.selected.includes(afterTpl.id));
const heroId = afterTpl.id;

// ---- 4. elements: flat collapsible groups + insert shape --------------------
await page.click('#tab_web_editor [data-ch-tab="elements"]');
await page.waitForTimeout(350);
const elGroups = await page.evaluate(() => {
  const groups = Array.from(document.querySelectorAll("#tab_web_editor [data-ch-el-group]"));
  return {
    ids: groups.map((g) => g.dataset.chElGroup),
    collapsed: groups.filter((g) => g.classList.contains("collapsed")).map((g) => g.dataset.chElGroup),
    itemsVisible: groups.every((g) => {
      const grid = g.querySelector("[data-ch-el-group-items]");
      return grid && grid.offsetHeight > 0 && grid.querySelectorAll("[data-ch-el-item]").length > 0;
    }),
    drillIn: document.querySelectorAll("#tab_web_editor [data-ch-el-cat]").length,
    mergedMedia: !!document.querySelector('#tab_web_editor [data-ch-el-group="media"]')
      && !document.querySelector('#tab_web_editor [data-ch-el-group="photos"]')
      && !document.querySelector('#tab_web_editor [data-ch-el-group="video"]'),
    mediaItems: Array.from(document.querySelectorAll('#tab_web_editor [data-ch-el-group="media"] [data-ch-el-item]')).map((el) => el.dataset.chElItem)
  };
});
check("elements panel is a flat scroll of groups (no drill-in categories)",
  elGroups.ids.join(",") === "shapes,buttons,widgets,media,sections,tables" && elGroups.drillIn === 0, elGroups.ids);
check("all element groups render expanded with their items", elGroups.collapsed.length === 0 && elGroups.itemsVisible,
  { collapsed: elGroups.collapsed });
check("Photos + Video merged into one Media group (image, photo, grid, video)",
  elGroups.mergedMedia && ["el_image", "el_photo_widget", "el_photo_grid", "el_video"].every((id) => elGroups.mediaItems.includes(id)),
  elGroups.mediaItems);

// collapse persists via localStorage
await page.click('#tab_web_editor [data-ch-el-group-toggle="shapes"]');
await page.waitForTimeout(200);
const collapsedNow = await page.evaluate(() => ({
  collapsed: document.querySelector('#tab_web_editor [data-ch-el-group="shapes"]').classList.contains("collapsed"),
  stored: localStorage.getItem("fm_webeditor_el_groups") || ""
}));
await page.click('#tab_web_editor [data-ch-tab="elements"]'); // close
await page.waitForTimeout(300);
await page.click('#tab_web_editor [data-ch-tab="elements"]'); // reopen
await page.waitForTimeout(300);
const collapsedAfterReopen = await page.evaluate(() =>
  document.querySelector('#tab_web_editor [data-ch-el-group="shapes"]').classList.contains("collapsed"));
check("group collapse persists (localStorage fm_webeditor_el_groups) across reopen",
  collapsedNow.collapsed && /shapes/.test(collapsedNow.stored) && collapsedAfterReopen, collapsedNow);
await page.click('#tab_web_editor [data-ch-el-group-toggle="shapes"]'); // re-expand
await page.waitForTimeout(200);

// search filters across all groups and hides empty ones
await page.evaluate(() => {
  const input = document.querySelector("#tab_web_editor [data-ch-el-search]");
  input.value = "video";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(250);
const searchState = await page.evaluate(() => ({
  groups: Array.from(document.querySelectorAll("#tab_web_editor [data-ch-el-group]")).map((g) => g.dataset.chElGroup),
  items: Array.from(document.querySelectorAll("#tab_web_editor [data-ch-el-item]")).map((el) => el.dataset.chElItem)
}));
check("elements search filters items and hides empty groups",
  searchState.groups.length === 1 && searchState.groups[0] === "media" && searchState.items.includes("el_video"), searchState);
await page.evaluate(() => {
  const input = document.querySelector("#tab_web_editor [data-ch-el-search]");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(250);

await page.click('#tab_web_editor [data-ch-el-item="el_rect"]');
await page.waitForTimeout(700);
const shapeInfo = await page.evaluate(() => {
  const ed = window.__fmweEditor;
  const sel = ed.selection();
  const d = ed.getDocument();
  const id = sel[0];
  let node = null, parent = null;
  (function walk(n, p) {
    if (!n || node) return;
    if (n.id === id) { node = n; parent = p; return; }
    (n.children || []).forEach((k) => walk(k, n));
  })(d.root, null);
  const canvas = document.querySelector("#tab_web_editor .fmde-canvas").getBoundingClientRect();
  const el = document.querySelector(`#tab_web_editor [data-node-id="${id}"]`);
  const r = el ? el.getBoundingClientRect() : null;
  return {
    sel, type: node && node.type,
    frameNumeric: node && ["x", "y", "w", "h", "z"].every((k) => Number.isFinite(node.frame[k])),
    parentIsSection: !!parent && d.root.children.some((s) => s.id === parent.id),
    nearCenter: r ? Math.abs((r.x + r.width / 2) - (canvas.x + canvas.width / 2)) < canvas.width * 0.35 : false,
    recent: (localStorage.getItem("fm_webeditor_recent_elements") || "")
  };
});
check("shape inserts into a section with a fully numeric frame",
  shapeInfo.type === "shape" && shapeInfo.frameNumeric && shapeInfo.parentIsSection, shapeInfo);
check("inserted shape is selected and lands near the viewport centre",
  shapeInfo.sel.length === 1 && shapeInfo.nearCenter, { nearCenter: shapeInfo.nearCenter });
check("recently-used list records the insert", /el_rect/.test(shapeInfo.recent), { recent: shapeInfo.recent });
const rectId = shapeInfo.sel[0];

// ---- 5. text: heading insert ------------------------------------------------
await page.click('#tab_web_editor [data-ch-tab="text"]');
await page.waitForTimeout(350);
await page.click('#tab_web_editor [data-ch-text-style="heading"]');
await page.waitForTimeout(600);
const headingInfo = await page.evaluate(() => {
  const ed = window.__fmweEditor;
  const id = ed.selection()[0];
  const d = ed.getDocument();
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(d.root);
  const font = node && node.style && node.style.font || {};
  const text = node && node.props.blocks[0].runs.map((r) => r.text).join("");
  return { type: node && node.type, size: font.size_pt, weight: font.weight, text };
});
check("heading insert produces a 28pt/900 text node",
  headingInfo.type === "text" && headingInfo.size === 28 && headingInfo.weight === 900 && /heading/i.test(headingInfo.text || ""), headingInfo);

// ---- 6. brand: REAL org branding + swatch apply + branding media ------------
await page.evaluate(() => { window.__fmweState.brandKit = null; }); // force a fresh load
await page.click('#tab_web_editor [data-ch-tab="brand"]');
await page.waitForSelector("#tab_web_editor [data-ch-brand-swatch]", { timeout: 15000 });
const brandInfo = await page.evaluate(() => ({
  swatches: Array.from(document.querySelectorAll("#tab_web_editor [data-ch-brand-swatch]")).map((el) => el.dataset.chBrandSwatch),
  logo: !!document.querySelector("#tab_web_editor [data-ch-brand-logo]"),
  mediaGrid: !!document.querySelector("#tab_web_editor [data-ch-brand-media-grid]"),
  mediaItems: document.querySelectorAll("#tab_web_editor [data-ch-brand-media]").length
}));
check("brand panel renders logo slot + swatches", brandInfo.logo && brandInfo.swatches.length >= 1, brandInfo);
check("brand swatches show the org's SAVED colors (seeded #123456 present)",
  brandInfo.swatches.some((hex) => String(hex).toLowerCase() === "#123456"), { swatches: brandInfo.swatches });
check("brandingMedia alternate-logo grid renders (grid or empty state)", brandInfo.mediaGrid, brandInfo);
await page.evaluate((id) => window.__fmweEditor.select([id]), rectId);
await page.click("#tab_web_editor [data-ch-brand-swatch]");
await page.waitForTimeout(500);
const fillNow = await page.evaluate((id) => {
  const d = window.__fmweEditor.getDocument();
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(d.root);
  return node && node.style && node.style.fill;
}, rectId);
check("clicking a swatch with a shape selected changes its fill in the model",
  !!fillNow && String(fillNow.color).toLowerCase() === String(brandInfo.swatches[0]).toLowerCase(), { fill: fillNow, swatch: brandInfo.swatches[0] });

// ---- 7. QR: insert a doc.qr widget ------------------------------------------
await page.click('#tab_web_editor [data-ch-tab="qr"]');
await page.waitForTimeout(350);
await page.evaluate(() => {
  const input = document.querySelector("#tab_web_editor [data-ch-qr-url]");
  input.value = "https://example.com/qr-check";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.click("#tab_web_editor [data-ch-qr-insert]");
await page.waitForTimeout(600);
const qrInfo = await page.evaluate(() => {
  const ed = window.__fmweEditor;
  const id = ed.selection()[0];
  const d = ed.getDocument();
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(d.root);
  return { type: node && node.type, widget: node && node.props.widget, url: node && node.props.config && node.props.config.url };
});
check("QR insert creates a doc.qr widget node with the URL",
  qrInfo.type === "widget" && /^doc\.qr@/.test(qrInfo.widget || "") && qrInfo.url === "https://example.com/qr-check", qrInfo);

// ---- 8. MEDIA tab (replaces Uploads): library + upload + project media ------
const uploaded = await page.evaluate(async ({ org }) => {
  const cnv = document.createElement("canvas");
  cnv.width = 200; cnv.height = 130;
  const g = cnv.getContext("2d");
  g.fillStyle = "#7c3aed"; g.fillRect(0, 0, 200, 130);
  g.fillStyle = "#fff"; g.font = "bold 22px sans-serif"; g.fillText("UP", 80, 74);
  const blob = await new Promise((r) => cnv.toBlob(r, "image/png"));
  const file = new File([blob], "chrome-check.png", { type: "image/png" });
  const up = await window.PlatformAPI.media.upload(org, file, { ownerType: "website_page", ownerId: "chrome-check", collection: "websites" });
  const item = (up && (up.media || up.item)) || up;
  window.__fmweState.uploadsList = null; // force the panel to refetch
  return { ok: !!(item.id || item.media_id), mediaId: item.id || item.media_id };
}, { org: ORG });
check("canvas-generated file uploads through PlatformAPI", uploaded.ok, uploaded);
await page.click('#tab_web_editor [data-ch-tab="media"]');
await page.waitForSelector(`#tab_web_editor [data-ch-up-item="${uploaded.mediaId}"]`, { timeout: 20000 });
const mediaPanel = await page.evaluate(() => ({
  subtabs: Array.from(document.querySelectorAll("#tab_web_editor [data-ch-up-tab]")).map((el) => el.dataset.chUpTab),
  uploadBtn: !!document.querySelector("#tab_web_editor [data-ch-up-btn]"),
  projSearch: !!document.querySelector("#tab_web_editor [data-ch-media-projsearch]"),
  uploadsTab: !!document.querySelector('#tab_web_editor [data-ch-tab="uploads"]')
}));
check("Media tab keeps the uploads surface (Upload files + Images|Designs|Folders)",
  mediaPanel.subtabs.join(",") === "images,designs,folders" && mediaPanel.uploadBtn && !mediaPanel.uploadsTab, mediaPanel);
check("Media tab adds a project search input", mediaPanel.projSearch, mediaPanel);
await page.click(`#tab_web_editor [data-ch-up-item="${uploaded.mediaId}"]`);
await page.waitForTimeout(2500); // insert + image fetch
const upInsert = await page.evaluate(() => {
  const id = window.__fmweEditor.selection()[0];
  const el = document.querySelector(`#tab_web_editor [data-node-id="${id}"]`);
  const img = el && (el.querySelector("img") || (el.tagName === "IMG" ? el : null));
  return { id, hasImg: !!img, loaded: !!(img && img.complete && img.naturalWidth > 0) };
});
check("clicking an org media item inserts an image node that actually renders", upInsert.hasImg && upInsert.loaded, upInsert);

// Ensure the named test project exists with at least one photo (idempotent
// PUT — platform project documents on this org are name-less skeletons).
const projectSeed = await page.evaluate(async ({ org, mediaId }) => {
  try {
    const existing = await window.PlatformAPI.projects.list(org);
    const docs = (existing && existing.documents) || [];
    const target = docs.find((d) => /Test Project/i.test(((d.data || {}).title || "")));
    if (!target) {
      await window.PlatformAPI.projects.save(org, "project_webtest_chrome", {
        title: "Test Project — Web Builder",
        photos: [{ media_id: mediaId }],
        updated_at: new Date().toISOString()
      });
    } else if (!((target.data || {}).photos || []).length) {
      await window.PlatformAPI.projects.save(org, target.id, { ...(target.data || {}), photos: [{ media_id: mediaId }] });
    }
    window.__fmweState.mediaProjects = null; // drop the panel's cache
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}, { org: ORG, mediaId: uploaded.mediaId });
check("test project with photos is available", projectSeed.ok, projectSeed);

// project search → project photos view → back
await page.evaluate(() => {
  const input = document.querySelector("#tab_web_editor [data-ch-media-projsearch]");
  input.value = "Test Project";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForSelector("#tab_web_editor [data-ch-media-project]", { timeout: 20000 });
const projHits = await page.evaluate(() =>
  Array.from(document.querySelectorAll("#tab_web_editor [data-ch-media-project]")).map((el) => el.textContent.trim()));
check("typing in Search projects lists matching projects",
  projHits.length >= 1 && projHits.some((t) => /Test Project/i.test(t)), projHits);
await page.click("#tab_web_editor [data-ch-media-project]");
await page.waitForSelector("#tab_web_editor [data-ch-media-back]", { timeout: 20000 });
await page.waitForFunction(() => {
  const state = window.__fmweState;
  return state && state.mediaProject && !state.mediaProjectPhotosLoading;
}, null, { timeout: 20000 });
const projView = await page.evaluate(() => ({
  back: !!document.querySelector("#tab_web_editor [data-ch-media-back]"),
  photos: document.querySelectorAll("#tab_web_editor [data-ch-media-photo]").length,
  empty: !!document.querySelector("#tab_web_editor .fmwe-ch-empty")
}));
check("selecting a project shows its photos view with a back link",
  projView.back && projView.photos > 0, projView);
await page.click("#tab_web_editor [data-ch-media-back]");
await page.waitForTimeout(400);
const backToLibrary = await page.evaluate(() => !!document.querySelector("#tab_web_editor [data-ch-media-projsearch]"));
check("back link returns to the media library view", backToLibrary);

// ---- 9. add section + pages strip -------------------------------------------
const beforeAdd = (await rootKids()).length;
const redundantAddControls = await page.evaluate(() => ({
  horizontal: !!document.querySelector("#tab_web_editor [data-ch-add-section]"),
  selectedSection: !!document.querySelector("#tab_web_editor [data-ch-sec-addbelow]")
}));
check("redundant horizontal Add section controls are absent", !redundantAddControls.horizontal && !redundantAddControls.selectedSection, redundantAddControls);
await page.click("#tab_web_editor [data-ch-page-new]");
await page.waitForTimeout(700);
const afterAdd = await page.evaluate(() => {
  const kids = window.__fmweEditor.getDocument().root.children;
  const last = kids[kids.length - 1];
  return { count: kids.length, layout: last.frame.layout, h: last.frame.h, w: last.frame.w };
});
check("Add section appends a blank absolute band", afterAdd.count === beforeAdd + 1 && afterAdd.layout === "absolute" && typeof afterAdd.h === "number" && afterAdd.w === "auto", afterAdd);

const strip = await page.evaluate(() => {
  const open = !document.querySelector("#tab_web_editor [data-ch-pages-strip]").classList.contains("hidden");
  const cards = Array.from(document.querySelectorAll("#tab_web_editor [data-ch-page-card]")).map((el) => el.dataset.chPageCard);
  const regular = window.__fmweEditor.getDocument().root.children.map((section) => section.id);
  const active = document.querySelector("#tab_web_editor [data-ch-page-card].active");
  return { open, cards, regular, activeId: active && active.dataset.chPageCard, plus: !!document.querySelector("#tab_web_editor [data-ch-page-new]") };
});
check("pages strip defaults open and lists every regular page",
  strip.open && strip.regular.length > 0 && strip.regular.every((id) => strip.cards.includes(id)), { cards: strip.cards.length, regular: strip.regular.length });
check("current section is outlined in the strip", !!strip.activeId && strip.regular.includes(strip.activeId), { active: strip.activeId });
check("strip's + card adds a section directly", afterAdd.count === beforeAdd + 1, afterAdd);

// pages toggle hides/shows the strip
await page.click("#tab_web_editor [data-ch-pages-toggle]");
await page.waitForTimeout(200);
const stripHidden = await page.evaluate(() => document.querySelector("#tab_web_editor [data-ch-pages-strip]").classList.contains("hidden"));
await page.click("#tab_web_editor [data-ch-pages-toggle]");
check("bottom-bar Pages control toggles the strip", stripHidden === true);

// ---- 10. notes drawer saves + persists --------------------------------------
const NOTE = "Chrome-check note " + Date.now();
await page.click("#tab_web_editor [data-ch-notes]");
await page.waitForTimeout(300);
const drawerOpen = await page.evaluate(() => !document.querySelector("#tab_web_editor [data-ch-notes-drawer]").classList.contains("hidden"));
check("Notes opens the bottom drawer", drawerOpen);
await page.evaluate((note) => {
  const input = document.querySelector("#tab_web_editor [data-ch-notes-input]");
  input.value = note;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}, NOTE);
await page.waitForFunction(() => /Saved/i.test((document.querySelector("#tab_web_editor [data-ch-notes-state]") || {}).textContent || ""), null, { timeout: 10000 });
check("notes save shows the Saved tick", true);
const persistedNote = await page.evaluate(async ({ org, siteId, pageId }) => {
  const res = await window.WebsitesAPI.pages.get(org, siteId, pageId);
  return (res.page || res).notes;
}, { ...setup, org: ORG });
check("notes persist on the page record (PATCH ok)", persistedNote === NOTE, { persisted: persistedNote });
await page.click("#tab_web_editor [data-ch-notes-close]");

// ---- 11. section-management chrome ------------------------------------------
await page.evaluate((id) => {
  document.querySelector(`#tab_web_editor [data-node-id="${id}"]`)?.scrollIntoView({ block: "center" });
  window.__fmweEditor.select([id]);
}, heroId);
await page.waitForTimeout(500);
const secChrome = await page.evaluate((id) => {
  const actions = document.querySelector("#tab_web_editor [data-ch-sec-actions]");
  const pill = document.querySelector("#tab_web_editor [data-ch-sec-pill]");
  const s = window.__fmweSectionRect(id); // effective box (fluid pages render 0-width section elements)
  if (!actions || !pill || !s) return { actions: !!actions, pill: !!pill, rect: !!s };
  const a = actions.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  return {
    actions: true, pill: true,
    buttons: Array.from(actions.querySelectorAll("button")).map((b) => b.getAttribute("data-ch-sec-lock") !== null ? "lock"
      : b.getAttribute("data-ch-sec-duplicate") !== null ? "duplicate"
      : b.getAttribute("data-ch-sec-addbelow") !== null ? "addbelow"
      : b.getAttribute("data-ch-sec-delete") !== null ? "delete" : "?"),
    pillButtons: Array.from(pill.querySelectorAll(":scope > button")).map((b) => b.textContent.trim()),
    // Outside the page when there is room; hugging the edge when the section
    // starts at the canvas edge (fluid pages).
    actionsLeftOfSection: a.right <= s.left + 8 || a.left <= s.left + 8,
    actionsVerticallyInside: a.top >= s.top - 6 && a.top <= s.bottom,
    pillAbove: p.bottom <= s.top + 8,
    pillCentered: Math.abs((p.x + p.width / 2) - ((s.left + s.right) / 2)) < 60
  };
}, heroId);
check("selecting a section shows only lock/duplicate/delete mini-buttons",
  secChrome.actions && Array.isArray(secChrome.buttons) && secChrome.buttons.join(",") === "lock,duplicate,delete", secChrome.buttons);
check("section pill [Ask][Edit][Position][Comment] floats centered above the section",
  secChrome.pill && Array.isArray(secChrome.pillButtons) && /Ask/.test(secChrome.pillButtons[0] || "")
    && secChrome.pillAbove && secChrome.pillCentered, secChrome);
check("mini-buttons hug the section's left edge, outside the page",
  secChrome.actionsLeftOfSection === true && secChrome.actionsVerticallyInside === true,
  { left: secChrome.actionsLeftOfSection, inside: secChrome.actionsVerticallyInside });

// lock toggles node locks
await page.click("#tab_web_editor [data-ch-sec-lock]");
await page.waitForTimeout(300);
const lockedState = await page.evaluate((id) => {
  const node = window.__fmweEditor.getDocument().root.children.find((n) => n.id === id);
  return node && node.locks;
}, heroId);
await page.click("#tab_web_editor [data-ch-sec-lock]");
await page.waitForTimeout(300);
const unlockedState = await page.evaluate((id) => {
  const node = window.__fmweEditor.getDocument().root.children.find((n) => n.id === id);
  return node && node.locks;
}, heroId);
check("lock button toggles node locks {move,resize,delete}",
  lockedState && lockedState.move === true && lockedState.resize === true && lockedState.delete === true
    && (!unlockedState || unlockedState.move !== true), { locked: lockedState, unlocked: unlockedState });

// duplicate section (deep clone, inserted after)
const beforeDup = (await rootKids()).length;
await page.click("#tab_web_editor [data-ch-sec-duplicate]");
await page.waitForTimeout(500);
const dupInfo = await page.evaluate((id) => {
  const kids = window.__fmweEditor.getDocument().root.children;
  const idx = kids.findIndex((n) => n.id === id);
  const copy = kids[idx + 1];
  return {
    count: kids.length,
    copyIsFrame: copy && copy.type === "frame",
    freshIds: copy && copy.id !== id && (copy.children || []).length === (kids[idx].children || []).length,
    selected: window.__fmweEditor.selection()[0] === (copy && copy.id)
  };
}, heroId);
check("duplicate section deep-clones after the original and selects it",
  dupInfo.count === beforeDup + 1 && dupInfo.copyIsFrame && dupInfo.freshIds && dupInfo.selected, dupInfo);

// Edit popover: swatch sets the section fill
await page.evaluate((id) => window.__fmweEditor.select([id]), heroId);
await page.waitForTimeout(400);
await page.click("#tab_web_editor [data-ch-sec-edit]");
await page.waitForSelector("#tab_web_editor [data-ch-sec-fill]", { timeout: 8000 });
const targetFill = await page.evaluate(() => {
  const btn = document.querySelector("#tab_web_editor [data-ch-sec-fill]");
  return btn && btn.dataset.chSecFill;
});
await page.click("#tab_web_editor [data-ch-sec-fill]");
await page.waitForTimeout(400);
const secFill = await page.evaluate((id) => {
  const node = window.__fmweEditor.getDocument().root.children.find((n) => n.id === id);
  return node && node.style && node.style.fill;
}, heroId);
check("Edit popover swatch sets the section background fill",
  !!secFill && secFill.type === "solid" && String(secFill.color).toLowerCase() === String(targetFill).toLowerCase(),
  { fill: secFill, expected: targetFill });

// Position popover: layer list + z reorder + row click selects
await page.click("#tab_web_editor [data-ch-sec-position]");
await page.waitForSelector("#tab_web_editor [data-ch-sec-layer]", { timeout: 8000 });
const posInfo = await page.evaluate((id) => {
  const node = window.__fmweEditor.getDocument().root.children.find((n) => n.id === id);
  const rows = Array.from(document.querySelectorAll("#tab_web_editor [data-ch-sec-layer]"));
  const zs = rows.map((r) => {
    const kid = (node.children || []).find((k) => k.id === r.dataset.chSecLayer);
    return kid && kid.frame && kid.frame.z;
  });
  return {
    rows: rows.length,
    kids: (node.children || []).length,
    frontFirst: zs.every((z, i) => i === 0 || zs[i - 1] >= z),
    firstRowId: rows[0] && rows[0].dataset.chSecLayer
  };
}, heroId);
check("Position popover lists the section's children front-most first",
  posInfo.rows === posInfo.kids && posInfo.rows >= 3 && posInfo.frontFirst, posInfo);
const zBefore = await page.evaluate((kidId) => {
  let z = null;
  (function walk(n) { if (!n || z !== null) return; if (n.id === kidId) { z = (n.frame || {}).z; return; } (n.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return z;
}, posInfo.firstRowId);
await page.click('#tab_web_editor [data-ch-sec-layer] [data-ch-sec-z="backward"]');
await page.waitForTimeout(400);
const zAfter = await page.evaluate((kidId) => {
  let z = null;
  (function walk(n) { if (!n || z !== null) return; if (n.id === kidId) { z = (n.frame || {}).z; return; } (n.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return z;
}, posInfo.firstRowId);
check("Position popover down button changes the child's z in the model", zAfter !== zBefore, { before: zBefore, after: zAfter });
await page.waitForSelector("#tab_web_editor [data-ch-sec-layer]", { timeout: 8000 });
const rowClickSel = await page.evaluate(() => {
  const row = document.querySelector("#tab_web_editor [data-ch-sec-layer]");
  const kidId = row.dataset.chSecLayer;
  row.click();
  return { kidId, selected: window.__fmweEditor.selection()[0] };
});
check("layer row click selects that child", rowClickSel.selected === rowClickSel.kidId, rowClickSel);

// Comment is a quiet toast; chrome hides again on empty selection
await page.evaluate(() => window.__fmweEditor.select([]));
await page.waitForTimeout(400);
const chromeGone = await page.evaluate(() => ({
  actions: !!document.querySelector("#tab_web_editor [data-ch-sec-actions]"),
  pill: !!document.querySelector("#tab_web_editor [data-ch-sec-pill]")
}));
check("section chrome hides when the selection leaves the section", !chromeGone.actions && !chromeGone.pill, chromeGone);

// ---- 12. drag-from-panel: shape → exact canvas point ------------------------
await page.click('#tab_web_editor [data-ch-tab="elements"]');
await page.waitForTimeout(400);
const dragTarget = await page.evaluate(() => {
  const kids = window.__fmweEditor.getDocument().root.children.filter((n) => n.type === "frame");
  const band = kids[kids.length - 1]; // blank band from Add section
  const el = document.querySelector(`#tab_web_editor [data-node-id="${band.id}"]`);
  el.scrollIntoView({ block: "center" });
  return band.id;
});
await page.waitForTimeout(500);
const dragGeom = await page.evaluate((bandId) => {
  const sec = window.__fmweSectionRect(bandId);
  const item = document.querySelector('#tab_web_editor [data-ch-el-item="el_rect"]').getBoundingClientRect();
  return {
    secLeft: sec.left, secTop: sec.top, secHeightPx: sec.height,
    fromX: item.x + item.width / 2, fromY: item.y + item.height / 2,
    toX: (sec.left + sec.right) / 2, toY: (sec.top + sec.bottom) / 2
  };
}, dragTarget);
await page.mouse.move(dragGeom.fromX, dragGeom.fromY);
await page.mouse.down();
await page.mouse.move(dragGeom.toX, dragGeom.toY, { steps: 12 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(700);
const dropInfo = await page.evaluate(({ bandId, geom }) => {
  const ed = window.__fmweEditor;
  const id = ed.selection()[0];
  const d = ed.getDocument();
  let node = null, parent = null;
  (function walk(n, p) { if (!n || node) return; if (n.id === id) { node = n; parent = p; return; } (n.children || []).forEach((k) => walk(k, n)); })(d.root, null);
  if (!node || !parent) return { type: node && node.type, inBand: false };
  // Model-space assertion (immune to post-insert canvas re-layout): the node
  // centre in the SECTION's space must equal the drop point converted with
  // the drop-time geometry (±10px equivalent).
  const band = d.root.children.find((n) => n.id === bandId);
  const pxPerPt = geom.secHeightPx / band.frame.h;
  const expectedX = (geom.toX - geom.secLeft) / pxPerPt;
  const expectedY = (geom.toY - geom.secTop) / pxPerPt;
  const cx = node.frame.x + node.frame.w / 2;
  const cy = node.frame.y + node.frame.h / 2;
  return {
    type: node.type,
    inBand: parent.id === bandId,
    dx: Math.abs(cx - expectedX) * pxPerPt,
    dy: Math.abs(cy - expectedY) * pxPerPt,
    zTop: node.frame.z >= Math.max(0, ...(band.children || []).filter((k) => k.id !== id).map((k) => (k.frame || {}).z || 0)),
    ghostGone: !document.querySelector(".fmwe-drag-ghost")
  };
}, { bandId: dragTarget, geom: dragGeom });
check("dragging a shape from the panel drops it into the section AT the drop point (±10px)",
  dropInfo.type === "shape" && dropInfo.inBand && dropInfo.dx <= 10 && dropInfo.dy <= 10 && dropInfo.zTop && dropInfo.ghostGone, dropInfo);
const droppedRectId = await page.evaluate(() => window.__fmweEditor.selection()[0]);

// ---- 13. drag media onto a shape → image FILL (no new image node) ----------
await page.click('#tab_web_editor [data-ch-tab="media"]');
await page.waitForSelector(`#tab_web_editor [data-ch-up-item="${uploaded.mediaId}"]`, { timeout: 20000 });
const imageCountBefore = await page.evaluate(() => {
  let count = 0;
  (function walk(n) { if (!n) return; if (n.type === "image") count += 1; (n.children || []).forEach(walk); })(window.__fmweEditor.getDocument().root);
  return count;
});
const fillGeom = await page.evaluate(({ rectNodeId, mediaId }) => {
  const target = document.querySelector(`#tab_web_editor [data-node-id="${rectNodeId}"]`);
  target.scrollIntoView({ block: "center" });
  const r = target.getBoundingClientRect();
  const thumb = document.querySelector(`#tab_web_editor [data-ch-up-item="${mediaId}"]`).getBoundingClientRect();
  return {
    fromX: thumb.x + thumb.width / 2, fromY: thumb.y + thumb.height / 2,
    toX: r.x + r.width / 2, toY: r.y + r.height / 2
  };
}, { rectNodeId: droppedRectId, mediaId: uploaded.mediaId });
await page.mouse.move(fillGeom.fromX, fillGeom.fromY);
await page.mouse.down();
await page.mouse.move(fillGeom.toX, fillGeom.toY, { steps: 12 });
await page.waitForTimeout(200);
const highlightDuringDrag = await page.evaluate(() => !!document.querySelector(".fmwe-fill-target"));
await page.mouse.up();
await page.waitForTimeout(700);
const fillDrop = await page.evaluate(({ rectNodeId, mediaId }) => {
  const d = window.__fmweEditor.getDocument();
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === rectNodeId) { node = n; return; } (n.children || []).forEach(walk); })(d.root);
  let imageCount = 0;
  (function walk2(n) { if (!n) return; if (n.type === "image") imageCount += 1; (n.children || []).forEach(walk2); })(d.root);
  const fill = node && node.style && node.style.fill;
  return {
    stillShape: node && node.type === "shape",
    fillType: fill && fill.type,
    fillMedia: fill && fill.media && fill.media.media_id,
    fit: fill && fill.fit,
    imageCount,
    matches: !!fill && fill.type === "image" && fill.media && fill.media.media_id === mediaId
  };
}, { rectNodeId: droppedRectId, mediaId: uploaded.mediaId });
check("hovering a media drag over a shape highlights it", highlightDuringDrag === true);
check("dropping media on a shape sets style.fill image (cover) WITHOUT a new image node",
  fillDrop.stillShape && fillDrop.matches && fillDrop.fit === "cover" && fillDrop.imageCount === imageCountBefore, fillDrop);

// ---- 14. drag media to empty canvas → normal image node at point ------------
// Zoom out first so the stage leaves an empty margin right of the sections.
await page.evaluate(() => {
  const slider = document.querySelector("#tab_web_editor [data-ch-zoom]");
  slider.value = "60";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(600);
const emptyGeom = await page.evaluate((mediaId) => {
  const canvas = document.querySelector("#tab_web_editor [data-ed-canvas]").getBoundingClientRect();
  const kids = window.__fmweEditor.getDocument().root.children.filter((n) => n.type === "frame");
  const rects = kids.map((n) => window.__fmweSectionRect(n.id)).filter(Boolean);
  const rightMost = Math.max(...rects.map((r) => r.right));
  const thumb = document.querySelector(`#tab_web_editor [data-ch-up-item="${mediaId}"]`).getBoundingClientRect();
  const gap = canvas.right - rightMost;
  return {
    gap,
    fromX: thumb.x + thumb.width / 2, fromY: thumb.y + thumb.height / 2,
    toX: Math.min(canvas.right - 15, rightMost + Math.max(15, gap / 2)),
    toY: canvas.top + canvas.height / 2
  };
}, uploaded.mediaId);
await page.mouse.move(emptyGeom.fromX, emptyGeom.fromY);
await page.mouse.down();
await page.mouse.move(emptyGeom.toX, emptyGeom.toY, { steps: 12 });
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(700);
const emptyDrop = await page.evaluate((mediaId) => {
  const ed = window.__fmweEditor;
  const d = ed.getDocument();
  const id = ed.selection()[0];
  let node = null;
  (function walk(n) { if (!n || node) return; if (n.id === id) { node = n; return; } (n.children || []).forEach(walk); })(d.root);
  return {
    type: node && node.type,
    matches: !!node && node.type === "image" && node.props.media && node.props.media.media_id === mediaId
  };
}, uploaded.mediaId);
check("dropping media on empty canvas inserts a regular image node", emptyDrop.matches, { ...emptyDrop, gap: Math.round(emptyGeom.gap) });

// ---- 15. markup: slim dock (no wide panel) + full session -------------------
await page.click('#tab_web_editor [data-ch-tab="markup"]');
await page.waitForTimeout(400);
const dockState = await page.evaluate(() => {
  const panel = document.querySelector("#tab_web_editor [data-ch-panel]");
  const dock = document.querySelector("#tab_web_editor [data-ch-mk-dock]");
  const canvas = document.querySelector("#tab_web_editor [data-ed-canvas]");
  const d = dock && dock.getBoundingClientRect();
  const c = canvas && canvas.getBoundingClientRect();
  return {
    panelHidden: panel.classList.contains("hidden"),
    dock: !!dock,
    slim: d ? d.width <= 70 : false,
    hugsLeft: d && c ? d.left - c.left < 30 : false,
    tools: dock ? Array.from(dock.querySelectorAll("[data-ch-mk-tool]")).map((b) => b.dataset.chMkTool) : [],
    colors: !!(dock && dock.querySelector("[data-ch-mk-colortoggle]")),
    undo: !!(dock && dock.querySelector("[data-ch-mk-undo]")),
    done: !!(dock && dock.querySelector("[data-ch-mk-done]")),
    railActive: document.querySelector('#tab_web_editor [data-ch-tab="markup"]').classList.contains("active")
  };
});
check("Markup opens a slim dock at the canvas's left edge — NOT the 400px panel",
  dockState.panelHidden && dockState.dock && dockState.slim && dockState.hugsLeft, dockState);
check("dock has pen/arrow/text/eraser + color + undo + Done, rail tab active",
  dockState.tools.join(",") === "pen,arrow,text,eraser" && dockState.colors && dockState.undo && dockState.done && dockState.railActive, dockState);

await page.click('#tab_web_editor [data-ch-mk-tool="pen"]');
await page.waitForTimeout(500);
const overlayRect = await page.evaluate(() => {
  const overlay = document.querySelector("#tab_web_editor [data-ch-mk-overlay]");
  const pageEl = document.querySelector("#tab_web_editor .fmde-stage .fmdoc-page");
  if (!overlay || !pageEl) return null;
  const o = overlay.getBoundingClientRect();
  const p = pageEl.getBoundingClientRect();
  const framePt = window.__fmweState.markupSession && window.__fmweState.markupSession.framePt;
  // Fluid pages render .fmdoc-page at 0 CSS width, so "covers the page" means:
  // anchored at the page origin, matching the page height, with a real width
  // that equals the session's pt frame (the coordinate space items map onto).
  const covers = Math.abs(o.x - p.x) < 3 && Math.abs(o.y - p.y) < 3 && o.width > 200
    && (p.height < 3 || Math.abs(o.height - p.height) < 6);
  return { x: o.x, y: o.y, w: o.width, h: o.height, pageW: p.width, pageH: p.height, framePt, covers };
});
check("markup session mounts a page-covering overlay", !!overlayRect && overlayRect.covers, overlayRect);
if (overlayRect) {
  // Draw a synthetic stroke with real pointer input near the overlay's top.
  const sx = overlayRect.x + overlayRect.w * 0.3;
  const sy = overlayRect.y + Math.min(120, overlayRect.h * 0.2);
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 160, sy + 60, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200); // markup persist debounce
  const markupNode = await page.evaluate(() => {
    const d = window.__fmweEditor.getDocument();
    const node = (d.root.children || []).find((n) => n.type === "markup_overlay");
    if (!node) return null;
    return {
      id: node.id, anchor: node.anchor,
      z: node.frame && node.frame.z, layout: node.frame && node.frame.layout,
      items: (node.props.items || []).length,
      numericFrame: ["x", "y", "w", "h"].every((k) => Number.isFinite(node.frame[k]))
    };
  });
  check("drawing creates the page-level markup_overlay node with items",
    !!markupNode && markupNode.items > 0 && markupNode.anchor === "page" && markupNode.numericFrame, markupNode);
  await page.click("#tab_web_editor [data-ch-mk-done]");
  await page.waitForTimeout(800);
  const afterDone = await page.evaluate(() => {
    const overlay = document.querySelector("#tab_web_editor [data-ch-mk-overlay]");
    const d = window.__fmweEditor.getDocument();
    const node = (d.root.children || []).find((n) => n.type === "markup_overlay");
    const el = node ? document.querySelector(`#tab_web_editor [data-node-id="${node.id}"]`) : null;
    const editorLive = document.querySelector("#tab_web_editor .fmwe-editor").classList.contains("fmwe-markup-live");
    const dockStill = !!document.querySelector("#tab_web_editor [data-ch-mk-dock]");
    return { overlayGone: !overlay, nodeStillRenders: !!el, editorLive, items: node ? node.props.items.length : 0, dockStill };
  });
  check("Done exits the session and the markup node still renders",
    afterDone.overlayGone && afterDone.nodeStillRenders && !afterDone.editorLive && afterDone.items > 0, afterDone);
  // Re-entering loads the saved items back into the session.
  await page.click('#tab_web_editor [data-ch-mk-tool="pen"]');
  await page.waitForTimeout(400);
  const reentered = await page.evaluate(() => {
    const session = window.__fmweState.markupSession;
    return session ? session.instance.items.length : -1;
  });
  check("re-entering markup loads the existing items", reentered > 0, { items: reentered });
  await page.click("#tab_web_editor [data-ch-mk-done]");
  await page.waitForTimeout(400);
}

// ---- 16. zoom slider ---------------------------------------------------------
const zoomBefore = await page.evaluate(() => window.__fmweEditor.zoom());
await page.evaluate(() => {
  const slider = document.querySelector("#tab_web_editor [data-ch-zoom]");
  slider.value = "50";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);
const zoomAfter = await page.evaluate(() => ({
  zoom: window.__fmweEditor.zoom(),
  readout: (document.querySelector("#tab_web_editor [data-ch-zoom-readout]") || {}).textContent
}));
check("zoom slider drives editor.zoom with a live % readout",
  Math.abs(zoomAfter.zoom - 0.5) < 0.01 && /50%/.test(zoomAfter.readout || ""), { before: zoomBefore, ...zoomAfter });

// section chrome tracks the section through zoom changes
await page.evaluate((id) => {
  document.querySelector(`#tab_web_editor [data-node-id="${id}"]`)?.scrollIntoView({ block: "center" });
  window.__fmweEditor.select([id]);
}, heroId);
await page.waitForTimeout(500);
await page.evaluate(() => {
  const slider = document.querySelector("#tab_web_editor [data-ch-zoom]");
  slider.value = "80";
  slider.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(600);
const trackAfterZoom = await page.evaluate((id) => {
  const pill = document.querySelector("#tab_web_editor [data-ch-sec-pill]");
  const s = window.__fmweSectionRect(id);
  if (!pill || !s) return { pill: !!pill, sec: !!s };
  const p = pill.getBoundingClientRect();
  return { pill: true, sec: true, centered: Math.abs((p.x + p.width / 2) - ((s.left + s.right) / 2)) < 60, above: p.bottom <= s.top + 8 };
}, heroId);
check("section chrome repositions with zoom", trackAfterZoom.centered === true && trackAfterZoom.above === true, trackAfterZoom);
await page.evaluate(() => window.__fmweEditor.select([]));

// ---- 17. template no-overlap audit across the WHOLE registry ----------------
const audit = await page.evaluate(async () => {
  const reg = window.__fmweTemplates;
  if (!reg) return { ok: false, reason: "no __fmweTemplates hook" };
  const failures = [];
  const list = reg.list();
  for (const entry of list) {
    const docDef = reg.buildDoc(entry.id);
    if (!docDef) { failures.push({ id: entry.id, reason: "no doc" }); continue; }
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;left:-12000px;top:0;width:980px;background:#fff;";
    document.body.appendChild(host);
    let handle = null;
    try {
      handle = window.FMDocRenderer.render(host, {
        document: docDef, mode: "static", widgetData: {}, mediaUrl: () => "", scale: 1
      });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const texts = Array.from(host.querySelectorAll('[data-node-type="text"]')).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute("data-node-id"), text: (el.textContent || "").slice(0, 30), l: r.left, t: r.top, r: r.right, b: r.bottom };
      }).filter((t) => (t.r - t.l) > 1 && (t.b - t.t) > 1);
      for (let i = 0; i < texts.length; i += 1) {
        for (let j = i + 1; j < texts.length; j += 1) {
          const a = texts[i], b = texts[j];
          const xo = Math.min(a.r, b.r) - Math.max(a.l, b.l);
          const yo = Math.min(a.b, b.b) - Math.max(a.t, b.t);
          if (xo > 2 && yo > 2) {
            failures.push({ id: entry.id, a: a.text, b: b.text, xo: Math.round(xo), yo: Math.round(yo) });
          }
        }
      }
    } catch (e) {
      failures.push({ id: entry.id, reason: String(e).slice(0, 120) });
    } finally {
      try { handle && handle.destroy && handle.destroy(); } catch (e) { /* noop */ }
      host.remove();
    }
  }
  return { ok: failures.length === 0, templates: list.length, failures: failures.slice(0, 8) };
});
check(`template audit: no two text nodes overlap in ANY of ${audit.templates || 0} templates`, audit.ok, audit.ok ? { templates: audit.templates } : audit);

// autosave settles before cleanup
await page.waitForTimeout(2500);

// ---- cleanup -----------------------------------------------------------------
const cleaned = await page.evaluate(async ({ org, siteId, pageId }) => {
  try { await window.WebsitesAPI.pages.remove(org, siteId, pageId); return true; } catch (e) { return String(e); }
}, { ...setup, org: ORG });
check("scratch page cleaned up", cleaned === true, cleaned === true ? undefined : { cleaned });

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("failed: " + failed.map((f) => f.name).join("; ")); process.exit(1); }
