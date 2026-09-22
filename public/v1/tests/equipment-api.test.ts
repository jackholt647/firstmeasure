import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
async function setOperatorFlags(orgId: string, input: { values: Record<string, unknown> }) {
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  return saveCapabilityValues(orgId, { "platform.expanded_access": true, ...input.values });
}
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-equipment-test-"));
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
    email: `equipment-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Equipment Test Owner",
    phone: nextTestPhone(),
    company: "Equipment API Test Org",
    organization_id: `org_equipment_${suffix}`
  });
  return { orgId: String(registered.organization.id), suffix };
}

async function enableEquipment(_client: TestClient, orgId: string) {
  // Operator rollout is explicit in this platform fixture; customer owners cannot enable it.
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": true, "apps.equipment": true });
}

test("equipment: capability gate — routes reject until apps.equipment is on", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  const denied = await owner.raw("GET", `/v1/equipment/organizations/${orgId}/units`);
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.data.error, "capability_denied");

  await enableEquipment(owner, orgId);
  const allowed = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units`);
  assert.equal(allowed.ok, true);
});

test("equipment: seeded categories, type and unit CRUD, fleet decoration", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  // Categories seed once with the shipped set.
  const categories = await owner.request("GET", `/v1/equipment/organizations/${orgId}/categories`);
  const seedNames = categories.categories.map((category: any) => category.name);
  for (const expected of ["Vehicles", "Trailers", "Heavy Equipment", "Tools", "Site Services", "Facilities"]) {
    assert.ok(seedNames.includes(expected), `missing seed category ${expected}`);
  }
  const trailers = categories.categories.find((category: any) => category.seed_key === "trailers");

  // Create a serialized type in the Trailers category.
  const createdType = await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, {
    name: "Disposal Trailer",
    kind: "trailer",
    category_id: trailers.id,
    tracking: "unit",
    mobility: "mobile",
    default_meter_kind: "none",
    default_rates: { daily_cents: 12500 },
    scope_item_keys: ["disposal_trailer"]
  });
  const typeId = createdType.type.id;
  assert.equal(createdType.type.tracking, "unit");
  assert.equal(createdType.type.kind, "trailer");
  assert.equal(createdType.type.default_rates.daily_cents, 12500);

  const createdYard = await owner.request("POST", `/v1/equipment/organizations/${orgId}/yards`, {
    name: "Main Yard",
    address: { formatted: "100 Shop Way, Sacramento, CA", lat: 38.5816, lng: -121.4944, access_instructions: "Use the east gate" }
  });
  assert.equal(createdYard.yard.address.formatted, "100 Shop Way, Sacramento, CA");
  assert.equal(createdYard.yard.address.access_instructions, "Use the east gate");
  const yards = await owner.request("GET", `/v1/equipment/organizations/${orgId}/yards`);
  assert.equal(yards.count, 1);

  const archivedYard = await owner.request("DELETE", `/v1/equipment/organizations/${orgId}/yards/${createdYard.yard.id}`);
  assert.equal(archivedYard.yard.status, "archived");
  assert.equal((await owner.request("GET", `/v1/equipment/organizations/${orgId}/yards`)).count, 0);
  const yardArchive = await owner.request("GET", `/v1/equipment/organizations/${orgId}/yards?include_archived=1`);
  assert.equal(yardArchive.yards[0].status, "archived");
  const restoredYard = await owner.request("PATCH", `/v1/equipment/organizations/${orgId}/yards/${createdYard.yard.id}`, {
    ...archivedYard.yard,
    status: "active",
    expected_revision: archivedYard.yard.revision
  });
  assert.equal(restoredYard.yard.status, "active");

  // Revision conflicts are detected on type saves.
  const conflicted = await owner.raw("PATCH", `/v1/equipment/organizations/${orgId}/types/${typeId}`, {
    name: "Disposal Trailer XL",
    expected_revision: 99
  });
  assert.equal(conflicted.statusCode, 409);

  const archivedType = await owner.request("DELETE", `/v1/equipment/organizations/${orgId}/types/${typeId}`);
  assert.equal(archivedType.type.status, "archived");
  const typeArchive = await owner.request("GET", `/v1/equipment/organizations/${orgId}/types?include_archived=1`);
  assert.ok(typeArchive.types.some((type: any) => type.id === typeId && type.status === "archived"));
  const restoredType = await owner.request("PATCH", `/v1/equipment/organizations/${orgId}/types/${typeId}`, {
    status: "active",
    expected_revision: archivedType.type.revision
  });
  assert.equal(restoredType.type.status, "active");

  // Units: create, patch, list with type decoration and filters.
  const createdUnit = await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: typeId,
    name: "Trailer #2",
    identifier: "TR-002",
    color: "#2563eb",
    ownership: "owned",
    status: "available",
    acquisition: { kind: "owned", procurement_date: "2026-08-01", estimated_value_cents: 2850000 },
    operator_tag_overrides: [{ tag_id: "cdl_a", label: "CDL Class A" }],
    photos: [{ kind: "media_reference", media_id: "media_trailer_2", role: "primary" }],
    location: { kind: "yard", yard_id: createdYard.yard.id, label: "Main Yard", address: createdYard.yard.address },
    home_location: { kind: "yard", yard_id: createdYard.yard.id, label: "Main Yard", address: createdYard.yard.address }
  });
  const unitId = createdUnit.unit.id;
  await owner.request("PATCH", `/v1/equipment/organizations/${orgId}/units/${unitId}`, { license_plate: "ABC1234" });

  const units = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units`);
  assert.equal(units.count, 1);
  assert.equal(units.units[0].type_name, "Disposal Trailer");
  assert.equal(units.units[0].type_kind, "trailer");
  assert.equal(units.units[0].category_name, "Trailers");
  assert.equal(units.units[0].license_plate, "ABC1234");
  assert.equal(units.units[0].color, "#2563eb");
  assert.equal(units.units[0].home_location.yard_id, createdYard.yard.id);
  assert.equal(units.units[0].acquisition.estimated_value_cents, 2850000);
  assert.equal(units.units[0].operator_tag_overrides[0].tag_id, "cdl_a");
  assert.equal(units.units[0].photos[0].media_id, "media_trailer_2");

  const filtered = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units?q=tr-002`);
  assert.equal(filtered.count, 1);
  const missed = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units?q=nomatch`);
  assert.equal(missed.count, 0);

  // Archive removes the unit from default lists but keeps the record.
  await owner.request("DELETE", `/v1/equipment/organizations/${orgId}/units/${unitId}`);
  const afterArchive = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units`);
  assert.equal(afterArchive.count, 0);
  const withArchived = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units?include_archived=1`);
  assert.equal(withArchived.count, 1);
  assert.equal(withArchived.units[0].status, "retired");
});

test("equipment: rental pickup condition stores repeatable notes and media", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  const created = await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    name: "Rental Excavator",
    ownership: "rented",
    acquisition: {
      kind: "rented",
      rental_date: "2026-09-02",
      pickup_time: "08:30",
      return_date: "2026-09-09",
      return_time: "16:00",
      rental_cost_cents: 184500,
      pickup_condition: {
        date: "2026-09-02",
        time: "08:30",
        return_date: "2026-09-09",
        return_time: "16:00",
        notes: ["Scratch on left counterweight", "Fuel tank full"],
        media: [
          { kind: "media_reference", media_id: "pickup_photo_1", content_type: "image/jpeg" },
          { kind: "media_reference", media_id: "pickup_video_1", content_type: "video/mp4" }
        ]
      }
    }
  });

  assert.equal(created.unit.status, "available");
  assert.equal(created.unit.acquisition.pickup_condition.notes.length, 2);
  assert.equal(created.unit.acquisition.pickup_condition.media.length, 2);
  assert.equal(created.unit.acquisition.return_time, "16:00");
  assert.equal(created.unit.acquisition.rental_cost_cents, 184500);
});

test("equipment: customer-owned units are a filter, not a fork", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    name: "Company Truck", ownership: "owned"
  });
  await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    name: "Customer Furnace",
    ownership: "customer",
    contact_id: "contact_123",
    service_location: { address: "42 Main St" }
  });

  // Fleet surfaces default to internal ownership only.
  const fleet = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units`);
  assert.equal(fleet.count, 1);
  assert.equal(fleet.units[0].name, "Company Truck");

  // Customer units come back with an explicit ownership or contact filter.
  const customer = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units?ownership=customer`);
  assert.equal(customer.count, 1);
  assert.equal(customer.units[0].contact_id, "contact_123");
  const byContact = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units?ownership=customer&contact_id=contact_123`);
  assert.equal(byContact.count, 1);

  // Dashboard counts only the internal fleet.
  const dash = await owner.request("GET", `/v1/equipment/organizations/${orgId}/dashboard`);
  assert.equal(dash.counts.units, 1);
});

