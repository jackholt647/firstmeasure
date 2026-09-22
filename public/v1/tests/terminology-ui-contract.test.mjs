import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const company = await readFile(new URL("../../libraries/apps/settings/company.js", import.meta.url), "utf8");
const platformClient = await readFile(new URL("../../libraries/platform-api/platform-api.js", import.meta.url), "utf8");
const manifest = await readFile(new URL("../../libraries/apps/firstmate-apps-manifest.js", import.meta.url), "utf8");
const flags = await readFile(new URL("../platform/app_flags.ts", import.meta.url), "utf8");
const platformApi = await readFile(new URL("../platform/api.ts", import.meta.url), "utf8");
const terminology = await readFile(new URL("../../libraries/platform-terminology/platform-terminology.js", import.meta.url), "utf8");
const portalCore = await readFile(new URL("../../portal/scripts/core.js", import.meta.url), "utf8");
const projectRequest = await readFile(new URL("../../libraries/apps/project-request/app.js", import.meta.url), "utf8");

test("terminology editor is a collapsible searchable table workspace", () => {
  assert.match(company, /<details class="tm-section"/);
  assert.match(company, /<table class="tm-table">/);
  assert.match(company, /data-terminology-search/);
  assert.match(company, /data-terminology-section/);
  assert.match(company, /data-terminology-status-filter/);
  assert.match(company, /data-terminology-expand/);
  assert.match(company, /data-terminology-collapse/);
});

test("terminology filters use replace navigation and registered replace-only keys", () => {
  assert.match(company, /navigation\?\.replace\?\.\(\{/);
  assert.match(manifest, /terminologyQuery:\{ history:'replace' \}/);
  assert.match(manifest, /terminologySection:\{ history:'replace' \}/);
  assert.match(manifest, /terminologyStatus:\{ history:'replace' \}/);
});

test("terminology assistant is default-off and enforced on both client and server", () => {
  assert.match(company, /appFlag\('platform', 'terminology_agent'\)/);
  assert.match(company, /terminologyAgentEnabled \? `<section class="tm-agent"/);
  assert.match(flags, /"platform\.terminology_agent"/);
  assert.match(flags, /terminology_agent: false/);
  assert.match(platformClient, /terminologyAgent:\s*\{/);
  assert.match(platformApi, /isAppFlagEnabled\(orgId, "platform", "terminology_agent"\)/);
  assert.match(platformApi, /runTerminologyAgent\(body\.prompt, body\.catalog\)/);
});

test("assistant applies validated drafts through existing terminology inputs", () => {
  assert.match(company, /data-terminology-id/);
  assert.match(company, /input\.dispatchEvent\(new Event\('input'/);
  assert.match(company, /Nothing is committed until you use Save Terminology/);
  assert.match(company, /data-terminology-save/);
});

test("shared terminology catalog covers registered portal, project, crew, and settings tabs", () => {
  assert.match(terminology, /const CATALOG = \[/);
  assert.match(terminology, /section\('projects'/);
  assert.match(terminology, /section\('money'/);
  assert.match(terminology, /section\('settings'/);
  assert.match(manifest, /terminologyKey: 'projects\.portal_tab'/);
  assert.match(manifest, /terminologyKey: 'money\.project_tab'/);
  assert.match(manifest, /terminologyKey: 'crew\.today_portal_tab'/);
  assert.match(manifest, /terminologyKey: 'checklists\.crew_project_tab'/);
  assert.match(company, /id:'company'[^\n]+term:'settings\.company_tab'/);
  assert.match(company, /id:'billing'[^\n]+term:'billing\.settings_tab'/);
});

test("portal and project tab chrome resolve labels without changing stable ids", () => {
  assert.match(portalCore, /terminologyLabel\(t\.terminologyKey, t\.title\)/);
  assert.match(portalCore, /PlatformTerminology\?\.load/);
  assert.match(projectRequest, /PlatformTerminology\?\.appLabel/);
  assert.match(projectRequest, /terminology\?\.get\?\.\('projects\.map_tab', 'Map'\)/);
});

test("every registered tab declares a terminology key", () => {
  const apps = [];
  const context = {
    window: { FirstMateEmbeddableApps: { registerManifest(app){ apps.push(app); }, registerApp(){} } },
    document: { currentScript:{ src:"https://example.test/libraries/apps/firstmate-apps-manifest.js" } },
    URL
  };
  vm.runInNewContext(manifest, context);
  const tabs = apps.filter((app) => app.kind === "portal_tab" || app.kind === "project_modal_app");
  assert.equal(tabs.length, 31);
  assert.deepEqual(tabs.filter((app) => !app.terminologyKey).map((app) => app.id), []);
});

test("terminology resolver preserves defaults and applies branch overrides", () => {
  class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
  const window = {
    dispatchEvent(){},
    PlatformScheduling:{ DEFAULT_MAPPINGS:{ schema_version:1, labels:{} } }
  };
  vm.runInNewContext(terminology, { window, CustomEvent });
  assert.equal(window.PlatformTerminology.get("money.project_tab"), "Money");
  window.PlatformTerminology.setConfig({ mappings:{ labels:{ money:{ project_tab:"Finances" } } } });
  assert.equal(window.PlatformTerminology.get("money.project_tab"), "Finances");
  assert.equal(window.PlatformTerminology.get("projects.portal_tab"), "My Projects");
});
