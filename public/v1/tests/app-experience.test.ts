/**
 * App experience (docs/architecture/app-experience.md): which apps a person
 * has, on which devices, with which options, and the server gates that follow
 * from it. There is no management or field application; a stored
 * `application_access` entry means nothing.
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
let normalizeAppDefaults: (value: unknown) => Json = () => ({});

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
  /** "200", or the status with the error code: "403 app_access_denied". */
  const outcome = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    return response.statusCode < 400 ? String(response.statusCode) : `${response.statusCode} ${String(response.data?.error || "")}`.trim();
  };
  return { request, raw, outcome };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-app-experience-"));
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
  ({ normalizeAppDefaults } = await import("../workforce/access.js"));
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

// ---------------------------------------------------------------------------
// The resolver, without a server.

function role(id: string, appDefaults: Json, permissions: Json = {}): any {
  return { id, organization_id: "org", name: id, description: "", status: "active", is_system: false, system_key: "", permissions, app_defaults: normalizeAppDefaults(appDefaults), metadata: {}, revision: 1, created_at: "", updated_at: "", archived_at: "" };
}

/** Every organization switch on. */
async function everythingOn() {
  const { appDefinitions } = await import("../platform/app-experience/registry.js");
  return Object.fromEntries(appDefinitions().flatMap((entry) => entry.capabilities).map((key) => [key, true]));
}

test("each app exists only on the devices it declares", async () => {
  const { appDefinitions } = await import("../platform/app-experience/registry.js");
  const { deviceTypeIds } = await import("../platform/app-experience/devices.js");
  const { resolveAppEntitlements } = await import("../workforce/access.js");
  const devices = deviceTypeIds();
  for (const entry of appDefinitions()) {
    assert.ok(entry.devices.length > 0, `${entry.id} exists on some device`);
    assert.ok(entry.devices.every((device) => devices.includes(device)), `${entry.id} names only known device types`);
  }
  assert.deepEqual(appDefinitions().find((entry) => entry.id === "documents.studio")!.devices, ["desktop"]);
  const studio = resolveAppEntitlements({ effectiveByKey: await everythingOn(), roles: [role("r", { "documents.studio": { visible: { desktop: true, mobile: true } } })] })
    .find((entry) => entry.id === "documents.studio")!;
  assert.deepEqual(studio.visible, { desktop: true }, "a setting for a device the app does not exist on is ignored");
  assert.deepEqual(studio.visible_devices, ["desktop"]);
});

test("an app the organization has off is not part of anyone's experience", async () => {
  const { resolveAppEntitlements, organizationAppCatalog } = await import("../workforce/access.js");
  const effectiveByKey = { ...(await everythingOn()), "canvassing.app": false };
  const ids = resolveAppEntitlements({ effectiveByKey, roles: [role("r", { "portal.canvassing": { visible: true } })] }).map((entry) => entry.id);
  assert.equal(ids.includes("portal.canvassing"), false);
  assert.equal(organizationAppCatalog(effectiveByKey).some((entry) => entry.id === "portal.canvassing"), false);
  // An app with several switches is on while any of them is.
  const docs = { ...(await everythingOn()), "platform.project_docs": false };
  assert.ok(resolveAppEntitlements({ effectiveByKey: docs }).some((entry) => entry.id === "project.docs"));
});

