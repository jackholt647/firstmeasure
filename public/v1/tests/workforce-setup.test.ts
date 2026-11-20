import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// GP-28: the Operations workforce setup. It asks what kind of company this is, what work it does and who does most of
// it first (setup steps, only while unanswered; GP-65: who does the work is the shared company.workforce step the
// appointment setup asks too, not a question of its own), then how many crews and subcontractors,
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
    // The entry put on dev replaces the snapshot's older one, as a library save does there. company.workforce is on dev,
    // not yet in the snapshot: saved first, as on dev.
    (await import("../config-library/kinds/index.js")).registerAllLibraryKinds();
    const { saveEntry } = await import("../config-library/writes.js");
    for (const step of library.setup_step) await saveEntry({ kind: "setup_step", id: step.id, data: step }, { kind: "agent", id: "test" }, "create");
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
  assert.deepEqual(experience.requires, ["company.type", "company.services", "company.workforce"]);
  // The one "Who does the work" (GP-65): the shared step, drawn by the company profile module like the appointment setup's.
  const step = library.setup_step.find((entry: any) => entry.id === "company.workforce");
  assert.equal(step.options.part, "workforce");
  assert.match(step.ui.module, /^\/libraries\/setup-steps\/company-profile\.js/);
  // Pay defaults are library data: roofing and exteriors are paid by the square, everyone else hourly.
  assert.deepEqual(experience.steps[0].options.pay_defaults[0], { industry_sets: ["roofing_exteriors"], method: "per_measurement", measurement: "roof.squares" });
});

