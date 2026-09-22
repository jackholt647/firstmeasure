/**
 * E2E verification for Doc Studio folders (Marketing tab + custom folders):
 *  - API: Marketing folder seeded idempotently; system row rename/delete 4xx
 *  - API: custom folder CRUD + archive; item CRUD incl. expected_revision 409
 *  - API: capability documents.custom_folders=false -> POST /folders 403
 *  - API: doc item PDF export responds with a PDF
 *  - UI: Marketing subtab renders; "New" chooser (4 kinds); document creation
 *    opens the autosaving item editor; "+" creates a custom folder; kebab
 *    rename/delete; "+" disappears when the capability is off
 *
 *   node scripts/marketing-folders-e2e.mjs   (from public/v1; local stack running)
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.MARKETING_FOLDERS_SHOTS_DIR || path.resolve("marketing-folders-shots");
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
    async raw(method, url, body) {
      const res = await fetch(API + url, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(jar.size ? { cookie: [...jar.values()].join("; ") } : {}),
          ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      for (const rawCookie of res.headers.getSetCookie?.() || []) {
        const pair = rawCookie.split(";")[0];
        jar.set(pair.split("=")[0], pair);
        if (pair.startsWith("fm_platform_session_csrf=")) csrf = decodeURIComponent(pair.split("=")[1] || "");
      }
      return res;
    },
    async req(method, url, body) {
      const res = await this.raw(method, url, body);
      const text = await res.text();
      if (res.status >= 400) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
      try { return text ? JSON.parse(text) : null; } catch { return null; }
    },
    async status(method, url, body) {
      const res = await this.raw(method, url, body);
      await res.text();
      return res.status;
    }
  };
}

// A minimal valid paged DocModel (mirrors studio.js blankDefinition fallback).
function minimalDocDefinition() {
  return {
    schema_version: 1,
    kind: "document",
    settings: { paper: { size: "letter", orientation: "portrait" }, locale: "en-US", base_font_pt: 11 },
    theme_ref: null,
    params: {},
    computed: {},
    outputs: {},
    assets: [],
    edit_policy: { base_profile: "document", max_profile: "designer", features: {}, unlock: { allowed: true } },
    metadata: { document_type: "generic" },
    pages: [{ id: "pg_1", role: "cover", name: "", master_ref: null, repeat: null, children: [] }]
  };
}

// --- seed: full-capability org ----------------------------------------------
const owner = apiClient();
const orgId = `org_mkfld_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Marketing Folders Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});

const D = `/v1/documents/organizations/${orgId}`;

// --- API: Marketing seeding + system protection ------------------------------
const list1 = await owner.req("GET", `${D}/folders`);
const marketing = (list1?.folders || []).find((f) => f.key === "marketing");
check("Marketing folder seeded on first list", !!marketing && marketing.system === true, marketing?.id);
const list2 = await owner.req("GET", `${D}/folders`);
check("Marketing seeding is idempotent", (list2?.folders || []).filter((f) => f.key === "marketing").length === 1);

check("system folder rename rejected", (await owner.status("PATCH", `${D}/folders/${marketing.id}`, { label: "Nope" })) === 409);
check("system folder delete rejected", (await owner.status("DELETE", `${D}/folders/${marketing.id}`)) === 409);

// --- API: custom folder CRUD -------------------------------------------------
const folderRes = await owner.req("POST", `${D}/folders`, { label: "Case Studies" });
const folder = folderRes?.folder;
check("custom folder created", !!folder?.id && folder.system === false && folder.label === "Case Studies", folder?.id);
const renamed = await owner.req("PATCH", `${D}/folders/${folder.id}`, { label: "Case Studies 2" });
check("custom folder renamed", renamed?.folder?.label === "Case Studies 2");

// --- API: items --------------------------------------------------------------
const docItemRes = await owner.req("POST", `${D}/folders/${marketing.id}/items`, {
  item_type: "document", name: "Brochure", definition: minimalDocDefinition()
});
const docItem = docItemRes?.item;
check("document item created", !!docItem?.id && docItem.item_type === "document", docItem?.id);

const mediaItemRes = await owner.req("POST", `${D}/folders/${marketing.id}/items`, {
  item_type: "media", name: "team-photo.jpg", media_ref: { media_id: "media_probe", variant: "original", file_name: "team-photo.jpg" }
});
check("media item created", !!mediaItemRes?.item?.id);

const itemsList = await owner.req("GET", `${D}/folders/${marketing.id}/items`);
const listedDoc = (itemsList?.items || []).find((i) => i.id === docItem.id);
check("item list omits definition but flags it", !!listedDoc && listedDoc.definition === undefined && listedDoc.has_definition === true);

const itemDetail = await owner.req("GET", `${D}/folders/${marketing.id}/items/${docItem.id}`);
check("item detail includes definition", Array.isArray(itemDetail?.item?.definition?.pages));

const patched = await owner.req("PATCH", `${D}/folders/${marketing.id}/items/${docItem.id}`, {
  definition: minimalDocDefinition(), expected_revision: itemDetail.item.revision
});
check("autosave patch with matching revision", Number(patched?.item?.revision) > Number(itemDetail.item.revision));
check("stale expected_revision -> 409", (await owner.status("PATCH", `${D}/folders/${marketing.id}/items/${docItem.id}`, {
  definition: minimalDocDefinition(), expected_revision: itemDetail.item.revision
})) === 409);

// --- API: PDF export ---------------------------------------------------------
const pdfRes = await owner.raw("GET", `${D}/folders/${marketing.id}/items/${docItem.id}/pdf`);
const pdfType = pdfRes.headers.get("content-type") || "";
await pdfRes.arrayBuffer();
check("doc item exports a PDF", pdfRes.status === 200 && pdfType.includes("pdf"), pdfType);

// --- API: archive ------------------------------------------------------------
await owner.req("DELETE", `${D}/folders/${marketing.id}/items/${docItem.id}`);
const afterArchive = await owner.req("GET", `${D}/folders/${marketing.id}/items`);
check("archived item leaves the list", !(afterArchive?.items || []).some((i) => i.id === docItem.id));

await owner.req("DELETE", `${D}/folders/${folder.id}`);
const foldersAfter = await owner.req("GET", `${D}/folders`);
check("deleted folder leaves the list (soft archive)", !(foldersAfter?.folders || []).some((f) => f.id === folder.id));

// --- API: capability gate ----------------------------------------------------
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "documents.custom_folders": false } });
check("capability off -> folder create 403", (await owner.status("POST", `${D}/folders`, { label: "Blocked" })) === 403);
check("capability off -> Marketing still lists", ((await owner.req("GET", `${D}/folders`))?.folders || []).some((f) => f.key === "marketing"));
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "documents.custom_folders": true } });

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
page.on("response", async (res) => {
  if (res.status() >= 400 && /\/v1\/(documents|platform)\//.test(res.url())) {
    let body = "";
    try { body = (await res.text()).slice(0, 200); } catch { /* streamed */ }
    console.log("   [http", res.status() + "]", res.request().method(), res.url(), body);
  }
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
await page.goto(WEB + "/portal/?tab=documents_studio", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForSelector(".fmdx-shell", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);
// The Windows dev stack's storage layer occasionally 404s one of the parallel
// list fetches (atomic-rename read race); retry the load like a human would.
for (let attempt = 0; attempt < 3; attempt += 1) {
  if ((await page.locator(".fmdx-subtab").filter({ hasText: "Marketing" }).count()) > 0) break;
  const retry = page.locator("[data-retry]");
  if (await retry.count()) await retry.click();
  else await page.reload({ waitUntil: "domcontentloaded" }).then(() => page.waitForSelector(".fmdx-shell", { timeout: 30000 }).catch(() => null));
  await page.waitForTimeout(2500);
}

// 1. Marketing subtab + "+" button render.
const marketingTab = page.locator(".fmdx-subtab").filter({ hasText: "Marketing" }).first();
check("UI: Marketing subtab renders", (await marketingTab.count()) > 0);
check("UI: + (new folder) button renders", (await page.locator(".fmdx-subtab-add").count()) > 0);
await shot("studio-tabs");

// 2. Marketing tab -> "New" chooser with 4 kinds.
await marketingTab.click();
await page.waitForTimeout(1200);
await page.locator(".fmdx-top-actions [data-new-folder-item]").click();
await page.waitForTimeout(600);
const kinds = await page.$$eval("[data-nfi-kind]", (els) => els.map((el) => el.dataset.nfiKind));
check("UI: New chooser offers 4 kinds", ["media", "file", "document", "visual_document"].every((k) => kinds.includes(k)), kinds);
await shot("new-chooser");

// 3. Create a Document -> autosaving item editor opens.
await page.locator('[data-nfi-kind="document"]').click();
await page.waitForTimeout(400);
await page.fill("[data-nfi-name]", "Spring Flyer");
await page.locator("[data-nfi-create]").click();
await page.waitForSelector("[data-studio-item-screen]", { timeout: 20000 }).catch(() => null);
check("UI: item editor opened", (await page.locator("[data-studio-item-screen]").count()) > 0);
const saveChip = await page.locator("[data-item-save-state]").textContent().catch(() => "");
check("UI: autosave chip present", /automat|Saved|Unsaved/i.test(saveChip || ""), saveChip);
await shot("item-editor");
await page.locator("[data-item-back]").click();
await page.waitForTimeout(1500);
check("UI: created item appears in the grid", (await page.locator("[data-folder-item-card]").count()) > 0);
await shot("marketing-grid");

// 4. "+" creates a custom folder.
await page.locator(".fmdx-subtab-add").click();
await page.waitForTimeout(500);
await page.fill("[data-name-input]", "Retail Kit");
await page.locator("[data-name-save]").click();
await page.waitForTimeout(1800);
const retailTab = page.locator(".fmdx-subtab").filter({ hasText: "Retail Kit" }).first();
check("UI: custom folder tab appears", (await retailTab.count()) > 0);
check("UI: custom folder tab has kebab", (await page.locator(".fmdx-subtab-kebab").count()) > 0);
await shot("custom-folder");

// 5. Kebab rename.
await page.locator(".fmdx-subtab-kebab").first().click();
await page.waitForTimeout(400);
await page.locator(".fmdx-menu-item").filter({ hasText: "Rename" }).click();
await page.waitForTimeout(400);
await page.fill("[data-name-input]", "Retail Kit 2");
await page.locator("[data-name-save]").click();
await page.waitForTimeout(1800);
check("UI: folder renamed in the strip", (await page.locator(".fmdx-subtab").filter({ hasText: "Retail Kit 2" }).count()) > 0);

// 6. Kebab delete (accept the confirm — Portal.ui.confirm modal, with a
// native-dialog fallback for sessions without the portal confirm helper).
page.once("dialog", (d) => d.accept().catch(() => null));
await page.locator(".fmdx-subtab-kebab").first().click();
await page.waitForTimeout(400);
await page.locator(".fmdx-menu-item").filter({ hasText: "Delete" }).click();
await page.waitForTimeout(800);
const confirmBtn = page.locator("button").filter({ hasText: /^Confirm$/ }).first();
if (await confirmBtn.count()) await confirmBtn.click();
await page.waitForTimeout(2000);
check("UI: deleted folder tab is gone", (await page.locator(".fmdx-subtab").filter({ hasText: "Retail Kit 2" }).count()) === 0);
await shot("after-delete");

// 7. Capability off hides the "+" (Marketing stays).
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, { values: { "documents.custom_folders": false } });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".fmdx-shell", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);
check("UI: capability off hides +", (await page.locator(".fmdx-subtab-add").count()) === 0);
check("UI: Marketing tab persists with capability off", (await page.locator(".fmdx-subtab").filter({ hasText: "Marketing" }).count()) > 0);
await shot("capability-off");

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exit(1);
}
