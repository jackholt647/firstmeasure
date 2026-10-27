import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// Setup steps (docs/architecture/setup-steps.md): declared once, required by setups, injected while unanswered,
// answered through a published action and read through the published data layer.
const dir = await mkdtemp(path.join(os.tmpdir(), "setup-steps-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_setup_steps";
const flags = { "platform.materials": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const t = (key: string, text: string) => ({ key, text });
const ids = (experience: any) => experience.steps.map((step: any) => step.id);

async function setup() {
  const storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: ORG, name: "Setup steps" }).catch(() => {});
  await enableExpandedPlatformFixture(ORG, flags);
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const service = await import("../guided-experiences/service.js");
  service.ensureGuidedDefinitions();
  return service;
}
const save = async (auth: any, input: Record<string, unknown>, key: string) => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return ((await invokeAction(userPublicationContext(auth, { mode: "command" }), { action: "company-profile.save", target: { scope: "organization", organizationId: ORG } }, input, { idempotencyKey: key })) as any).value;
};
const read = async (auth: any, provider: string, exported: string) => {
  const { readPublishedData } = await import("../platform/publication/providers.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return readPublishedData(userPublicationContext(auth), { provider, export: exported, target: { scope: "organization", organizationId: ORG } }) as any;
};

test("contracts: requires, module steps and require-only experiences are checked", async () => {
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const { setupStepDefinitionSchema } = await import("../guided-experiences/setup-steps.js");
  const base = { id: "test.require_only", version: 1, kind: "modal", scope: "organization", title: t("gx_test_r", "R"), variants: [{ id: "a", weight: 1 }] };
  assert.equal(experienceSchema.safeParse({ ...base, steps: [], requires: ["company.type"] }).success, true, "an experience may only require steps");
  assert.match(JSON.stringify(experienceSchema.safeParse({ ...base, steps: [] }).error!.issues), /needs a step/);
  assert.match(JSON.stringify(experienceSchema.safeParse({ ...base, steps: [{ id: "s", widget: "module", title: t("gx_test_s", "S") }] }).error!.issues), /without a module/);
  assert.equal(experienceSchema.safeParse({ ...base, steps: [{ id: "s", widget: "module", module: "/libraries/setup-steps/x.js", title: t("gx_test_s", "S"), requires: ["company.type"] }] }).success, true);
  assert.equal(experienceSchema.safeParse({ ...base, steps: [{ id: "s", widget: "module", module: "https://evil.example/x.js", title: t("gx_test_s", "S") }] }).success, false, "a module is served from /libraries/ only");
  const step = { id: "test.step", version: 1, title: t("gx_test_t", "T"), description: t("gx_test_d", "D"), ui: { module: "/libraries/setup-steps/x.js" }, satisfied: { provider: "p", export: "e" }, writes: { action: "a" } };
  assert.equal(setupStepDefinitionSchema.safeParse(step).success, true);
  assert.equal(setupStepDefinitionSchema.safeParse({ ...step, id: "nodot" }).success, false, "setup step ids are dotted");
  assert.equal(setupStepDefinitionSchema.safeParse({ ...step, ui: { widget: "module" } }).success, false);
});

test("the step graph refuses unknown and circular requirements", async () => {
  await setup();
  const { registerSetupStep, checkSetupStepGraph } = await import("../guided-experiences/setup-steps.js");
  const step = (id: string, requires: string[]) => ({ id, version: 1, title: t("gx_test_t", "T"), description: t("gx_test_d", "D"), ui: { widget: "brand-cards" }, requires, satisfied: { provider: "company-profile", export: "profile", path: "/answered/type" }, writes: { action: "company-profile.save" } });
  assert.throws(() => checkSetupStepGraph([{ from: "an.experience", requires: ["nobody.here"] }]), /not a registered setup step/);
  registerSetupStep(step("test.loop_a", ["test.loop_b"]));
  registerSetupStep(step("test.loop_b", ["test.loop_a"]));
  assert.throws(() => checkSetupStepGraph(), /circle/);
  assert.throws(() => registerSetupStep(step("test.loop_a", [])), /twice/);
});

test("Operations asks the company steps before the project, only while they are unanswered, and only of someone who may answer", async () => {
  const service = await setup();
  const owner = person("owner");
  const listed = async (auth = owner) => (await service.availableExperiences(auth, { tab: "project.materials" })).experiences;
  const operations = async (auth = owner) => (await listed(auth)).find((entry) => entry.id === "operations.setup")!;

  // Nothing answered: both company steps, type first (services requires it), between the path and the project.
  const first = await operations();
  assert.deepEqual(ids(first), ["path", "company.type", "company.services", "document", "ready"]);
  const typeStep = first.steps[1] as any;
  assert.equal(typeStep.widget, "module");
  assert.equal(typeStep.module, "/libraries/setup-steps/company-profile.js?v=20261027-1");
  assert.deepEqual(typeStep.setup_step, { id: "company.type", version: 1, writes: { action: "company-profile.save", target: "organization" }, injected_for: "document" });
  assert.equal(typeStep.title.key, "gx_step_company_type_title");
  // A require-only experience (what signup or the main setup plays) asks the same two.
  assert.deepEqual(ids((await listed()).find((entry) => entry.id === "setup_step.company.services")), ["company.type", "company.services"]);
  assert.equal((await listed()).find((entry) => entry.id === "setup_step.company.services")!.completion.screen, "none");

  // Its events are part of the experience; an unrelated step is not.
  assert.equal((await service.recordGuidedEvent(owner, "operations.setup", { type: "step_view", step_id: "company.type" })).recorded, true);
  const done = await service.recordGuidedEvent(owner, "operations.setup", { type: "step_done", step_id: "company.type" }) as any;
  assert.equal(done.next_step, undefined, "an injected step has no server branch");
  await assert.rejects(() => service.recordGuidedEvent(owner, "operations.photos", { type: "step_view", step_id: "company.type" }), /does not exist|not part/);

  // Someone who may build a scope but not change company settings is never asked: the setup plays without it.
  const editor = person("editor", { role: "member", permissions: { manage_projects: true, view_projects: true }, accessProfile: { roles: [], app_restrictions: [] } });
  assert.deepEqual(ids(await operations(editor)), ["path", "document", "ready"]);

  // Answering the type removes it; the services still wait.
  await assert.rejects(() => save(owner, { company_type: "space_station" }, "bad-type"), /Choose a kind of company/);
  await assert.rejects(() => save(owner, { company_type: "other" }, "bad-other"), /Say what kind/);
  await assert.rejects(() => save(editor, { company_type: "roofing_contractor" }, "editor-type"), /not permitted|permission|denied/i);
  const typed = await save(owner, { company_type: "roofing_contractor" }, "type-1");
  assert.equal(typed.company_type, "roofing_contractor");
  assert.equal(typed.industry, "roofing");
  assert.deepEqual(typed.answered, { type: true, services: false });
  assert.deepEqual(ids(await operations()), ["path", "company.services", "document", "ready"]);

  // Answering the services: the setup goes straight from the path to the project.
  await assert.rejects(() => save(owner, { services: ["teleportation"] }, "bad-service"), /not a kind of work/);
  const served = await save(owner, { services: ["roof_replacement", "gutters", "roof_repair"], services_other: ["Chimney caps"] }, "services-1");
  assert.deepEqual(served.services.map((entry: any) => entry.id), ["roof_replacement", "gutters", "roof_repair"]);
  assert.deepEqual(served.work_kinds, ["roofing", "gutters"], "services name their measurement schema");
  assert.equal(served.company_type, "roofing_contractor", "saving one part keeps the other");
  assert.deepEqual(ids(await operations()), ["path", "document", "ready"]);
  assert.deepEqual(ids((await listed()).find((entry) => entry.id === "setup_step.company.services")), [], "an answered requirement asks nothing");

  // The chooser reads what the company said.
  const chooser = await service.chooserContext(owner);
  assert.equal(chooser.organization.industry, "roofing");
  assert.equal(chooser.organization.company_type, "roofing_contractor");
});

test("the profile, the catalog and the step status are published data", async () => {
  await setup();
  const owner = person("owner");
  const profile = await read(owner, "company-profile", "profile");
  assert.equal(profile.status, "ready");
  assert.equal(profile.value.company_type_label, "Roofing contractor");
  assert.deepEqual(profile.value.services_other, ["Chimney caps"]);
  const catalog = await read(owner, "company-profile", "catalog");
  const roofing = catalog.value.company_types.find((entry: any) => entry.id === "roofing_contractor");
  assert.deepEqual(roofing.services.slice(0, 4), ["roof_replacement", "roof_repair", "roof_inspection", "storm_insurance"]);
  assert.ok(roofing.terms.includes("roofer"), "typing roofer finds a roofing contractor");
  for (const id of ["general_contractor", "exterior_remodeler", "siding_contractor", "gutter_contractor", "windows_doors", "solar_installer", "painting_contractor", "hvac_contractor", "plumbing_contractor", "electrical_contractor", "landscaping"]) assert.ok(catalog.value.company_types.some((entry: any) => entry.id === id), id);
  assert.ok(catalog.value.services.every((entry: any) => /^gx_service_[a-z0-9_]+$/.test(entry.label.key)), "every label is a language key");
  const steps = await read(owner, "setup-steps", "catalog");
  const services = steps.value.find((entry: any) => entry.id === "company.services");
  assert.deepEqual(services.requires, ["company.type"]);
  assert.equal(services.experience, "setup_step.company.services");
  assert.deepEqual(services.satisfied, { provider: "company-profile", export: "profile", path: "/answered/services" });
  const status = await read(owner, "setup-steps", "status");
  assert.deepEqual(status.value.filter((entry: any) => entry.id.startsWith("company.")), [{ id: "company.type", answered: true }, { id: "company.services", answered: true }]);
  const nobody = person("nobody", { role: "member", permissions: {}, accessProfile: { roles: [], app_restrictions: [] } });
  assert.notEqual((await read(nobody, "company-profile", "profile")).status, "ready", "reading needs view_projects");
});

test("Other: a company type in the person's own words", async () => {
  await setup();
  const value = await save(person("owner"), { company_type: "other", company_type_other: "Chimney sweep <b>" }, "other-1");
  assert.equal(value.company_type, "other");
  assert.equal(value.company_type_label, "Chimney sweep b");
  assert.equal(value.industry, null);
  assert.equal(value.answered.type, true);
});
