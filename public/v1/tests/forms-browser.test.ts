import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

/**
 * Drives the real public embed and the real forms editor in Chrome against the
 * real API: what a visitor and an administrator actually see and click.
 * Set FORMS_SCREENSHOT_DIR to keep screenshots of each surface.
 */

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const LIBRARIES = fileURLToPath(new URL("../../libraries/", import.meta.url));
const FLAGS = {
  platform: { lead_import: true, website_embed_import: true, scheduling: true, documents: true },
  lead_forms: { contact_form: true, appointment_form: true, instant_estimate: true }
};
const TYPES: Record<string, string> = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json" };

let app: any = null;
let browser: Browser | null = null;
let origin = "";
let storageRoot = "";
let originalFetch: typeof globalThis.fetch;
const skip = !existsSync(CHROME) && "Chrome is not installed";

async function shot(page: Page, name: string) {
  if (!process.env.FORMS_SCREENSHOT_DIR) return;
  await mkdir(process.env.FORMS_SCREENSHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(process.env.FORMS_SCREENSHOT_DIR, `${name}.png`), fullPage: true });
}

function cookiesFrom(response: any) {
  const raw = response.headers["set-cookie"];
  return (Array.isArray(raw) ? raw : raw ? [raw] : []).map((entry: string) => entry.split(";")[0]!).map((pair: string) => ({ name: pair.slice(0, pair.indexOf("=")), value: pair.slice(pair.indexOf("=") + 1) }));
}

async function registerOrg() {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/platform/auth/register",
    payload: { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner User", company: "Forms Browser Org", organization_id: `org_formsui_${suffix}`, global: { app_flags: FLAGS } }
  });
  assert.equal(response.statusCode < 400, true, response.body);
  const orgId = response.json().organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const cookies = cookiesFrom(response);
  const header = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const csrf = decodeURIComponent(cookies.find((cookie) => cookie.name.endsWith("_csrf"))?.value || "");
  const call = async (method: string, url: string, payload?: unknown) => {
    const result = await app.inject({ method, url, payload, headers: { cookie: header, ...(method === "GET" ? {} : { "x-platform-csrf": csrf }) } });
    assert.ok(result.statusCode < 400, `${method} ${url}: ${result.statusCode} ${result.body}`);
    return result.json();
  };
  return { orgId, cookies, call };
}

async function publishedForm(org: Awaited<ReturnType<typeof registerOrg>>, template: string, edit?: (definition: any) => void) {
  let form = (await org.call("POST", `/v1/forms/organizations/${org.orgId}/forms`, { template })).form;
  if (edit) {
    edit(form.definition);
    form = (await org.call("PATCH", `/v1/forms/organizations/${org.orgId}/forms/${form.id}`, { definition: form.definition })).form;
  }
  return (await org.call("POST", `/v1/forms/organizations/${org.orgId}/forms/${form.id}/publish`, {})).form;
}

