import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// FM-515: the appointment setup. Who sells and who does the work are company-profile setup steps; the kinds of
// appointments are a setup step that makes each one an appointment type; the setup's finish writes each type's texts
// and who goes, and gives the organization the group and company types its answers name. The library entries are the
// ones put on dev (tests/fixtures/appointment-setup-library.json).
const dir = await mkdtemp(path.join(os.tmpdir(), "appointment-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_appointment_setup";
const flags = { "platform.scheduling": true, "platform.materials": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const owner = person("owner");
const library = JSON.parse(await readFile(new URL("./fixtures/appointment-setup-library.json", import.meta.url), "utf8"));

let ready: Promise<any> | null = null;
function setup() {
  return ready ||= (async () => {
    const storage = await import("../platform/storage.js");
    await storage.createOrganization({ id: ORG, name: "Appointment setup" }).catch(() => {});
    await enableExpandedPlatformFixture(ORG, flags);
    const { initializePublication } = await import("../platform/publication/bootstrap.js");
    initializePublication();
    const { registerSetupStepForTests } = await import("../guided-experiences/setup-steps.js");
    for (const step of library.setup_step) registerSetupStepForTests(step);
    const { registerExperienceForTests } = await import("../guided-experiences/registry.js");
    for (const experience of library.guided_experience) registerExperienceForTests(experience);
    const service = await import("../guided-experiences/service.js");
    service.ensureGuidedDefinitions();
    return service;
  })();
}
const invoke = async (auth: any, action: string, input: Record<string, unknown>, key: string) => {
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return ((await invokeAction(userPublicationContext(auth, { mode: "command" }), { action, target: { scope: "organization", organizationId: ORG } }, input, { idempotencyKey: key })) as any).value;
};
const read = async (auth: any, provider: string, exported: string) => {
  const { readPublishedData } = await import("../platform/publication/providers.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  return (readPublishedData(userPublicationContext(auth), { provider, export: exported, target: { scope: "organization", organizationId: ORG } }) as any);
};
const value = async (auth: any, provider: string, exported: string) => { const result = await read(auth, provider, exported); return result.value ?? result; };
const ids = (experience: any) => experience.steps.map((step: any) => step.id);

test("the library entries parse, and their checks pass against the running code", async () => {
  await setup();
  const { setupStepDefinitionSchema } = await import("../guided-experiences/setup-steps.js");
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  for (const step of library.setup_step) assert.equal(setupStepDefinitionSchema.safeParse(step).success, true, step.id);
  for (const experience of library.guided_experience) assert.equal(experienceSchema.safeParse(experience).success, true, experience.id);
  const { setupStepKind } = await import("../config-library/kinds/setup_step.js");
  const { guidedExperienceKind } = await import("../config-library/kinds/guided_experience.js");
  const { registryChecks } = await import("../config-library/registries.js");
  const registries = registryChecks();
  // Requirements are looked up in the library, which holds only the snapshot's steps here: those are checked on dev.
  const fixtureIds = new Set(library.guided_experience.map((entry: any) => entry.id));
  const notInSnapshot = (error: string) => !/which is not a setup step/.test(error) && ![...fixtureIds].some((id) => error.includes(`plays ${id}, which is not an experience`) || error.includes(`follows ${id}, which is not an experience`));
  for (const step of library.setup_step) assert.deepEqual(setupStepKind.validate!(setupStepDefinitionSchema.parse(step), { id: step.id, registries } as any).filter(notInSnapshot), [], step.id);
  for (const experience of library.guided_experience) assert.deepEqual(guidedExperienceKind.validate!(experienceSchema.parse(experience), { id: experience.id, registries } as any).filter(notInSnapshot), [], experience.id);
  const experience = library.guided_experience.find((entry: any) => entry.id === "appointments.setup");
  // FM-553: the first view of Scheduling plays it, and a skip there only puts it off until New Appointment.
  assert.deepEqual(experience.triggers.map((trigger: any) => [trigger.kind, trigger.tab || trigger.selector || "", trigger.skip || ""]), [["tab_opened", "portal.scheduling", "later"], ["before_action", "[data-new-appointment]", ""], ["manual", "", ""]]);
  assert.deepEqual(experience.completion.then, [{ resume: true }, { play: "scheduling.tab_tutorial", held: false }], "New Appointment's dialog opens after a held click; the Scheduling tour follows the tab's");
  const tour = library.guided_experience.find((entry: any) => entry.id === "scheduling.tab_tutorial");
  assert.ok(tour.steps.some((step: any) => step.targets.includes("[data-new-appointment]")), "the tour points at New Appointment");
});

test("New Appointment in a project's Schedule tab plays the setup too (FM-597)", async () => {
  const experience = library.guided_experience.find((entry: any) => entry.id === "appointments.setup");
  const selector = experience.triggers.find((trigger: any) => trigger.kind === "before_action").selector;
  assert.equal(selector, "[data-new-appointment]");
  // The project window's Appointment button carries the same marker as Scheduling's, so the held click is caught there.
  const source = await readFile(new URL("../../libraries/apps/project-schedule/panel.js", import.meta.url), "utf8");
  const button = source.match(/<button[^>]*data-project-new-appointment[^>]*>/)?.[0] || "";
  assert.ok(button, "the project Schedule panel has its Appointment button");
  assert.match(button, /\sdata-new-appointment[\s>]/, "the project Appointment button matches the setup's before_action");
});

test("the setup asks only what is unanswered: company type, work, who sells, who works, the kinds", async () => {
  const service = await setup();
  const setupOf = async () => (await service.availableExperiences(owner, { tab: "portal.scheduling" })).experiences.find((entry: any) => entry.id === "appointments.setup");
  assert.deepEqual(ids(await setupOf()), ["company.type", "company.services", "company.sales_team", "company.workforce", "appointments.kinds", "types"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement", "roof_repair"] }, "profile-1");
  assert.deepEqual(ids(await setupOf()), ["company.sales_team", "company.workforce", "appointments.kinds", "types"], "the company type and work, answered elsewhere, are not asked again");
  await assert.rejects(() => invoke(owner, "company-profile.save", { sales_team: "everyone" }, "profile-bad"), /from the list/);
  await invoke(owner, "company-profile.save", { sales_team: "small_team", workforce: "crews_and_subs" }, "profile-2");
  const profile = await value(owner, "company-profile", "profile");
  assert.deepEqual(profile.answered, { type: true, services: true, sales_team: true, workforce: true, locations: false });
  assert.equal(profile.sales_is_team, true);
  assert.equal(profile.workforce_label, "Crews and subcontractors");
  assert.deepEqual(ids(await setupOf()), ["appointments.kinds", "types"]);
  // Someone who may not change company settings is never offered it.
  const member = person("member", { role: "member", permissions: { view_projects: true } });
  assert.equal((await service.availableExperiences(member, { tab: "portal.scheduling" })).experiences.some((entry: any) => entry.id === "appointments.setup"), false);
});

test("the kinds become appointment types; the finish sets texts and who goes, and adds the team types", async () => {
  await setup();
  const catalog = await value(owner, "appointment-setup", "catalog");
  assert.deepEqual(catalog.suggested, ["sales", "installation", "repair", "delivery"], "a roofer with a sales team: sales, the work, repairs and deliveries; never an inspection as well as a sales appointment (GP-85)");
  assert.deepEqual(catalog.kinds.find((kind: any) => kind.id === "sales").offer, ["me", "sales_team"], "sales offers me or a salesperson first (GP-85)");
  assert.deepEqual(catalog.kinds.find((kind: any) => kind.id === "installation").offer, ["crews", "subcontractors", "me"]);
  assert.deepEqual(catalog.kinds.find((kind: any) => kind.id === "repair").offer, ["technician", "crews", "subcontractors", "me", "sales_team"]);
  assert.deepEqual(catalog.categories.map((entry: any) => entry.id), ["sales", "production", "other"]);
  assert.deepEqual(catalog.kinds.filter((kind: any) => kind.retired).map((kind: any) => kind.id), ["inspection", "service_call"], "inspections and service calls are kept for those who picked them, and not offered (GP-135)");
  const { readAppointmentCatalog } = await import("../appointments/planning.js");
  assert.deepEqual((await readAppointmentCatalog(owner)).catalog.presets.map((preset: any) => preset.id), ["sales", "production"], "before: the built-in types");

  await assert.rejects(() => invoke(owner, "appointments.setup.apply", {}, "apply-early"), /kinds of appointments/);
  const saved = await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "sales" }, { id: "repair", category: "production" }, { label: "Estimate <b>", category: "sales" }] }, "kinds-1");
  assert.equal(saved.answered.kinds, true);
  assert.deepEqual(saved.kinds.map((kind: any) => [kind.id, kind.category, kind.attendee]), [["sales", "sales", "sales_team"], ["repair", "production", "technician"], ["custom_estimate_b", "sales", "sales_team"]]);
  assert.deepEqual(saved.kinds[1].attendees, ["technician"], "a repair appointment goes to a repair technician, not the company's crews and subcontractors (GP-139)");
  assert.deepEqual(saved.kinds[2].offered, ["me", "sales_team"], "a kind of the person's own offers its category's answers");
  assert.equal(saved.no_sales, false);
  assert.equal(saved.kinds[2].label, "Estimate b", "the person's own words, as plain text");
  assert.deepEqual(saved.attendees, ["me", "sales_team", "crews", "subcontractors", "anyone"]);
  let presets = (await readAppointmentCatalog(owner)).catalog.presets;
  assert.deepEqual(presets.map((preset: any) => [preset.id, preset.label]), [["sales", "Sales appointment"], ["repair", "Repair appointment"], ["custom_estimate_b", "Estimate b"]], "exactly the kinds picked replace the built-in types");
  assert.equal(presets[1]!.configuration.window_minutes, 240);

  const applied = await invoke(owner, "appointments.setup.apply", { appointment_types: [
    { id: "sales", reminder: true, on_my_way: true, attendee: "me" },
    { id: "repair", reminder: false, on_my_way: true, attendee: "crews" },
    { id: "custom_estimate_b", reminder: false, on_my_way: false, attendee: "subcontractors" }
  ] }, "apply-1");
  assert.equal(applied.answered.types, true);
  assert.deepEqual(applied.types_added.sort(), ["sales_team", "subcontractor"], "crews already exist as a group type; a sales team and subcontractors are added");
  assert.equal(applied.crews, 0);
  presets = (await readAppointmentCatalog(owner)).catalog.presets;
  const byId = new Map(presets.map((preset: any) => [preset.id, preset.configuration]));
  assert.deepEqual(byId.get("sales")!.customer_texts, { reminder: true, on_my_way: true });
  assert.deepEqual(byId.get("sales")!.requirements.map((r: any) => [r.subject_type, r.mode, r.subject_keys]), [["organization_user", "specific", ["organization_user:owner"]]], "me: the person who set it up");
  assert.deepEqual(byId.get("repair")!.requirements.map((r: any) => [r.subject_type, r.mode, r.count, r.crew_member_percent]), [["resource_group", "count", 1, 100]]);
  assert.deepEqual(byId.get("repair")!.customer_texts, { reminder: false, on_my_way: true });
  assert.deepEqual(byId.get("custom_estimate_b")!.requirements, [], "an outside company is not booked by the planner");
  const { listAssigneeTypes } = await import("../assignees/base.js");
  const types = (await listAssigneeTypes(ORG)).types.map((type) => `${type.kind}:${type.id}`);
  for (const id of ["resource_group:sales_team", "resource_group:crew", "organization_connection:subcontractor"]) assert.ok(types.includes(id), id);

  // GP-122: sales and work appointments mean Sales and Production departments, shown in People › Departments, and the
  // types are narrowed to them. Crews are in Production and the sales team in Sales.
  assert.deepEqual(applied.departments, { sales: "sales", production: "production" });
  const { departmentSettings } = await import("../workforce/departments.js");
  const people = await departmentSettings(owner);
  const department = (id: string) => people.departments.find((entry: any) => entry.id === id)!;
  assert.deepEqual(people.departments.map((entry: any) => [entry.id, entry.label, entry.status, entry.branch_id]), [["sales", "Sales", "active", "default"], ["production", "Production", "active", "default"]]);
  assert.ok(department("production").group_kind_ids.includes("crew"), "crews are in Production");
  assert.ok(department("sales").group_kind_ids.includes("sales_team") === false, "nobody said a salesperson goes: sales is the person who set it up");
  assert.deepEqual(byId.get("repair")!.department_ids, ["production"], "a type saved before its department existed gains it");
  assert.deepEqual(byId.get("repair")!.requirements.map((r: any) => r.department_id), ["production"]);
  assert.deepEqual(byId.get("sales")!.department_ids, ["sales"]);
  const { resolveOrganizationStructure, departmentIdsForSubject } = await import("../workforce/organization-structure.js");
  const { createResourceGroup } = await import("../workforce/storage.js");
  const crew = await createResourceGroup(ORG, { name: "Crew A" });
  assert.deepEqual(departmentIdsForSubject(await resolveOrganizationStructure(ORG), "resource_group", String(crew.id)), ["production"], "a crew added later is in Production");

  // Asked again (a replay), it keeps what each kind was answered; the kinds picked then are the types (GP-140).
  const again = await value(owner, "appointment-setup", "status");
  assert.deepEqual(again.kinds.map((kind: any) => [kind.id, kind.attendee, kind.reminder]), [["sales", "me", true], ["repair", "crews", false], ["custom_estimate_b", "subcontractors", false]]);
  await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "installation" }] }, "kinds-2");
  assert.deepEqual((await readAppointmentCatalog(owner)).catalog.presets.map((preset: any) => preset.id), ["installation"]);
  await assert.rejects(() => invoke(owner, "appointments.kinds.save", { kinds: [{ id: "nonsense" }] }, "kinds-bad"), /not a kind of appointment/);
  const member = person("member", { role: "member", permissions: { view_projects: true } });
  await assert.rejects(() => invoke(member, "appointments.kinds.save", { kinds: [{ id: "sales" }] }, "kinds-member"));
});

