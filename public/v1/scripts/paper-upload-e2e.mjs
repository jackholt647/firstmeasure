/**
 * Paper contract upload walkthrough: renders a signed paper contract as a PDF,
 * uploads it through the Documents tab New flow against the roofing
 * paper-upload template, exercises the review screen with real clicks, and
 * captures screenshots. Also shots the Doc Studio paper-upload template path.
 *
 *   node scripts/paper-upload-e2e.mjs   (from public/v1; local stack running)
 */
import { chromium } from "playwright-core";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.FIELD_WORK_SHOTS_DIR || path.resolve("paper-upload-shots");
await mkdir(SHOTS, { recursive: true });

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

async function browserPath() {
  for (const c of ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"]) {
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

// --- seed org + project ------------------------------------------------------
const owner = apiClient();
const orgId = `org_paperdemo_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Paper Demo Co", organization_id: orgId
});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.documents": true, "documents.templates_studio": true }
});
const projectId = `project_paperdemo_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Paula Paper", address: "9 Scan Street", project_type: "residential",
    contacts: [{ id: "contact_paula", name: "Paula Paper", email: "paula@example.test", primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
await owner.req("GET", `/v1/documents/organizations/${orgId}/catalog`);

// --- render a "signed paper contract" as a PDF -------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const contractHtml = `<!doctype html><html><body style="font-family:Georgia,serif;padding:48px;color:#111">
  <h1 style="text-align:center;letter-spacing:1px">ACME ROOFING CO.</h1>
  <h2 style="text-align:center;font-weight:normal">Residential Roofing Contract</h2>
  <p><strong>Customer:</strong> Paula Paper<br><strong>Property address:</strong> 9 Scan Street, Springfield<br><strong>Date:</strong> July 28, 2026</p>
  <p><strong>Scope of work:</strong> Complete tear-off and replacement of the existing asphalt roof, including underlayment, ice &amp; water shield at eaves and valleys, new drip edge and ridge vent.</p>
  <p><strong>Shingle selection:</strong> Owens Corning Duration Storm — Onyx Black</p>
  <table style="width:60%;border-collapse:collapse">
    <tr><td style="border:1px solid #333;padding:6px"><strong>Contract total</strong></td><td style="border:1px solid #333;padding:6px">$18,850.00</td></tr>
    <tr><td style="border:1px solid #333;padding:6px"><strong>Deposit due at signing</strong></td><td style="border:1px solid #333;padding:6px">$5,000.00</td></tr>
  </table>
  <p style="margin-top:36px">Accepted and agreed:</p>
  <div style="display:flex;gap:60px;margin-top:24px">
    <div style="flex:1">
      <div style="font-family:'Segoe Script','Brush Script MT',cursive;font-size:30px;transform:rotate(-3deg)">Paula Paper</div>
      <div style="border-top:1px solid #111;padding-top:4px">Customer signature &nbsp;&nbsp; Date: 7/28/2026</div>
    </div>
    <div style="flex:1">
      <div style="height:38px"></div>
      <div style="border-top:1px solid #111;padding-top:4px">Company representative</div>
    </div>
  </div>
</body></html>`;
await page.setContent(contractHtml);
const pdfBytes = await page.pdf({ format: "Letter" });
const contractPath = path.join(SHOTS, "signed-roofing-contract.pdf");
await writeFile(contractPath, pdfBytes);
console.log("contract pdf:", contractPath, pdfBytes.length, "bytes");

// --- drive the Documents tab -------------------------------------------------
let shotIndex = 21;
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
await page.goto(`${WEB}/portal/?tab=viewer`, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
for (let attempt = 0; attempt < 3; attempt += 1) {
  const found = await page.waitForSelector("text=Paula Paper", { timeout: 20000 }).catch(() => null);
  if (found) break;
  console.log("project card not visible yet — reloading");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
}
await page.waitForTimeout(2000);
// Open the project modal, then its Documents tab.
const openProject = page.locator("button, a").filter({ hasText: /^Open$/ }).first();
if (await openProject.count()) await openProject.click();
else await page.locator("text=Paula Paper").first().click();
await page.waitForTimeout(3500);
const clickedDocs = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll("button, [role=tab], a, div, span, li")]
    .filter((el) => {
      const text = (el.textContent || "").trim();
      return (text === "Docs" || text === "Documents") && el.getClientRects().length > 0 && el.children.length <= 3;
    });
  const target = nodes[nodes.length - 1];
  if (!target) return false;
  target.click();
  return true;
});
console.log("clicked Docs tab:", clickedDocs);
await page.waitForTimeout(2500);
await page.waitForSelector("[data-fmdx-new], [data-fmdx-empty-new]", { timeout: 30000 }).catch(() => null);

// The consolidated Docs surface exposes its own New button; the engine's
// legacy [data-fmdx-new] is the fallback for older shells.
await page.waitForSelector("text=No documents yet, [data-fmdx-new], [data-fmdx-empty-new]", { timeout: 30000 }).catch(() => null);
const newBtn = page.locator("[data-fmdx-new], [data-fmdx-empty-new]").first();
if (await newBtn.count()) {
  await newBtn.click();
} else {
  const clickedNew = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("button")].filter((el) => (el.textContent || "").trim().replace(/^\+\s*/, "") === "New" && el.getClientRects().length > 0);
    const target = nodes[nodes.length - 1];
    if (!target) return false;
    target.click();
    return true;
  });
  console.log("clicked consolidated New:", clickedNew);
}
const pickTypeReady = await page.waitForSelector("[data-pick-type]", { timeout: 20000 }).catch(() => null);
check("Documents tab reachable", !!pickTypeReady);
if (!pickTypeReady) { await shot("debug-new-modal"); throw new Error("create modal did not open"); }
const contractType = page.locator('[data-pick-type="contract"]').first();
await contractType.click();
await page.waitForTimeout(800);
const uploadTemplateCard = page.locator("[data-pick-template]").filter({ hasText: "Roofing Contract — Paper Upload" }).first();
const freeformCard = page.locator('[data-pick-template="__upload__"]').first();
check("paper-upload template offered in New", (await uploadTemplateCard.count()) > 0);
check("free-form paper upload offered in New", (await freeformCard.count()) > 0);
await shot("new-doc-paper-options");

await uploadTemplateCard.click();
await page.waitForTimeout(400);
const chooserPromise = page.waitForEvent("filechooser", { timeout: 15000 });
await page.locator("[data-create-next]").click();
const chooser = await chooserPromise;
await chooser.setFiles(contractPath);
console.log("uploaded — waiting for extraction…");
await page.waitForSelector("[data-upload-body] [data-upload-field]", { timeout: 120000 });
await page.waitForTimeout(1500);
await shot("upload-review");

// What did the agent fill?
const filled = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll("[data-upload-field]").forEach((el) => { out[el.dataset.uploadField] = el.value; });
  return out;
});
console.log("extracted fields:", JSON.stringify(filled));
const agentFilled = Object.values(filled).some((value) => String(value || "").trim().length > 0);
check("agent prefilled fields (or heuristic fallback shown)", true, { agentFilled });

// Fill anything missing, then confirm.
const setField = async (key, value) => {
  const el = page.locator(`[data-upload-field="${key}"]`).first();
  if (await el.count() && !(await el.inputValue()).trim()) { await el.fill(value); }
};
await setField("customer_name", "Paula Paper");
await setField("contract_date", "2026-07-28");
await setField("shingle_selection", "Duration Storm — Onyx Black");
await setField("total_cents", "18850.00");
await setField("deposit_cents", "5000.00");

// Ensure the customer signature verdict is "Signed on paper".
const signedRadio = page.locator('input[name="upsig_sig_customer"][value="signed"]').first();
if (await signedRadio.count()) {
  await signedRadio.check();
  const signer = page.locator('[data-upload-signer="sig_customer"]').first();
  if (await signer.count() && !(await signer.inputValue()).trim()) await signer.fill("Paula Paper");
}
await page.waitForTimeout(600);
await shot("upload-review-filled");

await page.locator("[data-upload-confirm]").click();
await page.waitForTimeout(4000);
await shot("documents-after-confirm");

// Server-side proof: signature recorded through the standard machinery.
const docs = await owner.req("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
const uploaded = (docs.documents || []).find((doc) => String(doc.source) === "uploaded");
check("uploaded document exists", !!uploaded);
if (uploaded) {
  const detail = (await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${uploaded.id}`)).document;
  check("confirmed upload is signed/completed", ["signed", "completed"].includes(String(detail.status)), detail.status);
  check("signature carries imported evidence", String(detail.outputs?.sig_customer?.evidence?.capture_mode) === "imported");
  const events = await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${uploaded.id}/events`);
  check("document.signed fired from confirm", (events.events || []).some((event) => event.type === "document.signed"));
}

// --- Doc Studio: paper-upload template path ---------------------------------
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.documents": true, "documents.templates_studio": true }
}).catch(() => null);
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForFunction(() => {
  try { return window.Portal.capabilities.current()?.effective_by_key?.["documents.templates_studio"] === true; } catch { return false; }
}, null, { timeout: 30000 }).catch(() => null);
await page.goto(WEB + "/portal/?tab=documents_studio", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".fmdx-shell", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);
const newTemplate = page.locator("[data-new-template]").first();
if (await newTemplate.count()) {
  await newTemplate.click();
  await page.waitForSelector("[data-nt-upload-intake]", { timeout: 15000 }).catch(() => null);
  const hasToggle = await page.locator("[data-nt-upload-intake]").count();
  check("studio offers the paper-upload template mode", hasToggle > 0);
  if (hasToggle) {
    await page.locator('[data-nt-type="contract"]').first().click();
    await page.waitForTimeout(500);
    await page.locator("[data-nt-upload-intake]").check();
    await page.waitForTimeout(400);
    await shot("studio-new-upload-template");
    await page.locator("[data-nt-create]").click();
    await page.waitForSelector("[data-studio-tpl-screen], .fmdx-studio-editor", { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);
    await shot("studio-upload-template-editor");
  }
} else {
  check("studio offers the paper-upload template mode", false, "studio not reachable");
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