test("roles add up per device; groups and departments override them; the person's own setting comes last", async () => {
  const { resolveAppEntitlements } = await import("../workforce/access.js");
  const effectiveByKey = await everythingOn();
  const find = (list: any[], id: string) => list.find((entry) => entry.id === id)!;

  // With no roles a person gets each app's default.
  const none = resolveAppEntitlements({ effectiveByKey });
  assert.deepEqual(find(none, "portal.viewer").visible, { mobile: true, desktop: true });
  assert.deepEqual(find(none, "portal.crew_overview").visible, { mobile: false, desktop: false });

  // One role hides My Projects on phones; another says nothing, so it gives the default and the app stays shown.
  const phoneless = role("phoneless", { "portal.viewer": { visible: { mobile: false } } });
  assert.equal(find(resolveAppEntitlements({ effectiveByKey, roles: [phoneless] }), "portal.viewer").visible.mobile, false);
  assert.equal(find(resolveAppEntitlements({ effectiveByKey, roles: [phoneless] }), "portal.viewer").visible.desktop, true);
  assert.equal(find(resolveAppEntitlements({ effectiveByKey, roles: [phoneless, role("other", {})] }), "portal.viewer").visible.mobile, true);

  // A department or group that says something wins over roles, any one showing it is enough, and a restriction hides it everywhere.
  const crew = role("crew", { "portal.crew_overview": { visible: true }, "portal.viewer": { visible: false } });
  const department = { source: "department_default" as const, defaults: { "portal.viewer": { visible: { desktop: true }, options: {}, params: {}, layout: {}, restricted: false } } };
  const viewer = find(resolveAppEntitlements({ effectiveByKey, roles: [crew], membership: [department] }), "portal.viewer");
  assert.deepEqual(viewer.visible, { mobile: false, desktop: true });
  assert.equal(viewer.sources.devices.desktop, "department_default");
  const restricted = { source: "group_default" as const, defaults: { "portal.crew_overview": { visible: {}, options: {}, params: {}, layout: {}, restricted: true } } };
  const today = find(resolveAppEntitlements({ effectiveByKey, roles: [crew], membership: [restricted], overrides: { "portal.crew_overview": { visible: { mobile: true }, options: {}, params: {}, layout: {} } } }), "portal.crew_overview");
  assert.equal(today.allowed, false, "a restriction beats even the person's own setting");
  assert.ok(today.reasons.includes("department_app_restricted"));

  // The person's own setting for one device.
  const own = find(resolveAppEntitlements({ effectiveByKey, roles: [crew], overrides: { "portal.crew_overview": { visible: { desktop: false }, options: {}, params: {}, layout: {} } } }), "portal.crew_overview");
  assert.deepEqual(own.visible, { mobile: true, desktop: false });
  assert.equal(own.sources.devices.desktop, "user_override");
});

test("an option resolves through the same layers and reaches the app as a parameter, apart from permissions", async () => {
  const { resolveAppEntitlements } = await import("../workforce/access.js");
  const effectiveByKey = await everythingOn();
  const today = (input: Json) => resolveAppEntitlements({ effectiveByKey, ...input }).find((entry) => entry.id === "portal.crew_overview")!;
  const clocked = role("clocked", { "portal.crew_overview": { visible: true, options: { time_clock: true } } });
  const salaried = role("salaried", { "portal.crew_overview": { visible: true } });
  assert.equal(today({ roles: [salaried] }).option_values.time_clock, false, "the time clock is off unless something turns it on");
  assert.equal(today({ roles: [salaried] }).params.time_clock_enabled, false);
  assert.equal(today({ roles: [clocked, salaried] }).params.time_clock_enabled, true, "any role turning it on is enough");
  // Permissions do not turn it on or off.
  assert.equal(today({ roles: [clocked], permissions: { "*": true } }).params.time_clock_enabled, true);
  assert.equal(today({ roles: [salaried], permissions: { "*": true } }).params.time_clock_enabled, false);
  assert.equal(today({ roles: [clocked], overrides: { "portal.crew_overview": { visible: {}, options: { time_clock: false }, params: {}, layout: {} } } }).params.time_clock_enabled, false);
  // App parameters that carry a permission still follow the permission.
  const receipts = resolveAppEntitlements({ effectiveByKey, roles: [role("r", { "portal.crew_receipts": { visible: true } })], permissions: { "crew.receipts.upload": true } })
    .find((entry) => entry.id === "portal.crew_receipts")!;
  assert.equal(receipts.params.can_upload, true);
  assert.equal(receipts.params.can_request_reimbursement, false);
});

test("seeded roles give each kind of work its apps and nothing else", async () => {
  const { factoryPersonaDefinitions, resolveAppEntitlements } = await import("../workforce/access.js");
  const effectiveByKey = await everythingOn();
  const allowedFor = (personaId: string) => {
    const persona = factoryPersonaDefinitions().find((entry) => entry.id === personaId)!;
    return new Set(resolveAppEntitlements({ effectiveByKey, roles: [role(persona.id, persona.app_defaults, persona.permissions)], permissions: persona.permissions })
      .filter((entry) => entry.allowed).map((entry) => entry.id));
  };
  const crew = allowedFor("crew_member");
  assert.ok(crew.has("portal.crew_overview") && crew.has("project.crew_overview"));
  assert.equal(crew.has("portal.viewer"), false);
  assert.equal(crew.has("portal.company_settings"), false);
  const viewer = allowedFor("viewer");
  assert.ok(viewer.has("portal.viewer") && viewer.has("project.map"));
  assert.equal(viewer.has("portal.crew_overview"), false);
  assert.equal(viewer.has("portal.payroll"), false, "money apps are shown by the roles that handle money");
  assert.ok(allowedFor("admin").has("portal.payroll"));
  const sales = allowedFor("salesperson");
  assert.ok(sales.has("portal.sales_overview"));
  assert.equal(sales.has("portal.crew_overview"), false);
});