test("the kinds picked are the organization's types: built-in and unpicked ones go, Settings' and a form's stay (GP-140)", async () => {
  await setup();
  const { readAppointmentCatalog, saveAppointmentCatalog } = await import("../appointments/planning.js");
  const { defaultAppointmentCatalog } = await import("../appointments/defaults.js");
  const { FORMS, saveRecord, removeRecord } = await import("../forms/storage.js");
  const type = (id: string, label: string) => ({ id, label, configuration: { title: label, duration_minutes: 60, window_minutes: 60 } });
  // A catalog saved in Settings: the built-in Production type is there (as in Jack's organization), beside a type the
  // person made, and two the instant organization starts with, one of them booked by a website form.
  const bundle = await readAppointmentCatalog(owner);
  await saveAppointmentCatalog(owner, { catalog: { ...bundle.catalog, presets: [...bundle.catalog.presets, defaultAppointmentCatalog().presets.find((preset) => preset.id === "production")!, type("0b5f3c2e-6f1a-4d6b-9f57-3f2a8f0f1c11", "Roof check"), type("maintenance", "Maintenance appointments"), type("company-meeting", "Company meeting")] }, revision: bundle.revision });
  await saveRecord(ORG, FORMS, "form_gp140", { name: "Book a meeting", branch_id: "default", definition: { steps: [{ id: "s1", items: [{ id: "i1", kind: "appointment", preset_id: "company-meeting" }] }] }, published: null });
  const presets = async () => (await readAppointmentCatalog(owner)).catalog.presets.map((preset: any) => preset.id);

  await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "sales" }, { id: "installation" }, { id: "repair" }, { id: "delivery" }] }, "kinds-gp140");
  assert.deepEqual(await presets(), ["installation", "0b5f3c2e-6f1a-4d6b-9f57-3f2a8f0f1c11", "company-meeting", "sales", "repair", "delivery"], "four kinds picked: no Production beside Installation, no unpicked maintenance; the person's own type and the form's stay");
  await invoke(owner, "appointments.setup.apply", {}, "apply-gp140");
  assert.deepEqual(await presets(), ["installation", "0b5f3c2e-6f1a-4d6b-9f57-3f2a8f0f1c11", "company-meeting", "sales", "repair", "delivery"], "the finish brings nothing back");
  await removeRecord(ORG, FORMS, "form_gp140");
  await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "sales" }, { id: "installation" }] }, "kinds-gp140-2");
  assert.deepEqual(await presets(), ["installation", "0b5f3c2e-6f1a-4d6b-9f57-3f2a8f0f1c11", "sales"], "a kind no longer picked goes, and so does a built-in type no form books");
});

