import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Schedule-item write rules shared by every scheduling surface (see
// docs/architecture/schedule-events.md):
// - resource_refs is the one list of who and what an item uses: the list sent
//   is the set, an empty list unassigns, a write that omits it keeps the set;
// - equipment needed for part of an item is a child item; it follows its
//   parent (and is then conflict-checked at its new range);
// - a parent drives its children through their placement; locked children
//   stay; a hand move becomes a fixed distance from the parent;
// - assignee overlap: warn / block / allow, units as capacity, family ignored;
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
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.APPOINTMENT_CONFIRMATIONS_DISABLED = "1";
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
  const { closeAppointmentsDatabase } = await import("../appointments/storage.js");
  (await closeAppointmentsDatabase());
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

type Crew = { id: string; name: string };
const crewRef = (crew: Crew, extra: any = {}) => ({ kind: "resource_group", id: crew.id, name: crew.name, role: "crew", ...extra });

/* Fields an item no longer stores (REMOVED_EVENT_FIELDS in scheduling/event-model.ts). */
const REMOVED_FIELDS = [
  "work_resource_ref", "assigned_resource_kind", "assigned_resource_id", "assigned_resource_name", "resource_id", "resource_name",
  "assigned_crew_id", "assigned_crew_ids", "assigned_crew_name", "assigned_crew", "crew_id", "crew_name",
  "material_list_id", "labor_list_id", "equipment_list_id",
  "schedule_rule", "schedule_rollup", "is_schedule_group"
];
function assertNoRemovedFields(event: any, label: string) {
  for (const field of REMOVED_FIELDS) assert.equal(field in event, false, `${label}: ${field} is not stored`);
  for (const ref of event.resource_refs || []) {
    assert.equal("start_at" in ref, false, `${label}: a resource carries no start_at`);
    assert.equal("end_at" in ref, false, `${label}: a resource carries no end_at`);
  }
}

async function storedEvents(client: TestClient, orgId: string, projectId: string) {
  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  return new Map<string, any>((project.document.data.events || []).map((event: any) => [String(event.id), event]));
}
const range = (event: any) => [event?.start_at, event?.end_at];
const ids = (events: any[]) => (events || []).map((event: any) => event.id).sort();

async function setOverlapDefault(client: TestClient, orgId: string, mode: string) {
  await client.request("PATCH", `/v1/platform/organizations/${orgId}/branch/default/modules/scheduling`, { data: { assignee_overlap: mode } });
}
async function setAssigneeOverlap(client: TestClient, orgId: string, assignee: { type: string; id: string }, overlap: string) {
  return client.request("PUT", `/v1/platform/organizations/${orgId}/assignee-scheduling`, { assignee, overlap });
}

test("resource_refs is the crew set: a new list replaces it, an empty list unassigns, an omitted list keeps it", async () => {
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
      resource_refs: [crewRef(alpha), crewRef(bravo)]
    }
  });
  assert.deepEqual(created.event.resource_refs, [crewRef(alpha), crewRef(bravo)], "each entry is { kind, id, name, role }");
  assertNoRemovedFields(created.event, "created");

  // A move that sends the stored item back with a new range keeps both crews.
  const moved = await owner.request("POST", base, {
    event: { ...created.event, start_at: "2026-10-14T15:00:00.000Z", end_at: "2026-10-14T23:00:00.000Z" }
  });
  assert.deepEqual(crewRefIds(moved.event), [alpha.id, bravo.id], "moving must not drop the second crew");

  // A write that omits resource_refs keeps the stored set.
  const renamed = await owner.request("POST", base, { event: { id: "event_two_crews", title: "Membrane tear-off (renamed)" } });
  assert.deepEqual(crewRefIds(renamed.event), [alpha.id, bravo.id]);

  // The list sent is the set: swapping one crew is sending the new list.
  const swapped = await owner.request("POST", base, {
    event: { id: "event_two_crews", resource_refs: [crewRef(service), crewRef(bravo)] }
  });
  assert.deepEqual(crewRefIds(swapped.event), [service.id, bravo.id]);

  // The first assignee is the primary one; order is kept as sent. An entry
  // sent without a name keeps the name already stored for it.
  const reordered = await owner.request("POST", base, {
    event: { id: "event_two_crews", resource_refs: [{ kind: "resource_group", id: bravo.id }, crewRef(alpha)] }
  });
  assert.deepEqual(reordered.event.resource_refs, [crewRef(bravo), crewRef(alpha)]);

  // An empty list unassigns everyone.
  const unassigned = await owner.request("POST", base, { event: { id: "event_two_crews", resource_refs: [] } });
  assert.deepEqual(unassigned.event.resource_refs, [], "an empty list clears every crew");
  assert.deepEqual((await storedEvents(owner, orgId, projectId)).get("event_two_crews").resource_refs, []);

  // A single-crew item handed to a person: the crew list is emptied and the
  // person is attached through assigned_user_ids.
  const single = await owner.request("POST", base, {
    event: {
      id: "event_one_crew",
      type_id: "custom",
      title: "Final cleanup",
      start_at: "2026-10-15T16:00:00.000Z",
      end_at: "2026-10-15T19:00:00.000Z",
      resource_refs: [crewRef(alpha)]
    }
  });
  const users = await owner.request("GET", `/v1/platform/organizations/${orgId}/users`);
  const personId = String(users.documents[0]?.id || "");
  assert.ok(personId);
  const person = await owner.raw("POST", base, {
    event: {
      ...single.event,
      resource_refs: [],
      assigned_user_ids: [personId],
      assigned_user_id: personId,
      assigned_users: [{ id: personId, name: "Schedule Owner" }]
    }
  });
  assert.equal(person.statusCode, 200, person.body);
  assert.deepEqual(person.data.event.resource_refs, [], "the replaced crew is not back-filled");
  assert.deepEqual(person.data.event.assigned_user_ids, [personId]);

  // Dropping the item on another crew's lane sends that crew as the list.
  const laneMove = await owner.request("POST", base, {
    event: { ...person.data.event, resource_refs: [crewRef(bravo)], start_at: "2026-10-16T16:00:00.000Z", end_at: "2026-10-16T19:00:00.000Z" }
  });
  assert.deepEqual(crewRefIds(laneMove.event), [bravo.id]);
  assertNoRemovedFields(laneMove.event, "lane move");
});