test("equipment: meter entries update the unit's current meter and history", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  const created = await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    name: "Skid Steer #1", ownership: "owned"
  });
  const unitId = created.unit.id;

  await owner.request("POST", `/v1/equipment/organizations/${orgId}/units/${unitId}/meter-entries`, {
    kind: "hours", value: 1450
  });
  await owner.request("POST", `/v1/equipment/organizations/${orgId}/units/${unitId}/meter-entries`, {
    kind: "fuel", gallons: 18.5, cost_cents: 6475
  });

  const unit = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units/${unitId}`);
  assert.equal(unit.unit.current_meter.hours, 1450);

  const history = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units/${unitId}/history`);
  assert.equal(history.meter_entries.length, 2);
  assert.equal(history.latest_meters.hours.value, 1450);
});

test("equipment scheduling: assignable subjects, resource_refs, conflicts warn then block", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  const type = await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, { name: "Skid Steer" });
  const unitA = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.type.id, name: "Skid Steer #1", ownership: "owned"
  })).unit;
  const unitB = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.type.id, name: "Skid Steer #2", ownership: "owned", status: "down"
  })).unit;
  const unitC = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.type.id, name: "Skid Steer #3", ownership: "owned"
  })).unit;

  // Equipment units surface as assignable subjects when scheduling is on.
  const catalog = await owner.request("GET", `/v1/workforce/organizations/${orgId}/branches/default/assignable-resources`);
  const equipmentSubjects = (catalog.subjects || catalog.resources || []).filter((subject: any) => subject.subject_type === "equipment_unit");
  assert.equal(equipmentSubjects.length, 3);
  assert.ok(equipmentSubjects.some((subject: any) => subject.name === "Skid Steer #1"));

  // A real crew so the event's crew assignment satisfies the default policy.
  const crew = (await owner.request("POST", `/v1/workforce/organizations/${orgId}/branches/default/resource-groups`, {
    name: "Alpha Crew", kind_id: "crew"
  })).group;

  // A project with one event booking unit A.
  const projectId = "proj_equipment_sched";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Equipment Sched", events: [] },
    metadata: { kind: "platform_project" }
  });
  const first = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_first",
      type_id: "project_work",
      title: "Demo day one",
      start_at: "2026-08-03T14:00:00.000Z",
      duration_minutes: 240,
      work_resource_ref: { kind: "resource_group", id: crew.id, name: "Alpha Crew" },
      resource_refs: [{ kind: "equipment_unit", id: unitA.id, name: unitA.name, role: "equipment" }],
      resourceRequirements: [
        { equipmentTypeId: type.type.id, name: "Skid Steer", quantity: 2 },
        { equipment_type_id: type.type.id, label: "Duplicate", quantity: 9 }
      ]
    }
  });
  assert.equal(first.equipment_conflicts.length, 0);
  // The singular crew assignment coexists with the equipment ref: the
  // resource_refs list carries both, crew derived from work_resource_ref.
  assert.equal(first.event.work_resource_ref.id, crew.id);
  assert.deepEqual(first.event.resource_refs.map((ref: any) => ref.kind).sort(), ["equipment_unit", "resource_group"]);
  assert.equal(first.event.resource_refs.find((ref: any) => ref.kind === "resource_group").id, crew.id);
  assert.deepEqual(first.event.resource_requirements, [{
    kind: "equipment_type", equipment_type_id: type.type.id, label: "Skid Steer", quantity: 2
  }]);

  // Writers that send only resource_refs back-fill the legacy mirrors.
  const refsOnly = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_refs_only",
      type_id: "project_work",
      title: "Refs-only writer",
      start_at: "2026-08-05T14:00:00.000Z",
      duration_minutes: 60,
      resource_refs: [
        { kind: "resource_group", id: crew.id, name: "Alpha Crew", role: "crew" },
        { kind: "equipment_unit", id: unitA.id, role: "equipment" }
      ]
    }
  });
  assert.equal(refsOnly.event.assigned_crew_id, crew.id);
  assert.equal(refsOnly.event.work_resource_ref.id, crew.id);

  // Overlapping second event: warn mode returns the conflict but allows it.
  const second = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_second",
      type_id: "project_work",
      title: "Overlapping work",
      start_at: "2026-08-03T16:00:00.000Z",
      duration_minutes: 120,
      resource_refs: [{ kind: "equipment_unit", id: unitA.id, name: unitA.name, role: "equipment" }]
    }
  });
  assert.equal(second.equipment_conflicts.length, 1);
  assert.equal(second.equipment_conflicts[0].reason, "double_booked");
  assert.equal(second.equipment_conflicts[0].events[0].id, "event_eq_first");

  // A unit can be needed for only a subset of a longer event. Conflict and
  // availability checks use the ref's window rather than the whole job.
  const subset = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_subset",
      type_id: "project_work",
      title: "All-day job, morning equipment",
      start_at: "2026-08-06T14:00:00.000Z",
      end_at: "2026-08-06T22:00:00.000Z",
      resource_refs: [{ kind:"equipment_unit", id:unitC.id, role:"equipment", start_at:"2026-08-06T14:00:00.000Z", end_at:"2026-08-06T15:00:00.000Z" }]
    }
  });
  assert.equal(subset.event.resource_refs.find((ref: any) => ref.id === unitC.id).end_at, "2026-08-06T15:00:00.000Z");
  const afterSubset = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id:"event_eq_after_subset",
      type_id:"project_work",
      title:"Afternoon use",
      start_at:"2026-08-06T16:00:00.000Z",
      end_at:"2026-08-06T17:00:00.000Z",
      resource_refs:[{ kind:"equipment_unit", id:unitC.id, role:"equipment" }]
    }
  });
  assert.equal(afterSubset.equipment_conflicts.length, 0);

  // A down unit is unavailable regardless of bookings.
  const downBooking = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_down",
      type_id: "project_work",
      title: "Down unit",
      start_at: "2026-08-04T14:00:00.000Z",
      duration_minutes: 60,
      resource_refs: [{ kind: "equipment_unit", id: unitB.id, role: "equipment" }]
    }
  });
  assert.equal(downBooking.equipment_conflicts[0].reason, "unit_unavailable");

  // The availability endpoint reports the same picture.
  const availability = await owner.request("GET", `/v1/equipment/organizations/${orgId}/availability?start=2026-08-03T15:00:00.000Z&end=2026-08-03T17:00:00.000Z&type_id=${type.type.id}`);
  const availabilityA = availability.units.find((unit: any) => unit.id === unitA.id);
  const availabilityB = availability.units.find((unit: any) => unit.id === unitB.id);
  assert.equal(availabilityA.available, false);
  assert.equal(availabilityA.bookings.length, 2);
  assert.equal(availabilityB.reason, "unit_unavailable");

  // Block mode rejects the write with a 409 equipment_conflict.
  await owner.request("PUT", `/v1/equipment/organizations/${orgId}/settings`, { conflict_mode: "block" });
  const blocked = await owner.raw("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_blocked",
      type_id: "project_work",
      title: "Should be blocked",
      start_at: "2026-08-03T15:00:00.000Z",
      duration_minutes: 60,
      resource_refs: [{ kind: "equipment_unit", id: unitA.id, role: "equipment" }]
    }
  });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.data.error, "equipment_conflict");

  // allow_double_booking on the type lifts the block.
  await owner.request("PATCH", `/v1/equipment/organizations/${orgId}/types/${type.type.id}`, { name: "Skid Steer", allow_double_booking: true });
  const allowed = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_eq_allowed",
      type_id: "project_work",
      title: "Double booking allowed",
      start_at: "2026-08-03T15:00:00.000Z",
      duration_minutes: 60,
      resource_refs: [{ kind: "equipment_unit", id: unitA.id, role: "equipment" }]
    }
  });
  assert.equal(allowed.equipment_conflicts.length, 0);
});

