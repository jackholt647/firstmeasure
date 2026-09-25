import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-capabilities-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>, flags: Record<string, Record<string, unknown>> = {}) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Capability Test Org",
    organization_id: `org_capability_${suffix}`
  });
  const orgId = data.organization.id as string;
  if (Object.keys(flags).length) {
    const { saveGlobal } = await import("../platform/storage.js");
    await saveGlobal(orgId, { data: { app_flags: flags } }, { replace: false });
  }
  await enableExpandedPlatformFixture(orgId);
  return { orgId };
}

test("registry is structurally valid and includes every legacy flag plus new app nodes", async () => {
  const { capabilityDefinitions, validateCapabilityRegistry } = await import("../platform/capabilities.js");
  await import("../platform/capability_defs.js");
  validateCapabilityRegistry();
  const definitions = capabilityDefinitions();
  const keys = new Set(definitions.map((definition) => definition.key));
  // Every pre-existing app flag key must still exist.
  const legacyKeys = [
    "platform.lead_import", "platform.website_embed_import", "platform.scheduling", "platform.contacts",
    "platform.project_photos", "platform.photos_feed", "platform.proposals", "platform.project_docs",
    "platform.project_stages_view", "platform.project_assignments", "platform.proposal_agent", "platform.terminology_agent", "platform.materials",
    "platform.manual_project_stage_movement",
    "platform.money", "platform.top_bar", "platform.left_column_apps", "platform.left_column_todo_list", "platform.cobrand_sidebar_logo",
    "platform.new_button_mode", "platform.configuration", "platform.pricebook", "platform.user_modals",
    "platform.user_activity", "platform.storage_limits", "platform.free_storage_gb", "platform.customer_portal",
    "platform.customer_portal_media", "platform.sms_settings", "platform.purchasable_storage",
    "email.inbound_lead_import", "canvassing.app", "calls.app",
    "lead_forms.contact_form", "lead_forms.appointment_form", "lead_forms.instant_estimate",
    "firstmeasure.bonus_upfront_match", "firstmeasure.gutter_reports", "firstmeasure.weather_reports",
    "firstmeasure.measurement_report_summary", "firstmeasure.report_orders", "firstmeasure.report_expedite_options",
    "firstmeasure.report_cancellations", "firstmeasure.report_followup", "firstmeasure.instant_reports",
    "firstmeasure.referral_program_banner"
  ];
  for (const key of legacyKeys) assert.ok(keys.has(key), `missing legacy flag ${key}`);
  // New app nodes for previously unflagged apps.
  for (const key of ["apps.projects", "apps.crm", "apps.payroll", "apps.crew", "apps.checklists", "apps.training", "apps.referrals", "apps.billing", "apps.messaging", "apps.channels", "apps.firstmeasure"]) {
    assert.ok(keys.has(key), `missing app node ${key}`);
  }
  assert.ok(keys.has("channels.sidebar_tab"), "missing integrated Channels sidebar capability");
  assert.ok(keys.has("assistant.sidebar_tab"), "missing integrated Agents sidebar capability");
  assert.equal(definitions.find((definition) => definition.key === "assistant.sidebar_tab")?.default, false);
  const leftColumnDefault = definitions.find((definition) => definition.key === "platform.left_column_default_mode");
  assert.equal(leftColumnDefault?.default, "apps", "Default Left Column should preserve Apps for existing organizations");
  assert.deepEqual(leftColumnDefault?.options?.map(([value]) => value), ["apps", "todo", "channels", "agents"]);
  assert.equal(definitions.find((definition) => definition.key === "platform.cobrand_sidebar_logo")?.default, true);
  assert.equal(definitions.find((definition) => definition.key === "platform.project_assignments")?.default, true);
  assert.equal(definitions.find((definition) => definition.key === "platform.separate_user_section")?.default, false);
  assert.equal(definitions.find((definition) => definition.key === "platform.custom_fields")?.default, true);
  assert.equal(definitions.find((definition) => definition.key === "platform.terminology_settings")?.default, true);
  const discoverableApps = definitions.filter((definition) => definition.kind === "app" && definition.discoverable);
  for (const appNode of discoverableApps) {
    assert.ok(appNode.catalog_stub, `${appNode.key} missing catalog_stub`);
    assert.ok(appNode.catalog_stub.length <= 42, `${appNode.key} catalog_stub is too long for two lines`);
  }
  const newButtonMode = definitions.find((definition) => definition.key === "platform.new_button_mode");
  assert.ok(newButtonMode?.options?.some(([value]) => value === "off"), "New Button Mode must support off");
  // Permission nodes exist and are typed.
  const permissions = definitions.filter((definition) => definition.kind === "permission");
  assert.ok(permissions.length >= 25, "expected a substantial permission catalog");
  for (const node of permissions) {
    assert.ok(node.permission_key, `${node.key} missing permission_key`);
    assert.ok(["read", "write"].includes(node.access as string), `${node.key} missing access`);
  }
  // Every parent/requires edge resolves.
  for (const node of definitions) {
    if (node.parent) assert.ok(keys.has(node.parent), `${node.key} parent ${node.parent} missing`);
    for (const requirement of node.requires) assert.ok(keys.has(requirement), `${node.key} requires ${requirement} missing`);
  }
});