test("defaults follow who sells and who works", async () => {
  const { defaultAttendee, offeredAttendees, suggestedKinds } = await import("../appointments/setup.js");
  assert.equal(defaultAttendee("sales", { sales_team: "just_me", workforce: null }), "sales_team", "a salesperson goes to sales appointments, never me by default (GP-136)");
  assert.equal(defaultAttendee("production", { sales_team: null, workforce: "subcontractors" }), "subcontractors");
  assert.equal(defaultAttendee("other", { sales_team: "small_team", workforce: "crews" }), "anyone");
  assert.deepEqual(offeredAttendees({ sales_team: "just_me", workforce: "just_me" }), ["me", "anyone"]);
  assert.deepEqual(suggestedKinds({ industry: "hvac", crm_pack: "home_services", sales_team: "no_sales" }), ["installation", "repair", "delivery", "maintenance"], "no sales appointments when there are none; never a service call, which is a repair appointment (GP-135)");
  assert.deepEqual(suggestedKinds({ industry: "roofing", crm_pack: null, sales_team: "small_team" } as any), ["sales", "installation", "repair", "delivery"], "an inspection is never picked to start with (GP-85)");
});

test("several people can go to a kind: any one of them meets its one requirement (GP-85)", async () => {
  const { requirementsFor, defaultAttendees } = await import("../appointments/setup.js");
  const shape = (rows: any[]) => rows.map((r) => [r.subject_type, r.department_id || "", r.crew_member_percent || 0]);
  assert.deepEqual(shape(requirementsFor(["crews"], "u1", "production")), [["resource_group", "production", 100]]);
  assert.deepEqual(requirementsFor(["crews", "subcontractors"], "u1", "production"), [], "a subcontractor is chosen when it is booked, so the planner requires nothing");
  assert.deepEqual(shape(requirementsFor(["technician", "crews"], "u1", "production")), [["any", "production", 0]], "a person or a group");
  assert.deepEqual(shape(requirementsFor(["me", "sales_team"], "u1", "sales")), [["organization_user", "", 0]], "me is not necessarily in the department");
  assert.deepEqual(shape(requirementsFor(["sales_team"], "u1", "sales")), [["organization_user", "sales", 0]]);
  assert.deepEqual(requirementsFor(["me"], "u1", "sales").map((r: any) => r.subject_keys), [["organization_user:u1"]]);
  assert.deepEqual(defaultAttendees("production", { sales_team: null, workforce: "crews_and_subs" }), ["crews", "subcontractors"]);
  assert.deepEqual(defaultAttendees("sales", { sales_team: "just_me", workforce: null }), ["sales_team"]);
  assert.deepEqual(defaultAttendees("production", { sales_team: null, workforce: "just_me" }, "delivery"), [], "nobody goes to a delivery, even in a company of one (GP-136)");
  assert.deepEqual(requirementsFor([], "u1", "production"), [], "nobody goes: nobody is required (GP-136)");
  for (const id of ["repair", "service_call", "maintenance"]) assert.deepEqual(defaultAttendees("production", { sales_team: null, workforce: "crews_and_subs" }, id), ["technician"], `${id} goes to a repair technician (GP-139)`);
  assert.deepEqual(defaultAttendees("production", { sales_team: null, workforce: "crews_and_subs" }, "installation"), ["crews", "subcontractors"], "the work goes to who does it");
  assert.deepEqual(defaultAttendees("production", { sales_team: null, workforce: "just_me" }, "repair"), ["me"], "a company of one does its own repairs");
});