/** Serves the libraries and two host pages from the API's own origin. */
async function newContext(viewport = { width: 1280, height: 900 }): Promise<BrowserContext> {
  const context = await browser!.newContext({ viewport });
  await context.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ body: "", contentType: "text/css" }));
  await context.route(`${origin}/libraries/**`, async (route) => {
    const file = path.join(LIBRARIES, decodeURIComponent(new URL(route.request().url()).pathname.replace(/^\/libraries\//, "")));
    if (!file.startsWith(LIBRARIES) || !existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ body: await readFile(file), contentType: TYPES[path.extname(file)] || "application/octet-stream" });
  });
  // On localhost the embed targets the conventional API port; point that at this test server.
  await context.route("http://127.0.0.1:3101/v1/forms/**", (route) => route.continue({ url: route.request().url().replace("http://127.0.0.1:3101", origin) }));
  await context.route(`${origin}/t/embed*`, (route) => {
    const key = new URL(route.request().url()).searchParams.get("k") || "";
    return route.fulfill({ contentType: "text/html", body: `<!doctype html><html><!-- No charset on purpose: third-party pages are not always UTF-8. --><body style="margin:0;padding:24px;background:#f3f5f8;font-family:Georgia,serif"><h1 style="color:red">Host page heading</h1><script src="/libraries/forms-embed/firstmate-forms-embed.js" data-form="${key}" data-base-url="${origin}/v1/forms"></script></body></html>` });
  });
  await context.route(`${origin}/t/settings`, (route) => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>
      body{margin:0;font-family:Inter,system-ui,Arial,sans-serif;background:#fff}#host{height:100vh;padding:18px;box-sizing:border-box}
      .fm-settings-subtabs{display:flex;align-items:center;gap:4px;width:max-content;max-width:100%;margin:0 0 18px;padding:4px;border:1px solid #e4e7ec;border-radius:999px;background:#f5f7fa}
      .fm-settings-subtab{display:inline-flex;align-items:center;gap:7px;min-height:36px;padding:8px 13px;border:0;border-radius:999px;background:transparent;color:#667085;font:850 11.5px/1 inherit;cursor:pointer}
      .fm-settings-subtab.active{background:#fff;color:#101828;box-shadow:0 1px 4px rgba(16,24,40,.13)}
    </style>${process.env.FORMS_SCREENSHOT_DIR ? '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css">' : ""}</head><body><div id="host"></div>
    <script>window.__APP={formsApiBase:"${origin}/v1/forms"};window.toasts=[];</script>
    <script src="/libraries/forms-api/forms-api.js"></script><script src="/libraries/platform-widgets/forms-widgets.js"></script><script src="/libraries/apps/settings/forms.js"></script></body></html>` }));
  return context;
}

before(async () => {
  if (skip) return;
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-forms-browser-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    EMAIL_OUTBOUND_DISABLED: "1",
    FORMS_RATE_LIMIT_DISABLED: "1",
    FIRSTMEASURE_JOB_WORKERS: "0",
    V1_LOG_LEVEL: "error"
  });
  await mkdir(path.join(process.env.PLATFORM_STORAGE_ROOT!, "config"), { recursive: true });
  await writeFile(path.join(process.env.PLATFORM_STORAGE_ROOT!, "config", "app_flag_defaults.json"), JSON.stringify({ data: { app_flags: FLAGS } }));
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://maps.googleapis.com/") || url.startsWith("https://solar.googleapis.com/")) throw new TypeError("fetch failed");
    return originalFetch(input, init);
  }) as typeof globalThis.fetch;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  origin = (await app.listen({ port: 0, host: "127.0.0.1" })).replace(/\/$/, "");
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
});

after(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  await browser?.close();
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

test("A visitor completes an estimate form: validation, conditional flow, and a priced result", { skip }, async () => {
  const org = await registerOrg();
  const form = await publishedForm(org, "estimate");
  const context = await newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/t/embed?k=${form.public_key}`);
    await page.getByRole("heading", { name: "Get an instant estimate" }).waitFor();
    // Host page styles must not leak into the form.
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('script[data-form]').previousElementSibling.shadowRoot.querySelector('h2')).color"), "rgb(17, 24, 39)");
    await shot(page, "embed-estimate-step1");

    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("This field is required.").waitFor();
    await page.getByLabel("Approximate size").fill("1500");
    await page.getByText("As soon as possible").click();
    await page.getByRole("button", { name: "Next" }).click();

    await page.getByRole("heading", { name: "Where should we send it?" }).waitFor();
    await page.getByRole("button", { name: "See my estimate" }).click();
    await page.getByText("Enter your name.").waitFor();
    await page.getByLabel("Full name").fill("Browser Visitor");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "See my estimate" }).click();
    await page.getByText("Enter a valid email address.").waitFor();
    await page.getByLabel("Email").fill("browser@example.test");
    await page.getByRole("button", { name: "See my estimate" }).click();
    await page.getByText("Please check this box to continue.").waitFor();
    await page.getByText("I agree to be contacted about my estimate.").click();
    await shot(page, "embed-estimate-step2");
    await page.getByRole("button", { name: "See my estimate" }).click();

    await page.getByRole("heading", { name: "Your estimate" }).waitFor();
    assert.match(await page.locator(".ff-option").first().innerText(), /Standard\s+\$6,000\s–\s\$9,000/);
    assert.match(await page.locator(".ff-option").nth(1).innerText(), /Premium\s+\$9,000\s–\s\$13,500/);
    await page.getByText("Size: 1,500 sq ft").waitFor();
    await shot(page, "embed-estimate-result");
    assert.deepEqual(errors, []);

    const projects = await org.call("GET", `/v1/platform/organizations/${org.orgId}/projects`);
    assert.equal(projects.documents.length, 1);
    assert.equal(projects.documents[0].data.form_submission.estimate.low, 6000);
    assert.equal(projects.documents[0].data.lead_source.page_url, `${origin}/t/embed?k=${form.public_key}`);
  } finally { await context.close(); }
});