test("what kind of company, what work it does and who does it are asked first, only while unanswered", async () => {
  const service = await setup();
  const ids = async () => (await service.availableExperiences(owner, { tab: "project.materials" })).experiences.find((entry: any) => entry.id === "operations.workforce.setup")?.steps.map((step: any) => step.id);
  assert.deepEqual(await ids(), ["company.type", "company.services", "company.workforce", "workforce"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement", "roof_repair", "gutters"] }, "profile-1");
  assert.deepEqual(await ids(), ["company.workforce", "workforce"]);
  // Answered once (here, or by the appointment setup), it is never asked again.
  await invoke(owner, "company-profile.save", { workforce: "crews" }, "profile-who");
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
  assert.deepEqual(by("Crew A").type_ids, ["crew"]);
  assert.deepEqual(by("Crew A").service_ids, ["roof_replacement", "roof_repair"]);
  assert.deepEqual(by("Gutter Pros").service_ids, ["gutters"]);
  assert.deepEqual(by("Crew B").pay.simple, { method: "per_measurement", rate: 70, measurement: "roof.squares" });
  assert.deepEqual(by("Gutter Pros").pay.simple, { method: "per_job", rate: 450 });
  // The measurements a piece rate is paid on are named, not shown by id.
  assert.equal(value.measurements.find((entry: any) => entry.id === "roof.squares")?.label, "Roof squares");
  // What each does is its capabilities: a service measured as a kind of work grants that kind's items (roofing here;
  // the dictionary has no gutter items yet), and saying anything makes it known.
  const { capabilitiesFor } = await import("../labor/capabilities.js");
  const able = await capabilitiesFor(ORG, [by("Crew A").ref, by("Gutter Pros").ref]);
  const crewA = able.get(`resource_group:${by("Crew A").ref.id}`)!, gutters = able.get(`organization_connection:${by("Gutter Pros").ref.id}`)!;
  assert.deepEqual(crewA.service_ids, ["roof_replacement", "roof_repair"]);
  assert.ok(crewA.items.includes("roofing.install"));
  assert.equal(gutters.known, true);
  assert.ok(!gutters.items.includes("roofing.install"), "the gutter company was not given roofing");
  // GP-122: they are People's own records: the crews in People › Groups (a crew), the subcontractor in People ›
  // Subcontractors, each in the person's branch.
  const { listResourceGroups } = await import("../workforce/storage.js");
  const { listOrganizationConnections } = await import("../connections/storage.js");
  const groups = await listResourceGroups(ORG, {});
  assert.deepEqual(["Crew A", "Crew B"].map((name) => { const group = groups.find((row: any) => row.name === name)!; return [group.kind_id, group.branch_id, group.status]; }), [["crew", "default", "active"], ["crew", "default", "active"]]);
  const company = (await listOrganizationConnections(ORG, {})).find((row: any) => row.name === "Gutter Pros")!;
  assert.deepEqual([company.id, company.branch_ids], [by("Gutter Pros").ref.id, ["default"]]);
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
  // A sales team or a dumpster company the organization has is not part of who does the work.
  assert.equal(module.inWorkforce(options, { kind: "resource_group", type_ids: ["crew"] }), true);
  assert.equal(module.inWorkforce(options, { kind: "resource_group", type_ids: ["sales_team"] }), false);
  assert.equal(module.inWorkforce(options, { kind: "organization_connection", type_ids: ["work_provider", "haul_off"] }), false);
  assert.equal(module.inWorkforce(options, { kind: "organization_connection", type_ids: ["work_provider"] }), true);
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

// GP-66: the kinds of each service in the company's words, who is in charge of a crew, what its members see in the
// app, a service the profile left out (Other), and someone new added and invited from the setup.
test("specialties, the lead, the crew's apps and a service found under Other are saved through the setup", async () => {
  await setup();
  const before = await status();
  const crewA = before.assignees.find((entry: any) => entry.name === "Crew A");
  assert.ok(!before.profile.services.some((entry: any) => entry.id === "siding"));
  await invoke(owner, "operations.workforce.setup.apply", { include_labor: true, labor: { assignees: [
    { ref: crewA.ref, kind: "resource_group", name: "Crew A", service_ids: ["roof_replacement", "siding"], lead_user_id: "ana",
      service_tags: { roof_replacement: ["Metal roofs", " metal  roofs", "Flat roofs"], siding: ["Vinyl"], gutters: ["Ignored: not a service it does"] },
      apps: { "portal.crew_payouts": { visible: false }, "portal.crew_overview": { options: { time_clock: false } } } }
  ] } }, "apply-gp66");
  const value = await status();
  const again = value.assignees.find((entry: any) => entry.name === "Crew A");
  assert.equal(again.lead_user_id, "ana");
  assert.deepEqual(again.service_tags, { roof_replacement: ["Metal roofs", "Flat roofs"], siding: ["Vinyl"] });
  assert.deepEqual(again.apps["portal.crew_payouts"], { visible: false });
  assert.deepEqual(again.apps["portal.crew_overview"], { options: { time_clock: false } });
  assert.deepEqual(value.service_tags_used.roof_replacement, ["Metal roofs", "Flat roofs"]);
  // Siding was found under Other: the company does it too now.
  assert.ok(value.profile.services.some((entry: any) => entry.id === "siding"), "the company profile gained the service");
  assert.deepEqual(value.can, { add_people: true, invite: true, pay: true });
  // The group's App experience settings, on every device each app exists on.
  const group = await (await import("../workforce/storage.js")).readResourceGroup(ORG, crewA.ref.id);
  assert.ok(Object.values((group.attributes as any).app_defaults["portal.crew_payouts"].visible).every((shown) => shown === false));
  // Moving the lead keeps one lead.
  await invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: crewA.ref, kind: "resource_group", name: "Crew A", lead_user_id: "ben" }] } }, "apply-gp66-lead");
  const led = await (await import("../workforce/storage.js")).readResourceGroup(ORG, crewA.ref.id);
  assert.deepEqual((led.members as any[]).filter((row) => row.is_lead).map((row) => row.user_id), ["ben"]);
  assert.deepEqual((await status()).assignees.find((entry: any) => entry.name === "Crew A").service_tags.siding, ["Vinyl"], "kinds left out of a change are kept");
  // Refused: a lead who is not on it, apps for a subcontractor, an app that does not exist.
  await assert.rejects(() => invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: crewA.ref, kind: "resource_group", name: "Crew A", lead_user_id: "nobody" }] } }, "apply-gp66-bad-lead"));
  const gutters = value.assignees.find((entry: any) => entry.name === "Gutter Pros");
  await assert.rejects(() => invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: gutters.ref, kind: "organization_connection", name: "Gutter Pros", apps: { "portal.crew_payouts": { visible: true } } }] } }, "apply-gp66-bad-apps"));
  await assert.rejects(() => invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: crewA.ref, kind: "resource_group", name: "Crew A", apps: { "portal.moon": { visible: true } } }] } }, "apply-gp66-bad-app"));
});

