import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// The Photos, Reports and Customer Portal tours in the browser (docs/architecture/guided-experiences.md), played by
// the real library against the real server definitions and progress: each plays the first time its tab opens, steps
// through the tab's controls to the end, does not play again on its own, and replays from "Show me the tutorial again".
// The tab markup below carries the same hooks the tabs draw; guided-tab-tours.test.ts checks those hooks are in the
// tabs' source.
const dir = await mkdtemp(path.join(os.tmpdir(), "guided-tab-tours-browser-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });

const ORG = "org_tab_tours_browser";
// The tabs, and the features their gated steps name (step eligibility), all on.
const CAPABILITIES = { "platform.project_photos": true, "apps.firstmeasure": true, "platform.customer_portal": true,
  "firstmeasure.measurement_report_summary": true, "firstmeasure.report_followup": true, "scheduling.customer_rescheduling": true, "customer_portal.guest_links": true, "platform.customer_portal_media": true };
const core = await readFile(new URL("../../libraries/guided-experiences/guided-experiences.js", import.meta.url), "utf8");
/** Per-person capability changes over CAPABILITIES. */
const OVERRIDES: Record<string, Record<string, boolean>> = {};
const person = (userId: string) => ({ orgId: ORG, userId, role: "member", permissions: { view_projects: true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: { ...CAPABILITIES, ...OVERRIDES[userId] } } }) as any;

const TABS = {
  photos: {
    id: "photos.tab_tutorial", route: "photos", app: "project.photos",
    html: `<div id="rPhotoFeedMount"><div class="pf-wrap"><div class="pf-toolbar" data-app-header><div class="pf-tools">
      <label class="pf-search"><input type="search" placeholder="Search"></label><div class="pf-density"><button data-density="loose">L</button></div>
      <div class="pf-shown-wrap"><button type="button" class="pf-toolbar-action" data-local-tags>Tags</button></div>
      <button type="button" class="pf-upload" data-photo-feed-upload>Upload</button></div></div>
      <div data-photo-feed-dynamic><div class="pf-grid"><button type="button" class="pf-thumb"><span class="pf-select">✓</span></button><button type="button" class="pf-thumb"><span class="pf-select">✓</span></button></div></div></div></div>`,
    titles: ["Welcome to Photos", "Upload", "Your photos", "Pick several", "Search", "Filter by tag", "You're all set"]
  },
  reports: {
    id: "reports.tab_tutorial", route: "measurements", app: "project.measurements",
    html: `<div class="r-measure-tabs" id="rMeasureTabs"><button data-tab="model">Model</button><button data-tab="summary">Summary</button><button data-tab="standard">Standard</button><button data-tab="customer">Customer</button><button data-tab="changes">Support</button></div>
      <div class="r-measure-body"><div class="r-measure-pane active" data-measure-pane="standard">Report</div></div>`,
    titles: ["Welcome to Reports", "The full report", "Customer version", "3D model", "Summary", "Support", "You're all set"]
  },
  portal: {
    id: "customer_portal.tab_tutorial", route: "customer_portal", app: "project.customer_portal",
    html: `<div class="cpo-wrap"><div class="cpo-head" data-app-header><strong>Customer Portal</strong><a class="cpo-btn" data-cpo-preview>Preview customer portal</a></div>
      <div class="cpo-body"><div class="cpo-main"><section class="cpo-card" data-cpo-link-card><span>https://example.test/p/abc</span><button data-cpo-copy>Copy</button>
      <div class="cpo-options"><label class="cpo-switch" data-cpo-resched-switch><input type="checkbox" data-cpo-rescheduling> Customer can reschedule</label><label class="cpo-switch" data-cpo-guest-switch><input type="checkbox" data-cpo-sharing> Customer can share guest links</label></div></section>
      <section class="cpo-card" data-cpo-media>Media</section></div><aside class="cpo-card" data-cpo-history>History</aside></div></div>`,
    titles: ["Welcome to the Customer Portal", "The customer's link", "Preview", "What the customer can do", "Photos they see", "History", "You're all set"]
  }
};

let browser: Browser;
before(async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Tab tours" });
  await enableExpandedPlatformFixture(ORG, CAPABILITIES);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
});
after(async () => { await browser?.close(); await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

/** The tab's markup, the guides library, and its API answered by the real service as `userId`. */
async function open(tab: (typeof TABS)[keyof typeof TABS], userId: string, html = tab.html): Promise<{ page: Page; errors: string[] }> {
  const service = await import("../guided-experiences/service.js");
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }), errors: string[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("pageerror", (error) => errors.push(error.message));
  // tsx keeps function names with a __name helper that the page does not have.
  await page.addInitScript("window.__name = (fn) => fn;");
  await page.route("https://fm.test/**", async (route) => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/^\/v1\/guided-experiences\/organizations\/[^/]+\/experiences(?:\/([^/]+)\/(events))?$/);
    if (!match) return route.fulfill({ contentType: "text/html", body: "<html></html>" });
    try {
      const result = match[2]
        ? await service.recordGuidedEvent(person(userId), decodeURIComponent(match[1]!), JSON.parse(route.request().postData() || "{}"))
        : await service.availableExperiences(person(userId), { tab: url.searchParams.get("tab") || "", projectId: url.searchParams.get("project_id") || "" });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, ...result }) });
    } catch (error) { return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, message: (error as Error).message }) }); }
  });
  await page.goto("https://fm.test/portal/");
  await page.setContent(`<style>body{margin:0;font:14px Arial}button,label,a,section,aside{display:inline-block;margin:6px;padding:8px;border:1px solid #ccc}#tab{padding:20px}
    .pf-thumb{position:relative;width:120px;height:90px}.pf-select{position:absolute;top:7px;left:7px;width:24px;height:24px;margin:0;padding:0}[data-photo-feed-dynamic]{min-height:120px}
    .cpo-body{display:flex;gap:12px}[data-cpo-history]{width:240px;height:200px}</style>
    <div id="tab">${html}</div><div class="fma-drawer" id="faqHost"><div data-fma="composer"><div class="fma-compose-shell"><textarea></textarea></div></div></div>`);
  await page.evaluate(({ route }) => {
    (window as any).__APP = { userOrgId: "org_tab_tours_browser", platformApiBase: "https://fm.test/v1/platform" };
    (window as any).route = { project: "p1", projectTab: route };
    (window as any).Portal = { navigation: { read: () => (window as any).route }, can: () => true, tabs: { activateTab() {} }, util: { currentBranchId: () => "default" } };
  }, { route: tab.route });
  await page.addScriptTag({ content: core });
  await page.waitForFunction(() => !!(window as any).FirstMateGuides);
  return { page, errors };
}