test("solver enforces parent chains and cross dependencies with legacy reason strings", async () => {
  const { resolveCapabilities, capabilityDefaultValues } = await import("../platform/capabilities.js");
  const values = {
    ...capabilityDefaultValues(),
    "platform.expanded_access": true,
    "platform.project_photos": false,
    "platform.photos_feed": true,
    "platform.customer_portal": true,
    "platform.customer_portal_media": true,
    "platform.materials": true,
    "platform.pricebook": false
  };
  const resolution = resolveCapabilities(values);
  assert.equal(resolution.effectiveByKey["platform.photos_feed"], false);
  assert.equal(resolution.reasons["platform.photos_feed"], "requires platform.project_photos");
  assert.equal(resolution.effectiveByKey["platform.customer_portal"], true);
  assert.equal(resolution.effectiveByKey["platform.customer_portal_media"], false);
  assert.equal(resolution.reasons["platform.customer_portal_media"], "requires platform.project_photos");
  assert.equal(resolution.effectiveByKey["platform.materials"], false);
  assert.equal(resolution.reasons["platform.materials"], "requires platform.pricebook");
  // Turning the dependency on flips the dependents without touching their raw values.
  const healed = resolveCapabilities({ ...values, "platform.project_photos": true, "platform.pricebook": true });
  assert.equal(healed.effectiveByKey["platform.photos_feed"], true);
  assert.equal(healed.effectiveByKey["platform.customer_portal_media"], true);
  assert.equal(healed.effectiveByKey["platform.materials"], true);
});

test("app-level parent gates nested firstmeasure features", async () => {
  const { resolveCapabilities, capabilityDefaultValues } = await import("../platform/capabilities.js");
  const off = resolveCapabilities({ ...capabilityDefaultValues(), "apps.firstmeasure": false });
  assert.equal(off.effectiveByKey["firstmeasure.report_orders"], false);
  assert.equal(off.reasons["firstmeasure.report_orders"], "requires apps.firstmeasure");
  assert.equal(off.effectiveByKey["firstmeasure.report_cancellations"], false);
  const on = resolveCapabilities(capabilityDefaultValues());
  assert.equal(on.effectiveByKey["firstmeasure.report_orders"], true);
  assert.equal(on.effectiveByKey["firstmeasure.report_cancellations"], true);
});

test("validateValueSet reports dependency violations without blocking storage", async () => {
  const { validateValueSet } = await import("../platform/capabilities.js");
  assert.deepEqual(validateValueSet({ "platform.new_button_mode": "off" }).violations, []);
  const { violations } = validateValueSet({
    "platform.expanded_access": true,
    "platform.materials": true,
    "platform.pricebook": false,
    "permission.view_projects": true,
    "does.not_exist": true
  });
  const codes = violations.map((violation) => violation.code).sort();
  assert.deepEqual(codes, ["dependency_unsatisfied", "not_settable", "unknown_key"]);
  const dependency = violations.find((violation) => violation.code === "dependency_unsatisfied");
  assert.equal(dependency?.key, "platform.materials");
  assert.equal(dependency?.missing, "platform.pricebook");
});

test("legacy /app-flags API keeps working over the capability registry", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { platform: { proposals: true, project_photos: true } });
  const state = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(state.effective.platform.proposals, true);
  assert.equal(state.effective.platform.photos_feed, false);
  assert.equal(state.disabled_reasons["platform.photos_feed"], "flag_disabled");
  // Groups now include the new apps group with defaults on.
  assert.equal(state.effective.apps.projects, true);
  assert.equal(state.effective.apps.crm, true);
  // Legacy PUT shape still normalizes and persists.
  const updated = await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/app-flags`, {
    app_flags: { platform: { proposals: true, photos_feed: true, project_photos: true, materials: true } }
  });
  assert.equal(updated.effective.platform.photos_feed, true);
  assert.equal(updated.effective.platform.materials, false);
  assert.equal(updated.disabled_reasons["platform.materials"], "requires platform.pricebook");
  // Launcher placement is org configuration alongside flags, but a placement-
  // only write must not reset the capability values.
  const placed = await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/app-flags`, {
    app_placements: {
      "portal.equipment": "more",
      "portal.payroll": "settings",
      "portal.invalid": "somewhere"
    }
  });
  assert.deepEqual(placed.app_placements, {
    "portal.equipment": "more",
    "portal.payroll": "settings"
  });
  assert.equal(placed.effective.platform.photos_feed, true);
  const placedAgain = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(placedAgain.app_placements["portal.equipment"], "more");
  const { isAppFlagEnabled } = await import("../platform/app_flags.js");
  assert.equal(await isAppFlagEnabled(orgId, "platform", "proposals"), true);
  assert.equal(await isAppFlagEnabled(orgId, "platform", "materials"), false);
  assert.equal(await isAppFlagEnabled(orgId, "apps", "crm"), true);
});