test("equipment for part of an item is a child item: it follows its parent and the move is conflict-checked", async () => {
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
  const unitRef = { kind: "equipment_unit", id: unit.id, name: unit.name, role: "equipment" };

  await owner.request("POST", base, {
    event: {
      id: "event_shingles",
      type_id: "project_work",
      title: "Shingle install",
      start_at: "2026-10-01T15:00:00.000Z",
      end_at: "2026-10-01T23:00:00.000Z",
      resource_refs: [crewRef(crew)]
    }
  });
  // The hoist is needed for two hours, an hour in: a child item holds it. A
  // resource never carries its own dates, so dates sent on the ref are dropped.
  const hoist = await owner.request("POST", base, {
    event: {
      id: "event_shingles_hoist",
      type_id: "project_work",
      title: "Hoist for loading",
      parent_event_id: "event_shingles",
      placement: { anchor: "start", offset: { value: 1, unit: "hour" }, duration: { value: 2, unit: "hour" } },
      resource_refs: [{ ...unitRef, start_at: "2026-10-01T15:00:00.000Z", end_at: "2026-10-01T23:00:00.000Z" }]
    }
  });
  assert.deepEqual(range(hoist.event), ["2026-10-01T16:00:00.000Z", "2026-10-01T18:00:00.000Z"], "the child is placed against its parent");
  assert.deepEqual(hoist.event.resource_refs, [unitRef]);
  assert.equal(hoist.event.parent_event_id, "event_shingles");

  // H-1 is held for the child's range only, not for the whole parent.
  const laterSameDay = await owner.request("POST", base, {
    event: {
      id: "event_hoist_evening", type_id: "project_work", title: "Evening lift",
      start_at: "2026-10-01T20:00:00.000Z", end_at: "2026-10-01T21:00:00.000Z", resource_refs: [unitRef]
    }
  });
  assert.equal(laterSameDay.equipment_conflicts.length, 0);

  // Another item books H-1 on Oct 8.
  await owner.request("POST", base, {
    event: {
      id: "event_other_hoist", type_id: "project_work", title: "Other job",
      start_at: "2026-10-08T16:30:00.000Z", end_at: "2026-10-08T17:30:00.000Z", resource_refs: [unitRef]
    }
  });

  // Moving the parent by a day moves the equipment child with it.
  const moved = await owner.request("POST", base, {
    event: { id: "event_shingles", start_at: "2026-10-02T15:00:00.000Z", end_at: "2026-10-02T23:00:00.000Z" }
  });
  assert.deepEqual(ids(moved.related_events), ["event_shingles_hoist"]);
  assert.deepEqual(range(moved.related_events[0]), ["2026-10-02T16:00:00.000Z", "2026-10-02T18:00:00.000Z"]);
  assert.deepEqual(moved.related_events[0].resource_refs, [unitRef], "the child still holds the unit");
  assert.deepEqual(range((await storedEvents(owner, orgId, projectId)).get("event_shingles_hoist")), ["2026-10-02T16:00:00.000Z", "2026-10-02T18:00:00.000Z"]);

  // Moving the parent onto the other booking's day collides: the child is
  // conflict-checked where it lands, and nothing is written.
  const collide = await saveEvent(owner, orgId, projectId, {
    id: "event_shingles", start_at: "2026-10-08T15:00:00.000Z", end_at: "2026-10-08T23:00:00.000Z"
  });
  assert.equal(collide.statusCode, 409, collide.body);
  assert.equal(collide.data.error, "equipment_conflict");
  const afterCollision = await storedEvents(owner, orgId, projectId);
  assert.equal(afterCollision.get("event_shingles").start_at, "2026-10-02T15:00:00.000Z", "the refused move changed nothing");
  assert.equal(afterCollision.get("event_shingles_hoist").start_at, "2026-10-02T16:00:00.000Z");

  // Floating calendar events: a resource holds the event's range; dates sent
  // on the ref are dropped, on the first write and on a later move.
  const reserved = await owner.request("PUT", `/v1/platform/organizations/${orgId}/calendar_events/reservation_h1`, {
    data: {
      id: "reservation_h1", title: "H-1 reserved", kind: "equipment_reservation", status: "scheduled",
      start_at: "2026-11-02T15:00:00.000Z", end_at: "2026-11-02T20:00:00.000Z",
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment", start_at: "2026-11-02T15:00:00.000Z", end_at: "2026-11-02T20:00:00.000Z" }]
    }
  });
  assert.deepEqual(reserved.document.data.resource_refs, [{ kind: "equipment_unit", id: unit.id, name: "", role: "equipment" }]);
  const floating = await owner.request("PATCH", `/v1/platform/organizations/${orgId}/calendar_events/reservation_h1`, {
    data: { start_at: "2026-11-03T15:00:00.000Z", end_at: "2026-11-03T20:00:00.000Z" }
  });
  assert.equal(floating.document.data.start_at, "2026-11-03T15:00:00.000Z");
  assert.deepEqual(floating.document.data.resource_refs, [{ kind: "equipment_unit", id: unit.id, name: "", role: "equipment" }]);
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
      resource_refs: [crewRef(crew)]
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
  const fresh = await saveEvent(owner, orgId, projectId, { id: "event_new", type_id: "project_work", title: "New", start_at: "2026-10-03T15:00:00.000Z", resource_refs: [crewRef(crew)] }, { expected_event_revision: 0 });
  assert.equal(fresh.statusCode, 200);

  // The token is optional: without one, the last write wins.
  const untokened = await owner.request("POST", base, { event: { id: "event_stale", title: "Tear-off (no token)" } });
  assert.equal(untokened.event.event_revision, 3);

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
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(removal.statusCode, 200, removal.body);
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

/* Runs writes concurrently. The JSON storage on Windows can transiently fail
 * a concurrent read of the session / organization file (delete-pending
 * rename) as 401 authentication_required or 404 not_found; such a request
 * never reached the write under test and is re-sent once afterwards. */
async function concurrently(writes: Array<() => Promise<{ statusCode: number; body: string; data: any }>>) {
  const results = await Promise.all(writes.map((write) => write()));
  for (let index = 0; index < results.length; index += 1) {
    if (["authentication_required", "not_found"].includes(results[index]!.data?.error)) results[index] = await writes[index]!();
  }
  return results;
}

test("a save of a project deleted meanwhile answers 404 and never recreates it (R4-EQ-3)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_deleted_elsewhere";
  await createProject(owner, orgId, projectId);
  const url = `/v1/platform/organizations/${orgId}/projects/${projectId}`;
  assert.equal((await owner.raw("DELETE", url)).statusCode, 200);

  // The Overview autosave (PATCH) of the window that still shows it.
  const patched = await owner.raw("PATCH", url, { data: { tech_notes: "late edit" }, metadata: {} });
  assert.equal(patched.statusCode, 404, patched.body);
  assert.equal(patched.data.error, "project_deleted");
  // A full save that names an existing copy is refused the same way.
  const replaced = await owner.raw("PUT", url, { data: { id: projectId, title: "Late" }, metadata: {}, require_existing: true });
  assert.equal(replaced.statusCode, 404, replaced.body);
  const stale = await owner.raw("PUT", url, { data: { id: projectId, title: "Late" }, metadata: {}, expected_revision: 3 });
  assert.equal(stale.statusCode, 404, stale.body);
  assert.equal((await owner.raw("GET", url)).statusCode, 404, "nothing was recreated");

  // Genuine creates keep working.
  const created = await owner.raw("PUT", url, { data: { id: projectId, title: "Recreated on purpose", events: [] }, metadata: {} });
  assert.equal(created.statusCode, 200, created.body);
  const posted = await owner.raw("POST", `/v1/platform/organizations/${orgId}/projects`, { id: "proj_posted_new", data: { id: "proj_posted_new", title: "Posted" }, metadata: {} });
  assert.ok([200, 201].includes(posted.statusCode), posted.body);
});

test("project document saves share the per-project queue with item writes (R4-EQ-4)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_patch_vs_items";
  await createProject(owner, orgId, projectId);
  const url = `/v1/platform/organizations/${orgId}/projects/${projectId}`;
  for (let round = 0; round < 3; round += 1) {
    const note = `notes round ${round}`;
    const results = await concurrently([
      ...[0, 1, 2, 3].map((index) => () => saveEvent(owner, orgId, projectId, {
        id: `event_q_${round}_${index}`, type_id: "project_work", title: `Q ${round}.${index}`,
        start_at: `2026-11-0${index + 2}T16:00:00.000Z`, end_at: `2026-11-0${index + 2}T17:00:00.000Z`
      })),
      () => owner.raw("PATCH", url, { data: { tech_notes: note, updated_at: new Date().toISOString() }, metadata: {} }),
      () => owner.raw("PUT", url, { data: { id: projectId, title: `Title ${round}`, tech_notes: note }, metadata: {} })
    ]);
    assert.deepEqual(results.map((response) => response.statusCode), results.map(() => 200), results.map((response) => response.body.slice(0, 200)).join(" | "));
    const stored = (await owner.request("GET", url)).document.data;
    assert.equal(stored.tech_notes, note, "the project save is not lost to concurrent item saves");
    assert.equal(stored.title, `Title ${round}`);
    const ids = stored.events.map((event: any) => event.id);
    for (let index = 0; index < 4; index += 1) assert.ok(ids.includes(`event_q_${round}_${index}`), "and no item is dropped by the project save");
  }
});

test("simultaneous bookings of one unit across projects and calendar events: only one wins (R4-EQ-5)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(orgId);
  const type = await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, { name: "Dump Trailer" });
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, { type_id: type.type.id, name: "DT-1", ownership: "owned" })).unit;
  const projects = ["proj_race_a", "proj_race_b", "proj_race_c"];
  for (const projectId of projects) await createProject(owner, orgId, projectId);
  const unitRef = { kind: "equipment_unit", id: unit.id, name: unit.name, role: "equipment" };
  for (let round = 0; round < 3; round += 1) {
    const day = `2026-12-0${round + 1}`;
    const window = { start_at: `${day}T16:00:00.000Z`, end_at: `${day}T20:00:00.000Z` };
    const results = await concurrently([
      ...projects.map((projectId) => () => saveEvent(owner, orgId, projectId, {
        id: `event_race_${round}_${projectId}`, type_id: "project_work", title: `Race ${projectId}`, ...window, resource_refs: [unitRef]
      })),
      () => owner.raw("PUT", `/v1/platform/organizations/${orgId}/calendar_events/booking_race_${round}`, {
        data: { id: `booking_race_${round}`, title: "DT-1 booked", vehicle_booking: true, status: "scheduled", ...window, resource_refs: [{ ...unitRef, role: "vehicle" }] }
      })
    ]);
    const statuses = results.map((response) => response.statusCode);
    assert.equal(statuses.filter((status) => status === 200).length, 1, `exactly one booking of DT-1 is stored: ${statuses.join(",")}`);
    assert.ok(results.filter((response) => response.statusCode !== 200).every((response) => response.statusCode === 409 && response.data?.error === "equipment_conflict"), results.map((response) => response.body.slice(0, 160)).join(" | "));
  }
});

