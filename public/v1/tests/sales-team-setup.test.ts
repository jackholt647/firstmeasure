import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import vm from "node:vm";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// GP-144: the salesperson setup. A sales appointment with nobody to go is offered the setup; the setup asks what work
// the company does first (only while unanswered), then saves the salespeople as the Sales department's members and
// what each sells as their capabilities. The library entry is the one put on dev (tests/fixtures/sales-team-setup-library.json).
const dir = await mkdtemp(path.join(os.tmpdir(), "sales-team-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), WORKFORCE_STORAGE_ROOT: path.join(dir, "workforce"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_sales_team_setup";
const flags = { "platform.scheduling": true, "platform.materials": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const owner = person("owner");
const appointments = JSON.parse(await readFile(new URL("./fixtures/appointment-setup-library.json", import.meta.url), "utf8"));
const library = JSON.parse(await readFile(new URL("./fixtures/sales-team-setup-library.json", import.meta.url), "utf8"));

let ready: Promise<any> | null = null;
function setup() {
  return ready ||= (async () => {
    const storage = await import("../platform/storage.js");
    await storage.createOrganization({ id: ORG, name: "Sales team setup" }).catch(() => {});
    await enableExpandedPlatformFixture(ORG, flags);
    const { initializePublication } = await import("../platform/publication/bootstrap.js");
    initializePublication();
    const { registerSetupStepForTests } = await import("../guided-experiences/setup-steps.js");
    for (const step of appointments.setup_step) registerSetupStepForTests(step);
    const { registerExperienceForTests } = await import("../guided-experiences/registry.js");
    for (const experience of [...appointments.guided_experience, ...library.guided_experience]) registerExperienceForTests(experience);
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
const ids = (experience: any) => experience.steps.map((step: any) => step.id);

test("the library entry parses and its checks pass against the running code", async () => {
  await setup();
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  const { guidedExperienceKind } = await import("../config-library/kinds/guided_experience.js");
  const { registryChecks } = await import("../config-library/registries.js");
  for (const experience of library.guided_experience) {
    assert.equal(experienceSchema.safeParse(experience).success, true, experience.id);
    assert.deepEqual(guidedExperienceKind.validate!(experienceSchema.parse(experience), { id: experience.id, registries: registryChecks() } as any).filter((error: string) => !/which is not a setup step/.test(error)), [], experience.id);
  }
  const step = library.guided_experience[0].steps[0];
  assert.equal(step.widget, "sales-team-setup");
  // The step's own pages are registered in the browser runtime, with the module that draws them.
  const runtime = await readFile(new URL("../../libraries/guided-experiences/guided-setup.js", import.meta.url), "utf8");
  assert.match(runtime, /registerWidget\('sales-team-setup'[\s\S]{0,400}import\(new URL\('\.\/sales-team-setup\.js\?v=/);
});

test("it asks what work the company does first, only while that is unanswered", async () => {
  const service = await setup();
  const setupOf = async () => (await service.availableExperiences(owner, {})).experiences.find((entry: any) => entry.id === "sales.team.setup");
  assert.deepEqual(ids(await setupOf()), ["company.type", "company.services", "salespeople"]);
  await invoke(owner, "company-profile.save", { company_type: "roofing_contractor", services: ["roof_replacement", "roof_repair", "gutters"], sales_team: "small_team", workforce: "crews" }, "profile-1");
  assert.deepEqual(ids(await setupOf()), ["salespeople"]);
  const member = person("member", { role: "member", permissions: { view_projects: true } });
  assert.equal((await service.availableExperiences(member, {})).experiences.some((entry: any) => entry.id === "sales.team.setup"), false, "only someone who may change company settings runs it");
});

test("a sales type nobody can go to is said so, and the setup's salespeople can go to it after", async () => {
  await setup();
  await invoke(owner, "appointments.kinds.save", { kinds: [{ id: "sales" }, { id: "delivery" }] }, "kinds-1");
  await invoke(owner, "appointments.setup.apply", { appointment_types: [{ id: "sales", reminder: true, on_my_way: true, attendees: ["sales_team"] }, { id: "delivery", reminder: false, on_my_way: false, attendees: [] }] }, "apply-1");
  const { readAppointmentCatalog, previewAppointment } = await import("../appointments/planning.js");
  let bundle = await readAppointmentCatalog(owner) as any;
  const sales = bundle.catalog.presets.find((preset: any) => preset.id === "sales");
  assert.equal(sales.configuration.requirements[0].department_id, "sales");
  assert.deepEqual(bundle.unstaffed, [{ id: "sales", sales: true, teams: false }], "the sales type needs a salesperson and has none; a delivery needs nobody");
  assert.deepEqual(bundle.sales_department_ids, ["sales"]);
  const preview = await previewAppointment(owner, { date: "2026-12-01", configuration: sales.configuration } as any, { unstaffed: "allow" }) as any;
  assert.deepEqual([preview.staffing[0].unstaffed, preview.sales_department_ids], [true, ["sales"]], "the booking dialog's note knows it is a salesperson that is missing");

  let status = await value(owner, "sales-team-setup", "status");
  assert.deepEqual(status.department, { id: "sales", label: "Sales" });
  assert.deepEqual(status.salespeople, []);
  assert.deepEqual(status.services.map((entry: any) => entry.id), ["roof_replacement", "roof_repair", "gutters"]);
  assert.equal(status.services[0].label.key.length > 0, true);

  const added = await invoke(owner, "workforce.users.add", { name: "Sam Seller", email: "sam@example.com" }, "add-sam");
  const sam = added.user.id;
  await assert.rejects(() => invoke(owner, "sales.team.setup.apply", { salespeople: [{ user_id: "nobody", service_ids: [] }] }, "apply-bad"), /not someone in this organization/);
  await assert.rejects(() => invoke(owner, "sales.team.setup.apply", { salespeople: [{ user_id: sam, service_ids: ["no_such_work"] }] }, "apply-bad-2"), /not a kind of work/);
  status = await invoke(owner, "sales.team.setup.apply", { salespeople: [{ user_id: sam, service_ids: ["roof_replacement", "gutters"] }] }, "apply-sam");
  assert.deepEqual(status.salespeople, [{ user_id: sam, name: "Sam Seller", via: "direct", service_ids: ["roof_replacement", "gutters"] }]);
  const { readOrganizationDepartments } = await import("../workforce/departments.js");
  assert.ok((await readOrganizationDepartments(ORG)).departments.find((entry: any) => entry.id === "sales")!.subject_keys.includes(`organization_user:${sam}`), "a salesperson is a member of the Sales department");
  const { capabilitiesFor } = await import("../labor/capabilities.js");
  assert.deepEqual((await capabilitiesFor(ORG, [{ type: "organization_user", id: sam }])).get(`organization_user:${sam}`)!.service_ids, ["roof_replacement", "gutters"], "what they sell is their capabilities' services");

  bundle = await readAppointmentCatalog(owner);
  assert.deepEqual(bundle.unstaffed, [], "nobody is missing any more: no Add users");
  const after = await previewAppointment(owner, { date: "2026-12-01", configuration: sales.configuration } as any, { unstaffed: "allow" }) as any;
  assert.equal(after.staffing[0].unstaffed, false);

  // Saving again with what they sell changed, then without them: only the direct member the setup added is taken off.
  status = await invoke(owner, "sales.team.setup.apply", { salespeople: [{ user_id: sam, service_ids: ["roof_repair"] }] }, "apply-sam-2");
  assert.deepEqual(status.salespeople[0].service_ids, ["roof_repair"]);
  status = await invoke(owner, "sales.team.setup.apply", { salespeople: [] }, "apply-none");
  assert.deepEqual(status.salespeople, []);
  assert.deepEqual((await readAppointmentCatalog(owner) as any).unstaffed.map((entry: any) => entry.id), ["sales"]);
});

test("the calendar's unassigned warning offers the salesperson setup only while there are no salespeople, with no list", async () => {
  const source = await readFile(new URL("../../libraries/platform-scheduling/platform-scheduling.js", import.meta.url), "utf8");
  const context: any = { window: { PlatformAPI: {} }, console, Date, Math, Set, Map, setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  const vmScheduling = context.window.PlatformScheduling;
  // Read across the vm's realm as plain data.
  const scheduling = { eventRequirementWarnings: (...args: unknown[]) => JSON.parse(JSON.stringify(vmScheduling.eventRequirementWarnings(...args))) };
  const placed = { id: "e1", type: "sales_appointment", event_type_id: "sales_appointment", title: "Sales appointment" };
  assert.deepEqual(scheduling.eventRequirementWarnings(placed, { includeEquipment: false, noSalespeople: true }).map((warning: any) => [warning.code, warning.setup]), [["salesperson_unassigned", "sales.team.setup"]]);
  assert.deepEqual(scheduling.eventRequirementWarnings(placed, { includeEquipment: false, noSalespeople: false }).map((warning: any) => [warning.code, warning.setup]), [["salesperson_unassigned", undefined]]);
  // Booked from a type that asks for someone of the Sales department: a salesperson too.
  const booked = { id: "e2", type: "appointment", appointment_configuration: { requirements: [{ department_id: "sales", subject_type: "organization_user", mode: "count", count: 1 }] } };
  assert.deepEqual(scheduling.eventRequirementWarnings(booked, { includeEquipment: false, noSalespeople: true, salesDepartmentIds: ["sales"] }).map((warning: any) => [warning.code, warning.setup]), [["salesperson_unassigned", "sales.team.setup"]]);
  // The alert is one line per warning beside its triangle: no bullets (GP-144).
  const app = await readFile(new URL("../../libraries/apps/scheduling/app.js", import.meta.url), "utf8");
  const alert = app.slice(app.indexOf("function requirementAlertHtml"), app.indexOf("function eventEquipRefs"));
  assert.doesNotMatch(alert, /<ul>|<li>/);
  assert.match(alert, /data-event-sales-setup/);
  const panel = await readFile(new URL("../../libraries/apps/project-schedule/panel.js", import.meta.url), "utf8");
  assert.doesNotMatch(panel.slice(panel.indexOf("const requirementAlert ="), panel.indexOf("const requirementAlert =") + 400), /<ul>|<li>/);
});