const opened = (page: Page, app: string) => page.evaluate((appId) => window.dispatchEvent(new CustomEvent("fm:project-tab:opened", { detail: { appId, tabId: appId, isActive: () => true } })), app);
const heading = (page: Page) => page.evaluate(() => document.querySelector(".gx-pop h3")?.textContent?.trim() || "");

/** Presses Next through the tour, checking each targeted step rings its control. Returns the titles shown. */
async function walk(page: Page, experienceId: string) {
  const service = await import("../guided-experiences/service.js"), { experience } = await import("../guided-experiences/registry.js");
  service.ensureGuidedDefinitions();
  const steps = experience(experienceId)!.steps as { title: { text: string }; targets: string[] }[];
  const titles: string[] = [];
  await page.waitForSelector(".gx-pop h3", { timeout: 8000 });
  for (let guard = 0; guard < 20; guard++) {
    const title = await heading(page);
    if (!title) break;
    if (titles.at(-1) !== title) {
      titles.push(title);
      const step = steps.find((entry) => entry.title.text === title)!;
      assert.ok(step, `"${title}" is a step of ${experienceId}`);
      // The popover's text changes first; the ring and the card's placement follow on the next frames.
      const settled = (check: (selectors: string[]) => boolean) => page.waitForFunction(check, step.targets, { timeout: 3000 }).then(() => true, () => false);
      if (step.targets.length) {
        assert.ok(await settled((selectors) => {
          const ring = document.querySelector(".gx-ov-ring");
          if (!ring || ring.hasAttribute("hidden")) return false;
          const box = ring.getBoundingClientRect();
          const target = selectors.map((selector) => document.querySelector(selector)).find(Boolean);
          if (!target) return false;
          const r = target.getBoundingClientRect();
          return Math.abs(box.left + 6 - r.left) < 2 && Math.abs(box.top + 6 - r.top) < 2 && Math.abs(box.width - 12 - r.width) < 2;
        }), `"${title}" rings its control`);
      } else assert.ok(await settled(() => !!document.querySelector(".gx-pop.gx-center")), `"${title}" is a centred card`);
    }
    await page.click(".gx-pop [data-gx=next]");
    await page.waitForFunction((previous) => (document.querySelector(".gx-pop h3")?.textContent?.trim() || "") !== previous, title, { timeout: 8000 });
  }
  await page.waitForFunction(() => !document.querySelector(".gx-pop"));
  return titles;
}

