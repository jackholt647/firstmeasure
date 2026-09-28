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
  const storage = await import("../platform/storage.js");
  const eq = await import("../equipment/storage.js");
  const { sandboxStore } = await import("../signup-sandbox/storage.js");
  await import("../platform/capability_defs.js");
  const { addTestOrgSampleData } = await import("../signup-sandbox/sample-data.js");
  try {
    const create = async (id: string, flags = true, full = true) => {
      const org = await storage.createOrganization({ name: "Samples test", metadata: { sandbox_test_org: true, sandbox_instance_id: id }, global: { app_flags: { platform: { expanded_access: true }, apps: { equipment: flags } } } });
      await sandboxStore.saveTestOrg({ id, org_id: org.id, workflow_id: full ? "swf_instant_full_org" : "other" });
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
  } finally {
    await eq.closeEquipmentDatabase();
    await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});


