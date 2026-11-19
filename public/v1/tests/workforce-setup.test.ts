import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// GP-28: the Operations workforce setup. It asks what kind of company this is and what work it does first (setup steps,
// only while unanswered), then who does the work (the company profile's answer), how many crews and subcontractors,
// what each does (company profile services, saved as its capabilities), who is on a crew and how each is paid. It ends
// in no price book. The library entry is the one put on dev (tests/fixtures/workforce-setup-library.json).
const dir = await mkdtemp(path.join(os.tmpdir(), "workforce-setup-"));
Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "development", FIRSTMEASURE_DATA_ENVIRONMENT: "development", FIRSTMEASURE_DATABASE_MODE: "sqlite", CONFIG_LIBRARY_SOURCE: "store", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { (await import("../config-library/library.js")).stopLibrarySync(); await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_workforce_setup";
const flags = { "platform.materials": true, "platform.pricebook": true, "apps.crew": true, "platform.people_access": true, "platform.expanded_access": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } }, ...extra }) as any;
const owner = person("owner");
const library = JSON.parse(await readFile(new URL("./fixtures/workforce-setup-library.json", import.meta.url), "utf8"));
const experience = library.guided_experience.find((entry: any) => entry.id === "operations.workforce.setup");

let ready: Promise<any> | null = null;
function setup() {
  return ready ||= (async () => {
    const storage = await import("../platform/storage.js");
    await storage.createOrganization({ id: ORG, name: "Workforce setup" }).catch(() => {});
    await enableExpandedPlatformFixture(ORG, flags);
    for (const [id, name] of [["owner", "Olivia Owner"], ["ana", "Ana Lopez"], ["ben", "Ben Hart"]]) await storage.upsertDocument(ORG, "users", { id, data: { name, email: `${id}@example.com`, status: "active" } }, { replace: false });
    const { initializePublication } = await import("../platform/publication/bootstrap.js");
    initializePublication();
    // company.type and company.services are setup steps in the library snapshot.
    // The entry put on dev replaces the snapshot's older one, as a library save does there.
    (await import("../config-library/kinds/index.js")).registerAllLibraryKinds();
    const { saveEntry } = await import("../config-library/writes.js");
    await saveEntry({ kind: "guided_experience", id: experience.id, data: experience }, { kind: "agent", id: "test" }, "update");
    const service = await import("../guided-experiences/service.js");
    service.ensureGuidedDefinitions();
    return service;
  })();
}
const invoke = async (auth: any, action: string, input: Record<string, unknown>, key: string) => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return ((await invokeAction(userPublicationContext(auth, { mode: "command" }), { action, target: { scope: "organization", organizationId: ORG } }, input, { idempotencyKey: key })) as any).value;
};
const status = async (auth: any = owner) => {
  const { readPublishedData } = await import("../platform/publication/providers.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const result = await (readPublishedData(userPublicationContext(auth), { provider: "workforce-setup", export: "status", target: { scope: "organization", organizationId: ORG } }) as any);
  return result.value ?? result;
};

test("the library entry parses and its checks pass; it ends in no price book", async () => {
  await setup();
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const { guidedExperienceKind } = await import("../config-library/kinds/guided_experience.js");
  const { registryChecks } = await import("../config-library/registries.js");
  const notInSnapshot = (error: string) => !/which is not a setup step/.test(error) && !/which is not an experience/.test(error);
  assert.deepEqual(guidedExperienceKind.validate!(experienceSchema.parse(experience), { id: experience.id, registries: registryChecks() } as any).filter(notInSnapshot), []);
  // "Build my price book" came from the price book finish screen; this setup finishes itself on its own last page.
  assert.equal(experience.completion.screen, "none");
  assert.equal(experience.completion.action, undefined);
  assert.deepEqual(experience.steps.map((step: any) => step.widget), ["workforce-setup"]);
  assert.deepEqual(experience.requires, ["company.type", "company.services"]);
  // Pay defaults are library data: roofing and exteriors are paid by the square, everyone else hourly.
  assert.deepEqual(experience.steps[0].options.pay_defaults[0], { industry_sets: ["roofing_exteriors"], method: "per_measurement", measurement: "roof.squares" });
});

test("what kind of company and what work it does are asked first, only while unanswered", async () => {
  const service = await setup();
  const ids = async () => (await service.availableExperiences(owner, { tab: "project.materials" })).experiences.find((entry: any) => entry.id === "operations.workforce.setup")?.steps.map((step: any) => step.id);
  assert.deepEqual(await ids(), ["company.type", "company.services", "workforce"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement", "roof_repair", "gutters"] }, "profile-1");
  assert.deepEqual(await ids(), ["workforce"]);
});

test("the status says the company's services, who does the work and the people a crew can have", async () => {
  await setup();
  await invoke(owner, "company-profile.save", { workforce: "crews_and_subs" }, "profile-2");
  const value = await status();
  assert.deepEqual(value.profile.services.map((entry: any) => entry.id), ["roof_replacement", "roof_repair", "gutters"]);
  assert.equal(value.profile.workforce, "crews_and_subs");
  assert.ok(value.profile.industry_sets.includes("roofing_exteriors"), "a roofing contractor is in the roofing and exteriors set");
  assert.deepEqual(value.workforces.map((entry: any) => entry.id), ["just_me", "crews", "subcontractors", "crews_and_subs"]);
  assert.deepEqual(value.people.map((entry: any) => entry.name), ["Ana Lopez", "Ben Hart", "Olivia Owner"]);
  // Pay rates are commercial: someone who only sees projects can't read them.
  const denied = await status(person("viewer", { role: "member", permissions: { view_projects: true }, applicationAccess: { management: { enabled: true, permissions: { view_projects: true } } } }));
  assert.notEqual(denied?.status, "ready");
  assert.equal(denied?.assignees, undefined);
});

test("the finish adds each crew and subcontractor with what it does, who is on it and its pay", async () => {
  await setup();
  const input = { include_labor: true, labor: { assignees: [
    { kind: "resource_group", name: "Crew A", service_ids: ["roof_replacement", "roof_repair"], member_user_ids: ["ana", "ben"], pay: { method: "per_measurement", rate: 70, measurement: "roof.squares" } },
    { kind: "resource_group", name: "Crew B", service_ids: ["roof_replacement"], pay: { method: "per_measurement", rate: 70, measurement: "roof.squares" } },
    { kind: "organization_connection", name: "Gutter Pros", service_ids: ["gutters"], pay: { method: "per_job", rate: 450 } }
  ] } };
  const done = await invoke(owner, "operations.workforce.setup.apply", input, "apply-1");
  assert.deepEqual(done.assignees.map((row: any) => [row.kind, row.name, row.created, row.pay]), [["resource_group", "Crew A", true, "saved"], ["resource_group", "Crew B", true, "saved"], ["organization_connection", "Gutter Pros", true, "saved"]]);
  const value = await status();
  const by = (name: string) => value.assignees.find((entry: any) => entry.name === name);
  assert.deepEqual(by("Crew A").member_user_ids.sort(), ["ana", "ben"]);
  assert.deepEqual(by("Crew A").service_ids, ["roof_replacement", "roof_repair"]);
  assert.deepEqual(by("Gutter Pros").service_ids, ["gutters"]);
  assert.deepEqual(by("Crew B").pay.simple, { method: "per_measurement", rate: 70, measurement: "roof.squares" });
  assert.deepEqual(by("Gutter Pros").pay.simple, { method: "per_job", rate: 450 });
  // What each does is its capabilities: a service measured as a kind of work grants that kind's items (roofing here;
  // the dictionary has no gutter items yet), and saying anything makes it known.
  const { capabilitiesFor } = await import("../labor/capabilities.js");
  const able = await capabilitiesFor(ORG, [by("Crew A").ref, by("Gutter Pros").ref]);
  const crewA = able.get(`resource_group:${by("Crew A").ref.id}`)!, gutters = able.get(`organization_connection:${by("Gutter Pros").ref.id}`)!;
  assert.deepEqual(crewA.service_ids, ["roof_replacement", "roof_repair"]);
  assert.ok(crewA.items.includes("roofing.install"));
  assert.equal(gutters.known, true);
  assert.ok(!gutters.items.includes("roofing.install"), "the gutter company was not given roofing");
  // The labor column shows now that someone does the work.
  const labor = (await (await import("../materials/resource-types.js")).listResourceTypes(ORG, { includeHidden: true })).find((row) => row.id === "labor");
  assert.equal(labor?.shown, "always");

  // Run again: the same ones by reference, a member added (none taken off) and what they do changed.
  await invoke(owner, "operations.workforce.setup.apply", { include_labor: true, labor: { assignees: [
    { ref: by("Crew A").ref, kind: "resource_group", name: "Crew A", service_ids: ["roof_replacement", "roof_repair", "gutters"], member_user_ids: ["owner"] }
  ] } }, "apply-2");
  const again = (await status()).assignees.find((entry: any) => entry.name === "Crew A");
  assert.deepEqual(again.member_user_ids.sort(), ["ana", "ben", "owner"]);
  assert.deepEqual(again.service_ids, ["roof_replacement", "roof_repair", "gutters"]);
  assert.equal((await status()).assignees.filter((entry: any) => entry.name === "Crew A").length, 1, "never added twice");
  // A service not in the catalog is refused.
  await assert.rejects(() => invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: by("Crew B").ref, kind: "resource_group", name: "Crew B", service_ids: ["moon_landings"] }] } }, "apply-bad"));
});