test("emitting a work event does not wait for the queue to drain (R4-RAIL-2)", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const { emitWorkEvent } = await import("../work/engine.js");
  const { readEventRecord } = await import("../work/storage.js");
  const emitted = await emitWorkEvent({
    organization_id: orgId, branch_id: "default", project_id: "proj_background_drain",
    type: "project.updated", idempotency_key: `background-drain-${Date.now()}`, payload: {}
  }, { process: "background" });
  // Durable before the caller continues, but not yet processed by it.
  assert.equal((await readEventRecord(orgId, String(emitted?.id)))?.status, "pending");
  let status = "";
  for (let index = 0; index < 100 && status !== "completed"; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    status = String((await readEventRecord(orgId, String(emitted?.id)))?.status || "");
  }
  assert.equal(status, "completed", "the scheduled drain processes it right after");
});

// ── Parents and children (docs/architecture/schedule-events.md) ─────────────

/* A span with three children and a grandchild:
 *   span_roof          Oct 5 14:00 – Oct 7 22:00
 *   ├ child_span       { anchor: "span" }                      (no range sent)
 *   ├ child_offset     start + 2h, 3h long                     (no range sent)
 *   │  └ grandchild    end of child_offset + 30min, 1h long    (no range sent)
 *   └ child_manual     placed by hand, Oct 6 15:00 – 17:00     (no placement sent) */
async function createFamily(owner: TestClient, orgId: string, projectId: string) {
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const span = await owner.request("POST", base, {
    event: { id: "span_roof", kind: "schedule_group", title: "Roof", start_at: "2026-10-05T14:00:00.000Z", end_at: "2026-10-07T22:00:00.000Z" }
  });
  const childSpan = await owner.request("POST", base, {
    event: { id: "child_span", type_id: "project_work", title: "Install", parent_event_id: "span_roof", placement: { anchor: "span" } }
  });
  const childOffset = await owner.request("POST", base, {
    event: {
      id: "child_offset", type_id: "project_work", title: "Tear-off", parent_event_id: "span_roof",
      placement: { anchor: "start", offset: { value: 2, unit: "hour" }, duration: { value: 3, unit: "hour" } }
    }
  });
  const grandchild = await owner.request("POST", base, {
    event: {
      id: "grandchild", type_id: "project_work", title: "Haul-off", parent_event_id: "child_offset",
      placement: { anchor: "end", offset: { value: 30, unit: "minute" }, duration: { value: 1, unit: "hour" } }
    }
  });
  const childManual = await owner.request("POST", base, {
    event: {
      id: "child_manual", type_id: "project_work", title: "Inspection", parent_event_id: "span_roof",
      start_at: "2026-10-06T15:00:00.000Z", end_at: "2026-10-06T17:00:00.000Z"
    }
  });
  return { base, span, childSpan, childOffset, grandchild, childManual };
}

test("a parent drives its children: a move re-places them, a resize stretches span-anchored ones, a grandchild follows", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_family";
  await createProject(owner, orgId, projectId);
  const { base, span, childSpan, childOffset, grandchild, childManual } = await createFamily(owner, orgId, projectId);

  assert.equal(span.event.kind, "schedule_group");
  assert.deepEqual(range(span.event), ["2026-10-05T14:00:00.000Z", "2026-10-07T22:00:00.000Z"]);
  // A placement sent without a range places the child on save.
  assert.deepEqual(range(childSpan.event), ["2026-10-05T14:00:00.000Z", "2026-10-07T22:00:00.000Z"], "a span-anchored child covers its parent");
  assert.equal(childSpan.event.placement.anchor, "span");
  assert.equal(childSpan.event.status, "scheduled");
  assert.deepEqual(range(childOffset.event), ["2026-10-05T16:00:00.000Z", "2026-10-05T19:00:00.000Z"]);
  assert.equal(childOffset.event.placement.anchor, "start");
  assert.notEqual(childOffset.event.placement.manual, true);
  assert.deepEqual(range(grandchild.event), ["2026-10-05T19:30:00.000Z", "2026-10-05T20:30:00.000Z"], "an end-anchored grandchild is placed against its own parent");
  // A child placed by hand stores a manual placement: a fixed distance from its parent.
  assert.deepEqual(range(childManual.event), ["2026-10-06T15:00:00.000Z", "2026-10-06T17:00:00.000Z"]);
  assert.equal(childManual.event.placement.manual, true);
  assert.equal(childManual.event.placement.anchor, "start");
  // The span's range is its own: it is not derived from its children.
  assert.deepEqual(range((await storedEvents(owner, orgId, projectId)).get("span_roof")), ["2026-10-05T14:00:00.000Z", "2026-10-07T22:00:00.000Z"]);

  // Move the span a week later: every child comes back re-placed.
  const moved = await owner.request("POST", base, {
    event: { id: "span_roof", start_at: "2026-10-12T14:00:00.000Z", end_at: "2026-10-14T22:00:00.000Z" }
  });
  const expectedAfterMove: Record<string, string[]> = {
    child_span: ["2026-10-12T14:00:00.000Z", "2026-10-14T22:00:00.000Z"],
    child_offset: ["2026-10-12T16:00:00.000Z", "2026-10-12T19:00:00.000Z"],
    grandchild: ["2026-10-12T19:30:00.000Z", "2026-10-12T20:30:00.000Z"],
    child_manual: ["2026-10-13T15:00:00.000Z", "2026-10-13T17:00:00.000Z"]
  };
  assert.deepEqual(ids(moved.related_events), Object.keys(expectedAfterMove).sort());
  assert.deepEqual(moved.blocked_children, []);
  const storedAfterMove = await storedEvents(owner, orgId, projectId);
  for (const [id, expected] of Object.entries(expectedAfterMove)) {
    assert.deepEqual(range(moved.related_events.find((event: any) => event.id === id)), expected, `${id} in related_events`);
    assert.deepEqual(range(storedAfterMove.get(id)), expected, `${id} as stored`);
    assert.deepEqual(range(moved.project.events.find((event: any) => event.id === id)), expected, `${id} in the returned project`);
  }
  assert.equal(storedAfterMove.get("child_offset").duration_minutes, 180);
  assert.equal(storedAfterMove.get("grandchild").parent_event_id, "child_offset");

  // Resize the span (same start, two days longer): the span-anchored child
  // stretches; start-anchored children keep their offset and do not change.
  const resized = await owner.request("POST", base, {
    event: { id: "span_roof", start_at: "2026-10-12T14:00:00.000Z", end_at: "2026-10-16T22:00:00.000Z" }
  });
  assert.deepEqual(ids(resized.related_events), ["child_span"]);
  assert.deepEqual(range(resized.related_events[0]), ["2026-10-12T14:00:00.000Z", "2026-10-16T22:00:00.000Z"]);
  const storedAfterResize = await storedEvents(owner, orgId, projectId);
  assert.deepEqual(range(storedAfterResize.get("child_span")), ["2026-10-12T14:00:00.000Z", "2026-10-16T22:00:00.000Z"]);
  assert.deepEqual(range(storedAfterResize.get("child_offset")), expectedAfterMove.child_offset);
  assert.deepEqual(range(storedAfterResize.get("grandchild")), expectedAfterMove.grandchild);
  assert.deepEqual(range(storedAfterResize.get("child_manual")), expectedAfterMove.child_manual);

  // A save that does not change the parent's range re-places nothing.
  const retitled = await owner.request("POST", base, { event: { id: "span_roof", title: "Roof (phase 1)" } });
  assert.deepEqual(retitled.related_events, []);
});

test("locked and completed children do not move with their parent and come back in blocked_children", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_locked_child";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  await owner.request("POST", base, {
    event: { id: "span_lock", kind: "schedule_group", title: "Siding", start_at: "2026-10-05T14:00:00.000Z", end_at: "2026-10-05T22:00:00.000Z" }
  });
  const placement = { anchor: "start", offset: { value: 1, unit: "hour" }, duration: { value: 2, unit: "hour" } };
  const locked = await owner.request("POST", base, {
    event: { id: "child_locked", type_id: "project_work", title: "Delivery window", parent_event_id: "span_lock", placement, locked: true }
  });
  assert.equal(locked.event.locked, true);
  assert.deepEqual(range(locked.event), ["2026-10-05T15:00:00.000Z", "2026-10-05T17:00:00.000Z"]);
  await owner.request("POST", base, {
    event: {
      id: "child_done", type_id: "project_work", title: "Prep", parent_event_id: "span_lock",
      placement: { anchor: "start", offset: { value: 3, unit: "hour" }, duration: { value: 1, unit: "hour" } },
      start_at: "2026-10-05T17:00:00.000Z", end_at: "2026-10-05T18:00:00.000Z", status: "completed"
    }
  });
  await owner.request("POST", base, {
    event: { id: "child_free", type_id: "project_work", title: "Install", parent_event_id: "span_lock", placement: { anchor: "span" } }
  });

  const moved = await owner.request("POST", base, {
    event: { id: "span_lock", start_at: "2026-10-06T14:00:00.000Z", end_at: "2026-10-06T22:00:00.000Z" }
  });
  assert.deepEqual(ids(moved.related_events), ["child_free"], "only the free child moved");
  assert.deepEqual(ids(moved.blocked_children), ["child_done", "child_locked"]);
  const stored = await storedEvents(owner, orgId, projectId);
  assert.deepEqual(range(stored.get("child_locked")), ["2026-10-05T15:00:00.000Z", "2026-10-05T17:00:00.000Z"], "the locked child stayed");
  assert.equal(stored.get("child_locked").locked, true);
  assert.equal(stored.get("child_locked").placement.anchor, "start", "and keeps its placement");
  assert.deepEqual(range(stored.get("child_done")), ["2026-10-05T17:00:00.000Z", "2026-10-05T18:00:00.000Z"], "the completed child stayed");
  assert.deepEqual(range(stored.get("child_free")), ["2026-10-06T14:00:00.000Z", "2026-10-06T22:00:00.000Z"]);
});