// ---------------------------------------------------------------------------
// Through the server.

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `experience-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Experience Owner",
    company: "App Experience Test Org",
    organization_id: `org_experience_${suffix}`
  });
  const orgId = String(registered.organization.id);
  await enableExpandedPlatformFixture(orgId);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: { app_flags: { platform: { expanded_access: true, documents: true, materials: true, pricebook: true, money: true, proposals: true } } }
  }, { replace: false });
  return { orgId, suffix };
}

async function createPerson(owner: TestClient, orgId: string, suffix: string, label: string, roleIds: string[], extra: Json = {}): Promise<Person> {
  const email = `experience-${label}-${suffix}@example.test`;
  const password = `experience ${label} password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: `Experience ${label}`, status: "active", role: "viewer", send_invite: false }
  });
  const userId = String(created.document.id);
  const profile = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, { access_role_ids: roleIds });
  assert.deepEqual(profile.user.access_role_ids, roleIds);
  if (Object.keys(extra).length) {
    const { upsertDocument } = await import("../platform/storage.js");
    await upsertDocument(orgId, "users", { id: userId, data: extra }, { replace: false });
  }
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
      events: [{ id: `${id}_work`, kind: "project_work", event_type_default_id: "project_work", status: "scheduled", date: "2030-01-03", assigned_user_ids: assignedUserIds }]
    },
    metadata: { kind: "platform_project", branch_id: "default", source: "app_experience_test" }
  }, { replace: true });
}

const APP_DENIED = "403 app_access_denied";

test('offered apps stay new for the organization until an eligible person starts them', async () => {
  const owner=createSessionClient();
  const {orgId,suffix}=await registerOwner(owner);
  const person=await createPerson(owner,orgId,suffix,'offer-reader',['viewer']);
  const {saveGlobal,readGlobal,upsertDocument}=await import('../platform/storage.js');
  const {effectiveCapabilities}=await import('../platform/capabilities.js');
  await (await import('../platform/capabilities.js')).saveCapabilityValues(orgId,{'apps.equipment':true});
  await saveGlobal(orgId,{data:{app_offers:['project.docs','project.materials','portal.equipment']}});
  const base=`/v1/platform/organizations/${orgId}`;
  const session=await person.client.request('GET','/v1/platform/auth/session');
  assert.equal(session.app_entitlements.find((app:any)=>app.id==='project.docs').offered,true);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['platform.documents'],false);
  assert.ok(((await readGlobal(orgId)).data.app_offers as string[]).includes('project.docs'),'a session read does not consume the offer');
  const anonymous=await app.inject({method:'POST',url:`${base}/app-offers/project.docs/start`,payload:{}});
  assert.equal(anonymous.statusCode,401);
  await upsertDocument(orgId,'users',{id:person.userId,data:{app_access_overrides:{'project.docs':{visible:{desktop:false,mobile:false}}}}},{replace:false});
  assert.equal((await person.client.raw('POST',`${base}/app-offers/project.docs/start`,{})).statusCode,403);
  await upsertDocument(orgId,'users',{id:person.userId,data:{app_access_overrides:{}}},{replace:false});
  await Promise.all([person.client.request('POST',`${base}/app-offers/project.docs/start`,{}),owner.request('POST',`${base}/app-offers/project.docs/start`,{})]);
  const global=await readGlobal(orgId);
  assert.deepEqual(global.data.app_offers,['project.materials','portal.equipment']);
  assert.ok((global.data.app_activations as Json)['project.docs'].started_at);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['platform.documents'],true);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['platform.materials'],false);
  const fresh=await owner.request('GET','/v1/platform/auth/session');
  assert.notEqual(fresh.app_entitlements.find((app:any)=>app.id==='project.docs').offered,true);
  // Equipment is offered only once Operations setup has reached its ready step (APP_OFFER_PREREQUISITES).
  assert.equal(fresh.app_entitlements.some((app:any)=>app.id==='portal.equipment'),false);
  assert.equal((await person.client.raw('POST',`${base}/app-offers/portal.equipment/start`,{})).statusCode,403);
  const {recordEvent}=await import('../guided-experiences/store.js');
  const opsEvent={experience_id:'operations.setup',experience_version:1,variant_id:'default',bucket:0,unit_id:orgId,user_id:person.userId};
  await recordEvent(orgId,{...opsEvent,type:'step_view',step_id:'document'});
  assert.equal((await owner.request('GET','/v1/platform/auth/session')).app_entitlements.some((app:any)=>app.id==='portal.equipment'),false);
  await recordEvent(orgId,{...opsEvent,type:'step_view',step_id:'ready'});
  const reached=await owner.request('GET','/v1/platform/auth/session');
  assert.equal(reached.app_entitlements.find((app:any)=>app.id==='portal.equipment').offered,true);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['apps.equipment'],false);
  await person.client.request('POST',`${base}/app-offers/portal.equipment/start`,{});
  const equipmentSession=await owner.request('GET','/v1/platform/auth/session');
  assert.notEqual(equipmentSession.app_entitlements.find((app:any)=>app.id==='portal.equipment').offered,true);
  assert.equal((await effectiveCapabilities(orgId)).effectiveByKey['apps.equipment'],true);
  assert.deepEqual((await readGlobal(orgId)).data.app_offers,['project.materials']);

  assert.equal((await person.client.raw('POST',`${base}/app-offers/portal.company_settings/start`,{})).statusCode,404);
});

