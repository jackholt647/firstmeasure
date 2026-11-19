import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// GP-15: the equipment setup. How many locations the company works out of is a company-profile setup step; the setup
// makes a facility for each, a type for each kind of equipment checked and the units each facility is short of, through
// the Equipment app's own writers, and only ever adds. The library entries are the ones put on dev
// (tests/fixtures/equipment-setup-library.json).
const dir = await mkdtemp(path.join(os.tmpdir(), "equipment-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_equipment_setup";
const flags = { "apps.equipment": true, "platform.materials": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const owner = person("owner");
const library = JSON.parse(await readFile(new URL("./fixtures/equipment-setup-library.json", import.meta.url), "utf8"));
const experience = library.guided_experience.find((entry: any) => entry.id === "equipment.setup");
const offered = experience.steps[0].options.equipment;

let ready: Promise<any> | null = null;
function setup() {
  return ready ||= (async () => {
    const storage = await import("../platform/storage.js");
    await storage.createOrganization({ id: ORG, name: "Equipment setup" }).catch(() => {});
    await enableExpandedPlatformFixture(ORG, flags);
    const { initializePublication } = await import("../platform/publication/bootstrap.js");
    initializePublication();
    const { registerSetupStepForTests } = await import("../guided-experiences/setup-steps.js");
    for (const step of library.setup_step) registerSetupStepForTests(step);
    const { registerExperienceForTests } = await import("../guided-experiences/registry.js");
    for (const entry of library.guided_experience) registerExperienceForTests(entry);
    const service = await import("../guided-experiences/service.js");
    service.ensureGuidedDefinitions();
    return service;
  })();
}
const invoke = async (auth: any, action: string, input: Record<string, unknown>, key: string) => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return ((await invokeAction(userPublicationContext(auth, { mode: "command" }), { action, target: { scope: "organization", organizationId: ORG } }, input, { idempotencyKey: key })) as any).value;
};
const value = async (auth: any, provider: string, exported: string) => {
  const { readPublishedData } = await import("../platform/publication/providers.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const result = await (readPublishedData(userPublicationContext(auth), { provider, export: exported, target: { scope: "organization", organizationId: ORG } }) as any);
  return result.value ?? result;
};
const ids = (entry: any) => entry.steps.map((step: any) => step.id);
const kind = (id: string, units: Record<string, number>) => {
  const entry = offered.find((row: any) => row.id === id);
  return { key: id, name: entry.label.text, kind: entry.kind, category: entry.category, icon: entry.icon, ...(entry.provides ? { provides: entry.provides } : {}), ownership: entry.ownership || "owned", units };
};

test("the library entries parse, and their checks pass against the running code", async () => {
  await setup();
  const { setupStepDefinitionSchema } = await import("../guided-experiences/setup-steps.js");
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const { setupStepKind } = await import("../config-library/kinds/setup_step.js");
  const { guidedExperienceKind } = await import("../config-library/kinds/guided_experience.js");
  const { registryChecks } = await import("../config-library/registries.js");
  const registries = registryChecks();
  // Requirements and follow-ups are looked up in the library, which here holds only the snapshot: checked on dev.
  const notInSnapshot = (error: string) => !/which is not a setup step/.test(error) && !/which is not an experience/.test(error);
  for (const step of library.setup_step) assert.deepEqual(setupStepKind.validate!(setupStepDefinitionSchema.parse(step), { id: step.id, registries } as any).filter(notInSnapshot), [], step.id);
  for (const entry of library.guided_experience) assert.deepEqual(guidedExperienceKind.validate!(experienceSchema.parse(entry), { id: entry.id, registries } as any).filter(notInSnapshot), [], entry.id);
  // The first view of the Equipment tab plays it (a skip only puts it off), and the tab's tour follows it there.
  assert.deepEqual(experience.triggers.map((trigger: any) => [trigger.kind, trigger.tab || "", trigger.skip || ""]), [["tab_opened", "portal.equipment", "later"], ["manual", "", ""]]);
  assert.deepEqual(experience.completion.then, [{ play: "equipment.tab_tutorial", held: false }]);
  // It is ordered before the tab's tour (entries are read by id), so a first visit arms the setup, not the tour.
  assert.ok("equipment.setup" < "equipment.tab_tutorial");
  for (const entry of offered) assert.equal(entry.label.key.startsWith("gx_eqs_kind_"), true, entry.id);
  // Font Awesome 6.0 (what the portal loads) has no fa-toilet-portable or fa-arrows-up-to-line: their tiles were blank.
  for (const entry of offered) assert.ok(!["fa-toilet-portable", "fa-arrows-up-to-line"].includes(entry.icon), `${entry.id} has an icon Font Awesome 6.0 draws`);
  // GP-57: the locations question is about the company's own places that keep equipment, not job sites ("work out of"
  // read as either), and its first page carries no intro line under the title that no other page has.
  const locations = library.setup_step.find((step: any) => step.id === "company.locations");
  assert.match(locations.title.text, /your own locations.*equipment/i);
  assert.doesNotMatch(`${locations.title.text} ${locations.subtitle.text}`, /work out of/i);
  assert.equal(experience.intro, undefined);
});

test("the setup asks the company type and how many locations only while unanswered", async () => {
  const service = await setup();
  const setupOf = async (auth = owner) => (await service.availableExperiences(auth, { tab: "portal.equipment" })).experiences.find((entry: any) => entry.id === "equipment.setup");
  assert.deepEqual(ids(await setupOf()), ["company.type", "company.locations", "equipment"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor" }, "profile-1");
  assert.deepEqual(ids(await setupOf()), ["company.locations", "equipment"]);
  await assert.rejects(() => invoke(owner, "company-profile.save", { locations: 0 }, "profile-bad"));
  await invoke(owner, "company-profile.save", { locations: 2 }, "profile-2");
  const profile = await value(owner, "company-profile", "profile");
  assert.equal(profile.locations, 2);
  assert.equal(profile.answered.locations, true);
  assert.equal(profile.company_type, "roofing_contractor", "a part not given is kept");
  assert.deepEqual(ids(await setupOf()), ["equipment"]);
  // Someone who may not manage equipment is never offered it.
  const member = person("member", { role: "member", permissions: { view_projects: true, "equipment.view": true } });
  assert.equal(await setupOf(member), undefined);
});

test("the finish makes a facility per location, a type per kind and the units each facility is short of", async () => {
  await setup();
  const before = await value(owner, "equipment-setup", "status");
  assert.deepEqual([before.answered.applied, before.facilities, before.equipment, before.units], [false, [], [], 0]);
  await assert.rejects(() => invoke(owner, "equipment.setup.apply", { facilities: [{ key: "a", name: "Main shop" }], equipment: [kind("dump_truck", { b: 1 })] }, "apply-bad"), /not one of the locations/);

  const applied = await invoke(owner, "equipment.setup.apply", { facilities: [{ key: "a", name: "Main shop" }, { key: "b", name: "North yard" }], equipment: [
    kind("dump_truck", { a: 2, b: 1 }), kind("dumpster_rented", {}), kind("portable_toilet", { a: 1, b: 0 })
  ] }, "apply-1");
  assert.equal(applied.answered.applied, true);
  assert.equal(applied.units_added, 4);
  assert.deepEqual(applied.facilities.map((row: any) => row.name).sort(), ["Main shop", "North yard"]);
  const yard = new Map(applied.facilities.map((row: any) => [row.name, row.id]));
  const byKey = new Map<string, any>(applied.equipment.map((row: any) => [row.key, row]));
  assert.deepEqual([...byKey.keys()].sort(), ["dump_truck", "dumpster_rented", "portable_toilet"]);
  assert.deepEqual(byKey.get("dump_truck")!.units, { [yard.get("Main shop") as string]: 2, [yard.get("North yard") as string]: 1 });
  assert.deepEqual(byKey.get("dumpster_rented")!.units, {}, "a rented kind has a type and no units");

  // Written with the Equipment app's own writers: types in its categories with their functions, units at home in a facility.
  const storage = await import("../equipment/storage.js");
  const types = await storage.listTypes(ORG);
  const truck = types.find((type) => type.seed_key === "setup.dump_truck")!;
  const categories = new Map((await storage.listCategories(ORG)).map((category) => [category.id, category.seed_key]));
  assert.equal(categories.get(String(truck.category_id)), "vehicles");
  assert.deepEqual(truck.provides, [{ item: "disposal.debris", capacity: 10, per_load: true }]);
  const units = (await storage.listUnits(ORG)).filter((unit) => unit.type_id === truck.id);
  assert.deepEqual(units.map((unit) => unit.name).sort(), ["Dump trucks 1", "Dump trucks 2", "Dump trucks 3"]);
  assert.ok(units.every((unit) => (unit.home_location as any).kind === "yard" && (unit.home_location as any).yard_id), "every unit has a home facility");

  // Again (a replay, or Back and Set up): facilities given back keep their id, nothing is duplicated, only the shortfall is added.
  const again = await invoke(owner, "equipment.setup.apply", { facilities: [{ key: "x", id: yard.get("Main shop"), name: "Main shop" }, { key: "y", id: yard.get("North yard"), name: "North lot" }], equipment: [
    kind("dump_truck", { x: 2, y: 2 }), kind("portable_toilet", { x: 0, y: 0 })
  ] }, "apply-2");
  assert.equal(again.units_added, 1, "one more truck at the north lot; the toilet is kept, never removed");
  assert.deepEqual(again.facilities.map((row: any) => row.name).sort(), ["Main shop", "North lot"], "renamed, not added");
  assert.equal((await storage.listTypes(ORG)).filter((type) => type.seed_key === "setup.dump_truck").length, 1);
  assert.deepEqual((await storage.listUnits(ORG)).filter((unit) => unit.type_id === truck.id).map((unit) => unit.name).sort(), ["Dump trucks 1", "Dump trucks 2", "Dump trucks 3", "Dump trucks 4"]);
  const status = await value(owner, "equipment-setup", "status");
  assert.equal(status.units, 5);

  const member = person("member", { role: "member", permissions: { view_projects: true, "equipment.view": true } });
  await assert.rejects(() => invoke(member, "equipment.setup.apply", { facilities: [{ key: "a", name: "Shop" }] }, "apply-member"));
});

test("the kinds offered follow the kind of company", async () => {
  // The browser module itself (plain JavaScript, no types), as the setup's widget runs it.
  const browserModule: string = "../../libraries/guided-experiences/equipment-setup.js";
  const { offeredKinds } = await import(browserModule);
  const options = experience.steps[0].options;
  const roofer = offeredKinds(options, { industry: "roofing", company_type: "roofing_contractor" }).map((entry: any) => entry.id);
  for (const id of ["dump_truck", "dump_trailer", "trailer", "dumpster_owned", "dumpster_rented", "portable_toilet", "pickup_truck"]) assert.ok(roofer.includes(id), id);
  const hvac = offeredKinds(options, { industry: "hvac", company_type: "hvac_contractor" }).map((entry: any) => entry.id);
  assert.ok(hvac.includes("work_van") && !hvac.includes("dump_truck"), "an HVAC company is not asked about dump trucks");
  assert.equal(offeredKinds(options, {}).length, offered.length, "a company that has not said what it is sees every kind");
  assert.ok(options.groups.every((group: any) => offered.some((entry: any) => entry.group === group.id)), "every group has kinds");
});