test("moving a child by hand rewrites its placement as a fixed distance from its parent", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_hand_move";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  await owner.request("POST", base, {
    event: { id: "span_hand", kind: "schedule_group", title: "Gutters", start_at: "2026-10-05T14:00:00.000Z", end_at: "2026-10-05T22:00:00.000Z" }
  });
  const ruled = await owner.request("POST", base, {
    event: {
      id: "child_ruled", type_id: "project_work", title: "Hang gutters", parent_event_id: "span_hand",
      placement: { anchor: "start", offset: { value: 2, unit: "hour" }, duration: { value: 1, unit: "hour" } }
    }
  });
  assert.deepEqual(range(ruled.event), ["2026-10-05T16:00:00.000Z", "2026-10-05T17:00:00.000Z"]);
  const stretched = await owner.request("POST", base, {
    event: { id: "child_stretch", type_id: "project_work", title: "Site protection", parent_event_id: "span_hand", placement: { anchor: "span" } }
  });
  assert.deepEqual(range(stretched.event), ["2026-10-05T14:00:00.000Z", "2026-10-05T22:00:00.000Z"]);

  // A new range sent for the child is a hand move: the placement turns manual.
  const handMoved = await owner.request("POST", base, {
    event: { id: "child_ruled", start_at: "2026-10-05T19:00:00.000Z", end_at: "2026-10-05T20:30:00.000Z" }
  });
  assert.deepEqual(range(handMoved.event), ["2026-10-05T19:00:00.000Z", "2026-10-05T20:30:00.000Z"]);
  assert.equal(handMoved.event.placement.manual, true);
  assert.equal(handMoved.event.parent_event_id, "span_hand");
  assert.equal((await storedEvents(owner, orgId, projectId)).get("child_ruled").placement.manual, true);
  // A hand-moved child of a span anchor stops stretching with the parent.
  const handShrunk = await owner.request("POST", base, {
    event: { id: "child_stretch", start_at: "2026-10-05T15:00:00.000Z", end_at: "2026-10-05T16:00:00.000Z" }
  });
  assert.equal(handShrunk.event.placement.manual, true);
  assert.notEqual(handShrunk.event.placement.anchor, "span");

  // The parent moves a day and grows: both children keep their new distance and length.
  const moved = await owner.request("POST", base, {
    event: { id: "span_hand", start_at: "2026-10-06T14:00:00.000Z", end_at: "2026-10-07T22:00:00.000Z" }
  });
  assert.deepEqual(ids(moved.related_events), ["child_ruled", "child_stretch"]);
  const stored = await storedEvents(owner, orgId, projectId);
  assert.deepEqual(range(stored.get("child_ruled")), ["2026-10-06T19:00:00.000Z", "2026-10-06T20:30:00.000Z"], "five hours after the parent's start, not the rule's two");
  assert.deepEqual(range(stored.get("child_stretch")), ["2026-10-06T15:00:00.000Z", "2026-10-06T16:00:00.000Z"], "no longer covers the parent");
});

test("a hand move that sends the whole stored item back (placement included) with a new range also turns the placement manual", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_hand_move_full";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  await owner.request("POST", base, {
    event: { id: "span_full", kind: "schedule_group", title: "Gutters", start_at: "2026-10-05T14:00:00.000Z", end_at: "2026-10-05T22:00:00.000Z" }
  });
  const ruled = await owner.request("POST", base, {
    event: {
      id: "child_full", type_id: "project_work", title: "Hang gutters", parent_event_id: "span_full",
      placement: { anchor: "start", offset: { value: 2, unit: "hour" }, duration: { value: 1, unit: "hour" } }
    }
  });
  // What a drag in a schedule view sends: the item as stored, with new times.
  const handMoved = await owner.request("POST", base, {
    event: { ...ruled.event, start_at: "2026-10-05T19:00:00.000Z", end_at: "2026-10-05T20:00:00.000Z" }
  });
  assert.deepEqual(range(handMoved.event), ["2026-10-05T19:00:00.000Z", "2026-10-05T20:00:00.000Z"]);
  assert.equal(handMoved.event.placement.manual, true, "the unchanged rule placement sent back with a new range is a hand move");
  await owner.request("POST", base, {
    event: { id: "span_full", start_at: "2026-10-06T14:00:00.000Z", end_at: "2026-10-06T22:00:00.000Z" }
  });
  assert.deepEqual(range((await storedEvents(owner, orgId, projectId)).get("child_full")), ["2026-10-06T19:00:00.000Z", "2026-10-06T20:00:00.000Z"], "the child keeps the distance it was dragged to");
});

