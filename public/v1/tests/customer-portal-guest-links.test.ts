import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Customer guest links are the organization feature `customer_portal.guest_links` (default on). Off, neither the
 * customer nor staff can make a new link and the portal offers no sharing; links made before keep working until
 * they expire or are revoked, and revoking stays available. Also: the satellite-media route never creates a project.
 */

let app: any = null;
let storageRoot = "";

type Json = Record<string, any>;

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
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-guest-links-test-"));
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
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  if (!appSource.includes("registerWebsitesApi")) {
    const { registerWebsitesApi } = await import("../websites/api.js");
    await app.register(registerWebsitesApi, { prefix: "/v1/websites" });
  }
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

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Guest Links Test Org",
    organization_id: `org_guest_links_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function seedProject(orgId: string, id: string, data: Json = {}) {
  const { upsertProjectWithContacts } = await import("./helpers/project-contacts.js");
  await upsertProjectWithContacts(orgId, {
    id,
    data: { branch_id: "default", title: `${id} Project`, address: `${id} Address`, ...data },
    metadata: { kind: "project" }
  }, { replace: true });
}

async function portalFor(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  const result = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
  return result.portal as Json;
}

async function setGuestLinks(orgId: string, on: boolean) {
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.customer_portal": true, "customer_portal.guest_links": on });
}

async function portalWithSharing(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await seedProject(orgId, projectId, {
    contact_id: `contact_${projectId}`,
    contacts: [{ id: `contact_${projectId}`, primary: true, name: "Taylor Customer", email: "taylor@example.test" }]
  });
  const portal = await portalFor(client, orgId, projectId);
  await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, {
    settings: { ...(portal.settings || {}), sharing: { enabled: true, max_guests: 5, default_expires_days: 30 } }
  });
  return portal;
}

test("guest links on: the customer and staff make links and the portal offers sharing", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await setGuestLinks(orgId, true);
  const { capabilityDefinition } = await import("../platform/capabilities.js");
  const definition: any = capabilityDefinition("customer_portal.guest_links");
  assert.equal(definition?.default, true, "existing organizations keep guest links");
  assert.equal(definition?.parent, "platform.customer_portal");
  const portal = await portalWithSharing(client, orgId, "proj_guest_on");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(payload.access.can_share, true);
  const customer = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, { label: "Spouse", preset: "full_view" });
  assert.equal(customer.statusCode, 201, customer.body);
  const staff = await client.raw("POST", `/v1/platform/organizations/${orgId}/projects/proj_guest_on/customer-portal/shares`, { label: "Adjuster", preset: "photos_only" });
  assert.equal(staff.statusCode, 201, staff.body);
});

test("guest links off: no new links from the customer or staff, no sharing in the portal; existing links keep working and can be revoked", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  await setGuestLinks(orgId, true);
  const portal = await portalWithSharing(client, orgId, "proj_guest_off");
  const made = await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, { label: "Before", preset: "full_view" });
  const staffMade = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_guest_off/customer-portal/shares`, { label: "Staff before", preset: "full_view" });
  const guestToken = new URL(made.url).searchParams.get("id") || "";

  await setGuestLinks(orgId, false);
  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(payload.access.can_share, false, "the customer's portal shows no share button");

  const customer = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, { label: "After", preset: "full_view" });
  assert.equal(customer.statusCode, 403);
  assert.equal(JSON.parse(customer.body).error, "portal_guest_links_disabled");
  const staff = await client.raw("POST", `/v1/platform/organizations/${orgId}/projects/proj_guest_off/customer-portal/shares`, { label: "Staff after", preset: "full_view" });
  assert.equal(staff.statusCode, 403);
  assert.equal(JSON.parse(staff.body).error, "portal_guest_links_disabled");

  const guest = await client.request("GET", `/v1/platform/customer-portals/${guestToken}`);
  assert.equal(guest.access.mode, "guest", "a link made before still opens the portal");

  const revokedByStaff = await client.request("DELETE", `/v1/platform/organizations/${orgId}/projects/proj_guest_off/customer-portal/shares/${made.share.id}`);
  assert.ok(revokedByStaff.share.revoked_at, "staff can still revoke");
  const opened = await client.raw("GET", `/v1/platform/customer-portals/${guestToken}`);
  assert.equal(opened.statusCode, 403, "a revoked link stops working");
  const revokedByCustomer = await client.request("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/shares/${staffMade.share.id}`);
  assert.ok(revokedByCustomer.share.revoked_at, "the customer can still revoke");

  await setGuestLinks(orgId, true);
  const again = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/shares`, { label: "Back on", preset: "full_view" });
  assert.equal(again.statusCode, 201);
});

test("the satellite-media route never creates a project", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const missing = await client.raw("POST", `/v1/platform/organizations/${orgId}/projects/proj_not_there/satellite-media`, {});
  assert.equal(missing.statusCode, 404);
  const { readDocument } = await import("../platform/storage.js");
  await assert.rejects(() => readDocument(orgId, "projects", "proj_not_there"));

  await seedProject(orgId, "proj_plain");
  const plain = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_plain/satellite-media`, {});
  assert.equal(plain.status, "unavailable", "no report and no coordinates: nothing to save yet");
});
