import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Capability defaults, flag defaults, presets, the signup preset and sandbox configurations are config library
// entries (docs/architecture/config-library.md): reads follow the library, saves are checked, and what a host saved
// in its platform configuration before comes across once.
const dir = await mkdtemp(path.join(os.tmpdir(), "config-library-capabilities-"));
Object.assign(process.env, {
  NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", CONFIG_LIBRARY_SOURCE: "store",
  PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"),
  FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1"
});
after(async () => {
  (await import("../config-library/library.js")).stopLibrarySync();
  await (await import("../platform/sql_store.js")).closeSqlStores();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});
const author = { kind: "person" as const, id: "operator@1m8.test" };

test("what a host saved in its platform configuration comes across once, then the library is the only source", async () => {
  const storage = await import("../platform/storage.js");
  await storage.mutatePlatformConfiguration("capability_presets", () => ({ presets: [{ id: "legacy_stack", name: "Legacy stack", description: "Saved before", values: { "platform.materials": true, "no.such_flag": true } }] }));
  await storage.mutatePlatformConfiguration("capability_signup_preset", () => ({ preset_id: "legacy_stack" }));
  await storage.mutatePlatformConfiguration("app_flag_defaults", () => ({ data: { app_flags: { canvassing: { app: true } } } }));
  const capabilities = await import("../platform/capabilities.js");
  const flags = await import("../platform/app_flags.js");
  const legacy = (await capabilities.listCapabilityPresets()).find((preset) => preset.id === "legacy_stack");
  assert.deepEqual([legacy?.builtin, legacy?.base, legacy?.values], [false, "off", { "platform.materials": true }], "imported as a preset that is not built in; an unknown key is dropped");
  assert.equal(await capabilities.readSignupCapabilityPresetId(), "legacy_stack");
  assert.equal((await flags.readNewOrganizationAppFlagOverrides()).canvassing?.app, true);
  for (const name of ["capability_presets", "capability_signup_preset", "app_flag_defaults"]) assert.ok((await storage.readPlatformConfiguration(name))?.library_imported_at, `${name} is marked imported`);
  const { listRevisions } = await import("../config-library/writes.js");
  assert.equal((await listRevisions("capability_preset", "legacy_stack"))[0]?.action, "import");

  // Later edits of the old documents are not read.
  await storage.mutatePlatformConfiguration("capability_signup_preset", (current) => ({ ...current, preset_id: "sales_crm" }));
  assert.equal(await capabilities.readSignupCapabilityPresetId(), "legacy_stack");
  await capabilities.setSignupCapabilityPreset("", author);
  assert.equal(await capabilities.readSignupCapabilityPresetId(), "");

  // Saving the flag defaults through the operator path writes the library and (for now) mirrors the old document for
  // the internal PHP console, marked so it is never imported again.
  const record = await flags.saveNewOrganizationAppFlagOverrides({ app_flags: { canvassing: { app: false }, platform: { scheduling: true } } }, author);
  assert.deepEqual(record.data.app_flags, { canvassing: { app: false }, platform: { scheduling: true } });
  const mirror = await storage.readPlatformConfiguration("app_flag_defaults");
  assert.deepEqual([(mirror as any).data.app_flags, Boolean(mirror?.library_imported_at)], [{ canvassing: { app: false }, platform: { scheduling: true } }, true]);
  assert.deepEqual(await flags.readNewOrganizationAppFlagDefaultsRecord(), record);
  assert.equal((await flags.newOrganizationAppFlagDefaults()).platform?.scheduling, true);
});