test("a delivery starts with nobody going and no texts, and nobody going is an answer that is kept (GP-136)", async () => {
  await setup();
  const { readAppointmentCatalog } = await import("../appointments/planning.js");
  await invoke(owner, "company-profile.save", { sales_team: "just_me" }, "profile-gp136");
  const saved = await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "sales" }, { id: "delivery" }] }, "kinds-gp136");
  const kind = (status: any, id: string) => status.kinds.find((entry: any) => entry.id === id);
  assert.deepEqual([kind(saved, "delivery").attendees, kind(saved, "delivery").attendee, kind(saved, "delivery").reminder, kind(saved, "delivery").on_my_way], [[], null, false, false]);
  const delivery = async () => (await readAppointmentCatalog(owner)).catalog.presets.find((preset: any) => preset.id === "delivery")!.configuration;
  assert.deepEqual([(await delivery()).requirements, (await delivery()).customer_texts], [[], { reminder: false, on_my_way: false }], "its type, before the setup is finished, already texts nobody and needs nobody");
  await invoke(owner, "appointments.setup.apply", { appointment_types: [{ id: "sales", reminder: true, on_my_way: true, attendees: [] }] }, "apply-gp136");
  const status = await value(owner, "appointment-setup", "status");
  assert.deepEqual([kind(status, "sales").attendees, kind(status, "sales").attendee, kind(status, "sales").answered], [[], null, true], "nobody going is kept, not turned back into someone");
  assert.deepEqual(kind(status, "delivery").attendees, [], "a kind not given keeps its defaults");
  const sales = (await readAppointmentCatalog(owner)).catalog.presets.find((preset: any) => preset.id === "sales")!.configuration;
  assert.deepEqual([sales.requirements, sales.customer_texts], [[], { reminder: true, on_my_way: true }]);
  await invoke(owner, "company-profile.save", { sales_team: "small_team" }, "profile-gp136-back");
});