test("a parent must be on the project and can never be the item itself or one of its descendants", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_parent_rules";
  await createProject(owner, orgId, projectId);
  await createProject(owner, orgId, "proj_parent_other");
  const window = { start_at: "2026-10-05T14:00:00.000Z", end_at: "2026-10-05T22:00:00.000Z" };

  const unknown = await saveEvent(owner, orgId, projectId, { id: "orphan", type_id: "project_work", title: "Orphan", parent_event_id: "event_nowhere", ...window });
  assert.equal(unknown.statusCode, 400, unknown.body);
  assert.equal(unknown.data.error, "event_parent_unknown");
  // A parent on another project is not on this one.
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_parent_other/events`, { event: { id: "elsewhere", type_id: "project_work", title: "Elsewhere", ...window } });
  const foreign = await saveEvent(owner, orgId, projectId, { id: "orphan", type_id: "project_work", title: "Orphan", parent_event_id: "elsewhere", ...window });
  assert.equal(foreign.statusCode, 400, foreign.body);
  assert.equal(foreign.data.error, "event_parent_unknown");
  assert.equal((await storedEvents(owner, orgId, projectId)).has("orphan"), false, "a refused write stores nothing");

  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  await owner.request("POST", base, { event: { id: "top", kind: "schedule_group", title: "Top", ...window } });
  await owner.request("POST", base, { event: { id: "middle", type_id: "project_work", title: "Middle", parent_event_id: "top", placement: { anchor: "span" } } });
  await owner.request("POST", base, { event: { id: "bottom", type_id: "project_work", title: "Bottom", parent_event_id: "middle", placement: { anchor: "span" } } });

  const underGrandchild = await saveEvent(owner, orgId, projectId, { id: "top", parent_event_id: "bottom" });
  assert.equal(underGrandchild.statusCode, 400, underGrandchild.body);
  assert.equal(underGrandchild.data.error, "event_parent_cycle");
  const underChild = await saveEvent(owner, orgId, projectId, { id: "top", parent_event_id: "middle" });
  assert.equal(underChild.statusCode, 400, underChild.body);
  assert.equal(underChild.data.error, "event_parent_cycle");
  const underItself = await saveEvent(owner, orgId, projectId, { id: "middle", parent_event_id: "middle" });
  assert.equal(underItself.statusCode, 400, underItself.body);
  assert.equal(underItself.data.error, "event_parent_cycle");
  const stored = await storedEvents(owner, orgId, projectId);
  assert.ok(!stored.get("top").parent_event_id, "the refused writes changed nothing");
  assert.equal(stored.get("middle").parent_event_id, "top");
});

test("deleting a parent leaves its children on the project with no parent and no placement", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_delete_parent";
  await createProject(owner, orgId, projectId);
  const { base } = await createFamily(owner, orgId, projectId);

  const removal = await owner.request("DELETE", `${base}/span_roof`);
  assert.equal(removal.deleted, true);
  const stored = await storedEvents(owner, orgId, projectId);
  assert.deepEqual([...stored.keys()].sort(), ["child_manual", "child_offset", "child_span", "grandchild"]);
  for (const id of ["child_span", "child_offset", "child_manual"]) {
    assert.ok(!stored.get(id).parent_event_id, `${id} has no parent`);
    assert.ok(!stored.get(id).placement, `${id} has no placement`);
  }
  // They stay where they were, and the next level down is untouched.
  assert.deepEqual(range(stored.get("child_offset")), ["2026-10-05T16:00:00.000Z", "2026-10-05T19:00:00.000Z"]);
  assert.deepEqual(range(stored.get("child_manual")), ["2026-10-06T15:00:00.000Z", "2026-10-06T17:00:00.000Z"]);
  assert.equal(stored.get("grandchild").parent_event_id, "child_offset");
  assert.equal(stored.get("grandchild").placement.anchor, "end");
  // The former child is now a parent in its own right: its child still follows it.
  const moved = await owner.request("POST", base, {
    event: { id: "child_offset", start_at: "2026-10-08T16:00:00.000Z", end_at: "2026-10-08T19:00:00.000Z" }
  });
  assert.ok(!moved.event.placement, "moving a parentless item gives it no placement");
  assert.deepEqual(ids(moved.related_events), ["grandchild"]);
  assert.deepEqual(range(moved.related_events[0]), ["2026-10-08T19:30:00.000Z", "2026-10-08T20:30:00.000Z"]);
});

test("unscheduling a parent unschedules its placed children; scheduling it again places them", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const projectId = "proj_unschedule_parent";
  await createProject(owner, orgId, projectId);
  const { base } = await createFamily(owner, orgId, projectId);

  const unscheduled = await owner.request("POST", base, { event: { id: "span_roof", status: "unscheduled", start_at: "", end_at: "" } });
  assert.equal(unscheduled.event.status, "unscheduled");
  assert.equal(unscheduled.event.start_at, "");
  assert.deepEqual(ids(unscheduled.related_events), ["child_manual", "child_offset", "child_span", "grandchild"]);
  const stored = await storedEvents(owner, orgId, projectId);
  for (const id of ["child_span", "child_offset", "child_manual", "grandchild"]) {
    assert.equal(stored.get(id).status, "unscheduled", `${id} is unscheduled`);
    assert.ok(!stored.get(id).start_at, `${id} holds no range`);
    assert.ok(stored.get(id).placement, `${id} keeps its placement`);
    assert.ok(stored.get(id).parent_event_id, `${id} keeps its parent`);
  }

  const rescheduled = await owner.request("POST", base, {
    event: { id: "span_roof", status: "scheduled", start_at: "2026-10-19T14:00:00.000Z", end_at: "2026-10-21T22:00:00.000Z" }
  });
  assert.deepEqual(ids(rescheduled.related_events), ["child_manual", "child_offset", "child_span", "grandchild"]);
  const placed = await storedEvents(owner, orgId, projectId);
  assert.deepEqual(range(placed.get("child_span")), ["2026-10-19T14:00:00.000Z", "2026-10-21T22:00:00.000Z"]);
  assert.deepEqual(range(placed.get("child_offset")), ["2026-10-19T16:00:00.000Z", "2026-10-19T19:00:00.000Z"]);
  assert.deepEqual(range(placed.get("grandchild")), ["2026-10-19T19:30:00.000Z", "2026-10-19T20:30:00.000Z"]);
  assert.deepEqual(range(placed.get("child_manual")), ["2026-10-20T15:00:00.000Z", "2026-10-20T17:00:00.000Z"]);
  for (const id of ["child_span", "child_offset", "child_manual", "grandchild"]) assert.equal(placed.get(id).status, "scheduled", `${id} is scheduled again`);
});

// ── Assignee overlap ────────────────────────────────────────────────────────

test("overlap warns by default: the save succeeds and names the other event and its project", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  const bravo = await createCrew(owner, orgId, "Bravo Crew");
  for (const projectId of ["proj_warn_a", "proj_warn_b"]) await createProject(owner, orgId, projectId);
  const work = (id: string, start: string, end: string, refs: any[], extra: any = {}) => ({
    id, type_id: "project_work", title: `Work ${id}`, start_at: start, end_at: end, resource_refs: refs, ...extra
  });

  const first = await saveEvent(owner, orgId, "proj_warn_a", work("warn_first", "2026-10-20T14:00:00.000Z", "2026-10-20T18:00:00.000Z", [crewRef(alpha)]));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.data.assignee_conflicts, []);

  // Same crew, another project, intersecting range: saved, with the overlap returned.
  const second = await saveEvent(owner, orgId, "proj_warn_b", work("warn_second", "2026-10-20T16:00:00.000Z", "2026-10-20T20:00:00.000Z", [crewRef(alpha), crewRef(bravo)]));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.data.assignee_conflicts.length, 1, "only the double-booked crew is reported");
  const conflict = second.data.assignee_conflicts[0];
  assert.equal(conflict.event_id, "warn_second");
  assert.deepEqual(conflict.assignee, { kind: "resource_group", id: alpha.id, name: alpha.name });
  assert.equal(conflict.reason, "overlap");
  assert.equal(conflict.capacity, 1, "an assignee with no units does one job at a time");
  assert.deepEqual(conflict.conflicts, [{
    event_id: "warn_first", project_id: "proj_warn_a", project_title: "Project proj_warn_a", title: "Work warn_first",
    start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T18:00:00.000Z"
  }]);
  assert.ok((await storedEvents(owner, orgId, "proj_warn_b")).has("warn_second"), "a warning does not stop the save");

  // Ranges that do not intersect (another day, or touching end to start) are free.
  const otherDay = await saveEvent(owner, orgId, "proj_warn_b", work("warn_other_day", "2026-10-21T14:00:00.000Z", "2026-10-21T18:00:00.000Z", [crewRef(alpha)]));
  assert.equal(otherDay.statusCode, 200, otherDay.body);
  assert.deepEqual(otherDay.data.assignee_conflicts, []);
  const touching = await saveEvent(owner, orgId, "proj_warn_b", work("warn_touching", "2026-10-21T18:00:00.000Z", "2026-10-21T20:00:00.000Z", [crewRef(alpha)]));
  assert.deepEqual(touching.data.assignee_conflicts, []);
  // Another crew in the same range is free too.
  const otherCrew = await saveEvent(owner, orgId, "proj_warn_b", work("warn_other_crew", "2026-10-22T14:00:00.000Z", "2026-10-22T18:00:00.000Z", [crewRef(bravo)]));
  assert.deepEqual(otherCrew.data.assignee_conflicts, []);
  // Events in the same project overlap like any others.
  const sameProject = await saveEvent(owner, orgId, "proj_warn_b", work("warn_same_project", "2026-10-22T15:00:00.000Z", "2026-10-22T16:00:00.000Z", [crewRef(bravo)]));
  assert.deepEqual(sameProject.data.assignee_conflicts.map((entry: any) => entry.conflicts.map((other: any) => other.event_id)), [["warn_other_crew"]]);

  // Cancelled and unscheduled events hold nothing.
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_warn_a/events`, { event: { id: "warn_first", status: "cancelled" } });
  const afterCancel = await saveEvent(owner, orgId, "proj_warn_b", work("warn_after_cancel", "2026-10-20T14:30:00.000Z", "2026-10-20T15:30:00.000Z", [crewRef(alpha)]));
  assert.equal(afterCancel.statusCode, 200, afterCancel.body);
  assert.deepEqual(afterCancel.data.assignee_conflicts, []);

  // A save that changes neither range nor assignees is not re-checked.
  const retitled = await saveEvent(owner, orgId, "proj_warn_b", { id: "warn_second", title: "Renamed" });
  assert.deepEqual(retitled.data.assignee_conflicts, []);
});

