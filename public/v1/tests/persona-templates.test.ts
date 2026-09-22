import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;
type TestClient = ReturnType<typeof createSessionClient>;

const FACTORY_TEMPLATE_IDS = [
  "viewer",
  "manager",
  "admin",
  "super_admin",
  "crew_member",
  "repairman",
  "crew_foreman",
  "supervisor",
  "salesperson"
];

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
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-persona-templates-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closeWorkforceDatabase }] = await Promise.all([
    import("../workforce/storage.js")
  ]);
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `persona-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Persona Test Owner",
    company: "Persona Template Test Org",
    organization_id: `org_persona_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { orgId: String(registered.organization.id), suffix };
}

test("factory persona templates are seeded per organization", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const listed = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/templates`);
  const byId: Record<string, Json> = Object.fromEntries(listed.templates.map((template: Json) => [template.id, template]));
  for (const id of FACTORY_TEMPLATE_IDS) {
    const template = byId[id];
    assert.ok(template, `factory template ${id} missing`);
    assert.equal(template.is_factory, true);
    assert.equal(template.factory_key, id);
    assert.equal(template.modified, false);
    assert.equal(template.status, "active");
    assert.ok(template.revision >= 1);
  }
  assert.deepEqual(byId.crew_member?.application_ids, ["field"]);
  assert.deepEqual(byId.viewer?.application_ids, ["management"]);
  assert.deepEqual(byId.crew_member?.capability_requirements, ["apps.crew"]);
});

test("factory templates are content-identical to the seeded system roles", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const [listedTemplates, listedRoles] = await Promise.all([
    owner.request("GET", `/v1/workforce/organizations/${orgId}/access/templates`),
    owner.request("GET", `/v1/workforce/organizations/${orgId}/access/roles`)
  ]);
  const roles: Record<string, Json> = Object.fromEntries(listedRoles.roles.map((role: Json) => [role.id, role]));
  for (const template of listedTemplates.templates) {
    const role = roles[template.id];
    assert.ok(role, `seeded role ${template.id} missing`);
    assert.equal(role.is_system, true);
    assert.equal(role.name, template.name);
    assert.equal(role.description, template.description);
    assert.deepEqual(role.application_ids, template.application_ids);
    assert.deepEqual(role.permissions, template.permissions);
    assert.deepEqual(role.app_defaults, template.app_defaults);
    assert.equal(role.metadata.level, template.level);
    if (template.metadata.field_mode) {
      assert.equal(role.metadata.field_mode, template.metadata.field_mode);
    }
  }
});

test("custom persona template lifecycle: create, patch, apply, archive", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const created = await owner.request("POST", `/v1/workforce/organizations/${orgId}/access/templates`, {
    id: "delivery_driver",
    name: "Delivery Driver",
    description: "Runs deliveries: schedule and receipts only.",
    application_ids: ["field"],
    level: 12,
    permissions: {
      "crew.dashboard.view": true,
      "crew.projects.view": true,
      "crew.schedule.view": true,
      "crew.receipts.upload": true
    },
    app_defaults: {
      "portal.crew_overview": { enabled: true },
      "portal.crew_schedule": { enabled: true },
      "portal.crew_receipts": { enabled: true }
    },
    capability_requirements: ["apps.crew"],
    metadata: { field_mode: "solo" }
  });
  assert.equal(created.template.id, "delivery_driver");
  assert.equal(created.template.is_factory, false);
  assert.equal(created.template.modified, false);
  assert.equal(created.template.level, 12);

  const patched = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/access/templates/delivery_driver`, {
    expected_revision: created.template.revision,
    description: "Runs deliveries: schedule, receipts, and materials.",
    app_defaults: {
      "portal.crew_overview": { enabled: true },
      "portal.crew_schedule": { enabled: true },
      "portal.crew_receipts": { enabled: true },
      "project.crew_materials": { enabled: true }
    }
  });
  assert.equal(patched.template.revision, created.template.revision + 1);
  assert.equal(patched.template.app_defaults["project.crew_materials"].enabled, true);

  const applied = await owner.request("POST", `/v1/workforce/organizations/${orgId}/access/templates/delivery_driver/apply`);
  assert.equal(applied.created, true);
  assert.equal(applied.role.id, "delivery_driver");
  assert.equal(applied.role.is_system, false);
  assert.deepEqual(applied.role.application_ids, ["field"]);
  assert.equal(applied.role.permissions["crew.schedule.view"], true);
  assert.equal(applied.role.app_defaults["project.crew_materials"].enabled, true);
  assert.equal(applied.role.metadata.persona_template_id, "delivery_driver");
  assert.equal(applied.role.metadata.level, 12);
  assert.ok(Array.isArray(applied.capability_warnings));

  const reapplied = await owner.request("POST", `/v1/workforce/organizations/${orgId}/access/templates/delivery_driver/apply`);
  assert.equal(reapplied.created, false);
  assert.equal(reapplied.role.id, "delivery_driver");

  const roles = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/roles?application=field`);
  assert.ok(roles.roles.some((role: Json) => role.id === "delivery_driver"));

  const archived = await owner.request(
    "DELETE",
    `/v1/workforce/organizations/${orgId}/access/templates/delivery_driver?expected_revision=${patched.template.revision}`
  );
  assert.equal(archived.template.status, "archived");
  const applyArchived = await owner.raw("POST", `/v1/workforce/organizations/${orgId}/access/templates/delivery_driver/apply`);
  assert.equal(applyArchived.statusCode, 400);
  assert.equal(applyArchived.data?.error, "persona_template_archived");
});

test("editing a factory template marks it modified and apply preserves system-role bookkeeping", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const read = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/templates/supervisor`);
  const patched = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/access/templates/supervisor`, {
    expected_revision: read.template.revision,
    permissions: { ...read.template.permissions, "crew.materials.append": false }
  });
  assert.equal(patched.template.modified, true);
  assert.equal(patched.template.is_factory, true);
  assert.equal(patched.template.permissions["crew.materials.append"], false);

  const roleBefore = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/roles/supervisor`);
  assert.equal(roleBefore.role.is_system, true);
  const applied = await owner.request("POST", `/v1/workforce/organizations/${orgId}/access/templates/supervisor/apply`);
  assert.equal(applied.created, false);
  assert.equal(applied.role.is_system, true);
  assert.equal(applied.role.permissions["crew.materials.append"], false);
  // Seed bookkeeping survives template application so future preset upgrades
  // still recognize the role as system-managed.
  assert.equal(applied.role.metadata.system_default, true);
  assert.ok(Number(applied.role.metadata.preset_revision) >= 1);
  assert.equal(applied.role.metadata.persona_template_id, "supervisor");
});

test("stale expected_revision conflicts and access administration is required", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const read = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/templates/crew_member`);
  const conflicting = await owner.raw("PATCH", `/v1/workforce/organizations/${orgId}/access/templates/crew_member`, {
    expected_revision: read.template.revision + 5,
    description: "should not save"
  });
  assert.equal(conflicting.statusCode, 409);
  assert.equal(conflicting.data?.error, "persona_template_revision_conflict");

  const anonymous = createSessionClient();
  const denied = await anonymous.raw("GET", `/v1/workforce/organizations/${orgId}/access/templates`);
  assert.ok(denied.statusCode === 401 || denied.statusCode === 403);
});
