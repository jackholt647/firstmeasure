import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Schedule-item write rules shared by every scheduling surface:
// - multi-crew assignment: resource_refs is the crew set, work_resource_ref the
//   primary only; explicit unassign / replace-with-person is honoured;
// - equipment usage windows follow a moved item (and then conflict-check);
// - optimistic concurrency via event_revision / expected_event_revision;
// - scheduling configuration writes require schedule-edit permission;
// - members may save their own preferences.

type TestClient = ReturnType<typeof createSessionClient>;

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-schedule-writes-test-"));
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
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, "messaging");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeEquipmentDatabase } = await import("../equipment/storage.js");
  (await closeEquipmentDatabase());
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  await closeSqlStoresForTests();
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
    email: `schedule-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Schedule Owner",
    phone: nextTestPhone(),
    company: "Schedule Writes Test Org",
    organization_id: `org_schedule_${suffix}`
  });
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(String(registered.organization.id), { "platform.expanded_access": true });
  return { orgId: String(registered.organization.id), userId: String(registered.user?.id || registered.organization_user?.id || ""), suffix };
}

async function enableEquipment(orgId: string) {
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": true, "apps.equipment": true });
}

async function createCrew(owner: TestClient, orgId: string, name: string) {
  return (await owner.request("POST", `/v1/workforce/organizations/${orgId}/branches/default/resource-groups`, {
    name, kind_id: "crew"
  })).group as { id: string; name: string };
}

async function createProject(owner: TestClient, orgId: string, projectId: string) {
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: `Project ${projectId}`, events: [] },
    metadata: { kind: "platform_project" }
  });
}

function crewRefIds(event: any) {
  return (event.resource_refs || []).filter((ref: any) => !["equipment_unit", "equipment_type"].includes(ref.kind)).map((ref: any) => ref.id);
}

async function saveEvent(client: TestClient, orgId: string, projectId: string, event: any, extra: any = {}) {
  return client.raw("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, { event, ...extra });
}

/* What the scheduling UI sends: the stored item with the legacy primary-crew
 * mirrors derived from work_resource_ref (decorateWorkEvent). */
function decorated(event: any, primary: { id: string; name: string } | null) {
  const id = primary?.id || "";
  const name = primary?.name || "";
  return {
    ...event,
    work_resource_ref: id ? { kind: "resource_group", id, name } : null,
    assigned_resource_kind: id ? "resource_group" : "",
    assigned_resource_id: id,
    assigned_resource_name: name,
    assigned_crew_id: id,
    assigned_crew_name: name,
    crew_id: id,
    crew_name: name,
    resource_id: id,
    resource_name: name
  };
}

test("multi-crew items keep every crew on moves; explicit unassign and person replacement are honoured", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  const bravo = await createCrew(owner, orgId, "Bravo Crew");
  const service = await createCrew(owner, orgId, "Service Crew");
  const projectId = "proj_multi_crew";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;

  const created = await owner.request("POST", base, {
    event: {
      id: "event_two_crews",
      type_id: "project_work",
      title: "Membrane tear-off",
      start_at: "2026-10-13T15:00:00.000Z",
      end_at: "2026-10-13T23:00:00.000Z",
      work_resource_ref: { kind: "resource_group", id: alpha.id, name: alpha.name },
      resource_refs: [
        { kind: "resource_group", id: alpha.id, name: alpha.name, role: "crew" },
        { kind: "resource_group", id: bravo.id, name: bravo.name, role: "crew" }
      ]
    }
  });
  assert.deepEqual(crewRefIds(created.event), [alpha.id, bravo.id]);
  assert.equal(created.event.work_resource_ref.id, alpha.id);
  assert.equal(created.event.assigned_crew_id, alpha.id);

  // A move from a single-crew view sends the primary mirrors plus the stored list.
  const moved = await owner.request("POST", base, {
    event: { ...decorated(created.event, alpha), start_at: "2026-10-14T15:00:00.000Z", end_at: "2026-10-14T23:00:00.000Z" }
  });
  assert.deepEqual(crewRefIds(moved.event), [alpha.id, bravo.id], "moving must not drop the second crew");

  // Legacy writer that sends only work_resource_ref (no list) keeps both crews.
  const legacy = await owner.request("POST", base, {
    event: { id: "event_two_crews", title: "Membrane tear-off (renamed)", work_resource_ref: { kind: "resource_group", id: alpha.id, name: alpha.name } }
  });
  assert.deepEqual(crewRefIds(legacy.event), [alpha.id, bravo.id]);

  // Changing only the primary replaces the old primary and keeps the others.
  const swapped = await owner.request("POST", base, {
    event: { ...decorated(legacy.event, service) }
  });
  assert.deepEqual(crewRefIds(swapped.event), [service.id, bravo.id]);
  assert.equal(swapped.event.assigned_crew_id, service.id);

  // A multi-crew writer that nulls work_resource_ref but sends a new list: list wins.
  const listWins = await owner.request("POST", base, {
    event: {
      ...decorated(swapped.event, bravo),
      work_resource_ref: null,
      resource_refs: [
        { kind: "resource_group", id: bravo.id, name: bravo.name, role: "crew" },
        { kind: "resource_group", id: alpha.id, name: alpha.name, role: "crew" }
      ]
    }
  });
  assert.deepEqual(crewRefIds(listWins.event), [bravo.id, alpha.id]);
  assert.equal(listWins.event.work_resource_ref.id, bravo.id, "primary mirrors follow the first crew");

  // Drop on "Unassigned": every singular field cleared, stale list still attached.
  const unassigned = await owner.request("POST", base, {
    event: { ...decorated(listWins.event, null), assigned_user_ids: [], assigned_users: [], assigned_user_id: "" }
  });
  assert.deepEqual(crewRefIds(unassigned.event), [], "unassign clears every crew");
  assert.equal(unassigned.event.work_resource_ref, null);
  assert.equal(unassigned.event.assigned_crew_id, "");

  // Single-crew item replaced by a person (stale crew list attached).
  const single = await owner.request("POST", base, {
    event: {
      id: "event_one_crew",
      type_id: "custom",
      title: "Final cleanup",
      start_at: "2026-10-15T16:00:00.000Z",
      end_at: "2026-10-15T19:00:00.000Z",
      work_resource_ref: { kind: "resource_group", id: alpha.id, name: alpha.name },
      resource_refs: [{ kind: "resource_group", id: alpha.id, name: alpha.name, role: "crew" }]
    }
  });
  const users = await owner.request("GET", `/v1/platform/organizations/${orgId}/users`);
  const personId = String(users.documents[0]?.id || "");
  assert.ok(personId);
  const person = await owner.raw("POST", base, {
    event: {
      ...decorated(single.event, null),
      assigned_user_ids: personId ? [personId] : [],
      assigned_user_id: personId,
      assigned_users: personId ? [{ id: personId, name: "Schedule Owner" }] : []
    }
  });
  assert.equal(person.statusCode, 200, person.body);
  assert.deepEqual(crewRefIds(person.data.event), [], "the replaced crew must not be back-filled");
  assert.equal(person.data.event.assigned_crew_id, "");
  assert.equal(person.data.event.work_resource_ref, null);
  assert.deepEqual(person.data.event.assigned_user_ids, [personId]);

  // Resource-lane move of a single-crew item (work_resource_ref → other crew).
  const laneMove = await owner.request("POST", base, {
    event: { ...decorated(person.data.event, bravo), start_at: "2026-10-16T16:00:00.000Z", end_at: "2026-10-16T19:00:00.000Z" }
  });
  assert.deepEqual(crewRefIds(laneMove.event), [bravo.id]);
});

test("equipment windows follow a moved item and the move is conflict-checked", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(orgId);
  const crew = await createCrew(owner, orgId, "Alpha Crew");
  const type = await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, { name: "Roofing Hoist" });
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.type.id, name: "H-1", ownership: "owned"
  })).unit;
  const projectId = "proj_equipment_follow";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const crewRef = { kind: "resource_group", id: crew.id, name: crew.name };

  const first = await owner.request("POST", base, {
    event: {
      id: "event_shingles",
      type_id: "project_work",
      title: "Shingle install",
      start_at: "2026-10-01T15:00:00.000Z",
      end_at: "2026-10-01T23:00:00.000Z",
      work_resource_ref: crewRef,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, name: unit.name, role: "equipment", start_at: "2026-10-01T15:00:00.000Z", end_at: "2026-10-01T23:00:00.000Z" }]
    }
  });
  const unitRef = (event: any) => event.resource_refs.find((ref: any) => ref.id === unit.id);
  assert.equal(unitRef(first.event).start_at, "2026-10-01T15:00:00.000Z");

  // Another item books H-1 on Oct 8.
  await owner.request("POST", base, {
    event: {
      id: "event_other_hoist",
      type_id: "project_work",
      title: "Other job",
      start_at: "2026-10-08T15:00:00.000Z",
      end_at: "2026-10-08T23:00:00.000Z",
      work_resource_ref: crewRef,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, name: unit.name, role: "equipment" }]
    }
  });

  // Moving by one day with the stale window attached shifts the window.
  const moved = await owner.request("POST", base, {
    event: { ...first.event, start_at: "2026-10-02T15:00:00.000Z", end_at: "2026-10-02T23:00:00.000Z" }
  });
  assert.equal(unitRef(moved.event).start_at, "2026-10-02T15:00:00.000Z");
  assert.equal(unitRef(moved.event).end_at, "2026-10-02T23:00:00.000Z");

  // A window the writer edited itself is kept as sent.
  const edited = await owner.request("POST", base, {
    event: {
      ...moved.event,
      resource_refs: [{ ...unitRef(moved.event), start_at: "2026-10-02T15:00:00.000Z", end_at: "2026-10-02T17:00:00.000Z" }]
    }
  });
  assert.equal(unitRef(edited.event).end_at, "2026-10-02T17:00:00.000Z");

  // Moving onto the other booking's day now collides (window followed the item).
  const collide = await saveEvent(owner, orgId, projectId, {
    ...edited.event, start_at: "2026-10-08T15:00:00.000Z", end_at: "2026-10-08T23:00:00.000Z"
  });
  assert.equal(collide.statusCode, 409);
  assert.equal(collide.data.error, "equipment_conflict");

  // Floating calendar events: a reservation's unit window follows its times.
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/calendar_events/reservation_h1`, {
    data: {
      id: "reservation_h1", title: "H-1 reserved", kind: "equipment_reservation", status: "scheduled",
      start_at: "2026-11-02T15:00:00.000Z", end_at: "2026-11-02T20:00:00.000Z",
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment", start_at: "2026-11-02T15:00:00.000Z", end_at: "2026-11-02T20:00:00.000Z" }]
    }
  });
  const floating = await owner.request("PATCH", `/v1/platform/organizations/${orgId}/calendar_events/reservation_h1`, {
    data: { start_at: "2026-11-03T15:00:00.000Z", end_at: "2026-11-03T20:00:00.000Z" }
  });
  assert.equal(floating.document.data.resource_refs[0].start_at, "2026-11-03T15:00:00.000Z");
  assert.equal(floating.document.data.resource_refs[0].end_at, "2026-11-03T20:00:00.000Z");
});

