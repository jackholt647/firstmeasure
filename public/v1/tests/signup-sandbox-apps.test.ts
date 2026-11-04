import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The signup sandbox Apps tab (signup-sandbox/apps.ts, apps-api.ts): every app's On / Offered / Off state read from a
// configuration's own data, each change written back as that data, and the write path through the config library.
const root = await mkdtemp(path.join(os.tmpdir(), "signup-sandbox-apps-"));
Object.assign(process.env, {
  FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite", CONFIG_LIBRARY_SOURCE: "store",
  PLATFORM_STORAGE_ROOT: path.join(root, "platform"), SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"),
  PLATFORM_SESSION_SECRET: "isolated-signup-sandbox-apps-test-secret", FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure-index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(root, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1"
});
const home = process.cwd();
after(async () => {
  process.chdir(home);
  (await import("../config-library/library.js")).stopLibrarySync();
  const { closePlatformFixtureStores } = await import("./helpers/platform-fixture.js");
  await closePlatformFixtureStores();
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

const CONFIGURATION = {
  title: "Apps fixture",
  entry_mode: "signup_first",
  stages: [{ id: "stg_apps_signup", page_id: "spg_firstmate_signup" }],
  app_flags_base: "expanded_access_off",
  defaults: {
    app_flags: { "platform.expanded_access": true, "apps.projects": true, "platform.project_photos": true, "platform.money": true, "money.profitability": true, "apps.channels": true, "platform.scheduling": false },
    settings: { app_offers: ["project.money", "portal.financials"], app_placements: { "portal.channels": "hidden" } }
  }
};

async function fixture() {
  await import("../platform/capability_defs.js");
  const { sandboxConfigurationSchema } = await import("../config-library/kinds/sandbox_configuration.js");
  return sandboxConfigurationSchema.parse(structuredClone(CONFIGURATION));
}
const find = (model: any, id: string) => model.groups.flatMap((group: any) => group.apps).find((app: any) => app.id === id);

test("app states come from the configuration's switches, offers and placements", async () => {
  const { configurationApps } = await import("../signup-sandbox/apps.js");
  const model = await configurationApps(await fixture());
  assert.deepEqual(model.groups.map((group: any) => group.id), ["portal_tab", "project_modal", "contact_modal"]);
  assert.equal(find(model, "project.photos").state, "on");
  assert.equal(find(model, "portal.viewer").state, "on");
  // Offered: in app_offers with its switch on underneath; the offer masks the switch until someone starts it.
  assert.equal(find(model, "project.money").state, "offered");
  assert.equal(find(model, "portal.financials").state, "offered");
  assert.deepEqual(find(model, "project.money").offer_siblings, ["portal.financials"]);
  // Off: a switch off, or a hidden placement.
  assert.equal(find(model, "portal.scheduling").state, "off");
  assert.equal(find(model, "portal.scheduling").reason, "flag_disabled");
  assert.equal(find(model, "portal.channels").state, "off");
  assert.equal(find(model, "portal.channels").reason, "hidden");
  // An app without a switch is always on; one whose offer names a switch that is off is not offered.
  assert.equal(find(model, "portal.company_settings").state, "on");
  assert.deepEqual(find(model, "portal.company_settings").switches, []);
  // Advanced: the features under the app's switches, and its options.
  const money = find(model, "project.money");
  assert.ok(money.features.some((feature: any) => feature.key === "money.take_payment"));
  assert.ok(!money.features.some((feature: any) => feature.key === "platform.money"));
  assert.deepEqual(find(model, "portal.viewer").options.map((option: any) => option.key), ["map_first"]);
});

test("changing a state writes only the switches, offers and placement it means", async () => {
  const { applyAppChange, configurationApps } = await import("../signup-sandbox/apps.js");
  const start = await fixture();

  // On: an offered app's own offer goes, with the offer that shares its switch (Money's tab and Financials page).
  const on = await applyAppChange(start, "project.money", { state: "on" });
  assert.deepEqual(on.defaults.settings.app_offers, []);
  let model = await configurationApps(on);
  assert.equal(find(model, "project.money").state, "on");
  assert.equal(find(model, "portal.financials").state, "on");

  // Offered: its switches are on underneath and it joins the list.
  const offered = await applyAppChange(start, "project.photos", { state: "offered" });
  assert.deepEqual(offered.defaults.settings.app_offers, ["project.money", "portal.financials", "project.photos"]);
  assert.equal(find(await configurationApps(offered), "project.photos").state, "offered");
  await assert.rejects(applyAppChange(start, "portal.scheduling", { state: "offered" }), /cannot be offered/);

  // On from off turns on what the switch depends on; a hidden app is shown again.
  const scheduling = await applyAppChange(start, "portal.scheduling", { state: "on" });
  assert.equal(scheduling.defaults.app_flags["platform.scheduling"], true);
  assert.equal(find(await configurationApps(scheduling), "portal.scheduling").state, "on");
  const channels = await applyAppChange(start, "portal.channels", { state: "on" });
  assert.equal(channels.defaults.settings.app_placements, undefined);
  assert.equal(find(await configurationApps(channels), "portal.channels").state, "on");

  // Off: the switch off and the offer gone. A flag equal to the configuration's base is removed, not written.
  const off = await applyAppChange(start, "project.money", { state: "off" });
  assert.deepEqual(off.defaults.settings.app_offers, []);
  model = await configurationApps(off);
  assert.equal(find(model, "project.money").state, "off");
  assert.equal(find(model, "portal.financials").state, "off");
  const photosOff = await applyAppChange(start, "project.photos", { state: "off" });
  assert.equal(Object.prototype.hasOwnProperty.call(photosOff.defaults.app_flags, "platform.project_photos"), false, "the base already has it off");
  assert.equal(find(await configurationApps(photosOff), "project.photos").state, "off");
  await assert.rejects(applyAppChange(start, "project.field_customer", { state: "off" }), /always on/);

  // Advanced: a feature, an option, a pill and a placement; nothing else moves.
  const feature = (model: any) => find(model, "project.money").features.find((entry: any) => entry.key === "money.take_payment");
  const flipped = !feature(await configurationApps(start)).value;
  const advanced = await applyAppChange(start, "project.money", { features: { "money.take_payment": flipped } });
  assert.equal(advanced.defaults.app_flags["money.take_payment"], flipped);
  assert.equal(feature(await configurationApps(advanced)).value, flipped);
  assert.equal((await applyAppChange(advanced, "project.money", { features: { "money.take_payment": null } })).defaults.app_flags["money.take_payment"], undefined, "null puts it back to the base");
  await assert.rejects(applyAppChange(start, "project.money", { features: { "apps.channels": false } }), /not a feature/);
  const option = await applyAppChange(start, "portal.viewer", { options: { map_first: true } });
  assert.deepEqual(option.role_app_options["portal.viewer"], { map_first: true });
  assert.equal((await applyAppChange(option, "portal.viewer", { options: { map_first: null } })).role_app_options["portal.viewer"], undefined);
  const pill = await applyAppChange(start, "project.photos", { pill: "new" });
  assert.deepEqual((pill.defaults.settings.project_tabs as any).pills, { "project.photos": "new" });
  assert.equal(find(await configurationApps(pill), "project.photos").pill, "new");
  const placed = await applyAppChange(start, "portal.contacts", { placement: "more" });
  assert.deepEqual(placed.defaults.settings.app_placements, { "portal.channels": "hidden", "portal.contacts": "more" });
  assert.deepEqual(start, await fixture(), "the input is never changed");
});

async function session(app: any, orgId: string, email: string, userId: string) {
  const storage = await import("../platform/storage.js");
  const { env } = await import("../src/config/env.js");
  const identity = await storage.findIdentityByEmail(email).catch(() => null) || await storage.createIdentity({ email, name: email });
  await storage.addIdentityMembership(String(identity.id), orgId, userId, "owner").catch(() => undefined);
  await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id, email, status: "active", role: "owner", org_permissions: { level: "owner", items: {} } } });
  const auth = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: "owner" });
  const signature = createHmac("sha256", env.platformSessionSecret).update(auth.sessionId).digest("base64url");
  return (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => app.inject({ method, url, payload,
    headers: { cookie: `fm_platform_session=${auth.sessionId}.${signature}`, "x-platform-csrf": String(auth.session.csrf_token), ...headers } });
}

