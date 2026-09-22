/**
 * E2E verification for the documents consolidation (v2: standalone doc-first):
 *  - data-driven New button (document + doc:<type> actions, new_button_items)
 *  - "New Proposal" opens the modal in standalone mode: ONLY the Docs tab,
 *    create wizard opens immediately (no project), left column = project picker
 *  - creating the doc opens the SmartDoc editor standalone
 *  - picking a project from the picker attaches the doc (PATCH project_id),
 *    unlocks the other tabs, and reopens the doc in the editor
 *  - the merged Docs gallery lists engine docs; + New works on a project
 *
 *   node scripts/docs-consolidation-e2e.mjs   (from public/v1; local stack running)
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.DOCS_CONSOLIDATION_SHOTS_DIR || path.resolve("docs-consolidation-shots");
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

// --- seed: full-capability org (mirrors the owner's test org) ---------------
const owner = apiClient();
const orgId = `org_docsv2_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Docs V2 Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: {
    "platform.new_button_mode": "selector",
    "platform.new_button_items": "project,contact,report,document,doc:proposal,doc:invoice"
  }
});

// Standalone create via the new org-scoped route works at the API level.
const standaloneProbe = await owner.req("POST", `/v1/documents/organizations/${orgId}/documents`, {
  document_type: "contract", title: "API Standalone Probe", params: {}
});
check("standalone create route works", !!standaloneProbe?.document?.id && !standaloneProbe.document.project_id, standaloneProbe?.document?.id);

const projectId = `project_docsv2_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Attach Target Project", address: "42 Consolidation Ct", project_type: "residential",
    contacts: [{ id: "contact_m", name: "Merle Merge", email: "merle@example.test", phone: "555-000-1111", primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
page.on("console", (m) => {
  const text = m.text();
  if (["warning", "error"].includes(m.type()) && /attach|adopt|picker|document/i.test(text)) console.log("   [console]", text.slice(0, 300));
});
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
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForFunction(() => {
  try { return window.Portal.appFlags.value("platform", "documents", false) === true; } catch { return false; }
}, null, { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);

// 1. New button menu is data-driven with icons.
await page.click("#btnNewReq").catch(() => null);
await page.waitForTimeout(1200);
const menuItems = await page.$$eval("#newMenuPopout [data-new-workflow]", (els) => els.map((el) => ({
  id: el.dataset.newWorkflow,
  label: el.textContent.trim(),
  icon: el.querySelector("i")?.className || ""
})));
console.log("menu:", JSON.stringify(menuItems));
check("menu lists configured items incl doc types",
  ["project", "contact", "report", "document", "doc:proposal", "doc:invoice"].every((id) => menuItems.some((item) => item.id === id)),
  menuItems.map((item) => item.id));
check("every menu item has an icon class", menuItems.every((item) => /fa-[a-z]/.test(item.icon)), menuItems.map((i) => i.icon));
await shot("new-button-menu");

// 2. "New Proposal": full-width chooser first (no wizard, no modal-over-modal).
await page.click('#newMenuPopout [data-new-workflow="doc:proposal"]');
await page.waitForSelector("#rOverlay.active", { timeout: 20000 }).catch(() => null);
await page.waitForSelector('#rOverlay [data-doc-picker][data-doc-picker-mode="full"]', { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(1500);
const chooserState = await page.evaluate(() => {
  const picker = document.querySelector("#rOverlay [data-doc-picker]");
  return {
    panels: [...document.querySelectorAll("#rOverlay .r-preview-panel[data-panel]")].map((el) => el.dataset.panel),
    pickerMode: picker?.dataset.docPickerMode || "",
    heading: picker?.querySelector(".r-doc-picker-head span")?.textContent?.trim() || "",
    hasSearch: !!picker?.querySelector("[data-doc-picker-search]"),
    hasNew: !!picker?.querySelector("[data-doc-picker-new]"),
    hasSkip: !!picker?.querySelector("[data-doc-picker-skip]"),
    wizardOpen: !!document.querySelector("[data-create-title]"),
    floatingModal: !!document.querySelector(".fmdx-modal-back")
  };
});
console.log("chooser:", JSON.stringify(chooserState));
check("only the Docs tab exists in standalone mode", chooserState.panels.length === 1 && chooserState.panels[0] === "docs", chooserState.panels);
check("full-width chooser shows first", chooserState.pickerMode === "full");
check("chooser copy asks to select a project", /select a project for this document/i.test(chooserState.heading), chooserState.heading);
check("chooser offers search + new project + no-project", chooserState.hasSearch && chooserState.hasNew && chooserState.hasSkip);
check("no wizard yet and no floating modal", !chooserState.wizardOpen && !chooserState.floatingModal);
await shot("full-width-chooser");

// 3. "Create without a project": chooser slides to the left column, the
// wizard fills the right panel inline, typed as a proposal.
await page.click("#rOverlay [data-doc-picker-skip]");
await page.waitForSelector("#rOverlay [data-docs-create-host] [data-create-title]", { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(1200);
const inlineState = await page.evaluate(() => {
  const picker = document.querySelector("#rOverlay [data-doc-picker]");
  const host = document.querySelector("#rOverlay [data-docs-create-host]");
  return {
    pickerMode: picker?.dataset.docPickerMode || "",
    inlineWizard: !!host?.querySelector("[data-create-title]"),
    wizardTitle: host?.querySelector("[data-create-title]")?.value || "",
    inPanel: !!host?.closest('.r-preview-panel[data-panel="docs"]'),
    floatingModal: !!document.querySelector(".fmdx-modal-back")
  };
});
console.log("inline:", JSON.stringify(inlineState));
check("chooser collapsed into the left column", inlineState.pickerMode === "left");
check("wizard renders inline in the right panel", inlineState.inlineWizard && inlineState.inPanel);
check("inline wizard typed as a proposal", /proposal/i.test(inlineState.wizardTitle), inlineState.wizardTitle);
check("still no floating modal", !inlineState.floatingModal);
await shot("inline-wizard");

// Create the standalone document → editor opens with no project.
await page.click("#rOverlay [data-docs-create-host] [data-create-go]");
await page.waitForSelector("#rOverlay [data-docs-engine-host]:not([hidden])", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(4000);
const standaloneDoc = await page.evaluate(() => {
  const host = document.querySelector("#rOverlay [data-docs-engine-host]");
  const doc = window.Portal?.modules?.projectDocsTab?.currentEngineDoc?.() || null;
  return {
    editorVisible: !!host && !host.hidden && !!host.querySelector(".fmdx-shell"),
    docId: doc?.id || "",
    docProjectId: doc?.project_id || ""
  };
});
console.log("standalone doc:", JSON.stringify(standaloneDoc));
check("standalone doc opens in the editor", standaloneDoc.editorVisible && !!standaloneDoc.docId, standaloneDoc.docId);
check("document has no project yet", !standaloneDoc.docProjectId);
await shot("standalone-editor");

// 4. Back to the list → picker → select the seeded project → doc attaches.
await page.evaluate(() => {
  const host = document.querySelector("#rOverlay [data-docs-engine-host]");
  host?.querySelector("[data-fmdx-back], .fmdx-back, button[title='Back to documents']")?.click();
});
await page.waitForTimeout(2000);
await page.waitForFunction(() => !!document.querySelector("#rOverlay [data-doc-picker] [data-doc-picker-project]"), null, { timeout: 25000 }).catch(() => null);
await shot("picker-after-editor");
await page.evaluate(() => {
  const rows = [...document.querySelectorAll("#rOverlay [data-doc-picker] [data-doc-picker-project]")];
  (rows.find((el) => /Attach Target Project/.test(el.textContent || "")) || rows[0])?.click();
});
await page.waitForSelector("#rOverlay [data-docs-engine-host]:not([hidden])", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(5000);
const attached = await page.evaluate(() => {
  const host = document.querySelector("#rOverlay [data-docs-engine-host]");
  const doc = window.Portal?.modules?.projectDocsTab?.currentEngineDoc?.() || null;
  return {
    editorVisible: !!host && !host.hidden && !!host.querySelector(".fmdx-shell"),
    docId: doc?.id || "",
    docProjectId: doc?.project_id || "",
    panels: [...document.querySelectorAll("#rOverlay .r-preview-panel[data-panel]")].map((el) => el.dataset.panel)
  };
});
console.log("attached:", JSON.stringify(attached));
check("doc reopens in the editor under the project", attached.editorVisible && attached.docId, attached.docId);
check("doc attached to the picked project", attached.docProjectId.includes("project_docsv2_"), attached.docProjectId);
check("other tabs unlock once a project is set", attached.panels.length > 1, attached.panels);
await shot("attached-editor");

// Server-side confirmation of the attach.
if (attached.docId) {
  const detail = await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${attached.docId}`);
  check("server shows the doc on the project", detail?.document?.project_id === projectId, detail?.document?.project_id);
  const list = await owner.req("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
  check("doc appears in the project document list", (list?.documents || []).some((d) => d.id === attached.docId));
}

// 5. Merged gallery on the project + "+ New".
await page.evaluate(() => {
  const host = document.querySelector("#rOverlay [data-docs-engine-host]");
  host?.querySelector("[data-fmdx-back], .fmdx-back, button[title='Back to documents']")?.click();
});
await page.waitForTimeout(3500);
const galleryText = await page.$eval('#rOverlay .r-preview-panel[data-panel="docs"]', (el) => el.textContent || "").catch(() => "");
check("engine document listed in the merged Docs gallery", /Proposal/.test(galleryText));
check("+ New action present on the project Docs tab", !!(await page.$('#rOverlay [data-gallery-toolbar-action="new_document"]')));
await shot("project-docs-gallery");

// 6. Drafts view in My Projects: unattached standalone docs, tile reopen.
await owner.req("POST", `/v1/documents/organizations/${orgId}/documents`, {
  document_type: "invoice", title: "Orphan Invoice Draft", params: {}
});
await page.goto(WEB + "/portal/?tab=viewer&projectView=drafts", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForSelector(".v-draft-tile", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(1500);
const draftsState = await page.evaluate(() => ({
  draftsButtonVisible: !!document.querySelector("#vViewDrafts") && !document.querySelector("#vViewDrafts").hidden,
  draftsButtonActive: document.querySelector("#vViewDrafts")?.classList.contains("active") || false,
  tiles: [...document.querySelectorAll(".v-draft-tile")].map((el) => el.textContent.replace(/\s+/g, " ").trim()).slice(0, 6)
}));
console.log("drafts:", JSON.stringify(draftsState));
check("Drafts view button shown and active", draftsState.draftsButtonVisible && draftsState.draftsButtonActive);
check("orphan draft tile lists kind + title", draftsState.tiles.some((t) => /Invoice draft/i.test(t) && /Orphan Invoice Draft/.test(t)), draftsState.tiles);
await shot("drafts-view");

// Reopen the draft session from the tile.
await page.evaluate(() => {
  const tile = [...document.querySelectorAll(".v-draft-tile")].find((el) => /Orphan Invoice Draft/.test(el.textContent));
  tile?.click();
});
await page.waitForSelector("#rOverlay [data-docs-engine-host]:not([hidden])", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(4000);
const resumed = await page.evaluate(() => {
  const host = document.querySelector("#rOverlay [data-docs-engine-host]");
  const doc = window.Portal?.modules?.projectDocsTab?.currentEngineDoc?.() || null;
  return {
    editorVisible: !!host && !host.hidden && !!host.querySelector(".fmdx-shell"),
    docTitle: doc?.title || "",
    pickerMode: document.querySelector("#rOverlay [data-doc-picker]")?.dataset.docPickerMode || "",
    panels: [...document.querySelectorAll("#rOverlay .r-preview-panel[data-panel]")].map((el) => el.dataset.panel)
  };
});
console.log("resumed:", JSON.stringify(resumed));
check("draft tile reopens the doc in the editor", resumed.editorVisible && /Orphan Invoice Draft/.test(resumed.docTitle), resumed.docTitle);
check("resume session is docs-only with the attach picker", resumed.panels.length === 1 && resumed.panels[0] === "docs" && resumed.pickerMode === "left", { panels: resumed.panels, picker: resumed.pickerMode });
await shot("draft-resumed");

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