test("stale saves are refused with 409 stale_event; saves without a token keep working", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const crew = await createCrew(owner, orgId, "Alpha Crew");
  const projectId = "proj_stale";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const created = await owner.request("POST", base, {
    event: {
      id: "event_stale",
      type_id: "project_work",
      title: "Tear-off",
      description: "original",
      start_at: "2026-10-01T15:00:00.000Z",
      end_at: "2026-10-01T23:00:00.000Z",
      work_resource_ref: { kind: "resource_group", id: crew.id, name: crew.name }
    }
  });
  assert.equal(created.event.event_revision, 1);

  // Session B edits the description with the current revision.
  const sessionB = await owner.request("POST", base, {
    event: { ...created.event, description: "changed by B" },
    expected_event_revision: 1
  });
  assert.equal(sessionB.event.event_revision, 2);
  assert.equal(sessionB.event.expected_event_revision, undefined, "the token is never stored");

  // Session A still holds revision 1 and moves the item: refused.
  const stale = await saveEvent(owner, orgId, projectId, {
    ...created.event, start_at: "2026-10-02T15:00:00.000Z", end_at: "2026-10-02T23:00:00.000Z", expected_event_revision: 1
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.data.error, "stale_event");
  assert.equal(stale.data.details.current_event_revision, 2);
  assert.equal(stale.data.details.current_event.description, "changed by B");

  const project = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const stored = project.document.data.events.find((event: any) => event.id === "event_stale");
  assert.equal(stored.description, "changed by B", "the refused save changed nothing");
  assert.equal(stored.start_at, "2026-10-01T15:00:00.000Z");

  // A token for an item deleted elsewhere is refused too; new items need none.
  const deleted = await saveEvent(owner, orgId, projectId, { id: "event_gone", type_id: "project_work", title: "Gone", start_at: "2026-10-03T15:00:00.000Z" }, { expected_event_revision: 3 });
  assert.equal(deleted.statusCode, 409);
  assert.equal(deleted.data.details.deleted, true);
  const fresh = await saveEvent(owner, orgId, projectId, { id: "event_new", type_id: "project_work", title: "New", start_at: "2026-10-03T15:00:00.000Z", work_resource_ref: { kind: "resource_group", id: crew.id, name: crew.name } }, { expected_event_revision: 0 });
  assert.equal(fresh.statusCode, 200);

  // Backward compatible: no token, last write wins as before.
  const legacy = await owner.request("POST", base, { event: { id: "event_stale", title: "Tear-off (legacy writer)" } });
  assert.equal(legacy.event.event_revision, 3);

  // Floating calendar events use the same token (inside data for PUT/PATCH).
  const url = `/v1/platform/organizations/${orgId}/calendar_events/cal_stale`;
  const cal = await owner.request("PUT", url, { data: { id: "cal_stale", title: "BBQ", start_at: "2026-10-10T19:00:00.000Z", end_at: "2026-10-10T21:00:00.000Z" } });
  assert.equal(cal.document.data.event_revision, 1);
  const calB = await owner.request("PUT", url, { data: { ...cal.document.data, description: "B", expected_event_revision: 1 } });
  assert.equal(calB.document.data.event_revision, 2);
  assert.equal(calB.document.data.expected_event_revision, undefined);
  const calStale = await owner.raw("PUT", url, { data: { ...cal.document.data, title: "BBQ moved", expected_event_revision: 1 } });
  assert.equal(calStale.statusCode, 409);
  assert.equal(calStale.data.error, "stale_event");
  const calStalePatch = await owner.raw("PATCH", url, { data: { title: "BBQ patched" }, expected_event_revision: 1 });
  assert.equal(calStalePatch.statusCode, 409);
});

