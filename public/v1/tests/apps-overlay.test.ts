/**
 * The apps overlay lists only apps a person opens, never offers a hidden app,
 * opens an app instead of a setup modal unless required setup is unfinished,
 * and opens Pricebook full screen (docs/architecture/app-experience.md,
 * "The apps overlay"). The overlay's own functions are taken from
 * portal/scripts/core.js and run against the MVP platform organization's real
 * switches and placements.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { appDefinitions, appIds, launcherAppIds } from "../platform/app-experience/registry.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.resolve(here, "../..");
const [core, manifestSource] = await Promise.all([
  readFile(path.join(publicRoot, "portal/scripts/core.js"), "utf8"),
  readFile(path.join(publicRoot, "libraries/apps/firstmate-apps-manifest.js"), "utf8")
]);

/** The source of one top-level `function name(` in core.js, by brace matching. */
function coreFunction(name: string) {
  const start = core.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `core.js defines ${name}`);
  const open = core.indexOf("{", core.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < core.length; index += 1) {
    if (core[index] === "{") depth += 1;
    if (core[index] === "}" && --depth === 0) return core.slice(start, index + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

function manifestApps() {
  const registered: any[] = [];
  const window: any = { FirstMateEmbeddableApps: { registerManifest: (entry: any) => registered.push(entry), registerApp() {}, getApp() {} } };
  vm.runInContext(manifestSource, vm.createContext({ window, document: { currentScript: { src: "https://example.test/libraries/apps/firstmate-apps-manifest.js" } }, URL, console }));
  return registered;
}

const OVERLAY_FUNCTIONS = ["cleanText", "advancedAppMenuEnabled", "portalAppPlacement", "appSetupDescription", "normalizeAppStatusPills", "launcherAppInExperience", "appLauncherEntries", "launcherSetupPending", "openLauncherEntry"];

type Org = { capabilities: Record<string, unknown>; placements: Record<string, string> };

/**
 * A portal with the overlay's functions. TabRegistry holds the portal tabs the
 * runtime lists for this organization: those whose switch is on.
 */
function portal(org: Org) {
  const on = (key: string) => org.capabilities[key] === true;
  const calls: any[] = [];
  const manifest = manifestApps();
  const window: any = {
    Portal: {
      appExperience: { app_ids: appIds(), launcher_app_ids: launcherAppIds() },
      capabilities: { current: () => ({}), value: (key: string, fallback: unknown) => (key in org.capabilities ? org.capabilities[key] : fallback) },
      appSetup: { run: async (key: string, context: any) => { calls.push(["setup", key, context.mode]); } }
    },
    PlatformAPI: { appFlags: { current: () => ({ app_placements: org.placements }) }, capabilities: { current: () => ({ definitions_by_key: {} }) } },
    FirstMateEmbeddableApps: {
      getApp: (id: string) => manifest.find((app) => app.id === id),
      evaluateAccess: () => ({ reasons: [] })
    }
  };
  const context: any = vm.createContext({
    window,
    TabRegistry: { tabs: new Map() },
    appSetupDefinitions: new Map(),
    appSetupHandlers: new Map(),
    terminologyLabel: (_key: string, fallback: string) => fallback,
    closeAdvancedAppMenu: () => calls.push(["close"]),
    activateTab: (id: string) => calls.push(["open", id]),
    Promise
  });
  vm.runInContext(OVERLAY_FUNCTIONS.map(coreFunction).join("\n"), context);
  for (const app of manifest) {
    if (app.kind !== "portal_tab" || (app.access?.capability && !on(app.access.capability))) continue;
    // Settings registers itself with the settings placement (apps/settings/company.js).
    const placement = app.id === "portal.company_settings" ? "settings" : context.portalAppPlacement(app);
    context.TabRegistry.tabs.set(app.portalTabId, { id: app.portalTabId, appId: app.id, title: app.title, icon: app.icon, placement, access: app.access || {} });
  }
  const declareSetup = (key: string, mode: string, status: string) => {
    context.appSetupDefinitions.set(key, { key, mode, getStatus: () => status });
    context.appSetupHandlers.set(key, () => null);
  };
  return { context, calls, declareSetup, labels: () => [...context.appLauncherEntries().map((entry: any) => String(entry.label))].sort() };
}

let mvp: Org;

test("the MVP platform organization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-apps-overlay-"));
  Object.assign(process.env, { FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite", PLATFORM_STORAGE_ROOT: path.join(root, "platform"), SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"), PLATFORM_SESSION_SECRET: "isolated-apps-overlay-test-secret", FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure-index.sqlite") });
  await import("../platform/capability_defs.js");
  for (const module of ["assistant", "comms", "chat"]) await import(`../${module}/capabilities.js`);
  const service = await import("../signup-sandbox/service.js");
  const storage = await import("../platform/storage.js");
  const capabilities = await import("../platform/capabilities.js");
  await import("../platform/widgets/catalog.js");
  const home = process.cwd();
  process.chdir(root);
  try {
    await service.ensureSeedData();
    const instance = await service.createTestInstance("swf_mvp_platform", { label: "Apps overlay fixture" });
    const orgId = String(instance.testOrg.org_id);
    const { effectiveByKey } = await capabilities.effectiveCapabilities(orgId);
    mvp = { capabilities: effectiveByKey as Record<string, unknown>, placements: ((await storage.readGlobal(orgId)).data as any).app_placements || {} };
  } finally {
    process.chdir(home);
  }
  assert.equal(mvp.capabilities["platform.advanced_app_menu"], true);
  assert.equal(mvp.placements["portal.channels"], "hidden");
});

