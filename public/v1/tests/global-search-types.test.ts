/**
 * The global search offers and returns only result types the organization has
 * (platform/search/result-types.ts, docs/architecture/app-experience.md
 * "Global search"). Run against the MVP platform organization: no equipment,
 * no scheduling, channels only behind project notes (its portal tab hidden),
 * and one scope switched on.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let root = "";
let home = "";
let orgId = "";
let cookie = "";

async function request(method: string, url: string, payload?: unknown) {
  const response = await app.inject({ method, url, payload, headers: cookie ? { cookie } : {} });
  const setCookie = ([] as string[]).concat(response.headers["set-cookie"] || []);
  const session = setCookie.find((value) => value.startsWith("fm_platform_session="));
  if (session) cookie = session.split(";")[0] || "";
  return { status: response.statusCode as number, data: response.body ? JSON.parse(response.body) : null };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "fm-global-search-types-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
    FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite",
    PLATFORM_STORAGE_ROOT: path.join(root, "platform"), SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"), CRM_STORAGE_ROOT: path.join(root, "crm"),
    PRICEBOOK_STORAGE_ROOT: path.join(root, "pricebook"), PLATFORM_SESSION_SECRET: "isolated-global-search-types-test-secret",
    FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure-index.sqlite")
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  await import("../platform/widgets/catalog.js");
  // The sandbox seed keeps its capability presets under the working directory.
  home = process.cwd();
  process.chdir(root);
  const service = await import("../signup-sandbox/service.js");
  await service.ensureSeedData();
  const instance = await service.createTestInstance("swf_mvp_platform", { label: "Global search fixture" });
  orgId = String(instance.testOrg.org_id);
  const login = await request("POST", "/v1/platform/auth/login", { email: instance.testOrg.email, password: instance.testOrg.password, organization_id: orgId });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  const storage = await import("../platform/storage.js");
  await storage.upsertDocument(orgId, "projects", {
    id: "project-bluewater",
    data: { title: "Bluewater roof", address: "12 Bluewater Lane" }
  });
  await storage.upsertDocument(orgId, "customers", {
    id: "customer-bluewater",
    data: { name: "Bluewater Owner", email: "owner@bluewater.test", project_id: "project-bluewater" }
  });
});

after(async () => {
  if (app) await app.close();
  process.chdir(home);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
});

test("the MVP organization is offered projects, contacts, settings and users only", async () => {
  const offered = await request("GET", `/v1/platform/organizations/${orgId}/search/types`);
  assert.equal(offered.status, 200, JSON.stringify(offered.data));
  assert.deepEqual(offered.data.types, ["project", "contact", "setting", "user"]);
  assert.deepEqual(offered.data.sources, ["project", "contact", "setting", "user"]);
  for (const type of ["equipment", "event", "document", "scope", "channel"]) assert.ok(!offered.data.types.includes(type), type);
});

test("the search returns only offered types", async () => {
  const found = await request("GET", `/v1/platform/organizations/${orgId}/search?q=Bluewater`);
  assert.equal(found.status, 200, JSON.stringify(found.data));
  assert.deepEqual([...new Set(found.data.results.map((result: any) => result.type))].sort(), ["contact", "project"]);
});

test("a type the organization turns off is never returned, even when asked for", async () => {
  const capabilities = await import("../platform/capabilities.js");
  await capabilities.saveCapabilityValues(orgId, { "platform.contacts": false });
  try {
    const offered = await request("GET", `/v1/platform/organizations/${orgId}/search/types`);
    assert.ok(!offered.data.types.includes("contact"));
    const found = await request("GET", `/v1/platform/organizations/${orgId}/search?q=Bluewater&types=contacts`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.data.results, []);
    const both = await request("GET", `/v1/platform/organizations/${orgId}/search?q=Bluewater&types=projects,contacts`);
    assert.deepEqual([...new Set(both.data.results.map((result: any) => result.type))], ["project"]);
  } finally {
    await capabilities.saveCapabilityValues(orgId, { "platform.contacts": true });
  }
});

test("equipment, events, channels and scopes appear once the organization has them", async () => {
  const capabilities = await import("../platform/capabilities.js");
  const storage = await import("../platform/storage.js");
  const scopes = await import("../scopes/storage.js");
  // Switches alone: channels stay out while their tab is hidden, scopes while only one is on.
  await capabilities.saveCapabilityValues(orgId, { "apps.equipment": true, "platform.scheduling": true });
  let offered = await request("GET", `/v1/platform/organizations/${orgId}/search/types`);
  assert.ok(offered.data.types.includes("equipment"));
  assert.ok(offered.data.types.includes("event"));
  assert.ok(!offered.data.types.includes("channel"));
  assert.ok(!offered.data.types.includes("scope"));

  const global = await storage.readGlobal(orgId);
  await storage.saveGlobal(orgId, { data: { app_placements: { ...(global.data as any).app_placements, "portal.channels": "more" } } });
  const templates = await scopes.listScopeTemplates(orgId, "default", { include_disabled: true });
  const another = templates.find((template) => template.id !== "generic_roofing");
  assert.ok(another, "a preset scope is installed");
  const state = await scopes.readScopeFlagState(orgId, "default");
  await scopes.patchScopeFlags(orgId, { expected_revision: state.revision, flags: { [String(another!.id)]: true } }, "default");
  offered = await request("GET", `/v1/platform/organizations/${orgId}/search/types`);
  assert.ok(offered.data.types.includes("channel"));
  assert.ok(offered.data.types.includes("scope"));
});