async function createViewer(owner: TestClient, orgId: string, suffix: string) {
  const email = `schedule-viewer-${suffix}@example.test`;
  const password = "schedule viewer password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: "Schedule Viewer", status: "active", role: "viewer", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), client };
}

test("scheduling configuration needs schedule-edit permission; members save their own preferences", async () => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const viewer = await createViewer(owner, orgId, suffix);
  const moduleUrl = `/v1/platform/organizations/${orgId}/branch/default/modules/scheduling`;

  const denied = await viewer.client.raw("PATCH", moduleUrl, { data: { unavailability: { someone: ["2026-10-01"] } } });
  assert.equal(denied.statusCode, 403, "a view-only member must not change org-wide availability");
  const deniedPut = await viewer.client.raw("PUT", moduleUrl, { data: { event_types: {} } });
  assert.equal(deniedPut.statusCode, 403);
  const allowed = await owner.raw("PATCH", moduleUrl, { data: { unavailability: { someone: ["2026-10-01"] } } });
  assert.equal(allowed.statusCode, 200);
  const readable = await viewer.client.raw("GET", moduleUrl);
  assert.equal(readable.statusCode, 200, "reading the scheduling configuration stays open");

  // Own preferences: allowed, merged per key, nothing else on the record.
  const usersUrl = `/v1/platform/organizations/${orgId}/users/${viewer.userId}`;
  const prefs = await viewer.client.raw("PATCH", usersUrl, { data: { preferences: { scheduling: { gantt_zoom: 48 } } }, metadata: { kind: "user_preferences" } });
  assert.equal(prefs.statusCode, 200, prefs.body);
  assert.equal(prefs.data.document.data.preferences.scheduling.gantt_zoom, 48);
  const more = await viewer.client.request("PATCH", usersUrl, { data: { preferences: { other_app: { mode: "compact" } } } });
  assert.equal(more.document.data.preferences.scheduling.gantt_zoom, 48, "other preference keys are kept");
  assert.equal(more.document.data.preferences.other_app.mode, "compact");
  const escalate = await viewer.client.raw("PATCH", usersUrl, { data: { preferences: {}, role: "admin" } });
  assert.equal(escalate.statusCode, 403);
  const otherUser = await viewer.client.raw("PATCH", `/v1/platform/organizations/${orgId}/users/${(await owner.request("GET", `/v1/platform/organizations/${orgId}/users`)).documents.find((doc: any) => doc.id !== viewer.userId).id}`, { data: { preferences: { scheduling: { gantt_zoom: 1 } } } });
  assert.equal(otherUser.statusCode, 403, "only your own preferences");
});