test("the overlay lists only apps a person opens: MVP shows My Projects, My Contacts, Feed and Pricebook", () => {
  const { labels } = portal(mvp);
  // Not Referrals (a banner), Documents, Project Photos, Materials, Customer
  // Portal or FirstMeasure (project window tabs and switches), the Assistant
  // (header control) or Channels (hidden: it backs project notes).
  assert.deepEqual(labels(), ["Feed", "My Contacts", "My Projects", "Pricebook"]);
});

test("only portal tabs are in the launcher, and Settings and the Assistant opt out", () => {
  const launcher = new Set(launcherAppIds());
  for (const app of appDefinitions()) {
    if (app.surface !== "portal_tab") assert.equal(launcher.has(app.id), false, `${app.id} is not a page of its own`);
  }
  assert.equal(launcher.has("portal.assistant"), false);
  assert.equal(launcher.has("portal.company_settings"), false);
  assert.equal(launcher.has("portal.pricebook"), true);
  assert.equal(launcher.has("portal.viewer"), true);
  // The Assistant stays out even where it is not hidden.
  const { labels } = portal({ ...mvp, placements: {} });
  assert.ok(labels().includes("Channels"), "an app that is on and not hidden is offered");
  assert.ok(!labels().some((label) => /Assistant/.test(label)));
});

test("an app whose placement is hidden is not offered; pinned apps show as pinned", () => {
  const { context } = portal({ ...mvp, placements: { ...mvp.placements, "portal.contacts": "hidden", "portal.photos_feed": "sidebar", "portal.viewer": "more" } });
  const entries = context.appLauncherEntries();
  assert.equal(entries.some((entry: any) => entry.appId === "portal.contacts"), false);
  assert.equal(entries.find((entry: any) => entry.appId === "portal.photos_feed").pinned, true);
  assert.equal(entries.find((entry: any) => entry.appId === "portal.viewer").pinned, false);
  assert.ok(entries.every((entry: any) => entry.pinnable && entry.tabId));
});

test("choosing an app opens it; setup runs only while required setup is unfinished", () => {
  const { context, calls, declareSetup } = portal(mvp);
  const entry = (appId: string) => context.appLauncherEntries().find((item: any) => item.appId === appId);
  // Optional setup that was never started: open the app.
  declareSetup("platform.contacts", "optional", "not_started");
  context.openLauncherEntry(entry("portal.contacts"));
  assert.deepEqual(calls.splice(0), [["close"], ["open", "contacts"]]);
  // Required setup that is complete: open the app.
  declareSetup("platform.photos_feed", "required", "complete");
  context.openLauncherEntry(entry("portal.photos_feed"));
  assert.deepEqual(calls.splice(0), [["close"], ["open", "photos_feed"]]);
  // Required setup not finished: its workflow, not the app and not a catalog modal.
  declareSetup("platform.photos_feed", "required", "in_progress");
  context.openLauncherEntry(entry("portal.photos_feed"));
  assert.deepEqual(calls.splice(0), [["close"], ["setup", "platform.photos_feed", "launch"]]);
  // The overlay never opens the add-apps catalog modal.
  assert.doesNotMatch(coreFunction("renderAdvancedAppMenu"), /openAppCatalogModal/);
});

test("Pricebook opens full screen from the overlay and stays in Settings without it", () => {
  const { context, calls } = portal(mvp);
  const pricebook = context.appLauncherEntries().find((item: any) => item.appId === "portal.pricebook");
  assert.equal(pricebook.placement, "more");
  context.openLauncherEntry(pricebook);
  assert.deepEqual(calls.splice(0), [["close"], ["open", "pricebook"]]);
  const manifest = manifestApps().find((app) => app.id === "portal.pricebook");
  assert.equal(manifest.access.capability, "platform.pricebook");
  assert.equal(manifest.settingsTabId, "pricebook");
  assert.deepEqual([...manifest.dependencies], ["pricebook.bridge"]);
  assert.ok(manifest.bundles.some((bundle: string) => bundle.includes("/apps/pricebook/app.js?v=")));
  // Without the apps overlay, Pricebook is not added to the left column.
  const legacy = portal({ ...mvp, capabilities: { ...mvp.capabilities, "platform.advanced_app_menu": false } });
  assert.equal(legacy.context.TabRegistry.tabs.get("pricebook").placement, "settings");
  // An org that turns Pricebook off loses the page.
  const off = portal({ ...mvp, capabilities: { ...mvp.capabilities, "platform.pricebook": false } });
  assert.equal(off.context.TabRegistry.tabs.has("pricebook"), false);
});

test("the Pricebook page mounts the shared renderer and draws it again when shown", async () => {
  const source = await readFile(path.join(publicRoot, "libraries/apps/pricebook/app.js"), "utf8");
  const registered: any[] = [];
  const mounts: any[] = [];
  const element = () => ({ style: {}, className: "", innerHTML: "", remove() {}, appendChild() {} });
  const window: any = {
    __APP: { userOrgId: "org_1" },
    FirstMateEmbeddableApps: { registerApp: (app: any) => registered.push(app) },
    FirstMatePricebook: { configure: (options: any) => mounts.push(["configure", options.currentOrganizationId()]), mount: (host: any) => { mounts.push(["mount", host.className]); return { destroy: () => mounts.push(["destroy"]) }; } }
  };
  vm.runInContext(source, vm.createContext({ window, document: { createElement: element } }));
  const app = registered.find((entry) => entry.id === "portal.pricebook");
  assert.equal(app.kind, "portal_tab");
  const handle = app.mount({ roots: { main: element() } });
  app.onShow();
  handle.destroy();
  assert.deepEqual(mounts, [["configure", "org_1"], ["mount", "fm-pricebook-page"], ["destroy"], ["configure", "org_1"], ["mount", "fm-pricebook-page"], ["destroy"]]);
});