test("the setup's browser module defaults pay by industry, copies pay and sends only what it shows", async () => {
  const browserModule: string = "../../libraries/guided-experiences/workforce-setup.js";
  const module = await import(browserModule);
  const options = experience.steps[0].options;
  assert.deepEqual(module.defaultPay(options, { industry_sets: ["roofing_exteriors"], work_kinds: ["roofing"] }, "resource_group"), { method: "per_measurement", rate: 0, measurement: "roof.squares" });
  assert.deepEqual(module.defaultPay(options, { industry_sets: [], work_kinds: [] }, "resource_group"), { method: "hourly", rate: 0 });
  // A piece rate is on a roofing measurement: a company with no roofing work is paid hourly by default.
  assert.deepEqual(module.defaultPay(options, { industry_sets: ["roofing_exteriors"], work_kinds: ["siding"] }, "resource_group"), { method: "hourly", rate: 0 });
  assert.deepEqual(module.kindsFor("crews_and_subs"), { groups: true, companies: true });
  assert.deepEqual(module.kindsFor("just_me"), { groups: true, companies: false });
  const rows = [
    { key: "a", kind: "resource_group", name: "Crew A", service_ids: ["roof_replacement"], member_user_ids: ["ana"], saved_members: [], pay: { method: "per_measurement", rate: 70, measurement: "roof.squares" }, same: "" },
    { key: "b", kind: "resource_group", name: "Crew B", service_ids: ["roof_replacement"], member_user_ids: [], saved_members: [], pay: { method: "hourly", rate: 0 }, same: "a" },
    { key: "c", kind: "organization_connection", ref: { type: "organization_connection", id: "c1" }, existing: true, name: "Subs", service_ids: ["gutters"], member_user_ids: [], saved_members: [], pay: { method: "hourly", rate: 0 }, same: "" }
  ];
  const sent = module.applyInput(rows).labor.assignees;
  assert.deepEqual(sent[1].pay, { method: "per_measurement", rate: 70, measurement: "roof.squares" }, "Crew B is paid the same as Crew A");
  assert.deepEqual(sent[0].member_user_ids, ["ana"]);
  assert.equal(sent[2].pay, undefined, "no rate, no pay sheet");
  assert.deepEqual(sent[2].ref, { type: "organization_connection", id: "c1" });
  // "Same as" never goes round in a circle.
  assert.equal(module.payOf([{ key: "x", same: "y" }, { key: "y", same: "x" }], { key: "x", same: "y" }), null);
});