test("concurrent writes to one project never drop each other's items (R3-RAIL-2)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_concurrent";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const item = (index: number, extra: any = {}) => ({
    id: `event_conc_${index}`, type_id: "project_work", title: `Item ${index}`,
    start_at: `2026-11-1${index}T16:00:00.000Z`, end_at: `2026-11-1${index}T17:00:00.000Z`, ...extra
  });

  // Concurrent creates (a double-clicked confirm, a cascade, two users) all persist.
  const created = await Promise.all([1, 2, 3, 4, 5].map((index) => saveEvent(owner, orgId, projectId, item(index))));
  assert.deepEqual(created.map((response) => response.statusCode), [200, 200, 200, 200, 200], created.map((response) => response.body.slice(0, 300)).join(" | "));
  const afterCreate = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.deepEqual(afterCreate.document.data.events.map((event: any) => event.id).sort(), [1, 2, 3, 4, 5].map((index) => `event_conc_${index}`));

  // Concurrent updates to different items both persist, alongside a delete.
  const [first, second, removal] = await Promise.all([
    saveEvent(owner, orgId, projectId, { id: "event_conc_1", description: "edited by A" }),
    saveEvent(owner, orgId, projectId, { id: "event_conc_2", title: "Renamed by B" }),
    owner.raw("DELETE", `${base}/event_conc_3`)
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(removal.statusCode, 200);
  const afterUpdate = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const byId = new Map<string, any>(afterUpdate.document.data.events.map((event: any) => [event.id, event]));
  assert.equal(byId.get("event_conc_1").description, "edited by A");
  assert.equal(byId.get("event_conc_2").title, "Renamed by B");
  assert.equal(byId.has("event_conc_3"), false);
  assert.equal(byId.size, 4);

  // A writer in another process (simulated: a direct storage write between
  // this mutation's read and its conditional write) forces a re-read and
  // re-apply instead of being overwritten.
  const { mutateProjectDocument, writeProjectDocument } = await import("../platform/project_document_mutation.js");
  const { upsertDocument } = await import("../platform/storage.js");
  let attempts = 0;
  await mutateProjectDocument(orgId, projectId, async (document: any) => {
    attempts += 1;
    if (attempts === 1) {
      await upsertDocument(orgId, "projects", {
        id: projectId,
        data: { ...document.data, events: [...document.data.events, item(6)] },
        metadata: document.metadata
      }, { replace: true });
    }
    return await writeProjectDocument(orgId, document, { ...document.data, events: [...document.data.events, item(7)] });
  });
  assert.equal(attempts, 2);
  const afterRace = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const ids = afterRace.document.data.events.map((event: any) => event.id);
  assert.ok(ids.includes("event_conc_6"), "the other writer's item survives");
  assert.ok(ids.includes("event_conc_7"), "this writer's item is applied on the retry");
});

test("client-only shadow fields are never stored; start_at/end_at stay authoritative (R3-TG-9)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const url = `/v1/platform/organizations/${orgId}/calendar_events/cal_shadow`;
  const saved = await owner.request("PUT", url, {
    data: {
      id: "cal_shadow", title: "Truck inspection",
      start_at: "2026-10-02T15:00:00.000Z", end_at: "2026-10-02T16:00:00.000Z",
      start: "2026-10-03T07:15:00.000Z", end: "2026-10-03T08:15:00.000Z",
      __start: "2026-10-03T07:15:00.000Z", __end: "2026-10-03T08:15:00.000Z", __draft: true, __activeDraft: true
    }
  });
  const data = saved.document.data;
  assert.equal(data.start_at, "2026-10-02T15:00:00.000Z");
  for (const key of ["start", "end", "__start", "__end", "__draft", "__activeDraft"]) assert.equal(key in data, false, `${key} is not stored`);

  // A PATCH also drops shadow fields a legacy writer stored earlier.
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "calendar_events", { id: "cal_shadow", data: { ...data, start: "2026-10-09T00:00:00.000Z", __draft: true } }, { replace: true });
  const patched = await owner.request("PATCH", url, { data: { title: "Truck inspection (renamed)" } });
  assert.equal(patched.document.data.title, "Truck inspection (renamed)");
  assert.equal(patched.document.data.start_at, "2026-10-02T15:00:00.000Z");
  assert.equal("start" in patched.document.data, false);
  assert.equal("__draft" in patched.document.data, false);

  // A legacy writer that sends only start/end still sets the window.
  const legacy = await owner.request("PUT", `/v1/platform/organizations/${orgId}/calendar_events/cal_legacy`, {
    data: { id: "cal_legacy", title: "Legacy", start: "2026-10-05T15:00:00.000Z", end: "2026-10-05T16:00:00.000Z" }
  });
  assert.equal(legacy.document.data.start_at, "2026-10-05T15:00:00.000Z");
  assert.equal("start" in legacy.document.data, false);

  // Project items: same rule.
  const projectId = "proj_shadow";
  await createProject(owner, orgId, projectId);
  const item = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: { id: "event_shadow", type_id: "project_work", title: "Install", start_at: "2026-10-06T15:00:00.000Z", end_at: "2026-10-06T23:00:00.000Z", start: "2026-10-01T00:00:00.000Z", __start: "x", __draft: true }
  });
  assert.equal(item.event.start_at, "2026-10-06T15:00:00.000Z");
  for (const key of ["start", "__start", "__draft"]) assert.equal(key in item.event, false, `${key} is not stored on project items`);
});