test("family is ignored: a child never conflicts with its ancestors or descendants, and a move answers for every re-placed child", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  const bravo = await createCrew(owner, orgId, "Bravo Crew");
  const projectId = "proj_family_overlap";
  await createProject(owner, orgId, projectId);
  await createProject(owner, orgId, "proj_family_outside");
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;

  const parent = await owner.request("POST", base, {
    event: { id: "fam_parent", type_id: "project_work", title: "Roof", start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T22:00:00.000Z", resource_refs: [crewRef(alpha)] }
  });
  assert.deepEqual(parent.assignee_conflicts, []);
  const child = await owner.request("POST", base, {
    event: { id: "fam_child", type_id: "project_work", title: "Tear-off", parent_event_id: "fam_parent", placement: { anchor: "span" }, resource_refs: [crewRef(alpha)] }
  });
  assert.deepEqual(range(child.event), ["2026-10-20T14:00:00.000Z", "2026-10-20T22:00:00.000Z"]);
  assert.deepEqual(child.assignee_conflicts, [], "a child with its parent's crew, inside its parent, is not double-booked");
  const grandchild = await owner.request("POST", base, {
    event: {
      id: "fam_grandchild", type_id: "project_work", title: "Haul-off", parent_event_id: "fam_child",
      placement: { anchor: "start", offset: { value: 1, unit: "hour" }, duration: { value: 2, unit: "hour" } },
      resource_refs: [crewRef(alpha), crewRef(bravo)]
    }
  });
  assert.deepEqual(grandchild.assignee_conflicts, [], "nor with its grandparent");
  // Re-saving the parent with a new crew list re-checks it: its descendants are family too.
  const parentAgain = await owner.request("POST", base, { event: { id: "fam_parent", resource_refs: [crewRef(alpha), crewRef(bravo)] } });
  assert.deepEqual(parentAgain.assignee_conflicts, []);

  // An event outside the family, on the same project, does conflict with all three.
  const outsider = await owner.request("POST", base, {
    event: { id: "fam_outsider", type_id: "project_work", title: "Unrelated", start_at: "2026-10-20T15:30:00.000Z", end_at: "2026-10-20T16:30:00.000Z", resource_refs: [crewRef(alpha)] }
  });
  assert.equal(outsider.assignee_conflicts.length, 1);
  assert.deepEqual(outsider.assignee_conflicts[0].conflicts.map((other: any) => other.event_id).sort(), ["fam_child", "fam_grandchild", "fam_parent"]);
  await owner.request("DELETE", `${base}/fam_outsider`);

  // Bravo is booked elsewhere on the 27th, 15:00–16:00. Moving the parent onto
  // that day carries the grandchild (bravo, 15:00–17:00) into it: the one
  // response reports the overlap for the re-placed grandchild.
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_family_outside/events`, {
    event: { id: "fam_elsewhere", type_id: "project_work", title: "Elsewhere", start_at: "2026-10-27T15:00:00.000Z", end_at: "2026-10-27T16:00:00.000Z", resource_refs: [crewRef(bravo)] }
  });
  const moved = await owner.request("POST", base, {
    event: { id: "fam_parent", start_at: "2026-10-27T14:00:00.000Z", end_at: "2026-10-27T22:00:00.000Z" }
  });
  assert.deepEqual(ids(moved.related_events), ["fam_child", "fam_grandchild"]);
  const byEvent = new Map<string, any[]>();
  for (const entry of moved.assignee_conflicts) byEvent.set(entry.event_id, [...(byEvent.get(entry.event_id) || []), entry]);
  assert.deepEqual([...byEvent.keys()].sort(), ["fam_grandchild", "fam_parent"], "the parent and the grandchild both name bravo; the child does not");
  for (const entry of moved.assignee_conflicts) {
    assert.equal(entry.assignee.id, bravo.id);
    assert.equal(entry.reason, "overlap");
    assert.deepEqual(entry.conflicts.map((other: any) => [other.event_id, other.project_id]), [["fam_elsewhere", "proj_family_outside"]]);
  }
});

test("overlap mode: block refuses with 409 assignee_conflict; one assignee can be set to allow or block on its own", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  const bravo = await createCrew(owner, orgId, "Bravo Crew");
  for (const projectId of ["proj_block_a", "proj_block_b"]) await createProject(owner, orgId, projectId);
  const settingsUrl = `/v1/platform/organizations/${orgId}/assignee-scheduling`;
  const overlapping = (id: string, crew: Crew) => ({
    id, type_id: "project_work", title: `Work ${id}`, start_at: "2026-10-20T16:00:00.000Z", end_at: "2026-10-20T20:00:00.000Z", resource_refs: [crewRef(crew)]
  });
  for (const crew of [alpha, bravo]) {
    await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_block_a/events`, {
      event: { id: `held_${crew.name.split(" ")[0]!.toLowerCase()}`, type_id: "project_work", title: `${crew.name} held`, start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T18:00:00.000Z", resource_refs: [crewRef(crew)] }
    });
  }
  const initial = await owner.request("GET", settingsUrl);
  assert.equal(initial.default_overlap, "warn");
  assert.deepEqual(initial.settings, []);

  // Organization default: block.
  await setOverlapDefault(owner, orgId, "block");
  assert.equal((await owner.request("GET", settingsUrl)).default_overlap, "block");
  const refused = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_alpha", alpha));
  assert.equal(refused.statusCode, 409, refused.body);
  assert.equal(refused.data.error, "assignee_conflict");
  assert.equal(refused.data.details.conflicts.length, 1);
  assert.equal(refused.data.details.conflicts[0].assignee.id, alpha.id);
  assert.equal(refused.data.details.conflicts[0].reason, "overlap");
  assert.deepEqual(refused.data.details.conflicts[0].conflicts.map((other: any) => [other.event_id, other.project_id]), [["held_alpha", "proj_block_a"]]);
  assert.equal((await storedEvents(owner, orgId, "proj_block_b")).has("blocked_alpha"), false, "a refused save stores nothing");
  // Moving a stored event into an overlap is refused the same way.
  const free = await saveEvent(owner, orgId, "proj_block_b", { ...overlapping("movable_alpha", alpha), start_at: "2026-10-21T16:00:00.000Z", end_at: "2026-10-21T20:00:00.000Z" });
  assert.equal(free.statusCode, 200, free.body);
  const movedIn = await saveEvent(owner, orgId, "proj_block_b", { id: "movable_alpha", start_at: "2026-10-20T16:00:00.000Z", end_at: "2026-10-20T20:00:00.000Z" });
  assert.equal(movedIn.statusCode, 409, movedIn.body);
  assert.equal(movedIn.data.error, "assignee_conflict");
  assert.equal((await storedEvents(owner, orgId, "proj_block_b")).get("movable_alpha").start_at, "2026-10-21T16:00:00.000Z");
  // A floating calendar event is refused too.
  const floating = await owner.raw("PUT", `/v1/platform/organizations/${orgId}/calendar_events/cal_blocked_alpha`, {
    data: { id: "cal_blocked_alpha", title: "Shop day", status: "scheduled", start_at: "2026-10-20T15:00:00.000Z", end_at: "2026-10-20T16:00:00.000Z", resource_refs: [crewRef(alpha)] }
  });
  assert.equal(floating.statusCode, 409, floating.body);
  assert.equal(floating.data.error, "assignee_conflict");

  // That one assignee set to allow: its save goes through with nothing reported; the other crew is still blocked.
  const allowSetting = await setAssigneeOverlap(owner, orgId, { type: "resource_group", id: alpha.id }, "allow");
  assert.deepEqual(allowSetting.setting.assignee, { type: "resource_group", id: alpha.id });
  assert.equal(allowSetting.setting.overlap, "allow");
  const listed = await owner.request("GET", settingsUrl);
  assert.deepEqual(listed.settings.map((setting: any) => [setting.assignee.type, setting.assignee.id, setting.overlap]), [["resource_group", alpha.id, "allow"]]);
  const allowed = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_alpha", alpha));
  assert.equal(allowed.statusCode, 200, allowed.body);
  assert.deepEqual(allowed.data.assignee_conflicts, []);
  const stillBlocked = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_bravo", bravo));
  assert.equal(stillBlocked.statusCode, 409, stillBlocked.body);
  assert.equal(stillBlocked.data.details.conflicts[0].assignee.id, bravo.id);

  // Organization default back to warn, that assignee set to block: refused for it, warned for the other.
  await setOverlapDefault(owner, orgId, "warn");
  await setAssigneeOverlap(owner, orgId, { type: "resource_group", id: alpha.id }, "block");
  const blockedAgain = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_alpha_again", alpha));
  assert.equal(blockedAgain.statusCode, 409, blockedAgain.body);
  assert.equal(blockedAgain.data.error, "assignee_conflict");
  const warned = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_bravo", bravo));
  assert.equal(warned.statusCode, 200, warned.body);
  assert.equal(warned.data.assignee_conflicts.length, 1);
  assert.equal(warned.data.assignee_conflicts[0].assignee.id, bravo.id);

  // inherit follows the organization default again.
  await setAssigneeOverlap(owner, orgId, { type: "resource_group", id: alpha.id }, "inherit");
  const inherited = await saveEvent(owner, orgId, "proj_block_b", overlapping("blocked_alpha_again", alpha));
  assert.equal(inherited.statusCode, 200, inherited.body);
  assert.ok(inherited.data.assignee_conflicts.length >= 1);
  // Organization default allow skips the check.
  await setOverlapDefault(owner, orgId, "allow");
  const skipped = await saveEvent(owner, orgId, "proj_block_b", overlapping("allowed_by_default", alpha));
  assert.equal(skipped.statusCode, 200, skipped.body);
  assert.deepEqual(skipped.data.assignee_conflicts, []);

  // The setting names a real assignee and takes one of the four values.
  const unknownAssignee = await owner.raw("PUT", settingsUrl, { assignee: { type: "resource_group", id: "resource_group_missing" }, overlap: "block" });
  assert.equal(unknownAssignee.statusCode, 400, unknownAssignee.body);
  const badValue = await owner.raw("PUT", settingsUrl, { assignee: { type: "resource_group", id: alpha.id }, overlap: "sometimes" });
  assert.equal(badValue.statusCode, 400, badValue.body);
});

