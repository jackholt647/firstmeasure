import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("full test org equipment samples are isolated, additive and safe to repeat concurrently", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-samples-"));
  const cwd = process.cwd();
  process.chdir(root);
  process.env.FIRSTMATE_ENV = "test";
  process.env.PLATFORM_SESSION_SECRET = "sample-data-isolated-test-secret";
  if (process.env.TEST_POSTGRES_URL) {
    process.env.FIRSTMEASURE_DATABASE_MODE = "postgres";
    process.env.DATABASE_URL = process.env.TEST_POSTGRES_URL;
    process.env.POSTGRES_AUTO_MIGRATE = "false";
  }
  const storage = await import("../platform/storage.js");
  const eq = await import("../equipment/storage.js");
  const { sandboxStore } = await import("../signup-sandbox/storage.js");
  await import("../platform/capability_defs.js");
  const { addTestOrgSampleData } = await import("../signup-sandbox/sample-data.js");
  try {
    const create = async (id: string, flags = true, full = true) => {
      const org = await storage.createOrganization({ name: "Samples test", metadata: { sandbox_test_org: true, sandbox_instance_id: id }, global: { app_flags: { platform: { expanded_access: true, contacts: true }, apps: { equipment: flags, projects: true, channels: true } } } });
      await sandboxStore.saveTestOrg({ id, org_id: org.id, workflow_id: full ? "swf_instant_full_org" : "other" });
      await storage.upsertDocument(String(org.id), "users", { id: "owner", data: { role: "owner", name: "Tester" } });
      return String(org.id);
    };
    const orgId = await create("sbi_samples");
    assert.deepEqual(await addTestOrgSampleData("sbi_samples", { equipment: false }), {});
    assert.equal((await eq.listUnits(orgId)).length, 0);
    await assert.rejects(addTestOrgSampleData("sbi_samples", { equipment: "true" }), /boolean/);
    await assert.rejects(addTestOrgSampleData("sbi_missing", { equipment: true }), /not found/);
    await create("sbi_disabled", false);
    await assert.rejects(addTestOrgSampleData("sbi_disabled", { equipment: true }), /Enable Equipment/);
    await create("sbi_other", true, false);
    await assert.rejects(addTestOrgSampleData("sbi_other", { equipment: true }), /full test/);
    await eq.saveUnit(orgId, { id: "existing_unit", name: "Keep me" });
    await Promise.all([addTestOrgSampleData("sbi_samples", { equipment: true }), addTestOrgSampleData("sbi_samples", { equipment: true })]);
    const units = await eq.listUnits(orgId);
    assert.equal(units.length, 11);
    assert.equal((await eq.listTypes(orgId)).length, 5);
    assert.equal((await eq.listWorkOrders(orgId)).length, 2);
    assert.equal((await storage.listDocuments(orgId, "calendar_events")).length, 3);
    const unit = units.find(row => row.id !== "existing_unit")!;
    await eq.saveUnit(orgId, { ...unit, name: "My edited sample" });
    await addTestOrgSampleData("sbi_samples", { equipment: true });
    assert.equal((await eq.readUnit(orgId, String(unit.id))).name, "My edited sample");
    assert.equal((await eq.readUnit(orgId, "existing_unit")).name, "Keep me");
    const secondOrg = await create("sbi_second");
    await addTestOrgSampleData("sbi_second", { equipment: true });
    assert.equal((await eq.listUnits(secondOrg)).length, 10);
    assert.ok((await eq.listUnits(secondOrg)).every(row => !units.some(first => first.id === row.id)));

    const independent = await create("sbi_independent");
    const chat = await import("../channels/storage.js");
    await addTestOrgSampleData("sbi_independent", { customers: true });
    assert.equal((await eq.listUnits(independent)).length, 0);
    assert.equal((await chat.listChannelRecords(independent)).length, 0);
    let docs = await storage.listDocuments(independent, "projects");
    assert.equal(docs.length, 5);
    assert.ok(docs.every(row => (row.data as any).workflow_state === "contact_only"));
    await addTestOrgSampleData("sbi_independent", { projects: true });
    docs = await storage.listDocuments(independent, "projects");
    assert.equal(docs.filter(row => (row.data as any).workflow_state !== "contact_only").length, 4);
    await Promise.all([addTestOrgSampleData("sbi_independent", { channels: true }), addTestOrgSampleData("sbi_independent", { channels: true })]);
    let channelRows = await chat.listChannelRecords(independent);
    assert.equal(channelRows.length, 4);
    assert.equal(channelRows.reduce((n, row) => n + row.message_seq, 0), 12);
    assert.equal((await chat.listChannelMembers(channelRows[0]!.id)).length, 3);
    await chat.updateChannelRecord(independent, channelRows[0]!.id, { name: "My renamed channel" });
    await storage.upsertDocument(independent, "projects", { id: docs[0]!.id, data: { title: "My edited record" } });
    await Promise.all([addTestOrgSampleData("sbi_independent", { customers: true, projects: true, channels: true }), addTestOrgSampleData("sbi_independent", { customers: true, projects: true, channels: true })]);
    channelRows = await chat.listChannelRecords(independent);
    assert.equal(channelRows.length, 4);
    assert.equal(channelRows.reduce((n, row) => n + row.message_seq, 0), 12);
    assert.ok(channelRows.some(row => row.name === "My renamed channel"));
    assert.equal((await storage.readDocument(independent, "projects", String(docs[0]!.id))).data?.title, "My edited record");
    assert.equal((await storage.listDocuments(independent, "projects")).length, 9);
    const projectsOnly = await create("sbi_projects_only");
    await addTestOrgSampleData("sbi_projects_only", { projects: true });
    assert.equal((await storage.listDocuments(projectsOnly, "projects")).length, 4);
    assert.ok((await storage.listDocuments(projectsOnly, "projects")).every(row => !(row.data as any).contacts.length));
  } finally {
    await eq.closeEquipmentDatabase();
    await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
    await (await import("../src/database/postgres.js")).closePostgresPools();
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});


