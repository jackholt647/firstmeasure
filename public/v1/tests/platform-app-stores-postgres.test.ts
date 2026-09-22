import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

const url = process.env.TEST_POSTGRES_URL || "";
test("assistant threads and messages use shared PostgreSQL with organization isolation", { skip: !url }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: url, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../assistant/storage.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { store.closeAssistantDatabase(); await database.closePostgresPools(); });
  const org = `assistant_${randomUUID()}`;
  const thread = (await store.createAssistantThread({ organization_id: org, title: "Test", created_by_user_id: "alice" }))!;
  const threadId = String(thread.id);
  await Promise.all(Array.from({ length: 24 }, (_, i) => store.appendAssistantMessage(org, threadId, { role: "user", content: `Message ${i}`, data: { i } })));
  assert.equal((await store.listAssistantMessages(org, threadId)).length, 24);
  assert.equal((await store.listAssistantThreads(org, { created_by_user_id: "bob" })).length, 0);
  assert.equal((await store.listAssistantThreads(org, { created_by_user_id: "alice" })).length, 1);
  assert.equal(await store.readAssistantThread("another_org", threadId), null);
  await assert.rejects(store.appendAssistantMessage("another_org", threadId, { content: "forbidden" }));
  await Promise.all([store.updateAssistantThread(org, threadId, { title: "Renamed" }), store.updateAssistantThread(org, threadId, { status: "complete" })]);
  const updated = (await store.readAssistantThread(org, threadId))!;
  assert.equal(updated.title, "Renamed");
  assert.equal(updated.status, "complete");
  assert.equal(await store.deleteAssistantThread("another_org", threadId), false);
  assert.equal(await store.deleteAssistantThread(org, threadId), true);
  assert.equal((await store.listAssistantMessages(org, threadId)).length, 0);
});


test("equipment, training and appointment stores share PostgreSQL and serialize conflicting writes", { skip: !url }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: url, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const equipment = await import("../equipment/storage.js");
  const training = await import("../training/storage.js");
  const appointments = await import("../appointments/storage.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await equipment.closeEquipmentDatabase(); await training.closeTrainingDatabase(); await appointments.closeAppointmentsDatabase(); await database.closePostgresPools(); });
  const org = `stores_${randomUUID()}`;
  const category = await equipment.saveCategory(org, { name: "Trucks" });
  const type = await equipment.saveType(org, { category_id: category.id, name: "Pickup" });
  const unit = await equipment.saveUnit(org, { name: "Truck 1", type_id: type.id });
  assert.equal((await equipment.listUnits(org)).length, 1);
  await assert.rejects(equipment.readUnit("another-org", String(unit.id)));
  const changes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => equipment.saveUnit(org, { ...unit, name: `Truck ${i}`, expected_revision: 1 })));
  assert.equal(changes.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await equipment.readUnit(org, String(unit.id))).revision, 2);
  const course = await training.saveCourse(org, { title: "Safety", lessons: [{ id: "lesson_1" }] });
  await Promise.all(Array.from({ length: 12 }, () => training.recordLessonCompletion(org, "alice", String(course.id), "lesson_1", 100, true)));
  assert.equal((await training.listProgressForUser(org, "alice")).length, 1);
  assert.equal((await training.listProgressForUser(org, "bob")).length, 0);
  await assert.rejects(training.readCourse("another-org", String(course.id)));
  const now = new Date();
  for (let i = 0; i < 2; i++) await appointments.upsertConfirmationRow({ organization_id: org, branch_id: "default", project_id: "project_1", event_id: `event_${i}`,
    contact_email: "alice@example.test", contact_phone: "", contact_id: "alice", contact_name: "Alice", timezone: "UTC", local_day: now.toISOString().slice(0, 10),
    send_at: new Date(now.getTime() - 60_000).toISOString(), starts_at: new Date(now.getTime() + 86_400_000).toISOString(), channels: {}, config: {}, event: {} });
  const groups = await Promise.all(Array.from({ length: 16 }, () => appointments.claimDueConfirmationGroups(now, 120, 1)));
  assert.equal(groups.flat().length, 1);
  assert.equal(groups.flat()[0]!.length, 2);
  const recovered = await appointments.claimDueConfirmationGroups(new Date(now.getTime() + 121_000), 120, 1);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.length, 2);
  await assert.rejects(training.getTrainingDatabase().transaction(async () => {
    await training.saveCourse(org, { id: `${org}_rollback`, title: "Should disappear" });
    throw new Error("rollback");
  }), /rollback/);
  await assert.rejects(training.readCourse(org, `${org}_rollback`));
});


test("staff access, resource groups, connections and crew records use PostgreSQL atomically", { skip: !url }, async t => {
  Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: url, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const store = await import("../workforce/storage.js");
  const access = await import("../workforce/access.js");
  const personas = await import("../workforce/persona_templates.js");
  const crew = await import("../workforce/crew_storage.js");
  const connections = await import("../connections/storage.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await store.closeWorkforceDatabase(); await database.closePostgresPools(); });
  const org = `staff_${randomUUID()}`;
  const roles = await access.listAccessRoles(org);
  assert.ok(roles.length > 0);
  const seeds = await Promise.all(Array.from({ length: 6 }, () => personas.listPersonaTemplates(org)));
  assert.ok(seeds[0]!.length > 0);
  assert.ok(seeds.every(rows => rows.length === seeds[0]!.length));
  const role = await access.createAccessRole(org, { name: "Dispatch", application_ids: ["management"], permissions: { view_projects: true } });
  await assert.rejects(access.readAccessRole("another_org", role.id));
  const group = await store.createResourceGroup(org, { name: "Roof crew", branch_id: "default" });
  const changes = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.patchResourceGroup(org, String(group.id), { name: `Crew ${i}`, expected_revision: 1 })));
  assert.equal(changes.filter(result => result.status === "fulfilled").length, 1);
  const connection = await connections.createOrganizationConnection(org, { name: "Roof subcontractor", branch_ids: ["default"] });
  const connectionChanges = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => connections.patchOrganizationConnection(org, String(connection.id), { name: `Partner ${i}`, expected_revision: 1 })));
  assert.equal(connectionChanges.filter(result => result.status === "fulfilled").length, 1);
  const clocks = await Promise.allSettled(Array.from({ length: 8 }, () => crew.performCrewTimeClockAction(org, "alice", "clock_in")));
  assert.equal(clocks.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((await crew.readCrewTimeClock(org, "alice")).active, true);
  assert.equal((await crew.readCrewTimeClock("another_org", "alice")).active, false);
  await crew.performCrewTimeClockAction(org, "alice", "clock_out");
  assert.equal((await crew.readCrewTimeClock(org, "alice")).active, false);
  const checklist = await crew.createProjectChecklist(org, "project_1", { title: "Inspection", items: [{ title: "Check roof" }] }, "alice");
  const detail = await crew.readProjectChecklistDetail(org, "project_1", checklist.id);
  assert.equal(detail.items.length, 1);
  await assert.rejects(crew.readProjectChecklistDetail("another_org", "project_1", checklist.id));
});
