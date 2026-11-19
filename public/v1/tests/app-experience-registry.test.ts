/**
 * The App experience registry and the browser's app manifest name the same
 * apps (docs/architecture/app-experience.md). An app a person can open must be
 * in the registry to be given to anyone, and a registry entry must be an app
 * the browser can open.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { appDefinitions } from "../platform/app-experience/registry.js";
import { DEVICE_TYPES } from "../platform/app-experience/devices.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const libraries = path.resolve(here, "../../libraries");

function manifestApps(definitions: any[] = []) {
  const registered: any[] = [];
  const window: any = { FirstMateEmbeddableApps: { registerManifest: (entry: any) => registered.push(entry), registerApp: (entry: any) => definitions.push(entry), getApp() {} } };
  const context = vm.createContext({ window, document: { currentScript: { src: "https://example.test/libraries/apps/firstmate-apps-manifest.js" } }, URL, console });
  vm.runInContext(readFileSync(path.join(libraries, "apps/firstmate-apps-manifest.js"), "utf8"), context);
  return registered;
}

const OPENABLE_KINDS = new Set(["portal_tab", "project_modal_app"]);

test("every app a person can open is in the registry, and every registry app can be opened", () => {
  const registry = new Map(appDefinitions().map((entry) => [entry.id, entry]));
  const manifest = manifestApps().filter((entry) => OPENABLE_KINDS.has(entry.kind));
  const missing = manifest.filter((entry) => !registry.has(entry.id)).map((entry) => entry.id);
  assert.deepEqual(missing, [], "Add these apps to platform/app-experience/registry.ts");
  const manifestIds = new Set(manifest.map((entry) => entry.id));
  // Contact window views are tabs of the contact window, not runtime apps.
  const unknown = [...registry.keys()].filter((id) => !manifestIds.has(id) && !id.startsWith("contact."));
  assert.deepEqual(unknown, [], "These registry apps have no manifest entry the browser can open");
  for (const entry of manifest) {
    const surface = registry.get(entry.id)!.surface;
    assert.equal(surface, entry.kind === "portal_tab" ? "portal_tab" : "project_modal", `${entry.id} is on the same surface`);
  }
});

test("an app in More apps is listed before its bundle loads", () => {
  // Its bundle loads when it first opens, so the runtime must list it from the manifest alone, or More apps and a
  // link to it (Checklist settings' "See Advanced Controls" for the Automations Hub, GP-72) land on the home tab.
  const definitions: any[] = [];
  const more = manifestApps(definitions).filter((entry) => entry.kind === "portal_tab" && entry.placement === "more").map((entry) => entry.id);
  assert.ok(more.includes("portal.automations_hub"));
  const hidden = more.filter((id) => definitions.find((entry) => entry.id === id)?.visible !== true);
  assert.deepEqual(hidden, [], "Add these to initialAppDefinitions in firstmate-apps-manifest.js with visible:true");
});

test("manifest entries do not decide visibility themselves", () => {
  for (const entry of manifestApps()) {
    const access = entry.access || {};
    for (const key of ["applicationsAny", "applicationsAll", "devices", "requireEntitlement", "permissionsAny", "permissionsAll"]) {
      assert.equal(access[key], undefined, `${entry.id} declares access.${key}; App experience decides who sees it`);
    }
  }
});

test("device types are data with one fallback, and every app names known device types", () => {
  const ids = DEVICE_TYPES.map((type) => type.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(DEVICE_TYPES.filter((type) => !Object.keys(type.match).length).length, 1, "exactly one device type has no sorting rules");
  for (const entry of appDefinitions()) {
    assert.ok(entry.devices.length, `${entry.id} exists on some device`);
    for (const device of entry.devices) assert.ok(ids.includes(device), `${entry.id} names ${device}`);
    for (const option of entry.options) assert.ok(option.key && option.param, `${entry.id} option ${option.key} names its parameter`);
  }
});
