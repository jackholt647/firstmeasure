/**
 * What a user reaches today depending on which of the two applications they
 * have: the management application (the main app) and the field application.
 *
 * This is a characterization. It records behavior as it is before the split is
 * removed, including one known bug, so the later steps can change each rule on
 * purpose and see it here. It does not say the rules are right.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture, nextTestPhone } from "./helpers/platform-fixture.js";

type Json = Record<string, any>;
type TestClient = ReturnType<typeof createSessionClient>;
type Person = { userId: string; client: TestClient };

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
    return { statusCode: response.statusCode as number, body: response.body as string, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  /** "200", or the status with the error code: "403 application_access_denied". */
  const outcome = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    return response.statusCode < 400 ? String(response.statusCode) : `${response.statusCode} ${String(response.data?.error || "")}`.trim();
  };
  return { request, raw, outcome };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-app-split-field-user-"));
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
  const [{ closeWorkforceDatabase }, { closeWorkDatabase }, { closePayrollDatabase }] = await Promise.all([
    import("../workforce/storage.js"),
    import("../work/storage.js"),
    import("../payroll/storage.js")
  ]);
  await closeWorkforceDatabase();
  await closeWorkDatabase();
  await closePayrollDatabase();
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
    email: `split-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Split Test Owner",
    company: "App Split Test Org",
    organization_id: `org_split_${suffix}`
  });
  const orgId = String(registered.organization.id);
  await enableExpandedPlatformFixture(orgId);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: { app_flags: { platform: { expanded_access: true, documents: true, materials: true, pricebook: true, money: true, proposals: true } } }
  }, { replace: false });
  return { orgId, suffix };
}

/** A user with exactly these roles and this stored per-application access. */
async function createPerson(owner: TestClient, orgId: string, suffix: string, label: string, roleIds: string[], applicationAccess: Json): Promise<Person> {
  const email = `split-${label}-${suffix}@example.test`;
  const password = `split ${label} password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: `Split ${label}`, status: "active", role: "viewer", send_invite: false }
  });
  const userId = String(created.document.id);
  const profile = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: roleIds,
    application_access: applicationAccess
  });
  assert.deepEqual(profile.user.access_role_ids, roleIds);
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client };
}

async function seedProject(orgId: string, id: string, title: string, assignedUserIds: string[]) {
  const { upsertProjectWithContacts } = await import("./helpers/project-contacts.js");
  await upsertProjectWithContacts(orgId, {
    id,
    data: {
      branch_id: "default",
      title,
      address: `${title} Address`,
      stage: "production",
      contacts: [{ id: `${id}_customer`, name: `${title} Customer`, phone: "555-0100", primary: true }],
      events: [{
        id: `${id}_work`,
        kind: "project_work",
        event_type_default_id: "project_work",
        status: "scheduled",
        date: "2030-01-03",
        assigned_user_ids: assignedUserIds
      }]
    },
    metadata: { kind: "platform_project", branch_id: "default", source: "app_split_field_user_test" }
  }, { replace: true });
}

const APPLICATION_DENIED = "403 application_access_denied";

