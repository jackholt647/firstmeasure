import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// Development tools for guided experiences (guided-experiences/dev.ts): who may use them, copy overrides applied for
// everyone, history and revert, the export to code, and reset.
const dir = await mkdtemp(path.join(os.tmpdir(), "guided-dev-"));
Object.assign(process.env, { NODE_ENV: "test", FIRSTMEASURE_DATA_ENVIRONMENT: "development", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), INTERNAL_STORAGE_ROOT: path.join(dir, "internal"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const SANDBOX = "org_gx_sandbox", PLAIN = "org_gx_plain";
const person = (orgId: string, userId: string, email: string, extra: Record<string, unknown> = {}) => ({ orgId, userId, role: "owner", permissions: { "*": true }, branchId: "default", identity: { email }, organization: { data: {} }, capabilities: { effectiveByKey: { "platform.materials": true } }, ...extra }) as any;

test("development tools: who may use them, copy for everyone, history, revert, export and reset", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: SANDBOX, name: "Sandbox", metadata: { sandbox_test_org: true, sandbox_instance_id: "sb_1" } });
  await s.createOrganization({ id: PLAIN, name: "Plain" });
  for (const org of [SANDBOX, PLAIN]) await enableExpandedPlatformFixture(org, { "platform.materials": true });
  const { saveInternalUser } = await import("../internal/storage.js");
  await saveInternalUser({ email: "admin@1m8.test", name: "Platform admin", role: "admin", status: "active" });
  const dev = await import("../guided-experiences/dev.js"), service = await import("../guided-experiences/service.js"), { env } = await import("../src/config/env.js");
  service.ensureGuidedDefinitions();

  const sandboxOwner = person(SANDBOX, "sb_owner", "owner@sandbox.test");
  const admin = person(PLAIN, "admin", "admin@1m8.test");
  const plainOwner = person(PLAIN, "plain_owner", "owner@plain.test");
  assert.deepEqual(await dev.guidedDevAccess(sandboxOwner), { editor: true, admin: false }, "the development tools audience");
  assert.deepEqual(await dev.guidedDevAccess(admin), { editor: true, admin: true }, "a platform administrator");
  assert.deepEqual(await dev.guidedDevAccess(plainOwner), { editor: false, admin: false }, "an ordinary organization owner is not");
  await assert.rejects(() => dev.saveCopy(plainOwner, { key: "gx_mps_makers_title", text: "Nope" }), /development/i);
  assert.equal((await service.availableExperiences(plainOwner, {})).dev, undefined);
  assert.ok((await service.availableExperiences(admin, {})).dev?.experiences.some((entry: any) => entry.id === "materials.tab_tutorial"));

  // An edit is plain text, saved with its place, and shown to everyone (another person, another organization).
  await assert.rejects(() => dev.saveCopy(admin, { key: "gx_mps_makers_title", text: "<b>Bold</b>" }), /plain text/);
  await dev.saveCopy(sandboxOwner, { key: "gx_mps_makers_title", text: "  Which   shingle brands do you install?  ", experience_id: "materials.pricebook_setup.roofing", step_id: "brands", field: "title" });
  await dev.saveCopy(admin, { key: "gx_mt_intro_body", text: "Your lists come from the roof report.", experience_id: "materials.tab_tutorial", step_id: "intro", field: "body" });
  const seen = await service.availableExperiences(plainOwner, { tab: "project.materials" });
  const setup = seen.experiences.find((entry) => entry.id === "materials.pricebook_setup.roofing")!;
  assert.equal((setup.steps.find((step) => step.id === "brands") as any).title.text, "Which shingle brands do you install?", "applied over the definition, whitespace tidied");
  assert.equal((setup.steps.find((step) => step.id === "brands") as any).title.key, "gx_mps_makers_title", "the language key stays");
  assert.equal((seen as any).copy_overrides.gx_mt_intro_body, "Your lists come from the roof report.");
  // History and revert.
  await dev.saveCopy(admin, { key: "gx_mps_makers_title", text: "Which brands?" });
  const history = await dev.copyFieldHistory(admin, "gx_mps_makers_title");
  assert.deepEqual(history.map((entry) => [entry.revision, entry.text, entry.author]), [[2, "Which brands?", "admin@1m8.test"], [1, "Which shingle brands do you install?", "owner@sandbox.test"]]);
  await dev.revertCopy(admin, { key: "gx_mps_makers_title", revision: 1 });
  assert.equal((await dev.copyOverrideMap()).gx_mps_makers_title, "Which shingle brands do you install?");
  await dev.revertCopy(admin, { key: "gx_mt_intro_body", revision: 0 });
  assert.equal((await dev.copyOverrideMap()).gx_mt_intro_body, undefined, "back to the code's own text");
  // The export finds the source line for each override.
  const exported = await dev.exportCopy(admin);
  const edit = exported.edits.find((entry) => entry.key === "gx_mps_makers_title")!;
  assert.equal(edit.file, "public/v1/guided-experiences/definitions/materials.ts");
  assert.match(edit.from, /What roofing manufacturers do you use\?/);
  assert.equal(edit.to, `"gx_mps_makers_title", "Which shingle brands do you install?"`);
  assert.equal(exported.catalog["guided-experiences"].gx_mps_makers_title, "Which shingle brands do you install?");

  // Reset: progress (and so reveal), exposures and the scripted lines, for me or for the organization.
  await service.recordGuidedEvent(admin, "materials.tab_tutorial", { type: "exposure" });
  await service.recordGuidedEvent(admin, "materials.tab_tutorial", { type: "dismiss", step_id: "intro" });
  await service.recordGuidedEvent(plainOwner, "materials.tab_tutorial", { type: "dismiss", step_id: "intro" });
  const store = await import("../guided-experiences/store.js");
  await store.writeProgress(PLAIN, "", "materials.pricebook_setup.roofing", { status: "completed", userId: "admin" });
  const agents = await import("../agents/storage.js");
  const thread = await agents.createAgentThread({ agent_id: "assistant", organization_id: PLAIN, branch_id: "default", subject_id: "project:p1", title: "p1", created_by_user_id: "admin" }) as any;
  await agents.appendAgentMessage("assistant", PLAIN, thread.id, { role: "assistant", content: "Which roofing manufacturers do you use?", data: { source: "guided_experience", line_key: "materials.pricebook_setup.roofing:brands:say:1" } });
  await agents.appendAgentMessage("assistant", PLAIN, thread.id, { role: "assistant", content: "An ordinary answer.", data: {} });
  assert.equal((await service.availableExperiences(admin, {})).reveals.length, 0, "the tour was finished, so Materials shows everywhere");
  await assert.rejects(() => dev.resetExperience(plainOwner, { experience_id: "materials.tab_tutorial" }), /development/i);
  const mine = await dev.resetExperience(admin, { experience_id: "materials.tab_tutorial", scope: "me" });
  assert.equal(mine.progress, 1);
  assert.equal((await service.availableExperiences(admin, {})).reveals.length, 1, "reset, so the reveal applies again");
  assert.equal((await service.availableExperiences(plainOwner, {})).reveals.length, 0, "only mine");
  assert.equal(await store.wasExposed(PLAIN, "materials.tab_tutorial", `person:${PLAIN}:admin`), false, "counted as new");
  assert.equal((await service.availableExperiences(admin, {})).experiences.some((entry) => entry.id === "materials.pricebook_setup.roofing"), false, "the setup is done");
  const org = await dev.resetExperience(admin, { experience_id: "materials.pricebook_setup.roofing", scope: "organization" });
  assert.equal(org.progress, 1); assert.equal(org.conversation_lines, 1);
  assert.equal((await service.availableExperiences(admin, {})).experiences.some((entry) => entry.id === "materials.pricebook_setup.roofing"), true, "the setup can run again");
  assert.deepEqual((await agents.listAgentMessages("assistant", PLAIN, thread.id)).map((message: any) => message.content), ["An ordinary answer."], "only its scripted lines go");

  // Production, or any environment other than development: refused for everyone, and no overrides are read.
  const was = env.dataEnvironment;
  (env as any).dataEnvironment = "production";
  try {
    assert.deepEqual(await dev.guidedDevAccess(admin), { editor: false, admin: false });
    await assert.rejects(() => dev.saveCopy(admin, { key: "gx_mps_makers_title", text: "Prod" }), /Not found/);
    await assert.rejects(() => dev.resetExperience(admin, { experience_id: "materials.tab_tutorial" }), /Not found/);
    await assert.rejects(() => dev.exportCopy(admin), /Not found/);
    assert.deepEqual(await dev.copyOverrideMap(), {});
    const prod = await service.availableExperiences(plainOwner, {});
    assert.equal((prod.experiences.find((entry) => entry.id === "materials.pricebook_setup.roofing")!.steps.find((step) => step.id === "brands") as any).title.text, "What roofing manufacturers do you use?", "production shows the code's copy");
  } finally { (env as any).dataEnvironment = was; }
});
