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
  } finally {
    await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