test("the Apps tab saves a configuration as a config library revision, as a library editor, with expected_revision", async () => {
  const { buildApp } = await import("../src/app.js");
  const app = await buildApp();
  const service = await import("../signup-sandbox/service.js");
  const storage = await import("../platform/storage.js");
  const { saveEntry } = await import("../config-library/writes.js");
  const { libraryEntry } = await import("../config-library/library.js");
  await saveEntry({ kind: "sandbox_configuration", id: "swf_apps_fixture", data: CONFIGURATION }, { kind: "agent", id: "test" }, "create");
  await service.ensureSeedData();
  const instance = await service.createTestInstance("swf_apps_fixture", { label: "Apps fixture" });
  const editor = await session(app, String(instance.testOrg.org_id), String(instance.testOrg.email), String(instance.authContext.userId));
  await storage.createOrganization({ id: "org_plain_apps", name: "Plain" });
  const plain = await session(app, "org_plain_apps", "plain-apps@example.test", "user_plain_apps");

  const read = (await app.inject({ method: "GET", url: "/v1/signup-sandbox/workflows/swf_apps_fixture/apps" })).json();
  assert.equal(read.configuration.source, "library");
  assert.equal(read.configuration.editable, true);
  assert.equal(read.configuration.copy_state, "library");
  assert.equal(read.csrf_cookie, "fm_platform_session_csrf");
  const revision = read.configuration.revision;
  assert.equal(find(read, "project.money").state, "offered");

  const url = "/v1/signup-sandbox/workflows/swf_apps_fixture/apps/project.money";
  assert.equal((await app.inject({ method: "PUT", url, payload: { expected_revision: revision, state: "on" } })).statusCode, 401, "no session, no write");
  assert.equal((await plain("PUT", url, { expected_revision: revision, state: "on" })).statusCode, 403, "only library editors write");
  assert.equal((await editor("PUT", url, { expected_revision: revision, state: "on" }, { "x-platform-csrf": "wrong" })).statusCode, 403, "CSRF is checked");
  assert.equal((await editor("PUT", url, { expected_revision: revision, state: "sideways" })).statusCode, 400);

  const saved = await editor("PUT", url, { expected_revision: revision, state: "on" });
  assert.equal(saved.statusCode, 200, saved.body);
  const body = saved.json();
  assert.equal(body.configuration.revision, revision + 1);
  assert.equal(find(body, "project.money").state, "on");
  assert.deepEqual(libraryEntry<any>("sandbox_configuration", "swf_apps_fixture")!.data.defaults.settings.app_offers, []);
  assert.match(libraryEntry<any>("sandbox_configuration", "swf_apps_fixture")!.updated_by, /@signup-sandbox\.test/);
  // The untouched sandbox copy followed, so the next launch uses it.
  const copy = await (await import("../signup-sandbox/storage.js")).sandboxStore.readWorkflow("swf_apps_fixture");
  assert.deepEqual((copy as any).defaults.settings.app_offers, []);

  // A stale revision is refused with the current one, and nothing is written.
  const stale = await editor("PUT", url, { expected_revision: revision, state: "off" });
  assert.equal(stale.statusCode, 409);
  assert.equal(libraryEntry("sandbox_configuration", "swf_apps_fixture")!.revision, revision + 1);

  // A sandbox-only workflow is shown read-only and is never written here.
  const custom = await service.createWorkflow({ title: "Sandbox only" });
  const customRead = (await app.inject({ method: "GET", url: `/v1/signup-sandbox/workflows/${custom.id}/apps` })).json();
  assert.equal(customRead.configuration.source, "workflow");
  assert.equal(customRead.configuration.editable, false);
  assert.equal((await editor("PUT", `/v1/signup-sandbox/workflows/${custom.id}/apps/project.money`, { expected_revision: 1, state: "on" })).statusCode, 404);
  await app.close();
});