test("equipment maintenance: programs, due service, work orders, downtime conflicts, failed inspections", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await setOperatorFlags(orgId, {
    values: { "apps.equipment": true, "equipment.scheduling": true, "equipment.maintenance": true }
  });

  const type = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, { name: "Excavator" })).type;
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.id, name: "Excavator #1", ownership: "owned"
  })).unit;

  // A 30-day program for the whole type surfaces as due within the horizon.
  const program = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/service-programs`, {
    name: "Monthly inspection",
    kind: "inspection",
    type_id: type.id,
    trigger: { every_days: 30 },
    checklist: [{ label: "Tracks intact" }, { label: "Hydraulics leak-free" }],
    lead_time_days: 5
  })).program;
  const due = await owner.request("GET", `/v1/equipment/organizations/${orgId}/due-service`);
  assert.equal(due.count, 1);
  assert.equal(due.due_service[0].unit_id, unit.id);
  assert.equal(due.due_service[0].program_id, program.id);

  // Open + schedule the work order; scheduling creates the downtime block.
  const workOrder = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders`, {
    unit_id: unit.id, program_id: program.id
  })).work_order;
  assert.equal(workOrder.kind, "inspection");
  // An open order suppresses the due-service entry.
  const dueAfterOpen = await owner.request("GET", `/v1/equipment/organizations/${orgId}/due-service`);
  assert.equal(dueAfterOpen.count, 0);

  const scheduled = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders/${workOrder.id}/schedule`, {
    start_at: "2026-09-01T13:00:00.000Z",
    end_at: "2026-09-01T17:00:00.000Z"
  })).work_order;
  assert.equal(scheduled.status, "scheduled");
  assert.ok(scheduled.downtime_event_id);

  // The downtime block conflicts with a project booking like any other event.
  const projectId = "proj_equipment_downtime";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Downtime Conflict", events: [] },
    metadata: { kind: "platform_project" }
  });
  const overlapping = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_during_downtime",
      type_id: "project_work",
      title: "Dig day",
      start_at: "2026-09-01T14:00:00.000Z",
      duration_minutes: 120,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment" }]
    }
  });
  assert.equal(overlapping.equipment_conflicts.length, 1);
  assert.ok(overlapping.equipment_conflicts[0].events.some((entry: any) => entry.kind === "equipment_downtime"));

  // Completing with a failed checklist item logs the meter, opens a repair
  // order, and can set the unit down.
  const completion = await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders/${workOrder.id}/complete`, {
    cost: { parts_cents: 12000, labor_cents: 30000 },
    meter_at_service: { hours: 210 },
    checklist_state: [
      { label: "Tracks intact", passed: true },
      { label: "Hydraulics leak-free", passed: false, notes: "Slow leak at boom cylinder" }
    ],
    set_unit_down: true
  });
  assert.equal(completion.work_order.status, "completed");
  assert.equal(completion.failed_items, 1);
  assert.ok(completion.repair_order);
  assert.equal(completion.repair_order.kind, "repair");

  const unitAfter = (await owner.request("GET", `/v1/equipment/organizations/${orgId}/units/${unit.id}`)).unit;
  assert.equal(unitAfter.status, "down");
  assert.equal(unitAfter.current_meter.hours, 210);

  const history = await owner.request("GET", `/v1/equipment/organizations/${orgId}/units/${unit.id}/history`);
  assert.ok(history.work_orders.length >= 2);
  assert.ok(history.meter_entries.some((entry: any) => entry.source === "maintenance"));

  // Completion resolved the downtime block: the window is bookable again.
  const afterComplete = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_after_downtime",
      type_id: "project_work",
      title: "Second dig",
      start_at: "2026-09-01T18:00:00.000Z",
      duration_minutes: 60,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment" }]
    }
  });
  // The unit is down, so availability still flags it — but no downtime booking.
  assert.ok(afterComplete.equipment_conflicts.every((entry: any) => entry.reason === "unit_unavailable"));

  // Canceling a scheduled order releases its downtime block too.
  const secondOrder = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders`, {
    unit_id: unit.id, title: "Track tension check"
  })).work_order;
  await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders/${secondOrder.id}/schedule`, {
    start_at: "2026-09-05T13:00:00.000Z", end_at: "2026-09-05T15:00:00.000Z"
  });
  const canceled = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/work-orders/${secondOrder.id}/cancel`, {})).work_order;
  assert.equal(canceled.status, "canceled");
});

test("equipment requirements: scope items bind to types and auto-fulfill single units", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await setOperatorFlags(orgId, {
    values: { "apps.equipment": true, "equipment.scheduling": true, "equipment.requirements": true, "platform.pricebook": true, "platform.materials": true }
  });

  const trailerType = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, {
    name: "Disposal Trailer", scope_item_keys: ["disposal_trailer"]
  })).type;
  const trailer = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: trailerType.id, name: "Trailer #1", ownership: "owned"
  })).unit;

  const projectId = "proj_equipment_requirements";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Requirements Roof", events: [] },
    metadata: { kind: "platform_project" }
  });
  const generated = await owner.request("POST", `/v1/materials/organizations/${orgId}/projects/${projectId}/material-lists/initialize-from-scope`, {
    scope_template_id: "roof_replacement",
    scope: { root_items: [], measurements: { roofSquares: 30, shingleSquares: 28 } }
  });
  const equipmentEvent = generated.schedule_events.find((event: any) => event.resource_type === "equipment");
  assert.ok(equipmentEvent, "equipment event should generate");
  const requirements = equipmentEvent.resource_requirements;
  assert.ok(Array.isArray(requirements) && requirements.length >= 3);
  const trailerRequirement = requirements.find((entry: any) => entry.label === "Disposal trailer");
  assert.equal(trailerRequirement.equipment_type_id, trailerType.id);
  // The single active trailer auto-fulfilled the requirement.
  const refs = Array.isArray(equipmentEvent.resource_refs) ? equipmentEvent.resource_refs : [];
  assert.ok(refs.some((ref: any) => ref.kind === "equipment_unit" && ref.id === trailer.id));
});

test("equipment operators: missing certifications warn, then block when enforced", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await setOperatorFlags(orgId, {
    values: { "apps.equipment": true, "equipment.scheduling": true, "equipment.operators": true }
  });
  const type = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, {
    name: "Dump Truck", operator_requirements: [{ tag_id: "cdl_a", label: "CDL-A" }]
  })).type;
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.id, name: "Dump Truck #1"
  })).unit;
  const projectId = "proj_equipment_operators";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Operator Checks", events: [] },
    metadata: { kind: "platform_project" }
  });
  const warned = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_operator_warn",
      type_id: "project_work",
      title: "Hauling",
      start_at: "2026-08-10T14:00:00.000Z",
      duration_minutes: 240,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment" }]
    }
  });
  assert.equal(warned.equipment_operator_warnings.length, 1);
  assert.ok(warned.equipment_operator_warnings[0].message.includes("CDL-A"));

  await owner.request("PUT", `/v1/equipment/organizations/${orgId}/settings`, { operator_enforcement: "block" });
  const blocked = await owner.raw("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_operator_block",
      type_id: "project_work",
      title: "Hauling two",
      start_at: "2026-08-11T14:00:00.000Z",
      duration_minutes: 240,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment" }]
    }
  });
  assert.equal(blocked.statusCode, 400);
  assert.equal(blocked.data.error, "equipment_operator_required");
});

test("equipment custody and utilization: check-out/in, booked hours and costs", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await setOperatorFlags(orgId, {
    values: { "apps.equipment": true, "equipment.scheduling": true, "equipment.costing": true, "equipment.custody": true }
  });
  const type = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/types`, {
    name: "Lift", default_rates: { hourly_cents: 5000 }
  })).type;
  const unit = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units`, {
    type_id: type.id, name: "Lift #1"
  })).unit;

  // Custody: check out, double check-out rejected, check in clears.
  const checkedOut = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units/${unit.id}/check-out`, {
    expected_return_at: "2026-08-20T00:00:00.000Z", notes: "Site 12"
  })).unit;
  assert.ok(checkedOut.custody.user_id);
  const doubleOut = await owner.raw("POST", `/v1/equipment/organizations/${orgId}/units/${unit.id}/check-out`, {});
  assert.equal(doubleOut.statusCode, 400);
  const checkedIn = (await owner.request("POST", `/v1/equipment/organizations/${orgId}/units/${unit.id}/check-in`, {})).unit;
  assert.ok(!checkedIn.custody.user_id);

  // A 4-hour booking at $50/hr shows up in utilization.
  const projectId = "proj_equipment_util";
  await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Utilization", events: [] },
    metadata: { kind: "platform_project" }
  });
  await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: "event_util",
      type_id: "project_work",
      title: "Facade work",
      start_at: "2026-08-12T13:00:00.000Z",
      duration_minutes: 240,
      resource_refs: [{ kind: "equipment_unit", id: unit.id, role: "equipment" }]
    }
  });
  const result = await owner.request("GET", `/v1/equipment/organizations/${orgId}/utilization?start=2026-08-01T00:00:00.000Z&end=2026-08-31T00:00:00.000Z`);
  const row = result.units.find((entry: any) => entry.id === unit.id);
  assert.equal(row.booked_hours, 4);
  assert.equal(row.bookings, 1);
  assert.equal(row.projected_cost_cents, 4 * 5000);

  // Costing gate: turning the flag off closes the endpoint.
  await setOperatorFlags(orgId, {
    values: { "equipment.costing": false }
  });
  const denied = await owner.raw("GET", `/v1/equipment/organizations/${orgId}/utilization`);
  assert.equal(denied.statusCode, 403);
});

test("equipment: module settings defaults, saves, and revision conflicts", async () => {
  const owner = createSessionClient();
  const { orgId } = await registerOwner(owner);
  await enableEquipment(owner, orgId);

  const initial = await owner.request("GET", `/v1/equipment/organizations/${orgId}/settings`);
  assert.equal(initial.settings.conflict_mode, "warn");
  assert.equal(initial.settings.auto_fulfill_single_unit, true);
  assert.equal(initial.revision, 0);

  const saved = await owner.request("PUT", `/v1/equipment/organizations/${orgId}/settings`, {
    tier: "standard",
    conflict_mode: "block"
  });
  assert.equal(saved.settings.tier, "standard");
  assert.equal(saved.settings.conflict_mode, "block");
  assert.equal(saved.settings.operator_enforcement, "warn");
  assert.equal(saved.revision, 1);

  const conflicted = await owner.raw("PUT", `/v1/equipment/organizations/${orgId}/settings`, {
    conflict_mode: "off",
    expected_revision: 99
  });
  assert.equal(conflicted.statusCode, 409);
});