test("floating calendar bookings are equipment conflict-checked like project items (R3-RES-4)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(orgId);
  const type = await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, { name: "Crew Truck" });
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, { type_id: type.type.id, name: "T-1", ownership: "owned" })).unit;
  const booking = (id: string, extra: any = {}) => ({
    id, title: "T-1 booked", vehicle_booking: true, status: "scheduled",
    start_at: "2026-10-12T15:00:00.000Z", end_at: "2026-10-12T23:00:00.000Z",
    resource_refs: [{ kind: "equipment_unit", id: unit.id, name: unit.name, role: "vehicle" }], ...extra
  });
  const calendarUrl = (id: string) => `/v1/platform/organizations/${orgId}/calendar_events/${id}`;

  const first = await owner.raw("PUT", calendarUrl("booking_a"), { data: booking("booking_a") });
  assert.equal(first.statusCode, 200, first.body);
  // A second booking of the same unit in an overlapping window is refused (default conflict mode "block")...
  const second = await owner.raw("PUT", calendarUrl("booking_b"), { data: booking("booking_b", { start_at: "2026-10-12T20:00:00.000Z", end_at: "2026-10-13T01:00:00.000Z" }) });
  assert.equal(second.statusCode, 409);
  assert.equal(second.data.error, "equipment_conflict");
  const created = await owner.raw("POST", `/v1/platform/organizations/${orgId}/calendar_events`, { id: "booking_c", data: booking("booking_c") });
  assert.equal(created.statusCode, 409);
  // ...as is moving another booking onto it.
  await owner.request("PUT", calendarUrl("booking_d"), { data: booking("booking_d", { start_at: "2026-10-14T15:00:00.000Z", end_at: "2026-10-14T23:00:00.000Z" }) });
  const moved = await owner.raw("PATCH", calendarUrl("booking_d"), { data: { start_at: "2026-10-12T16:00:00.000Z", end_at: "2026-10-12T18:00:00.000Z" } });
  assert.equal(moved.statusCode, 409);
  // Editing the booking itself (same unit, its own window) is not a conflict.
  const renamed = await owner.raw("PATCH", calendarUrl("booking_a"), { data: { title: "T-1 booked (Alpha)" } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  // A cancelled booking is not checked.
  const cancelled = await owner.raw("PUT", calendarUrl("booking_e"), { data: booking("booking_e", { status: "cancelled" }) });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
});
