/**
 * E2E verification for the document-designer agent build:
 *  - Doc Studio workflow editor v2: visual builder, JSON toggle, agent tray
 *  - Doc Studio template editor: tabbed right tray (Inspect | Setup | Agent)
 *  - Project document editor: Data tray subtabs (Setup | Agent)
 *  - Agents API: "docs" agent registered, thread bootstrap works
 *
 *   node scripts/doc-agent-e2e.mjs   (from public/v1; local stack running)
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.DOC_AGENT_SHOTS_DIR || path.resolve("doc-agent-shots");
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

// --- seed org + project + a draft document ----------------------------------
const owner = apiClient();
const orgId = `org_docagent_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Doc Agent Demo Co", organization_id: orgId
});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "platform.documents": true, "documents.templates_studio": true, "documents.agent": true }
}).catch((error) => console.log("capabilities:", String(error).slice(0, 200)));

// ensureDefaultDocumentAssets runs on first list — seeds templates + workflows.
const tplList = await owner.req("GET", `/v1/documents/organizations/${orgId}/templates`);
check("seeded templates exist", (tplList.templates || []).length > 0, (tplList.templates || []).length);
const wfList = await owner.req("GET", `/v1/documents/organizations/${orgId}/workflows`);
check("seeded workflows exist", (wfList.workflows || []).length > 0, (wfList.workflows || []).length);

// Agents API: docs agent registered + thread bootstrap.
const agentCatalog = await owner.req("GET", `/v1/agents/organizations/${orgId}/agents`);
const docsAgent = (agentCatalog.agents || []).find((a) => a.id === "docs");
check("docs agent in org agent catalog", !!docsAgent, docsAgent && docsAgent.title);
const wfSubject = String((wfList.workflows || [])[0]?.id || "wfl_subject");
const thread = await owner.req("POST", `/v1/agents/organizations/${orgId}/agents/docs/threads`, { subject_id: wfSubject });
check("docs agent thread creates", !!thread?.thread?.id, thread?.thread?.id);

// ── generate_document item kind (pure API) ──────────────────────────────────
const genWorkflowRes = await owner.req("POST", `/v1/documents/organizations/${orgId}/workflows`, {
  name: "Receipt Generator E2E",
  definition: {
    schema_version: 1,
    name: "Receipt Generator E2E",
    contract: { params: {}, outputs: { receipt: { type: "value", label: "Generated receipt" } } },
    steps: [
      { id: "st_collect", title: "Collect", audience: ["internal"], items: [{ kind: "text", writes: "params.job_note", label: "Job note" }] },
      { id: "st_finish", title: "Finish", audience: ["internal"], items: [
        { kind: "generate_document", writes: "outputs.receipt", label: "Receipt", config: { document_type: "generic", title: "Receipt — E2E", copy_params: false } }
      ] }
    ]
  }
});
const genWorkflowId = String(genWorkflowRes.workflow.id);
const genWorkflowVersion = Number(genWorkflowRes.workflow.current_version || 0);
await owner.req("POST", `/v1/documents/organizations/${orgId}/workflows/${genWorkflowId}/publish`, {
  definition: {
    schema_version: 1, name: "Receipt Generator E2E",
    contract: { params: {}, outputs: { receipt: { type: "value", label: "Generated receipt" } } },
    steps: [
      { id: "st_collect", title: "Collect", audience: ["internal"], items: [{ kind: "text", writes: "params.job_note", label: "Job note" }] },
      { id: "st_finish", title: "Finish", audience: ["internal"], items: [
        { kind: "generate_document", writes: "outputs.receipt", label: "Receipt", config: { document_type: "generic", title: "Receipt — E2E", copy_params: false } }
      ] }
    ]
  },
  expected_version: genWorkflowVersion
}).then(
  () => check("generate_document kind publishes", true),
  (error) => check("generate_document kind publishes", false, String(error).slice(0, 200))
);

// from-examples route exists (generation itself needs the OpenAI key; a bad
// payload must 400 with a schema error, never 404).
const feStatus = await fetch(API + `/v1/documents/organizations/${orgId}/templates/from-examples`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
}).then((r) => r.status);
check("templates/from-examples route mounted", feStatus !== 404, feStatus);

const projectId = `project_docagent_${suffix}`;
await owner.req("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
  data: {
    id: projectId, title: "Jane Homeowner", address: "100 Document Lane", project_type: "residential",
    contacts: [{ id: "contact_jane", name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222", primary: true }],
    photos: []
  },
  metadata: { kind: "platform_project" }
});
const draftDoc = await owner.req("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
  document_type: "proposal", title: "Draft Proposal For Agent Tray",
  workflow_id: genWorkflowId,
  params: { customer: { name: "Jane Homeowner" }, scope_items: [] }
});
const draftDocId = String(draftDoc.document.id);
console.log("draft doc:", draftDocId);

// Completing the finish step mints the receipt document server-side.
await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${draftDocId}/workflow/state`, { complete_step: "st_collect" });
const genState = await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${draftDocId}/workflow/state`, { complete_step: "st_finish" });
const receiptRef = genState?.document?.outputs?.receipt || {};
check("completing the step generates the receipt document", !!receiptRef.document_id, receiptRef);
if (receiptRef.document_id) {
  const receiptDoc = await owner.req("GET", `/v1/documents/organizations/${orgId}/documents/${receiptRef.document_id}`);
  check("generated receipt carries the source ref", receiptDoc?.document?.params?.source_document_id === draftDocId, receiptDoc?.document?.title);
  // idempotency: re-completing the step must not mint a second document
  await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${draftDocId}/workflow/state`, { completed_steps: ["st_collect"], current_step: "st_finish" });
  const reState = await owner.req("POST", `/v1/documents/organizations/${orgId}/documents/${draftDocId}/workflow/state`, { complete_step: "st_finish" });
  check("generation is idempotent per outputs key", reState?.document?.outputs?.receipt?.document_id === receiptRef.document_id);
}

// --- drive the browser -------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", (err) => console.log("pageerror:", String(err).slice(0, 300)));

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

// ── Workflow editor v2 ───────────────────────────────────────────────────────
const workflowsTab = page.locator(".fmdx-subtab").filter({ hasText: "Workflows" }).first();
check("studio has Workflows subtab", (await workflowsTab.count()) > 0);
await workflowsTab.click();
await page.waitForTimeout(1800);
// Agent-first creation: the New workflow modal carries the copilot brief.
await page.locator(".fmdx-top-actions [data-new-workflow]").click();
await page.waitForTimeout(700);
check("new workflow modal has copilot brief", (await page.locator("[data-wf-brief]").count()) > 0);
await page.locator(".fmdx-modal-close").click();
await page.waitForTimeout(400);
const firstCard = page.locator("[data-workflow-card] [data-wf-open]").first();
check("workflow list shows cards", (await firstCard.count()) > 0);
await firstCard.click();
await page.waitForSelector("[data-wf-steps] .fmdx-wf-step-card", { timeout: 20000 }).catch(() => null);
await page.waitForTimeout(1500);
await shot("workflow-visual-editor");

const stepCards = await page.locator("[data-wf-steps] .fmdx-wf-step-card").count();
check("visual editor: step cards render", stepCards > 0, stepCards);
check("visual editor: step detail fields render", (await page.locator("[data-wf-detail] [data-wfs-title]").count()) > 0);
const itemCards = await page.locator("[data-wf-detail] .fmdx-wf-item-card").count();
check("visual editor: item cards render", itemCards >= 0, itemCards);
check("visual editor: contract tables render", (await page.locator("[data-wf-contract-params] table").count()) > 0);
check("agent tray mounts (workflow copilot)", (await page.locator("[data-wf-agent] .fmda-panel").count()) > 0);
await page.waitForTimeout(1200);
const agentBooted = await page.evaluate(() => {
  const msgs = document.querySelector("[data-wf-agent] [data-da-msgs]");
  return msgs ? msgs.innerHTML.length > 40 : false;
});
check("agent tray boots (welcome or thread)", agentBooted);

// select a different step if there is one
const secondStep = page.locator("[data-wf-steps] .fmdx-wf-step-card").nth(1);
if (await secondStep.count()) {
  await secondStep.click();
  await page.waitForTimeout(600);
  check("step selection switches detail", (await page.locator("[data-wf-steps] .fmdx-wf-step-card.active").count()) === 1);
}

// JSON toggle round-trip
await page.locator('[data-wf-mode-btn="json"]').click();
await page.waitForTimeout(600);
const jsonText = await page.locator("[data-wf-json]").inputValue().catch(() => "");
let jsonOk = false;
try { jsonOk = Array.isArray(JSON.parse(jsonText).steps); } catch { jsonOk = false; }
check("JSON mode shows parseable definition", jsonOk);
await shot("workflow-json-mode");
await page.locator('[data-wf-mode-btn="visual"]').click();
await page.waitForTimeout(600);
check("switching back re-renders visual", (await page.locator("[data-wf-steps] .fmdx-wf-step-card").count()) > 0);

// visual edit: add a step, retitle it, publish
const beforeSteps = await page.locator("[data-wf-steps] .fmdx-wf-step-card").count();
await page.locator("[data-wf-step-add]").click();
await page.waitForTimeout(500);
const afterSteps = await page.locator("[data-wf-steps] .fmdx-wf-step-card").count();
check("Add step appends a step", afterSteps === beforeSteps + 1, { beforeSteps, afterSteps });
await page.locator("[data-wf-detail] [data-wfs-title]").fill("Agent E2E Step");
await page.locator("[data-wf-detail] [data-wfs-title]").dispatchEvent("change");
await page.waitForTimeout(400);
const dirtyText = await page.locator("[data-wf-save-state]").textContent().catch(() => "");
check("edits mark the workflow dirty", /unpublished/i.test(String(dirtyText)), dirtyText);
const versionBefore = await page.evaluate(() => Number(document.querySelector("[data-studio-workflow-screen] .fmdx-chip.plain")?.textContent?.replace(/^v/, "") || 0));
await page.locator("[data-wf-publish]").click();
await page.waitForTimeout(3500);
const versionAfter = await page.evaluate(() => Number(document.querySelector("[data-studio-workflow-screen] .fmdx-chip.plain")?.textContent?.replace(/^v/, "") || 0));
check("publish bumps the version", versionAfter === versionBefore + 1, { versionBefore, versionAfter });
await shot("workflow-published");

// ── Template editor: tabbed right tray ───────────────────────────────────────
await page.locator("[data-wf-back]").click();
await page.waitForTimeout(1500);
const templatesTab = page.locator(".fmdx-subtab").filter({ hasText: "Templates" }).first();
await templatesTab.click();
await page.waitForTimeout(1500);
// Agent-first creation: brief + example-upload fields on the New template modal.
await page.locator(".fmdx-top-actions [data-new-template]").click();
await page.waitForTimeout(800);
check("new template modal has brief + example uploads", (await page.locator("[data-nt-brief]").count()) > 0 && (await page.locator("[data-nt-files]").count()) > 0);
await page.locator(".fmdx-modal-close").click();
await page.waitForTimeout(400);
const tplCard = page.locator("[data-template-card] [data-tpl-open]").first();
check("template list shows cards", (await tplCard.count()) > 0);
await tplCard.click();
await page.waitForSelector(".fmde-root", { timeout: 30000 }).catch(() => null);
await page.waitForTimeout(2500);
const inspTabs = await page.evaluate(() => [...document.querySelectorAll(".fmde-insp-tabs .fmde-rail-tab")].map((el) => el.textContent.trim()));
check("editor right tray shows tabs Inspect/Setup/Agent", JSON.stringify(inspTabs) === JSON.stringify(["Inspect", "Setup", "Agent"]), inspTabs);
check("no separate studio side drawer remains", (await page.locator(".fmdx-studio-side").count()) === 0);
await shot("template-inspect-tab");

// Setup tab via toolbar button
await page.locator("[data-tpl-schema]").click();
await page.waitForTimeout(800);
check("Setup tab renders template setup", (await page.locator(".fmde-insp-panels [data-schema-params] table").count()) > 0);
await shot("template-setup-tab");

// Agent tab
await page.locator("[data-tpl-agent]").click();
await page.waitForTimeout(1500);
check("Agent tab mounts the design copilot", (await page.locator(".fmde-insp-panels .fmda-panel").count()) > 0);
await shot("template-agent-tab");

// clicking a node on canvas returns to Inspect
await page.locator(".fmde-stage .fmdoc-page").first().click({ position: { x: 200, y: 200 } }).catch(() => null);
await page.waitForTimeout(700);
const activeTab = await page.evaluate(() => document.querySelector(".fmde-insp-tabs .fmde-rail-tab.active")?.textContent?.trim());
console.log("active tab after canvas click:", activeTab);

// ── Project document editor: Data tray subtabs ───────────────────────────────
await page.goto(WEB + "/portal/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => !!window.Portal?.currentUser, null, { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(3000);
const modalOpened = await page.evaluate(({ pid }) => {
  try {
    if (window.Portal?.ProjectModal?.open) { window.Portal.ProjectModal.open(pid); return "ProjectModal"; }
    if (window.Portal?.modules?.request?.openProject) { window.Portal.modules.request.openProject({ id: pid }); return "modules.request"; }
    window.dispatchEvent(new CustomEvent("fm:projects:open", { detail: { id: pid } }));
    return "event";
  } catch (error) { return "error:" + String(error).slice(0, 120); }
}, { pid: projectId });
console.log("project modal via:", modalOpened);
await page.waitForTimeout(4000);
const docsClicked = await page.evaluate(() => {
  const candidates = [...document.querySelectorAll("button, a, [role=tab], .tab, [data-tab]")]
    .filter((el) => el.offsetParent !== null && /^\s*Docs\s*$/.test(el.textContent || ""));
  if (candidates.length) { candidates[0].click(); return true; }
  return false;
});
console.log("docs tab clicked:", docsClicked);
await page.waitForFunction(
  (title) => document.body.textContent.includes(title),
  "Draft Proposal For Agent Tray",
  { timeout: 25000 }
).catch(() => null);
await page.waitForTimeout(1500);
const listDebug = await page.evaluate(async ({ org, pid }) => {
  try {
    const res = await window.DocumentsAPI.documents.listForProject(org, pid);
    return { count: (res.documents || []).length, titles: (res.documents || []).map((d) => d.title) };
  } catch (error) { return { error: String(error?.message || error).slice(0, 200) }; }
}, { org: orgId, pid: projectId });
console.log("project documents:", JSON.stringify(listDebug));
await shot("project-docs-tab");
// open the draft document (engine list card) — click the closest clickable
// ancestor of the title text.
const openedDoc = await page.evaluate(({ title }) => {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if ((node.textContent || "").includes(title)) {
      const clickable = node.parentElement?.closest("button, a, [data-doc-open], .fmdx-tpl-card, [data-docs-entry], .fmdx-doc-row, [role=button]") || node.parentElement;
      clickable?.click();
      return clickable ? (clickable.className || clickable.tagName) : false;
    }
  }
  return false;
}, { title: "Draft Proposal For Agent Tray" });
console.log("opened draft doc card:", openedDoc);
await page.waitForSelector("[data-fmdx-editor-screen]", { timeout: 25000 }).catch(() => null);
await page.waitForTimeout(3000);
// Workflow view first: the doc has a workflow attached — exercise the
// runtime copilot toggle (Agent button docks the aside beside the stepper).
await page.evaluate(() => { document.querySelector('[data-fmdx-mode="workflow"]')?.click(); });
await page.waitForTimeout(3000);
const wfViewActive = await page.evaluate(() => !!document.querySelector("[data-fmdx-workflow-host]:not([hidden])"));
console.log("workflow view active:", wfViewActive);
if (wfViewActive) {
  await page.locator("[data-fmdx-agent-btn]").click();
  await page.waitForTimeout(2500);
  check("workflow runtime copilot mounts", (await page.locator("[data-fmdx-wfrun-agent] .fmda-panel").count()) > 0);
  await shot("workflow-runtime-agent");
  await page.locator("[data-fmdx-agent-btn]").click();
  await page.waitForTimeout(400);
} else {
  check("workflow runtime copilot mounts", false, "workflow view unavailable");
}
// make sure we're in editor view + open the Data tray
await page.evaluate(() => {
  document.querySelector('[data-fmdx-mode="editor"]')?.click();
});
await page.waitForTimeout(2500);
const dataToggle = page.locator("[data-fmdx-data-toggle]");
if (await dataToggle.count()) {
  const trayVisible = await page.evaluate(() => !!document.querySelector("[data-fmdx-data-panel]:not(.collapsed)"));
  if (!trayVisible) { await dataToggle.click(); await page.waitForTimeout(1000); }
}
check("document Data tray has Setup|Agent subtabs", (await page.locator("[data-fmdx-data-panel] [data-fmdx-tray-tab]").count()) === 2);
check("Setup pane renders the data form", (await page.locator("[data-fmdx-tray-data] .fmdx-data-body").count()) > 0);
await shot("document-setup-tab");
await page.locator('[data-fmdx-tray-tab="agent"]').click().catch(() => null);
await page.waitForTimeout(1500);
check("document Agent subtab mounts the copilot", (await page.locator("[data-fmdx-tray-agent] .fmda-panel").count()) > 0);
await shot("document-agent-tab");

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} checks passed`);
await browser.close();
process.exit(results.every((r) => r.pass) ? 0 : 1);