test("A visitor books an appointment on a phone and the roofing form degrades gracefully without imagery", { skip }, async () => {
  const org = await registerOrg();
  const booking = await publishedForm(org, "appointment", (definition) => { definition.steps[1].items[0].preset_id = "sales"; definition.steps[1].items[0].horizon_days = 365; });
  const roofing = await publishedForm(org, "roofing_instant_estimate");
  const context = await newContext({ width: 390, height: 844 });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/t/embed?k=${booking.public_key}`);
    await page.getByLabel("Full name").fill("Phone Visitor");
    await page.getByLabel("Phone").fill("555 444 5555");
    await page.getByLabel("Address").fill("441 Pine Avenue, Tacoma, WA 98402");
    await page.getByRole("button", { name: "Next" }).click();
    await page.locator(".fmle-slot").first().waitFor({ timeout: 20_000 });
    assert.ok(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "no horizontal scrolling on a phone");
    await page.getByRole("button", { name: "Book appointment" }).click();
    await page.getByText("Choose a day and time.").waitFor();
    await page.locator(".fmle-slot").first().click();
    await page.getByText(/^Selected: /).waitFor();
    assert.equal(await page.evaluate("getComputedStyle(document.querySelector('script[data-form]').previousElementSibling.shadowRoot.querySelector('.fmle-slot.active')).backgroundColor"), await page.evaluate("getComputedStyle(document.querySelector('script[data-form]').previousElementSibling.shadowRoot.querySelector('.ff-btn.primary')).backgroundColor"), "the calendar uses the form's accent color");
    await shot(page, "embed-appointment-phone");
    await page.getByRole("button", { name: "Book appointment" }).click();
    await page.getByRole("heading", { name: "You are booked" }).waitFor({ timeout: 20_000 });
    assert.ok((await page.locator(".ff-when").innerText()).length > 8);
    await shot(page, "embed-appointment-booked");
    const project = (await org.call("GET", `/v1/platform/organizations/${org.orgId}/projects`)).documents[0].data;
    assert.equal(project.events[0].status, "scheduled");

    await page.goto(`${origin}/t/embed?k=${roofing.public_key}`);
    await page.getByLabel("Property address").fill("500 Roof Lane, Tacoma, WA");
    await page.getByRole("button", { name: "Get started" }).click();
    await page.getByText(/could not measure/i).waitFor({ timeout: 20_000 });
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("More than 20 years").click();
    await page.getByText("No visible damage").click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByText("As soon as possible").click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("Full name").fill("Roof Visitor");
    await page.getByLabel("Email").fill("roof@example.test");
    await page.getByText("I agree to be contacted about my roofing estimate.").click();
    await page.getByRole("button", { name: "Get my estimate" }).click();
    await page.getByRole("heading", { name: "Your roof estimate" }).waitFor({ timeout: 20_000 });
    assert.equal(await page.locator(".ff-option").count(), 3);
    await page.getByText(/Roof area: 2,200 sq ft \(a typical size/).waitFor();
    await shot(page, "embed-roofing-result-phone");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("An administrator builds, previews, publishes and shares a form in the editor", { skip }, async () => {
  const org = await registerOrg();
  const context = await newContext({ width: 1440, height: 950 });
  try {
    await context.addCookies(org.cookies.map((cookie) => ({ ...cookie, url: origin })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/t/settings`);
    // Passed as source text: the TypeScript loader's function-name helper does not exist in the page.
    await page.evaluate(`window.FirstMateFormsSettings.mount(document.getElementById("host"), {
      orgId: ${JSON.stringify(org.orgId)},
      branding: { primary: "#0f766e", logo: "" },
      showToast: function (title, body, ok) { window.toasts.push({ title: title, body: body, ok: ok }); },
      confirm: function () { return Promise.resolve(true); },
      onNavigate: function (formId) { window.routedForm = formId; }
    }); undefined`);

    await page.getByRole("heading", { name: "Create your first form" }).waitFor();
    await shot(page, "editor-empty-library");
    await page.getByRole("button", { name: /^Instant estimate/ }).click();
    await page.getByLabel("Form name").waitFor();
    assert.match(await page.evaluate("window.routedForm"), /^form_/);
    const preview = page.locator("[data-preview]");
    await preview.getByRole("heading", { name: "Get an instant estimate" }).waitFor();
    assert.equal(await page.evaluate("document.querySelector('[data-preview] [data-form]').shadowRoot.querySelector('.ff').style.getPropertyValue('--ff-primary')"), "#0f766e", "company colors reach the preview");
    assert.ok(await page.evaluate("!!(document.querySelector('[data-save]').compareDocumentPosition(document.querySelector('[data-status]')) & Node.DOCUMENT_POSITION_FOLLOWING)"), "the save status sits before the status pill");

    // Wording lives in Build as blocks; edits show up in the live preview and autosave.
    assert.deepEqual(await page.getByRole("tab").allInnerTexts().then((tabs) => tabs.map((tab) => tab.trim())), ["Build", "Style", "Pricing", "Settings", "Submissions"]);
    await page.getByRole("button", { name: /Introduction/ }).click();
    await page.getByLabel("Headline", { exact: true }).fill("Fence estimate in 30 seconds");
    await preview.getByRole("heading", { name: "Fence estimate in 30 seconds" }).waitFor();
    await page.getByText("All changes saved").waitFor();

    // Style: colors are always visible; changing one gives the form its own palette, and it can be reverted.
    await page.getByRole("tab", { name: "Style" }).click();
    const ffStyle = (property: string) => page.evaluate(`document.querySelector('[data-preview] [data-form]').shadowRoot.querySelector('.ff').style.getPropertyValue('${property}')`);
    assert.equal(await page.getByRole("button", { name: "Revert to company colors" }).count(), 0);
    await page.locator("[data-path='presentation.style.primary_color'][data-hex]").fill("#7c3aed");
    await page.locator("[data-path='presentation.style.primary_color'][data-hex]").press("Tab");
    await page.getByRole("button", { name: "Revert to company colors" }).waitFor();
    assert.equal(await ffStyle("--ff-primary"), "#7c3aed");
    await page.locator("[data-path='presentation.style.header']").selectOption("band");
    assert.equal(await page.evaluate("document.querySelector('[data-preview] [data-form]').shadowRoot.querySelector('.ff').dataset.header"), "band");
    await shot(page, "editor-style");
    await page.getByRole("button", { name: "Revert to company colors" }).click();
    assert.equal(await ffStyle("--ff-primary"), "#0f766e");
    await page.getByText("All changes saved").waitFor();

    // Build: add a conditional question and see it in the preview.
    await page.getByRole("tab", { name: "Build" }).click();
    await page.locator("[data-step-card]").first().getByRole("button", { name: "Add block" }).click();
    await page.getByRole("button", { name: "Yes / no" }).click();
    await page.getByLabel("Question", { exact: true }).fill("Is there a locked gate?");
    await preview.getByText("Is there a locked gate?").waitFor();
    await page.locator("[data-step-card]").first().getByRole("button", { name: "Add block" }).click();
    await page.getByRole("button", { name: "Short answer" }).click();
    await page.getByLabel("Question", { exact: true }).fill("Gate code");
    await page.locator(".fms-block.open select[data-cond-field=param]").selectOption({ label: "When: Is there a locked gate?" });
    await page.getByText("All changes saved").waitFor();
    assert.equal(await preview.getByText("Gate code").count(), 0, "hidden until its condition matches");
    await preview.getByText("Yes", { exact: true }).click();
    await preview.getByText("Gate code").waitFor();
    await shot(page, "editor-build");

    // Pricing: change a rate, then run the draft in the preview without creating a lead.
    await page.getByRole("tab", { name: "Pricing" }).click();
    await page.locator("[data-path='calculation.pricing.options.0.low_rate']").fill("10");
    await shot(page, "editor-pricing");
    await preview.getByLabel("Approximate size").fill("100");
    await preview.getByLabel("Gate code").fill("1234");
    await preview.getByText("As soon as possible").click();
    await preview.getByRole("button", { name: "Next" }).click();
    await preview.getByLabel("Full name").fill("Preview Person");
    await preview.getByLabel("Email").fill("preview@example.test");
    await preview.getByText("I agree to be contacted about my estimate.").click();
    await preview.getByRole("button", { name: "See my estimate" }).click();
    await preview.getByText("Preview — nothing was submitted").waitFor();
    assert.match(await preview.locator(".ff-option").first().innerText(), /\$1,000/);
    assert.equal((await org.call("GET", `/v1/platform/organizations/${org.orgId}/projects`)).documents.length, 0);

    // Publish, then Settings offers the embed code and link.
    await page.getByRole("button", { name: "Publish", exact: true }).click();
    await page.getByRole("heading", { name: "Embed on any website" }).waitFor();
    await page.locator("[data-status] .fms-pill").getByText("Live").waitFor();
    const snippet = await page.locator("[data-copy-source=embed]").inputValue();
    const key = /data-form="([^"]+)"/.exec(snippet)?.[1] || "";
    assert.ok(key, snippet);
    await shot(page, "editor-settings");
    assert.equal(await page.getByRole("tab", { name: "Settings" }).getAttribute("class").then((value) => /active/.test(value || "")), true);
    assert.equal(await page.getByRole("button", { name: "Published" }).isDisabled(), true);

    // The published form is what a visitor gets; the hosted link works too.
    const visitor = await context.newPage();
    await visitor.goto(`${origin}/libraries/forms-embed/form.html?k=${encodeURIComponent(key)}`);
    await visitor.getByRole("heading", { name: "Fence estimate in 30 seconds" }).waitFor();
    await visitor.close();

    // Submissions is the same widget the assistant can show in a conversation.
    await page.getByRole("tab", { name: "Submissions" }).click();
    await page.getByText("times the form was opened").waitFor();
    await page.getByText("Publish and share the form to start collecting responses.").waitFor({ state: "detached" }).catch(() => undefined);
    await shot(page, "editor-submissions");

    // Back to the library: the form is listed as live.
    await page.getByRole("button", { name: "Forms" }).click();
    await page.locator(".fms-row").getByText("Live").waitFor();
    await shot(page, "editor-library");
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate("window.toasts.filter(function (toast) { return !toast.ok; })"), []);
  } finally { await context.close(); }
});