test("units give an assignee capacity; two events naming the same unit conflict", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  // Units are managed through the labor routes, which need Materials on.
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, pricebook: true, materials: true } } } }, { replace: false });
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": true, "platform.pricebook": true, "platform.materials": true });
  const summit = await createCrew(owner, orgId, "Summit Roofing");
  const solo = await createCrew(owner, orgId, "Solo Crew");
  const assignee = { type: "resource_group", id: summit.id };
  const north = (await owner.request("POST", `/v1/materials/organizations/${orgId}/assignee-units`, { assignee, name: "North" })).unit;
  const south = (await owner.request("POST", `/v1/materials/organizations/${orgId}/assignee-units`, { assignee, name: "South" })).unit;
  assert.ok(north.id && south.id && north.id !== south.id);
  for (const projectId of ["proj_units_a", "proj_units_b", "proj_units_c"]) await createProject(owner, orgId, projectId);
  const work = (id: string, day: string, from: string, to: string, ref: any) => ({
    id, type_id: "project_work", title: `Work ${id}`, start_at: `2026-10-${day}T${from}:00:00.000Z`, end_at: `2026-10-${day}T${to}:00:00.000Z`, resource_refs: [ref]
  });

  // Two units: two overlapping jobs fit, a third does not.
  const one = await saveEvent(owner, orgId, "proj_units_a", work("cap_one", "20", "14", "18", crewRef(summit)));
  const two = await saveEvent(owner, orgId, "proj_units_b", work("cap_two", "20", "15", "19", crewRef(summit)));
  assert.equal(two.statusCode, 200, two.body);
  assert.deepEqual(one.data.assignee_conflicts, []);
  assert.deepEqual(two.data.assignee_conflicts, [], "the second job goes to the second unit");
  const three = await saveEvent(owner, orgId, "proj_units_c", work("cap_three", "20", "16", "20", crewRef(summit)));
  assert.equal(three.statusCode, 200, three.body);
  assert.equal(three.data.assignee_conflicts.length, 1);
  assert.equal(three.data.assignee_conflicts[0].reason, "overlap");
  assert.equal(three.data.assignee_conflicts[0].capacity, 2);
  assert.deepEqual(three.data.assignee_conflicts[0].conflicts.map((other: any) => other.event_id).sort(), ["cap_one", "cap_two"]);
  // A third job that only meets them one at a time still fits: 14–18 and 19–23 never run together.
  const staggered = await saveEvent(owner, orgId, "proj_units_c", work("cap_staggered", "21", "14", "18", crewRef(summit)));
  await saveEvent(owner, orgId, "proj_units_a", work("cap_staggered_late", "21", "19", "23", crewRef(summit)));
  const between = await saveEvent(owner, orgId, "proj_units_b", work("cap_between", "21", "17", "20", crewRef(summit)));
  assert.deepEqual(staggered.data.assignee_conflicts, []);
  assert.deepEqual(between.data.assignee_conflicts, [], "never more than two at once");
  // An assignee with no units still does one job at a time.
  await saveEvent(owner, orgId, "proj_units_a", work("solo_one", "20", "14", "18", crewRef(solo)));
  const soloTwo = await saveEvent(owner, orgId, "proj_units_b", work("solo_two", "20", "15", "19", crewRef(solo)));
  assert.equal(soloTwo.data.assignee_conflicts[0].capacity, 1);

  // Naming a unit: different units side by side are fine, the same unit twice is a `unit` conflict.
  const northJob = await saveEvent(owner, orgId, "proj_units_a", work("unit_north_one", "22", "14", "18", crewRef(summit, { unit_id: north.id })));
  assert.equal(northJob.statusCode, 200, northJob.body);
  assert.equal(northJob.data.event.resource_refs[0].unit_id, north.id, "the unit is stored on the assignee's entry");
  const southJob = await saveEvent(owner, orgId, "proj_units_b", work("unit_south_one", "22", "15", "19", crewRef(summit, { unit_id: south.id })));
  assert.deepEqual(southJob.data.assignee_conflicts, []);
  const northAgain = await saveEvent(owner, orgId, "proj_units_c", work("unit_north_two", "23", "15", "19", crewRef(summit, { unit_id: north.id })));
  assert.deepEqual(northAgain.data.assignee_conflicts, [], "the same unit on another day is free");
  const northClash = await saveEvent(owner, orgId, "proj_units_c", work("unit_north_clash", "23", "16", "17", crewRef(summit, { unit_id: north.id })));
  assert.equal(northClash.statusCode, 200, northClash.body);
  assert.equal(northClash.data.assignee_conflicts.length, 1);
  const clash = northClash.data.assignee_conflicts[0];
  assert.equal(clash.reason, "unit");
  assert.equal(clash.capacity, 2);
  assert.deepEqual(clash.assignee, { kind: "resource_group", id: summit.id, name: summit.name, unit_id: north.id });
  assert.deepEqual(clash.conflicts.map((other: any) => [other.event_id, other.project_id, other.unit_id]), [["unit_north_two", "proj_units_c", north.id]]);
});

test("people attached through assigned_user_ids are overlap-checked like any other assignee", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const users = await owner.request("GET", `/v1/platform/organizations/${orgId}/users`);
  const personId = String(users.documents[0]?.id || "");
  assert.ok(personId);
  for (const projectId of ["proj_people_a", "proj_people_b"]) await createProject(owner, orgId, projectId);
  const visit = (id: string, from: string, to: string, extra: any = {}) => ({
    id, type_id: "custom", title: `Visit ${id}`, start_at: `2026-10-20T${from}:00:00.000Z`, end_at: `2026-10-20T${to}:00:00.000Z`, ...extra
  });

  const first = await saveEvent(owner, orgId, "proj_people_a", visit("visit_one", "14", "16", { assigned_user_ids: [personId] }));
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.data.assignee_conflicts, []);
  const second = await saveEvent(owner, orgId, "proj_people_b", visit("visit_two", "15", "17", { assigned_user_ids: [personId] }));
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.data.assignee_conflicts.length, 1);
  assert.equal(second.data.assignee_conflicts[0].event_id, "visit_two");
  assert.equal(second.data.assignee_conflicts[0].assignee.kind, "organization_user");
  assert.equal(second.data.assignee_conflicts[0].assignee.id, personId);
  assert.equal(second.data.assignee_conflicts[0].reason, "overlap");
  assert.deepEqual(second.data.assignee_conflicts[0].conflicts.map((other: any) => [other.event_id, other.project_id]), [["visit_one", "proj_people_a"]]);
  const later = await saveEvent(owner, orgId, "proj_people_b", visit("visit_later", "18", "19", { assigned_user_ids: [personId] }));
  assert.deepEqual(later.data.assignee_conflicts, []);

  // The same person named in resource_refs meets the events that hold them through assigned_user_ids.
  const viaRefs = await saveEvent(owner, orgId, "proj_people_b", visit("visit_refs", "14", "15", { resource_refs: [{ kind: "organization_user", id: personId, name: "Schedule Owner", role: "crew" }] }));
  assert.equal(viaRefs.statusCode, 200, viaRefs.body);
  assert.equal(viaRefs.data.assignee_conflicts.length, 1);
  assert.deepEqual(viaRefs.data.assignee_conflicts[0].conflicts.map((other: any) => other.event_id), ["visit_one"]);

  // And the person's own setting applies.
  await setAssigneeOverlap(owner, orgId, { type: "organization_user", id: personId }, "block");
  const blocked = await saveEvent(owner, orgId, "proj_people_b", visit("visit_blocked", "15", "16", { assigned_user_ids: [personId] }));
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.data.error, "assignee_conflict");
});

test("POST schedule/overlap-check answers for a draft without saving it", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  for (const projectId of ["proj_check_a", "proj_check_b"]) await createProject(owner, orgId, projectId);
  const checkUrl = `/v1/platform/organizations/${orgId}/schedule/overlap-check`;
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_check_a/events`, {
    event: { id: "check_held", type_id: "project_work", title: "Held", start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T18:00:00.000Z", resource_refs: [crewRef(alpha)] }
  });
  const draft = { id: "check_draft", type_id: "project_work", title: "Draft", start_at: "2026-10-20T16:00:00.000Z", end_at: "2026-10-20T20:00:00.000Z", resource_refs: [crewRef(alpha)] };

  const checked = await owner.request("POST", checkUrl, { project_id: "proj_check_b", event: draft });
  assert.equal(checked.mode, "warn");
  assert.equal(checked.assignee_conflicts.length, 1);
  assert.equal(checked.assignee_conflicts[0].event_id, "check_draft");
  assert.equal(checked.assignee_conflicts[0].reason, "overlap");
  assert.deepEqual(checked.assignee_conflicts[0].conflicts.map((other: any) => [other.event_id, other.project_id, other.project_title]), [["check_held", "proj_check_a", "Project proj_check_a"]]);
  assert.equal((await storedEvents(owner, orgId, "proj_check_b")).has("check_draft"), false, "the check saves nothing");

  // A draft with no project (a floating calendar event) is checked the same way.
  const floating = await owner.request("POST", checkUrl, { event: { ...draft, id: "check_floating" } });
  assert.deepEqual(floating.assignee_conflicts.map((entry: any) => entry.conflicts.map((other: any) => other.event_id)), [["check_held"]]);
  // A free range has no conflicts.
  const free = await owner.request("POST", checkUrl, { project_id: "proj_check_b", event: { ...draft, start_at: "2026-10-21T16:00:00.000Z", end_at: "2026-10-21T20:00:00.000Z" } });
  assert.deepEqual(free.assignee_conflicts, []);

  // The save then reports exactly what the check did.
  const saved = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/proj_check_b/events`, { event: draft });
  assert.deepEqual(saved.assignee_conflicts, checked.assignee_conflicts);
  // Checking a stored event against itself finds only the others.
  const recheck = await owner.request("POST", checkUrl, { project_id: "proj_check_b", event: saved.event });
  assert.deepEqual(recheck.assignee_conflicts, checked.assignee_conflicts);

  // The check reports the mode a save would meet.
  await setOverlapDefault(owner, orgId, "block");
  const underBlock = await owner.request("POST", checkUrl, { project_id: "proj_check_b", event: { ...draft, id: "check_draft_two" } });
  assert.equal(underBlock.mode, "block");
  assert.ok(underBlock.assignee_conflicts.length >= 1);
  assert.ok(underBlock.assignee_conflicts.every((entry: any) => entry.mode === "block"));
});