test("what the management and field applications let a user reach today", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const base = `/v1/platform/organizations/${orgId}`;

  // Only field roles, management off: the plain field user.
  const field = await createPerson(owner, orgId, suffix, "field", ["crew_member"], {
    management: { enabled: false, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "crew_member", permissions: {} }
  });
  // An office role and a field role.
  const both = await createPerson(owner, orgId, suffix, "both", ["viewer", "crew_member"], {
    management: { enabled: true, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "crew_member", permissions: {} }
  });
  // Only an office role.
  const office = await createPerson(owner, orgId, suffix, "office", ["viewer"], {
    management: { enabled: true, role_id: "viewer", permissions: {} },
    field: { enabled: false, role_id: "crew_member", permissions: {} }
  });
  // Only field roles, but the stored management entry still says enabled.
  const leftover = await createPerson(owner, orgId, suffix, "leftover", ["crew_member"], {
    management: { enabled: true, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "crew_member", permissions: {} }
  });
  // A field user who is denied the receipt upload permission.
  const fieldNoReceipts = await createPerson(owner, orgId, suffix, "noreceipts", ["crew_member"], {
    management: { enabled: false, role_id: "viewer", permissions: {} },
    field: { enabled: true, role_id: "crew_member", permissions: { "crew.receipts.upload": false } }
  });
  // A field user whose stored, disabled management entry carries an office permission.
  const fieldWithOfficeGrant = await createPerson(owner, orgId, suffix, "officegrant", ["crew_member"], {
    management: { enabled: false, role_id: "viewer", permissions: { view_contacts: true } },
    field: { enabled: true, role_id: "crew_member", permissions: {} }
  });

  await seedProject(orgId, "split_assigned", "Splitrock Assigned", [field.userId, fieldNoReceipts.userId]);
  await seedProject(orgId, "split_unassigned", "Splitrock Unassigned", []);

  const session = async (person: Person) => (await person.client.request("GET", "/v1/platform/auth/session")).membership as Json;

  await t.test("the applications each user ends up with", async () => {
    const enabled = async (person: Person) => {
      const access = (await session(person)).application_access;
      return { management: access.management.enabled, field: access.field.enabled };
    };
    assert.deepEqual(await enabled(field), { management: false, field: true });
    assert.deepEqual(await enabled(both), { management: true, field: true });
    assert.deepEqual(await enabled(office), { management: true, field: false });
    assert.deepEqual(await enabled(fieldNoReceipts), { management: false, field: true });
  });

  // Routes whose only requirement beyond being signed in is the management
  // application. One or more from each family: media, notifications, action
  // items, canvassing pins, document lists, work plans and lead creation.
  const managementOnly: Array<[string, string, string, unknown?]> = [
    ["media storage", "GET", `${base}/media/storage`],
    ["media item", "GET", `${base}/media/no_such_media`],
    ["notifications", "GET", `${base}/notifications`],
    ["action items", "GET", `${base}/action-items`],
    ["canvassing pins", "GET", `/v1/canvassing/organizations/${orgId}/branch/default/pins`],
    ["document list", "GET", `/v1/documents/organizations/${orgId}/documents`],
    ["work plans", "GET", `/v1/work/organizations/${orgId}/projects/split_unassigned/plans`],
    ["lead creation", "POST", `${base}/leads`, {}]
  ];

  await t.test("a field-only user is refused every management-only route at the application gate", async () => {
    for (const [label, method, url, payload] of managementOnly) {
      assert.equal(await field.client.outcome(method, url, payload), APPLICATION_DENIED, label);
    }
  });

  await t.test("a field-only user reaches the routes that accept either application", async () => {
    assert.equal(await field.client.outcome("GET", `/v1/workforce/organizations/${orgId}/access/me`), "200");
    assert.equal(await field.client.outcome("GET", `${base}/search?q=Splitrock`), "200");
    assert.equal(await field.client.outcome("GET", `${base}/events/poll`), "200");
    assert.equal(await field.client.outcome("GET", `/v1/payments/organizations/${orgId}/receipts`), "200");
  });

  await t.test("a user with an office role and a field role passes the application gate on both sides", async () => {
    for (const [label, method, url, payload] of managementOnly) {
      assert.notEqual(await both.client.outcome(method, url, payload), APPLICATION_DENIED, label);
    }
    // The routes with no further check answer outright.
    assert.equal(await both.client.outcome("GET", `${base}/media/storage`), "200");
    assert.equal(await both.client.outcome("GET", `${base}/notifications`), "200");
    assert.equal(await both.client.outcome("GET", `${base}/action-items`), "200");
    assert.equal(await both.client.outcome("GET", `/v1/workforce/organizations/${orgId}/access/me`), "200");
    assert.equal(await both.client.outcome("GET", `/v1/payments/organizations/${orgId}/receipts`), "200");
  });

  await t.test("permissions are the union of the roles of the enabled applications only", async () => {
    const viewer = (await session(office)).permissions as Json;
    const crew = (await session(field)).permissions as Json;
    const combined = (await session(both)).permissions as Json;
    const granted = (permissions: Json) => Object.keys(permissions).filter(key => permissions[key] === true).sort();
    // The viewer role grants office permissions the field role does not, and the reverse.
    assert.equal(viewer.view_projects, true);
    assert.notEqual(crew.view_projects, true);
    assert.equal(crew["crew.receipts.upload"], true);
    assert.notEqual(viewer["crew.receipts.upload"], true);
    assert.deepEqual(granted(combined), [...new Set([...granted(viewer), ...granted(crew)])].sort());

    // A permission stored under an application that is not enabled does not count.
    const stored = await session(fieldWithOfficeGrant);
    assert.equal(stored.application_access.management.enabled, false);
    assert.equal(stored.application_access.management.permissions.view_contacts, true);
    assert.notEqual(stored.permissions.view_contacts, true);
    assert.equal(await fieldWithOfficeGrant.client.outcome("GET", `${base}/media/storage`), APPLICATION_DENIED);
  });

  await t.test("search shows a field-only user their assigned projects and everyone with management all of them", async () => {
    const found = async (person: Person) => {
      const result = await person.client.request("GET", `${base}/search?q=Splitrock&types=projects`);
      return [...new Set((result.results as Json[]).map(row => String(row.project_id || row.id)))].sort();
    };
    assert.deepEqual(await found(field), ["split_assigned"]);
    assert.deepEqual(await found(office), ["split_assigned", "split_unassigned"]);
    assert.deepEqual(await found(both), ["split_assigned", "split_unassigned"]);
  });

  await t.test("project presence refuses a field-only user a project they are not assigned to", async () => {
    // The route opens a stream once it has authorized, so only refusals are requested here.
    assert.equal(await field.client.outcome("GET", `${base}/presence/project:split_unassigned`), "403 project_access_denied");
    // An unknown scope is a bad request, not an application refusal: the field application is enough to enter.
    assert.equal(await field.client.outcome("GET", `${base}/presence/elsewhere`), "400 invalid_presence_scope");
    // The rule is the management application or assignment; these are the two inputs it reads.
    const { assignedProjectIdsForUser } = await import("../workforce/assignment_scope.js");
    assert.deepEqual([...(await assignedProjectIdsForUser(orgId, field.userId))], ["split_assigned"]);
    assert.deepEqual([...(await assignedProjectIdsForUser(orgId, office.userId))], []);
  });

  await t.test("receipts need the field receipt permission only when the management application is off", async () => {
    const receipts = `/v1/payments/organizations/${orgId}/receipts`;
    assert.equal(await fieldNoReceipts.client.outcome("GET", receipts), "403 crew_permission_denied");
    assert.equal(await fieldNoReceipts.client.outcome("POST", receipts, {}), "403 crew_permission_denied");
    // The office viewer has no field application and no receipt permission, and is let through.
    assert.notEqual((await session(office)).permissions["crew.receipts.upload"], true);
    assert.equal(await office.client.outcome("GET", receipts), "200");
    assert.notEqual(await office.client.outcome("POST", receipts, {}), "403 crew_permission_denied");
  });

  await t.test("message audience follows the applications a user has", async () => {
    const { backgroundAuthContext } = await import("../platform/auth.js");
    const { viewerAudienceGroups } = await import("../channels/service.js");
    const groups = async (person: Person) => viewerAudienceGroups(await backgroundAuthContext(orgId, person.userId)).sort();
    // The audience group ids are stored values ("crew", "office"), not display names.
    assert.deepEqual(await groups(field), ["crew"]);
    assert.deepEqual(await groups(office), ["office"]);
    assert.deepEqual(await groups(both), ["crew"]);
  });

  await t.test("the office to-do list is behind the management application", async () => {
    const todos = `/v1/work/organizations/${orgId}/todos`;
    assert.equal(await field.client.outcome("GET", todos), APPLICATION_DENIED);
    assert.notEqual(await both.client.outcome("GET", todos), APPLICATION_DENIED);
  });

  // KNOWN BUG, to be fixed at step 6 of the application split removal. Do not
  // copy this behavior. A user whose roles are all field roles, but whose
  // stored `application_access.management.enabled` is still true, is treated
  // as having the management application: a saved role list does not turn off
  // an application flag left behind on the user. They pass every gate that asks
  // only for the management application, and the data rules that key off it
  // stop narrowing them to their assigned projects. They gain no office
  // permission, so routes that also ask for a permission still refuse them.
  // When this is fixed, each assertion below should flip to the field-only
  // result asserted above.
  await t.test("KNOWN BUG (fix at step 6): field roles plus a leftover management flag get management access", async () => {
    const membership = await session(leftover);
    assert.deepEqual(membership.access_role_ids, ["crew_member"]);
    assert.equal(membership.application_access.management.enabled, true);
    assert.deepEqual(membership.application_access.management.role_ids, []);
    assert.notEqual(membership.permissions.view_projects, true);

    for (const [label, method, url, payload] of managementOnly) {
      assert.notEqual(await leftover.client.outcome(method, url, payload), APPLICATION_DENIED, label);
    }
    assert.equal(await leftover.client.outcome("GET", `${base}/media/storage`), "200");
    assert.equal(await leftover.client.outcome("GET", `${base}/notifications`), "200");
    assert.equal(await leftover.client.outcome("GET", `${base}/action-items`), "200");

    // Search is no longer narrowed to assigned projects; this user is assigned to none.
    const result = await leftover.client.request("GET", `${base}/search?q=Splitrock&types=projects`);
    assert.deepEqual([...new Set((result.results as Json[]).map(row => String(row.project_id || row.id)))].sort(), ["split_assigned", "split_unassigned"]);

    // A route that also asks for an office permission still refuses them.
    assert.equal(await leftover.client.outcome("GET", `/v1/workforce/organizations/${orgId}/users`), "403 permission_denied");
  });
});