test("someone new is added to the organization from the setup, joins a crew and is invited", async () => {
  await setup();
  const added = await invoke(owner, "workforce.users.add", { name: "Cara New", email: "Cara@Example.com" }, "add-cara");
  assert.equal(added.user.email, "cara@example.com");
  assert.equal(added.user.status, "invited");
  const listed = (await status()).people.find((entry: any) => entry.id === added.user.id);
  assert.deepEqual(listed, { id: added.user.id, name: "Cara New", email: "cara@example.com", status: "invited" });
  // Added once: the same email again is refused.
  await assert.rejects(() => invoke(owner, "workforce.users.add", { name: "Cara Again", email: "cara@example.com" }, "add-cara-2"));
  const crewB = (await status()).assignees.find((entry: any) => entry.name === "Crew B");
  await invoke(owner, "operations.workforce.setup.apply", { labor: { assignees: [{ ref: crewB.ref, kind: "resource_group", name: "Crew B", member_user_ids: [added.user.id], lead_user_id: added.user.id }] } }, "apply-cara");
  assert.equal((await status()).assignees.find((entry: any) => entry.name === "Crew B").lead_user_id, added.user.id);
  // Invited with People's invite (no mail server in tests, so it is reported, not thrown); nobody else is touched.
  const invited = await invoke(owner, "workforce.users.invite", { user_ids: [added.user.id] }, "invite-cara");
  assert.deepEqual(invited.invites.map((row: any) => row.user_id), [added.user.id]);
  await assert.rejects(() => invoke(owner, "workforce.users.invite", { user_ids: ["nobody"] }, "invite-nobody"));
  // People's permission: someone who only sets up the company can't add or invite people.
  const settingsOnly = person("settings", { role: "member", permissions: { manage_company_settings: true, manage_projects: true }, applicationAccess: { management: { enabled: true, permissions: { manage_company_settings: true, manage_projects: true } } } });
  await assert.rejects(() => invoke(settingsOnly, "workforce.users.add", { name: "Dan", email: "dan@example.com" }, "add-dan"));
  assert.deepEqual((await status(settingsOnly)).can, { add_people: false, invite: false, pay: true });
});

test("the browser module sends the kinds, the lead and the apps, and leaves out someone not added yet", async () => {
  const browserModule: string = "../../libraries/guided-experiences/workforce-setup.js";
  const module = await import(browserModule);
  const options = experience.steps[0].options;
  const row = { key: "a", kind: "resource_group", name: "Crew A", service_ids: ["roof_replacement"], service_tags: { roof_replacement: ["Metal roofs", "metal roofs"], gutters: ["Seamless"] }, member_user_ids: ["ana", "new-person:x"], saved_members: [], lead_user_id: "new-person:x", saved_lead: "", pay: { method: "hourly", rate: 0 }, same: "" };
  const apps = module.appsFor(options.crew_apps, { earnings: false, time_clock: true, schedule: true });
  assert.deepEqual(apps["portal.crew_payouts"], { visible: false });
  assert.deepEqual(apps["project.crew_payouts"], { visible: false });
  assert.deepEqual(apps["portal.crew_overview"], { options: { time_clock: true } });
  assert.deepEqual(apps["project.crew_payments"], { visible: false }, "a choice not made is the library's off");
  const sent = module.applyInput([row], { apps }).labor.assignees[0];
  assert.deepEqual(sent.member_user_ids, ["ana"], "someone new is added before they are put on it");
  assert.equal(sent.lead_user_id, undefined);
  assert.deepEqual(sent.service_tags, { roof_replacement: ["Metal roofs"] });
  assert.deepEqual(sent.apps, apps);
  assert.equal(module.applyInput([{ ...row, lead_user_id: "ana" }]).labor.assignees[0].lead_user_id, "ana");
  assert.equal(module.applyInput([{ ...row, kind: "organization_connection" }], { apps }).labor.assignees[0].apps, undefined, "apps are a crew's");
  // Every choice of what a crew sees names apps the registry has; the library's kinds are for services the catalog has.
  const { appDefinition } = await import("../platform/app-experience/registry.js");
  for (const choice of options.crew_apps) for (const id of [...(choice.apps || []), choice.option?.app].filter(Boolean)) assert.ok(appDefinition(id), `${choice.id}: ${id}`);
  const { serviceOf } = await import("../company-profile/catalog.js");
  for (const service of Object.keys(options.service_tags)) assert.ok(serviceOf(service), service);
  assert.ok(module.matchService({ terms: ["gutter", "downspouts"] }, "Gutters", "downsp") > 0);
  assert.equal(module.matchService({ terms: [] }, "Gutters", "solar"), 0);
});