test("a company with no sales appointments gets no sales kinds and no departments on its types (GP-85)", async () => {
  await setup();
  const { readAppointmentCatalog } = await import("../appointments/planning.js");
  await invoke(owner, "company-profile.save", { sales_team: "no_sales" }, "profile-no-sales");
  const catalog = await value(owner, "appointment-setup", "catalog");
  assert.ok(!catalog.suggested.includes("sales") && !catalog.suggested.includes("inspection"), "no sales kinds are picked to start with");
  const saved = await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "repair" }, { label: "Consultation", category: "sales" }] }, "kinds-no-sales");
  assert.equal(saved.no_sales, true);
  assert.equal(saved.kinds.find((kind: any) => kind.id === "custom_consultation").category, "production", "there is no sales or production, only the work");
  await invoke(owner, "appointments.setup.apply", { appointment_types: [{ id: "repair", reminder: true, on_my_way: true, attendees: ["technician", "crews"] }] }, "apply-no-sales");
  const repair = (await readAppointmentCatalog(owner)).catalog.presets.find((preset: any) => preset.id === "repair")!.configuration;
  assert.deepEqual(repair.department_ids, [], "departmentless");
  assert.deepEqual(repair.requirements.map((r: any) => [r.subject_type, r.department_id]), [["any", undefined]]);
  const status = await value(owner, "appointment-setup", "status");
  assert.deepEqual(status.kinds.find((kind: any) => kind.id === "repair").attendees, ["technician", "crews"], "both answers are kept");
  await assert.rejects(() => invoke(owner, "appointments.setup.apply", { appointment_types: [{ id: "repair", reminder: true, on_my_way: true }] }, "apply-nobody"), /who goes/i);
  await invoke(owner, "company-profile.save", { sales_team: "small_team" }, "profile-sales-again");
});

test("an appointment type can turn the on-my-way text off", async () => {
  const { appointmentConfigurationSchema } = await import("../appointments/planning.js");
  assert.equal(appointmentConfigurationSchema.parse({}).customer_texts, undefined, "an older type keeps the old behaviour");
  assert.deepEqual(appointmentConfigurationSchema.parse({ customer_texts: {} }).customer_texts, { reminder: false, on_my_way: true });
});
