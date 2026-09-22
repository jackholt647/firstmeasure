import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function seedAppFlagDefaults(platformRoot: string) {
  const configDir = path.join(platformRoot, "config");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "app_flag_defaults.json"), JSON.stringify({
    data: {
      app_flags: {
        canvassing: { app: true }
      }
    }
  }));
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-canvassing-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CANVASSING_STORAGE_ROOT = path.join(storageRoot, "canvassing");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  await seedAppFlagDefaults(process.env.PLATFORM_STORAGE_ROOT);

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

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Canvassing Test Org",
    organization_id: `org_canvas_${suffix}`,
    global: {
      app_flags: { canvassing: { app: true } }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function registerStandaloneCanvassing(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `canvas-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Canvas Owner",
    company: "Standalone Canvas Org",
    organization_id: `org_canvas_standalone_${suffix}`,
    membership: {
      role: "owner",
      roles: ["canvasser", "canvassing_manager"],
      permissions: { "*": true, manage_canvassing: true, manage_company_users: true }
    },
    organization: {
      metadata: { signup_app: "canvassing", signup_type: "standalone" }
    },
    global: {
      app_flags: { canvassing: { app: true } },
      product_mode: "canvassing_standalone",
      billing: { status: "not_required_for_canvassing" }
    }
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

test("Generic Platform lead endpoint creates project contacts and notification", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/platform/organizations/${orgId}/leads`, {
    branch_id: "default",
    source_kind: "embedded_form",
    address: "10 Lead Lane",
    contacts: [{ name: "Pat Prospect", email: "pat@example.test", phone: "555-100-2000" }],
    summary: "Website form lead"
  });

  assert.equal(created.project.data.source, "embedded_form");
  const leadProjection = created.project.data.work_projection;
  assert.equal(leadProjection.lifecycle.status, "open");
  assert.equal(leadProjection.active_instances[0].template_id, "sales_pipeline");
  assert.equal(leadProjection.active_instances[0].stage_id, "new_lead_stage");
  assert.equal(created.project.data.contacts[0].email, "pat@example.test");
  assert.equal(created.contacts[0].email, "pat@example.test");
  assert.equal(created.notification.data.context.project_id, created.project.id);
});

test("Canvassing pins stay lightweight and promote into Platform leads", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const settings = await client.request("GET", `/v1/canvassing/organizations/${orgId}/branch/default/settings`);
  assert.ok(settings.settings.statuses.some((status: any) => status.id === "follow_up" && status.label === "Follow Up"));

  const saved = await client.request("POST", `/v1/canvassing/organizations/${orgId}/branch/default/pins`, {
    coordinates: { lat: 47.61, lng: -122.33 },
    status_id: "follow_up",
    address: "22 Canvas Court",
    contact: { name: "Casey Canvas", phone: "555-300-4000" },
    notes: "Interested in a roof quote."
  });
  assert.equal(saved.pin.status_id, "follow_up");
  assert.equal(saved.pin.platform_project_id, "");

  const promoted = await client.request("POST", `/v1/canvassing/organizations/${orgId}/branch/default/pins/${saved.pin.id}/promote`, {
    summary: "Canvasser spoke with homeowner."
  });
  assert.equal(promoted.project.data.source, "canvassing");
  assert.equal(promoted.project.data.address, "22 Canvas Court");
  assert.equal(promoted.pin.status_id, "lead_created");
  assert.equal(promoted.pin.platform_project_id, promoted.project.id);

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(projects.documents.length, 1);
  assert.equal(projects.documents[0].data.lead_source.pin_id, saved.pin.id);
});

test("Disabled branch canvassing blocks operational routes but keeps settings editable", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const disabled = await client.request("PUT", `/v1/canvassing/organizations/${orgId}/branch/default/settings`, {
    data: { enabled: false }
  });
  assert.equal(disabled.settings.enabled, false);

  const response = await client.raw("GET", `/v1/canvassing/organizations/${orgId}/branch/default/pins`);
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /canvassing_disabled/);

  const settings = await client.request("GET", `/v1/canvassing/organizations/${orgId}/branch/default/settings`);
  assert.equal(settings.settings.enabled, false);
});

test("Canvassing app flag hides the canvassing API before branch settings", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: { platform: { expanded_access: true },
        canvassing: { app: false }
      }
    }
  }, { replace: false });

  const flags = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(flags.enabled.canvassing.includes("app"), false);

  const settings = await client.raw("GET", `/v1/canvassing/organizations/${orgId}/branch/default/settings`);
  assert.equal(settings.statusCode, 403);
  assert.match(settings.body, /app_flag_disabled/);
});

test("Standalone canvassing owner can add canvassers and managers", async () => {
  const client = createSessionClient();
  const { orgId } = await registerStandaloneCanvassing(client);

  const created = await client.request("POST", `/v1/canvassing/organizations/${orgId}/branch/default/users`, {
    name: "Door Rep",
    email: `door-rep-${Date.now()}@example.test`,
    role: "canvasser",
    password: "temporary password"
  });
  assert.equal(created.user.role, "canvasser");
  assert.deepEqual(created.user.roles, ["canvasser"]);
  assert.equal(created.invite_pending, false);

  const invited = await client.request("POST", `/v1/canvassing/organizations/${orgId}/branch/default/users`, {
    name: "Canvas Manager",
    email: `canvas-manager-${Date.now()}@example.test`,
    role: "canvassing_manager"
  });
  assert.equal(invited.user.role, "canvassing_manager");
  assert.ok(invited.user.roles.includes("canvassing_manager"));
  assert.equal(invited.invite_pending, true);

  const users = await client.request("GET", `/v1/canvassing/organizations/${orgId}/branch/default/users`);
  assert.ok(users.users.some((user: any) => user.email === created.user.email));
  assert.ok(users.users.some((user: any) => user.email === invited.user.email));
});
