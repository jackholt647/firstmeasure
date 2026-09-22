/**
 * Drives the shared FirstMateSetupWizard shell end-to-end against the local
 * stack (web :8011 + API :3101):
 *
 *  - domains wizard opens from Company Settings -> Domains on the new shell
 *    (fm-wizard classes + 250px step rail)
 *  - step navigation writes the workflow/workflow_step route keys
 *  - browser Back returns a step
 *  - Escape closes through Portal.modals and clears the route keys
 *  - deep link ?workflow=domain_onboarding&workflow_step=domain reopens there
 *  - the Web Editor embedded mount still opens the wizard
 *  - pure shell: synthetic 3-step wizard from page context with validation
 *    gating and a debounced autosave callback
 *
 *   node scripts/setup-wizard-e2e.mjs      (from public/v1)
 *
 * Screenshots go to SETUP_WIZARD_SHOTS_DIR (or ./setup-wizard-shots).
 */
import { chromium } from "playwright-core";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";

const WEB = process.env.WEB_ORIGIN || "http://127.0.0.1:8011";
const API = process.env.API_ORIGIN || "http://127.0.0.1:3101";
const SHOTS = process.env.SETUP_WIZARD_SHOTS_DIR || path.resolve("setup-wizard-shots");
const PREFIX = process.env.SETUP_WIZARD_SHOT_PREFIX || "";
await mkdir(SHOTS, { recursive: true });

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : "  " + JSON.stringify(detail)}`);
};

async function browserPath() {
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
       "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/chromium"];
  for (const c of candidates) { try { await access(c); return c; } catch { /* next */ } }
  throw new Error("no Chrome/Edge found");
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

// --- seed an org with web editor + custom domains ---------------------------
const owner = apiClient();
const orgId = `org_setupwiz_${suffix}`;
const ownerEmail = `owner-${suffix}@example.test`;
const ownerPassword = "correct horse battery staple";
await owner.req("POST", "/v1/platform/auth/register", {
  email: ownerEmail, password: ownerPassword, name: "Owner User",
  company: "Setup Wizard Demo Co", organization_id: orgId
});
await owner.req("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform/apply`, {});
await owner.req("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
  values: { "apps.web_editor": true, "web_editor.custom_domains": true }
});
check("seed: org registered with web editor + custom domains", true, orgId);