test("capabilities API returns definitions, resolves values, and persists flat writes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const state = await client.request("GET", `/v1/platform/organizations/${orgId}/capabilities`);
  assert.ok(Array.isArray(state.definitions) && state.definitions.length > 60);
  assert.equal(state.effective_by_key["apps.projects"], true);
  assert.equal(state.effective_by_key["platform.proposals"], false);
  const updated = await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.proposals": true,
      "platform.proposal_agent": true,
      "platform.advanced_app_menu": true,
      "platform.materials": true,
      "platform.left_column_default_mode": "channels"
    }
  });
  assert.equal(updated.effective_by_key["platform.proposals"], true);
  assert.equal(updated.effective_by_key["platform.proposal_agent"], true);
  assert.equal(updated.effective["platform.advanced_app_menu"], true);
  assert.equal(updated.effective_by_key["platform.materials"], false);
  assert.equal(updated.effective["platform.left_column_default_mode"], "channels");
  assert.equal(updated.reasons["platform.materials"], "requires platform.pricebook");
  assert.ok(updated.violations.some((violation: any) => violation.key === "platform.materials"));
  // The same values must be visible through the legacy API (shared storage).
  const legacy = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(legacy.effective.platform.proposals, true);
  assert.equal(legacy.raw.platform.materials, true);
  assert.equal(legacy.effective.platform.materials, false);
  assert.equal(legacy.effective.platform.left_column_default_mode, "channels");
  // Validate endpoint previews without persisting.
  const preview = await client.request("POST", `/v1/platform/organizations/${orgId}/capabilities/validate`, {
    values: { "platform.pricebook": true }
  });
  assert.equal(preview.effective_by_key["platform.materials"], true);
  const unchanged = await client.request("GET", `/v1/platform/organizations/${orgId}/capabilities`);
  assert.equal(unchanged.effective_by_key["platform.materials"], false);
  assert.equal(unchanged.effective["platform.left_column_default_mode"], "channels");
  assert.equal(unchanged.raw["platform.advanced_app_menu"], true);
  assert.equal(unchanged.effective["platform.advanced_app_menu"], true);
});

test("Agents left-column mode is opt-in and projects through the shared flags API", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const initial = await client.request("GET", `/v1/platform/organizations/${orgId}/capabilities`);
  assert.equal(initial.effective_by_key["assistant.sidebar_tab"], false);
  const updated = await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "assistant.sidebar_tab": true, "platform.left_column_default_mode": "agents" }
  });
  assert.equal(updated.effective_by_key["assistant.sidebar_tab"], true);
  assert.equal(updated.effective["platform.left_column_default_mode"], "agents");
  const legacy = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(legacy.effective.assistant.sidebar_tab, true);
  assert.equal(legacy.effective.platform.left_column_default_mode, "agents");
});

test("built-in presets exist and applying proposals_only reshapes the org", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { canvassing: { app: true }, platform: { scheduling: true } });
  const state = await client.request("GET", `/v1/platform/organizations/${orgId}/capabilities`);
  const presetIds = state.presets.map((preset: any) => preset.id);
  for (const id of ["platform_defaults", "proposals_only", "sales_crm", "field_operations", "full_platform"]) {
    assert.ok(presetIds.includes(id), `missing builtin preset ${id}`);
  }
  const applied = await (await operatorFixtureClient(app, orgId)).request("POST", `/v1/platform/organizations/${orgId}/capabilities/presets/proposals_only/apply`);
  assert.equal(applied.applied_preset.id, "proposals_only");
  // Proposals now ride on the document engine; the legacy proposals app stays off.
  assert.equal(applied.effective_by_key["platform.documents"], true);
  assert.equal(applied.effective_by_key["platform.proposals"], false);
  assert.equal(applied.effective_by_key["platform.customer_portal"], true);
  assert.equal(applied.effective_by_key["canvassing.app"], false);
  assert.equal(applied.effective_by_key["platform.scheduling"], false);
  assert.equal(applied.effective_by_key["apps.crm"], false);
  assert.equal(applied.effective["platform.new_button_mode"], "doc:proposal");
});

