import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
test("base records and time off are stored the same on both database backends", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assignee-base-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: root,
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const base = await import("../assignees/base.js");
  const off = await import("../assignees/time-off.js");
  const database = await import("../src/database/postgres.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await database.closePostgresPools(); await rm(root, { recursive: true, force: true }); });
  const org = `assignees_${randomUUID()}`, other = `assignees_${randomUUID()}`;
  const actor = { orgId: org, userId: "owner", system: true };
  const ana = { type: "organization_user" as const, id: "ana" }, crew = { type: "resource_group" as const, id: "crew_a" }, summit = { type: "organization_connection" as const, id: "summit" };

  assert.deepEqual(await base.readAssigneeBase(org, summit), { assignee: summit, type_ids: [], permission_defaults: { access_role_ids: [], permission_overrides: {} }, staffing_requirements: [], revision: 0 }, "nothing saved reads as an empty record, and reading writes nothing");
  assert.deepEqual(await base.listAssigneeBases(org), []);
  // An outside company's types are a list, and its own permission set sits beside them.
  assert.deepEqual([(await base.writeAssigneeBase(org, summit, { type_ids: ["subcontractor", "labor-supplier"] }, actor)).revision, (await base.readAssigneeBase(org, summit)).type_ids], [1, ["subcontractor", "labor-supplier"]]);
  const company = await base.writeAssigneeBase(org, summit, { permission_defaults: { access_role_ids: ["viewer"], permission_overrides: { view_schedule: true } } }, actor, 1);
  assert.deepEqual([company.revision, company.type_ids, company.permission_defaults], [2, ["subcontractor", "labor-supplier"], { access_role_ids: ["viewer"], permission_overrides: { view_schedule: true } }], "a part saved alone leaves the other parts as they were");
  const requirement = { id: "cdl", label: "CDL driver", count: 1, where: { match: "all" as const, rules: [{ field: "fields.has_cdl", operator: "equals", value: true }] } };
  assert.equal((await base.writeAssigneeBase(org, crew, { staffing_requirements: [requirement] }, actor, 0)).revision, 1);
  await assert.rejects(() => base.writeAssigneeBase(org, crew, { staffing_requirements: [] }, actor, 0), /changed elsewhere/);
  await assert.rejects(() => base.writeAssigneeBase(org, { type: "resource_group", id: "new" }, { staffing_requirements: [] }, actor, 3), /changed elsewhere/, "an expected revision for a record that does not exist is a conflict");
  assert.deepEqual((await base.listAssigneeBases(org)).map((row) => [row.assignee.type, row.assignee.id, row.type_ids, row.staffing_requirements.length, row.revision]), [["organization_connection", "summit", ["subcontractor", "labor-supplier"], 0, 2], ["resource_group", "crew_a", [], 1, 1]]);
  assert.deepEqual(await base.listAssigneeBases(other), [], "base records belong to their organization");
  assert.equal((await base.readAssigneeBase(org, crew)).staffing_requirements[0]!.where.rules.length, 1);
  await base.writeAssigneeBase(org, ana, { staffing_requirements: [] }, actor);

  // Time off: exact instants, normalized to UTC so ranges compare the same on both backends.
  const first = await off.storeTimeOff(org, { id: "t1", assignee: ana, from: "2026-10-13T08:00:00-05:00", until: "2026-10-13T12:00:00-05:00", reason: "Dentist" }, "owner");
  assert.deepEqual([first.from, first.until, first.assignee_id, first.revision], ["2026-10-13T13:00:00.000Z", "2026-10-13T17:00:00.000Z", "organization_user:ana", 1]);
  await off.storeTimeOff(org, { id: "t2", assignee: ana, from: "2026-10-20T00:00:00.000Z", until: "2026-10-27T00:00:00.000Z" }, "owner");
  await off.storeTimeOff(org, { id: "t3", assignee: { type: "organization_connection", id: "summit" }, from: "2026-10-13T00:00:00.000Z", until: "2026-10-14T00:00:00.000Z" }, "owner");
  await off.storeTimeOff(other, { id: "t1", assignee: ana, from: "2026-10-13T00:00:00.000Z", until: "2026-10-14T00:00:00.000Z" }, "owner");
  const during = async (from: string, until: string) => (await off.listTimeOff(org, { from, until })).map((row) => row.id);
  assert.deepEqual(await during("2026-10-13T16:59:00.000Z", "2026-10-13T18:00:00.000Z"), ["t3", "t1"]);
  assert.deepEqual(await during("2026-10-13T17:00:00.000Z", "2026-10-13T18:00:00.000Z"), ["t3"], "an interval does not include the instant it ends");
  assert.deepEqual(await during("2026-10-12T00:00:00.000Z", "2026-10-13T00:00:00.000Z"), [], "nor does a range reach one that starts when the range ends");
  assert.deepEqual((await off.listTimeOff(org, { assignee: ana })).map((row) => row.id), ["t1", "t2"]);
  const moved = await off.storeTimeOff(org, { id: "t1", assignee: ana, from: "2026-10-13T13:00:00.000Z", until: "2026-10-13T15:00:00.000Z", expected_revision: 1 }, "owner");
  assert.deepEqual([moved.until, moved.reason, moved.revision], ["2026-10-13T15:00:00.000Z", "", 2]);
  await assert.rejects(() => off.storeTimeOff(org, { id: "t1", assignee: ana, from: "2026-10-13T13:00:00.000Z", until: "2026-10-13T15:00:00.000Z", expected_revision: 1 }, "owner"), /changed elsewhere/);
  assert.equal((await off.listTimeOff(other)).length, 1, "the same id in another organization is another entry");

  // Cleaning up after an assignee that is in no store removes its base record and its time off, and nothing else.
  const cleaned = await base.cleanupAssignee(org, ana, actor);
  assert.deepEqual(cleaned.steps.slice(0, 2).map((step) => [step.name, step.removed, step.error]), [["assignee-base", 1, ""], ["assignee-time-off", 2, ""]]);
  assert.deepEqual([(await base.listAssigneeBases(org)).map((row) => row.assignee.id), (await off.listTimeOff(org)).map((row) => row.id), (await off.listTimeOff(other)).length], [["summit", "crew_a"], ["t3"], 1]);
});