test("capability defaults are the library entry, laid over the declarations", async () => {
  const capabilities = await import("../platform/capabilities.js");
  const library = await import("../config-library/library.js");
  const { saveLibraryEntry } = await import("../platform/capability-library.js");
  const entry = library.libraryEntry<{ values: Record<string, unknown> }>("capability_defaults", "platform")!;
  assert.equal(capabilities.capabilityDefaultValues()["platform.cobrand_sidebar_logo"], entry.data.values["platform.cobrand_sidebar_logo"]);
  const values = { ...entry.data.values, "platform.cobrand_sidebar_logo": !entry.data.values["platform.cobrand_sidebar_logo"] };
  await saveLibraryEntry("capability_defaults", "platform", { values }, author);
  assert.equal(capabilities.capabilityDefaultValues()["platform.cobrand_sidebar_logo"], values["platform.cobrand_sidebar_logo"], "read at once in this process");
  assert.equal(capabilities.capabilityDefinition("platform.cobrand_sidebar_logo")?.default, values["platform.cobrand_sidebar_logo"]);
  // Every value is checked against its declaration.
  await assert.rejects(() => saveLibraryEntry("capability_defaults", "platform", { values: { ...values, "platform.cobrand_sidebar_logo": "yes" } }, author), /on or off/);
  await assert.rejects(() => saveLibraryEntry("capability_defaults", "platform", { values: { ...values, "platform.no_such_thing": true } }, author), /not a declared capability/);
  await assert.rejects(() => saveLibraryEntry("capability_defaults", "platform", { values: { ...values, "platform.new_button_mode": "nowhere" } }, author), /has no option/);
  // A capability the entry does not name is off.
  const { "platform.cobrand_sidebar_logo": _dropped, ...without } = values;
  await saveLibraryEntry("capability_defaults", "platform", { values: without }, author);
  assert.equal(capabilities.capabilityDefaultValues()["platform.cobrand_sidebar_logo"], false);
  await saveLibraryEntry("capability_defaults", "platform", { values: entry.data.values }, author);
});

test("presets: built-in ones are protected, an edit made elsewhere is a conflict, a base covers the whole registry", async () => {
  const capabilities = await import("../platform/capabilities.js");
  await assert.rejects(() => capabilities.updateCapabilityPreset("full_platform", { name: "Mine" }, author), /Built-in presets/);
  await assert.rejects(() => capabilities.deleteCapabilityPreset("sales_crm", author), /cannot be deleted/);
  const full = await capabilities.readCapabilityPreset("full_platform");
  assert.equal(full.base, "all_on");
  for (const node of capabilities.valueCapabilities()) if (node.type === "boolean") assert.equal(full.values[node.key], true, node.key);
  const { preset } = await capabilities.createCapabilityPreset({ name: "Sales & CRM", values: { "apps.crm": true } }, author);
  assert.equal(preset.id, "sales_crm_2", "a name that matches another preset gets its own id");
  const { saveLibraryEntry } = await import("../platform/capability-library.js");
  const library = await import("../config-library/library.js");
  const before = library.libraryEntry("capability_preset", preset.id)!;
  await capabilities.updateCapabilityPreset(preset.id, { description: "First" }, author);
  // Another save between this process's read and its write: the stale revision is refused.
  await assert.rejects(() => saveLibraryEntry("capability_preset", preset.id, { ...before.data, description: "Stale" }, author, { expected_revision: before.revision }), /Read it again/);
  await capabilities.deleteCapabilityPreset(preset.id, author);
  assert.equal((await capabilities.listCapabilityPresets()).some((entry) => entry.id === preset.id), false);
});

test("sandbox configurations are checked on save; setup inputs have an on-demand deep check", async () => {
  const library = await import("../config-library/library.js");
  const { saveLibraryEntry } = await import("../platform/capability-library.js");
  const { deepCheckSandboxConfiguration } = await import("../config-library/kinds/sandbox_configuration.js");
  const mvp = structuredClone(library.libraryEntry<any>("sandbox_configuration", "swf_mvp_platform")!.data);
  assert.deepEqual(deepCheckSandboxConfiguration(mvp), []);
  const save = (data: unknown) => saveLibraryEntry("sandbox_configuration", "swf_test_config", data, author);
  await assert.rejects(() => save({ ...mvp, setup: [{ action: "no.such.action", input: {} }] }), /no published action/);
  await assert.rejects(() => save({ ...mvp, defaults: { ...mvp.defaults, app_flags: { "platform.no_such_thing": true } } }), /not a declared capability/);
  await assert.rejects(() => save({ ...mvp, defaults: { ...mvp.defaults, settings: { credits_balance: 500 } } }), /money/);
  await assert.rejects(() => save({ ...mvp, role_app_options: { "portal.viewer": { no_such_option: true } } }), /has no option/);
  await assert.rejects(() => save({ ...mvp, defaults: { ...mvp.defaults, settings: { app_offers: ["portal.nothing"] } } }), /cannot be offered|can be offered/);
  assert.match(deepCheckSandboxConfiguration({ ...mvp, setup: [{ action: "sandbox.scopeFlags.only", input: { template_ids: "all" }, on_error: "stop" }] }).join(" "), /setup\.0\.input/);
  const saved = await save({ ...mvp, title: "Test configuration" });
  assert.equal(saved.entry.title, "Test configuration");
});