test("custom presets: create from current, update, apply elsewhere, delete", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { platform: { proposals: true, pricebook: true, materials: true } });
  const created = await (await operatorFixtureClient(app, orgId)).request("POST", `/v1/platform/organizations/${orgId}/capabilities/presets`, {
    name: "My Custom Stack",
    description: "Proposals with materials",
    from_current: true
  });
  assert.equal(created.preset.name, "My Custom Stack");
  assert.equal(created.preset.builtin, false);
  assert.equal(created.preset.values["platform.proposals"], true);
  assert.equal(created.preset.values["platform.materials"], true);
  const presetId = created.preset.id;

  // Apply the custom preset to a second, empty org.
  const client2 = createSessionClient();
  const { orgId: otherOrgId } = await register(client2);
  const applied = await (await operatorFixtureClient(app, otherOrgId)).request("POST", `/v1/platform/organizations/${otherOrgId}/capabilities/presets/${presetId}/apply`);
  assert.equal(applied.effective_by_key["platform.proposals"], true);
  assert.equal(applied.effective_by_key["platform.materials"], true);

  const renamed = await (await operatorFixtureClient(app, orgId)).request("PATCH", `/v1/platform/organizations/${orgId}/capabilities/presets/${presetId}`, {
    name: "Renamed Stack"
  });
  assert.equal(renamed.preset.name, "Renamed Stack");
  await (await operatorFixtureClient(app, orgId)).request("DELETE", `/v1/platform/organizations/${orgId}/capabilities/presets/${presetId}`);
  const state = await client.request("GET", `/v1/platform/organizations/${orgId}/capabilities`);
  assert.ok(!state.presets.some((preset: any) => preset.id === presetId));
  // Built-ins are protected.
  const forbidden = await (await operatorFixtureClient(app, orgId)).raw("DELETE", `/v1/platform/organizations/${orgId}/capabilities/presets/full_platform`);
  assert.equal(forbidden.statusCode, 400);
});

test("signup preset shapes newly registered organizations", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities/signup-preset`, { preset_id: "proposals_only" });
  try {
    const fresh = createSessionClient();
    const { orgId: freshOrgId } = await register(fresh);
    const state = await fresh.request("GET", `/v1/platform/organizations/${freshOrgId}/capabilities`);
    assert.equal(state.effective_by_key["platform.documents"], true);
    assert.equal(state.effective_by_key["canvassing.app"], false);
    assert.equal(state.signup_preset_id, "proposals_only");
  } finally {
    await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities/signup-preset`, { preset_id: "" });
  }
});

test("app capabilities enforce server-side: training and payroll routes reject when off", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  // Defaults on: both APIs respond.
  await client.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  await client.request("GET", `/v1/payroll/organizations/${orgId}/earnings/me`);
  // Turn the apps off; the same routes must now 403.
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.training": false, "apps.payroll": false }
  });
  const trainingDenied = await client.raw("GET", `/v1/training/organizations/${orgId}/me/courses`);
  assert.equal(trainingDenied.statusCode, 403);
  const payrollDenied = await client.raw("GET", `/v1/payroll/organizations/${orgId}/earnings/me`);
  assert.equal(payrollDenied.statusCode, 403);
  // Sub-feature: studio off but app on blocks manage routes only.
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.training": true, "training.studio": false }
  });
  await client.request("GET", `/v1/training/organizations/${orgId}/me/courses`);
  const studioDenied = await client.raw("GET", `/v1/training/organizations/${orgId}/manage/courses`);
  assert.equal(studioDenied.statusCode, 403);
});

test("can() combines org capability state with user permissions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client, { platform: { proposals: true } });
  const { can } = await import("../platform/auth.js");
  const viewerCtx: any = {
    orgId,
    role: "viewer",
    permissions: { view_projects: true }
  };
  assert.equal(await can(viewerCtx, "platform.proposals"), true);
  assert.equal(await can(viewerCtx, "canvassing.app"), false);
  assert.equal(await can(viewerCtx, "permission.view_projects"), true);
  assert.equal(await can(viewerCtx, "permission.manage_projects"), false);
  assert.equal(await can(viewerCtx, "not.a_real_key"), false);
  // Admin roles pass permission nodes wholesale.
  const adminCtx: any = { orgId, role: "admin", permissions: {} };
  assert.equal(await can(adminCtx, "permission.manage_projects"), true);
  // Org-level off gates the permission even for admins.
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "apps.projects": false });
  assert.equal(await can(adminCtx, "permission.manage_projects"), false);
  assert.equal(await can(viewerCtx, "permission.view_projects"), false);
});