// ── Children are not customer appointments ──────────────────────────────────

test("a child of an appointment type is not sent for confirmation unless it says so itself", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const settingsUrl = `/v1/appointments/organizations/${orgId}/branches/default/confirmation-settings`;
  const initial = await owner.request("GET", settingsUrl);
  await owner.request("PUT", settingsUrl, {
    ...initial.settings,
    enabled: true,
    default_required: true,
    channels: { email: true, sms: true },
    schedule: { mode: "days_before", days_before: 1, time_of_day: "16:00" },
    timezone: "America/Chicago"
  });
  const projectId = "proj_child_appointment";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId, title: "Dana Reyes Roof Replacement", branch_id: "default", events: [],
      contacts: [{ id: "contact_dana", name: "Dana Reyes", email: "dana.reyes@example.test", phone: "+12065551234", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const queueUrl = `/v1/appointments/organizations/${orgId}/projects/${projectId}/confirmations`;
  const startAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const laterAt = new Date(Date.now() + 9 * 86_400_000).toISOString();

  // Without a parent, a sales appointment is a customer appointment as before.
  const appointment = await owner.request("POST", base, {
    branch_id: "default",
    event: { id: "appt_parent", event_type_default_id: "sales_appointment", title: "Roof Estimate", start_at: startAt, duration_minutes: 60 }
  });
  assert.equal(appointment.event.confirmation.required, true);
  assert.equal(appointment.event.confirmation.status, "pending");
  assert.deepEqual((await owner.request("GET", queueUrl)).confirmations.map((entry: any) => entry.event_id), ["appt_parent"]);

  // The same type under a parent is a piece of that work: no confirmation block, nothing queued.
  const child = await owner.request("POST", base, {
    branch_id: "default",
    event: { id: "appt_child", event_type_default_id: "sales_appointment", title: "Attic check", parent_event_id: "appt_parent", start_at: laterAt, duration_minutes: 60 }
  });
  assert.equal(child.event.parent_event_id, "appt_parent");
  assert.equal(child.event.confirmation, undefined, "a child carries no confirmation block");
  assert.equal(child.event.customer_visible, false);
  assert.deepEqual((await owner.request("GET", queueUrl)).confirmations.map((entry: any) => entry.event_id), ["appt_parent"]);
  // Moving the child still queues nothing.
  await owner.request("POST", base, { branch_id: "default", event: { id: "appt_child", start_at: new Date(Date.parse(laterAt) + 3_600_000).toISOString(), duration_minutes: 60 } });
  assert.deepEqual((await owner.request("GET", queueUrl)).confirmations.map((entry: any) => entry.event_id), ["appt_parent"]);

  // A child that asks for confirmation itself gets it.
  const optedIn = await owner.request("POST", base, {
    branch_id: "default",
    event: {
      id: "appt_child_opted", event_type_default_id: "sales_appointment", title: "Colour selection", parent_event_id: "appt_parent",
      start_at: laterAt, duration_minutes: 60, confirmation: { required: true }
    }
  });
  assert.equal(optedIn.event.confirmation.required, true);
  assert.equal(optedIn.event.confirmation.status, "pending");
  assert.deepEqual((await owner.request("GET", queueUrl)).confirmations.map((entry: any) => entry.event_id).sort(), ["appt_child_opted", "appt_parent"]);
});

// ── Removed fields ──────────────────────────────────────────────────────────

test("fields that no longer exist are never stored, on project items or floating calendar events", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const alpha = await createCrew(owner, orgId, "Alpha Crew");
  const bravo = await createCrew(owner, orgId, "Bravo Crew");
  const projectId = "proj_removed_fields";
  await createProject(owner, orgId, projectId);
  const base = `/v1/platform/organizations/${orgId}/projects/${projectId}/events`;
  const removed = {
    work_resource_ref: { kind: "resource_group", id: bravo.id, name: bravo.name },
    assigned_resource_kind: "resource_group", assigned_resource_id: bravo.id, assigned_resource_name: bravo.name,
    resource_id: bravo.id, resource_name: bravo.name,
    assigned_crew_id: bravo.id, assigned_crew_ids: [bravo.id], assigned_crew_name: bravo.name, assigned_crew: { id: bravo.id },
    crew_id: bravo.id, crew_name: bravo.name,
    material_list_id: "material_list_x", labor_list_id: "labor_list_x", equipment_list_id: "equipment_list_x",
    schedule_rule: { anchor: "group_start", offset_days: 1 }, schedule_rollup: "children", is_schedule_group: true
  };

  const saved = await owner.request("POST", base, {
    event: {
      id: "event_removed", type_id: "project_work", title: "Old-shape writer",
      start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T18:00:00.000Z",
      ...removed,
      resource_refs: [{ ...crewRef(alpha), start_at: "2026-10-20T14:00:00.000Z", end_at: "2026-10-20T15:00:00.000Z" }],
      metadata: { note: "kept", material_list_id: "material_list_x", scope_resource_list_id: "material_list_x", resource_type: "material", assigned_crew_id: bravo.id }
    }
  });
  assertNoRemovedFields(saved.event, "response");
  assert.deepEqual(saved.event.resource_refs, [crewRef(alpha)], "resource_refs is the only assignment; the removed mirrors add nobody");
  assert.deepEqual(saved.event.metadata, { note: "kept" }, "the list link and the mirrors are not copied into metadata");
  const stored = (await storedEvents(owner, orgId, projectId)).get("event_removed");
  assertNoRemovedFields(stored, "stored");
  assert.deepEqual(stored.resource_refs, [crewRef(alpha)]);
  assert.notEqual(stored.kind, "schedule_group", "is_schedule_group does not make a span; kind does");

  // The removed mirrors alone assign nobody, and do not replace a stored list.
  const mirrorsOnly = await owner.request("POST", base, {
    event: { id: "event_mirrors_only", type_id: "project_work", title: "Mirrors only", start_at: "2026-10-21T14:00:00.000Z", end_at: "2026-10-21T18:00:00.000Z", ...removed }
  });
  assert.deepEqual(mirrorsOnly.event.resource_refs, []);
  assertNoRemovedFields(mirrorsOnly.event, "mirrors only");
  const update = await owner.request("POST", base, { event: { id: "event_removed", ...removed } });
  assert.deepEqual(update.event.resource_refs, [crewRef(alpha)]);
  assertNoRemovedFields(update.event, "update");

  // An item stored before the change loses the fields on its next write.
  const { readDocument, upsertDocument } = await import("../platform/storage.js");
  const document: any = await readDocument(orgId, "projects", projectId);
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { ...document.data, events: document.data.events.map((event: any) => (event.id === "event_removed" ? { ...event, ...removed } : event)) },
    metadata: document.metadata
  }, { replace: true });
  const rewritten = await owner.request("POST", base, { event: { id: "event_removed", title: "Rewritten" } });
  assertNoRemovedFields(rewritten.event, "rewritten");
  assertNoRemovedFields((await storedEvents(owner, orgId, projectId)).get("event_removed"), "rewritten, stored");

  // Floating calendar events follow the same rule.
  const calendar = await owner.request("PUT", `/v1/platform/organizations/${orgId}/calendar_events/cal_removed`, {
    data: {
      id: "cal_removed", title: "Shop day", status: "scheduled",
      start_at: "2026-10-22T14:00:00.000Z", end_at: "2026-10-22T18:00:00.000Z",
      ...removed,
      resource_refs: [{ ...crewRef(alpha), start_at: "2026-10-22T14:00:00.000Z", end_at: "2026-10-22T15:00:00.000Z" }]
    }
  });
  assertNoRemovedFields(calendar.document.data, "calendar event");
  assert.deepEqual(calendar.document.data.resource_refs, [crewRef(alpha)]);
});
