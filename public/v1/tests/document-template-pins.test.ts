import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("an organization's pinned templates are unset until chosen, then saved in order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "template-pins-"));
  Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: root, PLATFORM_HEARTBEAT_DISABLED: "1", SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "sandbox"), FIRSTMEASURE_DATA_ENVIRONMENT: "development" });
  try {
    const signup = await import("../signup-sandbox/service.js");
    await signup.ensureSeedData();
    const { authContext } = await signup.createTestInstance("swf_instant_full_org");
    const settings = await import("../documents/settings.js");
    assert.equal(await settings.readPinnedTemplateIds(authContext.orgId), null, "never chosen");
    assert.deepEqual(await settings.savePinnedTemplateIds(authContext.orgId, ["tpl_b", "tpl_a", "tpl_b", " "]), ["tpl_b", "tpl_a"]);
    assert.deepEqual(await settings.readPinnedTemplateIds(authContext.orgId), ["tpl_b", "tpl_a"]);
    await settings.savePinnedTemplateIds(authContext.orgId, []);
    assert.deepEqual(await settings.readPinnedTemplateIds(authContext.orgId), [], "pinning nothing is a choice too");
    assert.equal((await settings.savePinnedTemplateIds(authContext.orgId, Array.from({ length: 20 }, (_, i) => `tpl_${i}`))).length, 12);

    // Document types start as one per built-in kind and then belong to the organization.
    const seeded = await settings.readOrganizationDocumentTypes(authContext.orgId);
    assert.equal(seeded.customized, false);
    assert.ok(seeded.types.some(type => type.id === "proposal" && type.kind === "proposal"));
    assert.ok(!seeded.types.some(type => type.id === "payment_receipt"), "receipts are never started by hand");
    const saved = await settings.saveOrganizationDocumentTypes(authContext.orgId, {
      types: [{ id: "proposal", label: "Estimates", kind: "proposal", color: "#2563eb", department_ids: ["dep_a"] }, { label: "Warranties", kind: "not_a_kind" }, { label: "Warranties" }, { label: " " }],
      assignments: { tpl_cert: "warranties", tpl_gone: "no_such_type" }
    });
    assert.deepEqual(saved.types.map(type => [type.id, type.label, type.kind]), [["proposal", "Estimates", "proposal"], ["warranties", "Warranties", "generic"], ["warranties_2", "Warranties", "generic"]]);
    assert.deepEqual(saved.assignments, { tpl_cert: "warranties" }, "a template can only be filed under a type that exists");
    const read = await settings.readOrganizationDocumentTypes(authContext.orgId);
    assert.equal(read.customized, true);
    assert.deepEqual(read.types[0]?.department_ids, ["dep_a"]);
    await assert.rejects(settings.saveOrganizationDocumentTypes(authContext.orgId, { types: [] }), /document type/i);
    await assert.rejects(settings.saveOrganizationDocumentTypes(authContext.orgId, { types: [{ label: "Only", archived: true }] }), /in use/i);
  } finally {
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