// GP-143: Scheduling's New appointment sets up crews before Operations is on. The setup plays with the crew app alone;
// pay sheets are Operations', so it has no pay page there and the save leaves pay (and the work-order column) for then.
test("crews and subcontractors are set up with the crew app alone; pay waits for Operations", async () => {
  const service = await setup();
  const ORG2 = "org_workforce_no_ops";
  const off = { ...flags, "platform.materials": false };
  const storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: ORG2, name: "No Operations yet" }).catch(() => {});
  await enableExpandedPlatformFixture(ORG2, off);
  const scheduler = person("owner", { orgId: ORG2, capabilities: { effectiveByKey: off } });
  const target = { scope: "organization", organizationId: ORG2 } as const;
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  const run = async (action: string, input: Record<string, unknown>, key: string) => ((await invokeAction(userPublicationContext(scheduler, { mode: "command" }), { action, target }, input, { idempotencyKey: key })) as any).value;
  await run("company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement", "gutters"], workforce: "crews_and_subs" }, "no-ops-profile");
  const offered = (await service.availableExperiences(scheduler, {})).experiences.find((entry: any) => entry.id === "operations.workforce.setup");
  assert.deepEqual(offered?.steps.map((step: any) => step.id), ["workforce"], "it plays, starting past who does the work");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const read = await (readPublishedData(userPublicationContext(scheduler), { provider: "workforce-setup", export: "status", target }) as any);
  const value = read.value ?? read;
  assert.equal(value.profile.workforce, "crews_and_subs");
  assert.equal(value.can.pay, false, "no pay page without Operations");
  assert.equal((await status()).can.pay, true, "with Operations, pay is asked");
  const done = await run("operations.workforce.setup.apply", { include_labor: true, labor: { assignees: [
    { kind: "resource_group", name: "North Crew", service_ids: ["roof_replacement"], pay: { method: "hourly", rate: 30 } },
    { kind: "organization_connection", name: "Rain Gutters Co", service_ids: ["gutters"] }
  ] } }, "no-ops-apply");
  assert.deepEqual(done.assignees.map((row: any) => [row.name, row.created, row.pay]), [["North Crew", true, "none"], ["Rain Gutters Co", true, "none"]]);
  const { capabilitiesFor } = await import("../labor/capabilities.js");
  const crew = done.assignees[0].ref;
  assert.deepEqual((await capabilitiesFor(ORG2, [crew])).get(`resource_group:${crew.id}`)?.service_ids, ["roof_replacement"], "what each does is saved");
  const { listPaySheets } = await import("../labor/pay-sheets.js");
  assert.equal((await listPaySheets(ORG2)).length, 0);
  // The browser module sends no pay when the setup has no pay page.
  const browserModule: string = "../../libraries/guided-experiences/workforce-setup.js";
  const module = await import(browserModule);
  const rows = [{ key: "a", kind: "resource_group", name: "Crew A", service_ids: [], member_user_ids: [], saved_members: [], pay: { method: "hourly", rate: 30 }, same: "" }];
  assert.deepEqual(module.applyInput(rows).labor.assignees[0].pay, { method: "hourly", rate: 30 });
  assert.equal(module.applyInput(rows, { pay: false }).labor.assignees[0].pay, undefined);
});