test("the server gives each person their apps and gates routes by them", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const base = `/v1/platform/organizations/${orgId}`;
  const crew = await createPerson(owner, orgId, suffix, "crew", ["crew_member"]);
  const office = await createPerson(owner, orgId, suffix, "office", ["viewer"]);
  const both = await createPerson(owner, orgId, suffix, "both", ["viewer", "crew_member"]);
  // A crew member whose user document still carries an old management entry.
  const leftover = await createPerson(owner, orgId, suffix, "leftover", ["crew_member"], {
    application_access: { management: { enabled: true, role_id: "viewer", permissions: { view_contacts: true } } }
  });
  await seedProject(orgId, "experience_assigned", "Bluewater Assigned", [crew.userId]);
  await seedProject(orgId, "experience_unassigned", "Bluewater Unassigned", []);
  const session = async (person: Person) => await person.client.request("GET", "/v1/platform/auth/session") as Json;
  const allowed = async (person: Person) => new Set(((await session(person)).app_entitlements as Json[]).filter((entry) => entry.allowed).map((entry) => entry.id));

  await t.test("the session carries the apps, their devices and the device types", async () => {
    const value = await session(crew);
    assert.ok(Array.isArray(value.app_experience.device_types.types));
    assert.ok(value.app_experience.app_ids.includes("portal.crew_overview"));
    const today = (value.app_entitlements as Json[]).find((entry) => entry.id === "portal.crew_overview")!;
    assert.deepEqual(today.visible, { mobile: true, desktop: true });
    assert.equal(today.params.time_clock_enabled, true);
    assert.equal(value.membership.application_access, undefined);
    assert.equal(value.access_profile.application_access, undefined);
    const crewApps = await allowed(crew);
    assert.ok(crewApps.has("portal.crew_overview"));
    assert.equal(crewApps.has("portal.viewer"), false);
    const bothApps = await allowed(both);
    assert.ok(bothApps.has("portal.crew_overview") && bothApps.has("portal.viewer"));
  });

  await t.test("the access catalog lists only apps the organization has on, with their devices and options", async () => {
    const catalog = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/catalog`);
    assert.equal(catalog.applications, undefined);
    assert.ok(catalog.device_types.types.some((type: Json) => type.id === "desktop"));
    const { effectiveCapabilities } = await import("../platform/capabilities.js");
    const { effectiveByKey } = await effectiveCapabilities(orgId);
    const { appDefinitions } = await import("../platform/app-experience/registry.js");
    const listed = new Set((catalog.apps as Json[]).map((entry) => entry.id));
    for (const entry of appDefinitions()) {
      const on = entry.capabilities.length === 0 || entry.capabilities.some((key) => effectiveByKey[key] === true);
      assert.equal(listed.has(entry.id), on, `${entry.id} is listed exactly when the organization has it on`);
    }
    const today = (catalog.apps as Json[]).find((entry) => entry.id === "portal.crew_overview");
    if (today) assert.deepEqual(today.options.map((option: Json) => option.key), ["time_clock"]);
  });

  await t.test("a route that belongs to an app needs that app", async () => {
    const pins = `/v1/canvassing/organizations/${orgId}/branch/default/pins`;
    const canvassingOn = (await allowed(office)).has("portal.canvassing");
    if (canvassingOn) {
      assert.notEqual(await office.client.outcome("GET", pins), APP_DENIED);
      assert.equal(await crew.client.outcome("GET", pins), APP_DENIED);
    } else {
      // An app the organization has off is refused by its own feature check, for everyone.
      assert.equal(await crew.client.outcome("GET", pins), "403 app_flag_disabled");
    }
    assert.equal(await crew.client.outcome("GET", `${base}/media/storage`), APP_DENIED);
    assert.equal(await office.client.outcome("GET", `${base}/media/storage`), "200");
    assert.equal(await crew.client.outcome("POST", `${base}/leads`, {}), APP_DENIED);
    // Personal routes stay open to every member.
    assert.equal(await crew.client.outcome("GET", `${base}/notifications`), "200");
    assert.equal(await crew.client.outcome("GET", `/v1/workforce/organizations/${orgId}/access/me`), "200");
  });

  await t.test("a stored application entry grants nothing", async () => {
    const value = await session(leftover);
    assert.notEqual(value.membership.permissions.view_contacts, true);
    assert.equal((await allowed(leftover)).has("portal.viewer"), false);
    assert.equal(await leftover.client.outcome("GET", `${base}/media/storage`), APP_DENIED);
    const found = await leftover.client.request("GET", `${base}/search?q=Bluewater&types=projects`);
    assert.deepEqual((found.results || found.projects || []).map((row: Json) => row.id || row.project_id).filter(Boolean).sort(), []);
  });

  await t.test("permissions are the union of every role", async () => {
    const permissions = (await session(both)).membership.permissions;
    assert.equal(permissions.view_projects, true);
    assert.equal(permissions["crew.receipts.upload"], true);
  });

  await t.test("who works with every project is a permission: others search and open only their assigned ones", async () => {
    const ids = async (person: Person) => {
      const found = await person.client.request("GET", `${base}/search?q=Bluewater&types=projects`);
      return (found.results || found.projects || []).map((row: Json) => String(row.id || row.project_id)).filter(Boolean).sort();
    };
    assert.deepEqual(await ids(crew), ["experience_assigned"]);
    assert.deepEqual(await ids(office), ["experience_assigned", "experience_unassigned"]);
    assert.equal(await crew.client.outcome("GET", `${base}/presence/project:experience_unassigned`), "403 project_access_denied");
  });

  await t.test("the time clock is Today's option, not a permission", async () => {
    const clock = `/v1/workforce/organizations/${orgId}/crew/me/time-clock`;
    assert.equal(await crew.client.outcome("GET", clock), "200");
    assert.equal(await office.client.outcome("GET", clock), "403 time_clock_unavailable");
    const profile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${crew.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${crew.userId}/profile`, {
      expected_revision: profile.user.revision,
      app_access_overrides: { "portal.crew_overview": { options: { time_clock: false } } }
    });
    assert.equal(await crew.client.outcome("GET", clock), "403 time_clock_unavailable");
    const today = ((await session(crew)).app_entitlements as Json[]).find((entry) => entry.id === "portal.crew_overview")!;
    assert.equal(today.allowed, true, "turning an option off leaves the app");
    assert.equal(today.params.time_clock_enabled, false);
  });

  await t.test("a person's own setting can hide an app on one device", async () => {
    const profile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${office.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${office.userId}/profile`, {
      expected_revision: profile.user.revision,
      app_access_overrides: { "portal.viewer": { visible: { mobile: false } } }
    });
    const viewer = ((await session(office)).app_entitlements as Json[]).find((entry) => entry.id === "portal.viewer")!;
    assert.deepEqual(viewer.visible, { mobile: false, desktop: true });
    assert.equal(viewer.allowed, true, "an app shown on any device can still be used");
    assert.equal(await office.client.outcome("GET", `${base}/media/storage`), "200");
  });
});