// --- browser -----------------------------------------------------------------
const browser = await chromium.launch({ executablePath: await browserPath(), headless: true, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", e.message));
let shotIndex = 0;
async function shot(name) {
  shotIndex += 1;
  const file = path.join(SHOTS, `${PREFIX}${String(shotIndex).padStart(2, "0")}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log("shot:", file);
}
const routeParams = () => page.evaluate(() => {
  const params = new URLSearchParams(window.location.search);
  return { workflow: params.get("workflow") || "", workflow_step: params.get("workflow_step") || "" };
});
const wizardState = () => page.evaluate(() => {
  const backdrop = document.querySelector(".fm-wizard-backdrop, .dm-dialog");
  const active = backdrop?.querySelector(".fm-wizard-step.active, .dm-step.active");
  return {
    open: !!backdrop,
    fmShell: !!document.querySelector('.fm-wizard-backdrop [class*="fm-wizard"]'),
    stepCount: backdrop ? backdrop.querySelectorAll(".fm-wizard-step, .dm-step").length : 0,
    railWidth: (() => {
      const rail = backdrop?.querySelector(".fm-wizard-rail, .dm-rail");
      return rail ? Math.round(rail.getBoundingClientRect().width) : 0;
    })(),
    activeStep: active ? (active.dataset.fmStep || active.dataset.dmStep || "") : "",
    activeLabel: active?.querySelector("strong")?.textContent.trim() || "",
    modalRegistered: !!(window.Portal?.modals?.snapshot?.() || []).find((m) => m.id === "domain-onboarding")
  };
});

await page.goto(WEB + "/portal/login.php", { waitUntil: "domcontentloaded" });
await page.evaluate(async ({ api, email, password, org }) => {
  await fetch(api + "/v1/platform/auth/login", {
    method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, organization_id: org })
  });
}, { api: API, email: ownerEmail, password: ownerPassword, org: orgId });

// --- 1. Company Settings -> Domains, open the wizard -------------------------
await page.goto(WEB + "/portal/?tab=company_settings&sub=domains", { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-new-domain]", { timeout: 45000 });
await shot("domains-pane");
await page.click("[data-new-domain]");
await page.waitForSelector(".fm-wizard-backdrop .fm-wizard, .dm-dialog .dm-wizard", { timeout: 15000 });
const opened = await wizardState();
check("wizard opens with the shared shell (fm-wizard classes)", opened.open && opened.fmShell, opened);
check("step rail renders with steps at 250px", opened.stepCount >= 6 && opened.railWidth === 250, { steps: opened.stepCount, rail: opened.railWidth });
check("wizard opens on the Choose step", opened.activeStep === "choose", opened.activeStep);
check("wizard registered with Portal.modals", opened.modalRegistered);
const routeOpen = await routeParams();
check("open writes workflow/workflow_step route keys", routeOpen.workflow === "domain_onboarding" && routeOpen.workflow_step === "choose", routeOpen);
await shot("wizard-choose");

// --- 2. Step navigation writes the route -------------------------------------
await page.click('[data-path="existing"]');
await page.waitForFunction(() => document.querySelector('.fm-wizard-step.active, .dm-step.active')?.getAttribute("data-fm-step") === "domain"
  || document.querySelector('.dm-step.active')?.getAttribute("data-dm-step") === "domain", null, { timeout: 10000 });
const routeStep = await routeParams();
check("advancing a step writes workflow_step=domain", routeStep.workflow === "domain_onboarding" && routeStep.workflow_step === "domain", routeStep);
const domainStep = await wizardState();
check("existing path shows the 6-step rail", domainStep.stepCount === 6, domainStep.stepCount);
await shot("wizard-domain-step");

// --- 3. Browser Back returns a step ------------------------------------------
await page.goBack();
await page.waitForFunction(() => new URLSearchParams(window.location.search).get("workflow_step") === "choose", null, { timeout: 10000 });
await page.waitForFunction(() => {
  const active = document.querySelector(".fm-wizard-step.active, .dm-step.active");
  return (active?.getAttribute("data-fm-step") || active?.getAttribute("data-dm-step")) === "choose";
}, null, { timeout: 10000 });
check("browser Back returns the wizard to the previous step", true);

// --- 4. Escape closes via Portal.modals and clears route keys ----------------
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".fm-wizard-backdrop, .dm-dialog"), null, { timeout: 10000 });
await page.waitForFunction(() => !new URLSearchParams(window.location.search).get("workflow"), null, { timeout: 10000 });
const routeClosed = await routeParams();
check("Escape closes the wizard and clears workflow keys", !routeClosed.workflow && !routeClosed.workflow_step, routeClosed);
check("modal stack empty after close", await page.evaluate(() => (window.Portal?.modals?.snapshot?.() || []).length === 0));

// --- 5. Deep link reopens at the requested step ------------------------------
let deepLinkOpen = false;
for (let attempt = 0; attempt < 3 && !deepLinkOpen; attempt += 1) {
  await page.goto(WEB + "/portal/?tab=company_settings&sub=domains&workflow=domain_onboarding&workflow_step=domain", { waitUntil: "domcontentloaded" });
  deepLinkOpen = await page.waitForSelector(".fm-wizard-backdrop .fm-wizard, .dm-dialog .dm-wizard", { timeout: 20000 }).then(() => true).catch(() => false);
}
check("deep link opens the wizard overlay", deepLinkOpen);
await page.waitForFunction(() => {
  const active = document.querySelector(".fm-wizard-step.active, .dm-step.active");
  return (active?.getAttribute("data-fm-step") || active?.getAttribute("data-dm-step")) === "domain";
}, null, { timeout: 10000 }).catch(() => null);
const deepLink = await wizardState();
check("deep link reopens the wizard at workflow_step=domain", deepLink.open && deepLink.activeStep === "domain", deepLink);
check("only one wizard overlay exists", await page.evaluate(() => document.querySelectorAll(".fm-wizard-backdrop, .dm-dialog").length === 1));
await shot("wizard-deeplink-domain");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".fm-wizard-backdrop, .dm-dialog"), null, { timeout: 10000 });

// --- 6. Web Editor embedded mount --------------------------------------------
// Drive the real user path (Web Editor -> Domains & Hosting button). A fresh
// org can 404 platform lookups for a moment right after seeding, so retry the
// embedded mount a couple of times before giving up.
let weReady = false;
for (let attempt = 0; attempt < 3 && !weReady; attempt += 1) {
  await page.goto(WEB + "/portal/?tab=web_editor", { waitUntil: "domcontentloaded" });
  weReady = await page.waitForSelector("[data-we-add-domain]", { timeout: 20000 }).then(() => true).catch(() => false);
}
check("web editor tab renders", weReady);
let embeddedReady = false;
for (let attempt = 0; attempt < 3 && !embeddedReady; attempt += 1) {
  await page.click("[data-we-add-domain]");
  embeddedReady = await page.waitForSelector("[data-we-domains] [data-new-domain]", { timeout: 12000 }).then(() => true).catch(() => false);
  if (!embeddedReady) {
    await page.click("[data-we-back]").catch(() => null);
    await page.waitForSelector("[data-we-add-domain]", { timeout: 15000 }).catch(() => null);
  }
}
check("web-editor Domains & Hosting view renders", embeddedReady);
await page.click("[data-we-domains] [data-new-domain]");
await page.waitForSelector(".fm-wizard-backdrop .fm-wizard, .dm-dialog .dm-wizard", { timeout: 15000 });
const embedded = await wizardState();
check("web-editor embedded mount opens the shell wizard", embedded.open && embedded.fmShell && embedded.activeStep === "choose", embedded);
await shot("wizard-web-editor");
await page.keyboard.press("Escape");
await page.waitForFunction(() => !document.querySelector(".fm-wizard-backdrop, .dm-dialog"), null, { timeout: 10000 });

// --- 7. Pure shell: synthetic wizard, validation gating, debounced autosave --
// Let the route-apply from the previous close settle so the synthetic wizard's
// own route write is not suppressed by navigation.applying.
await page.waitForFunction(() => !document.documentElement.classList.contains("fm-route-applying") && !window.Portal?.navigation?.applying, null, { timeout: 10000 }).catch(() => null);
const synthetic = await page.evaluate(() => {
  // The workflow/workflow_step schemas are scope-gated per tab; a real host
  // registers its tab scope via registerApp. Do the same for this test tab.
  window.Portal?.navigation?.registerSchema?.("workflow", { scope: { tab: "web_editor" } });
  window.Portal?.navigation?.registerSchema?.("workflow_step", { scope: { tab: "web_editor" } });
  window.__synthSaves = [];
  window.__synthAllow = false;
  window.__synthSubmitted = false;
  const state = { value: "" };
  window.__synthCtrl = window.FirstMateSetupWizard.open({
    id: "synthetic-shell-test",
    workflowKey: "synthetic_shell",
    title: "Synthetic Wizard",
    icon: "fa-flask",
    state,
    autosave: { debounceMs: 250, save: async (s) => { window.__synthSaves.push({ ...s }); } },
    steps: [
      { id: "one", label: "Step One", render: (el) => { el.innerHTML = '<p data-synth-one>one</p>'; },
        validate: () => (window.__synthAllow ? [] : ["Fill in the required thing"]) },
      { id: "two", label: "Step Two", render: (el) => { el.innerHTML = '<p data-synth-two>two</p>'; } },
      { id: "three", label: "Step Three", render: (el) => { el.innerHTML = '<p data-synth-three>three</p>'; } }
    ],
    submitLabel: "Finish",
    onSubmit: () => { window.__synthSubmitted = true; }
  });
  const rootEl = document.querySelector('[data-fm-wizard="synthetic-shell-test"]');
  const params = new URLSearchParams(window.location.search);
  return {
    open: !!rootEl,
    steps: rootEl ? rootEl.querySelectorAll(".fm-wizard-step").length : 0,
    body: !!rootEl?.querySelector("[data-synth-one]"),
    route: { workflow: params.get("workflow") || "", workflow_step: params.get("workflow_step") || "" }
  };
});
check("synthetic shell wizard opens with 3 steps", synthetic.open && synthetic.steps === 3 && synthetic.body, synthetic);
check("synthetic wizard writes its own workflow key", synthetic.route.workflow === "synthetic_shell" && synthetic.route.workflow_step === "one", synthetic.route);

await page.click('[data-fm-wizard="synthetic-shell-test"] [data-fm-next]');
await page.waitForSelector('[data-fm-wizard="synthetic-shell-test"] .fm-wizard-issues', { timeout: 5000 });
const gated = await page.evaluate(() => ({
  issueText: document.querySelector('[data-fm-wizard="synthetic-shell-test"] .fm-wizard-issues')?.textContent.replace(/\s+/g, " ").trim() || "",
  stillOnOne: !!document.querySelector('[data-fm-wizard="synthetic-shell-test"] [data-synth-one]')
}));
check("Continue is blocked by validate issues (issue list shown)", gated.stillOnOne && /required thing/.test(gated.issueText), gated);

await page.evaluate(() => { window.__synthAllow = true; });
await page.click('[data-fm-wizard="synthetic-shell-test"] [data-fm-next]');
await page.waitForSelector('[data-fm-wizard="synthetic-shell-test"] [data-synth-two]', { timeout: 5000 });
check("Continue advances once validation passes", true);

// Debounced autosave: two rapid touches -> exactly one save call.
await page.evaluate(() => {
  window.__synthCtrl.getState().value = "first";
  window.__synthCtrl.ctx.touch();
  window.__synthCtrl.getState().value = "second";
  window.__synthCtrl.ctx.touch();
});
await page.waitForTimeout(700);
const saves = await page.evaluate(() => window.__synthSaves.map((s) => s.value));
check("autosave fires once (debounced) with the latest state", saves.length === 1 && saves[0] === "second", saves);

await page.evaluate(() => window.__synthCtrl.close());
await page.waitForFunction(() => !document.querySelector('[data-fm-wizard="synthetic-shell-test"]'), null, { timeout: 5000 });
const synthClosed = await page.evaluate(() => {
  const params = new URLSearchParams(window.location.search);
  return { workflow: params.get("workflow") || "", saves: window.__synthSaves.length, submitted: window.__synthSubmitted };
});
check("synthetic close clears its route key", synthClosed.workflow === "", synthClosed);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log("FAILED:", failed.map((r) => r.name)); process.exit(1); }