for (const [name, tab] of Object.entries(TABS)) {
  test(`${name}: the tour plays on first view, finishes, stays finished, and replays from the agent's question`, async () => {
    const userId = `user_${name}`;
    const first = await open(tab, userId);
    try {
      await opened(first.page, tab.app);
      assert.deepEqual(await walk(first.page, tab.id), tab.titles);
      const { listEvents } = await import("../guided-experiences/store.js");
      await first.page.waitForTimeout(300);
      const events = (await listEvents(ORG, tab.id)).map((event: any) => event.type);
      assert.ok(events.includes("complete"), "finishing it is recorded");
      assert.deepEqual(first.errors, []);
    } finally { await first.page.close(); }

    // A later visit: the tab opens again, and nothing plays on its own.
    const again = await open(tab, userId);
    try {
      await opened(again.page, tab.app);
      await again.page.waitForTimeout(2000);
      assert.equal(await again.page.locator(".gx-pop").count(), 0, "a finished tour does not play again on its own");
      // The agent's questions for this tab lead with the replay, which plays the tour from the start.
      await again.page.evaluate(() => (window as any).FirstMateGuides.attachAssistant(document.querySelector(".fma-drawer"), { getContext: () => ({ surface: "project", projectId: "p1", tab: (window as any).route.projectTab }), ask: () => {} }));
      await again.page.waitForSelector(".gx-faqs:not([hidden]) .gx-faq");
      assert.equal(await again.page.locator(".gx-faq").first().innerText(), "Show me the tutorial again");
      assert.ok(await again.page.locator(".gx-faq").count() >= 3, "beside the tab's own questions");
      await again.page.locator(".gx-faq").first().click();
      assert.deepEqual(await walk(again.page, tab.id), tab.titles);
      const { listEvents } = await import("../guided-experiences/store.js");
      await again.page.waitForTimeout(300);
      assert.ok((await listEvents(ORG, tab.id)).some((event: any) => event.type === "replay"), "recorded as a replay");
      assert.deepEqual(again.errors, []);
    } finally { await again.page.close(); }
  });
}

test("reports: a report without its model or support yet skips those steps", async () => {
  const html = TABS.reports.html.replace('<button data-tab="model">Model</button>', "").replace('<button data-tab="changes">Support</button>', "");
  const { page, errors } = await open(TABS.reports, "user_reports_pending", html);
  try {
    await opened(page, TABS.reports.app);
    assert.deepEqual(await walk(page, TABS.reports.id), ["Welcome to Reports", "The full report", "Customer version", "Summary", "You're all set"]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("reports: with report follow-up off the Support step is never played, even with its button on the page", async () => {
  OVERRIDES.user_reports_no_support = { "firstmeasure.report_followup": false };
  const { page, errors } = await open(TABS.reports, "user_reports_no_support");
  try {
    await opened(page, TABS.reports.app);
    assert.deepEqual(await walk(page, TABS.reports.id), ["Welcome to Reports", "The full report", "Customer version", "3D model", "Summary", "You're all set"]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