test("The AI tab is the shared assistant in a conversation about the form, and the editor follows what it saves", { skip }, async () => {
  const org = await registerOrg();
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(org.orgId, { "apps.assistant": true });
  const form = (await org.call("POST", `/v1/forms/organizations/${org.orgId}/forms`, { template: "contact", name: "Assistant form" })).form;
  const context = await newContext({ width: 1440, height: 950 });
  try {
    await context.addCookies(org.cookies.map((cookie) => ({ ...cookie, url: origin })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/t/settings`);
    // The assistant renderer itself is the portal's shared one; this stands in for it and records how the editor mounts it.
    await page.evaluate(`window.PlatformAssistant = { mountSurface: function (container, options) {
      window.ai = options;
      container.innerHTML = '<div data-shared-assistant>Shared assistant</div>';
      return { ready: options.loadContext().then(function (loaded) { window.aiThread = loaded.main_thread; }), destroy: function () { window.aiDestroyed = true; } };
    } };
    window.FirstMateFormsSettings.mount(document.getElementById("host"), {
      orgId: ${JSON.stringify(org.orgId)},
      initialFormId: ${JSON.stringify(form.id)},
      branding: { primary: "#0f766e", logo: "" },
      showToast: function () {},
      confirm: function () { return Promise.resolve(true); }
    }); undefined`);
    const preview = page.locator("[data-preview]");
    await preview.getByRole("heading", { name: "Tell us how we can help" }).waitFor();
    assert.deepEqual(await page.getByRole("tab").allInnerTexts().then((tabs) => tabs.map((tab) => tab.trim())), ["AI", "Build", "Style", "Pricing", "Settings", "Submissions"]);
    assert.match((await page.getByRole("tab", { name: "AI" }).getAttribute("class")) || "", /active/, "a form opens on the AI tab");
    await page.locator("[data-shared-assistant]").waitFor();
    await page.waitForFunction("window.aiThread && window.aiThread.subject_id");
    assert.equal(await page.evaluate("window.aiThread.subject_id"), `form:${form.id}`);
    assert.equal(await page.evaluate("window.aiThread.agent_id"), "assistant");
    assert.deepEqual(await page.evaluate("window.ai.getContext()"), { surface: "forms", formId: form.id, formName: "Assistant form" });
    await shot(page, "editor-ai");

    // An assistant turn saves the draft through the forms tools; when it finishes, the editor and preview follow.
    const current = (await org.call("GET", `/v1/forms/organizations/${org.orgId}/forms/${form.id}`)).form;
    current.definition.presentation.headline = "Built by the assistant";
    await page.evaluate("window.ai.onState({ pending: true })");
    await org.call("PATCH", `/v1/forms/organizations/${org.orgId}/forms/${form.id}`, { definition: current.definition, name: "Renamed by the assistant" });
    await page.evaluate("window.ai.onState({ pending: false })");
    await preview.getByRole("heading", { name: "Built by the assistant" }).waitFor();
    assert.equal(await page.getByLabel("Form name").inputValue(), "Renamed by the assistant");
    await page.getByRole("tab", { name: "Build" }).click();
    await page.getByRole("button", { name: /Introduction/ }).getByText("Built by the assistant").waitFor();
    assert.equal(await page.evaluate("window.aiDestroyed"), true, "leaving the tab releases the assistant surface");

    // Manual edits made afterwards save on top of the assistant's version rather than overwriting it.
    await page.getByRole("button", { name: /Introduction/ }).click();
    await page.getByLabel("Opening line").fill("Edited by hand");
    await page.getByText("All changes saved").waitFor();
    const saved = (await org.call("GET", `/v1/forms/organizations/${org.orgId}/forms/${form.id}`)).form;
    assert.deepEqual([saved.definition.presentation.headline, saved.definition.presentation.subheadline], ["Built by the assistant", "Edited by hand"]);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
