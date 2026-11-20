import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// GP-141: the kinds of work a company does are its production boards and its work appointments. Each kind of work
// picked gets a board, on and in the Production lane; the Scheduling setup offers the appointment kinds for that work
// (a roof installation and a roof repair for a roofer that does both) and not another trade's; sales stays one kind.
const dir = await mkdtemp(path.join(os.tmpdir(), "work-boards-"));
Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
  PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
  FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });

const work = (...ids: string[]) => ids.map((id) => ({ id, label: id, work_kind: null }));

test("the appointment kinds offered and picked follow the work the company does", async () => {
  const { offeredKinds, suggestedKinds, workKinds, APPOINTMENT_KINDS } = await import("../appointments/setup.js");
  const roofer = { industry: "roofing", crm_pack: "roofing", sales_team: "small_team", services: work("roof_replacement", "roof_repair"), services_other: [] };
  assert.deepEqual(workKinds(roofer), ["roof_installation", "roof_repair"]);
  assert.deepEqual(suggestedKinds(roofer), ["sales", "roof_installation", "roof_repair", "delivery"], "one sales kind, the work's own kinds, deliveries");
  const offered = offeredKinds(roofer);
  for (const id of ["sales", "roof_installation", "roof_repair", "delivery", "walkthrough", "meeting"]) assert.ok(offered.includes(id), id);
  for (const id of ["repair", "installation", "maintenance", "gutter_installation", "siding_installation", "inspection", "service_call"]) assert.ok(!offered.includes(id), `${id} is not offered to a roofer that does no such work`);

  const exteriors = { ...roofer, services: work("roof_replacement", "gutters", "siding", "gutter_cleaning", "decks") };
  assert.deepEqual(workKinds(exteriors), ["roof_installation", "gutter_installation", "siding_installation", "maintenance", "installation"], "work no kind names is an installation");
  assert.ok(!offeredKinds(exteriors).includes("roof_repair"), "no repairs picked, no repair kind");
  assert.deepEqual(workKinds({ services: work("plumbing_repair"), services_other: ["Bathroom fans"] }), ["repair", "installation"], "work in the person's own words is an installation");
  assert.deepEqual(suggestedKinds({ ...roofer, sales_team: "no_sales" }), ["roof_installation", "roof_repair", "delivery"], "no sales appointments, no sales kind");
  assert.ok(!offeredKinds({ ...roofer, sales_team: "no_sales" }).includes("sales"));

  // Before the work is answered nothing is known: every kind is offered and the common ones are picked.
  const unanswered = { industry: "roofing", crm_pack: null, sales_team: "small_team" } as any;
  assert.equal(workKinds(unanswered), null);
  assert.deepEqual(suggestedKinds(unanswered), ["sales", "installation", "repair", "delivery"]);
  assert.deepEqual(offeredKinds(unanswered), APPOINTMENT_KINDS.filter((entry) => !entry.retired).map((entry) => entry.id));
});

test("each kind of work picked gets its own production board, and loses it when it is no longer picked", async (t) => {
  const storage = await import("../platform/storage.js");
  const { syncWorkBoards, readWorkBoards } = await import("../scopes/work-boards.js");
  const { readScopeTemplate, readScopeFlagState, patchScopeFlags, listScopeTemplates } = await import("../scopes/storage.js");
  const { templateCategoryIds } = await import("../scopes/categories.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_work_boards";
  await storage.createOrganization({ id: ORG, name: "Work boards" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);
  // Like a new MVP organization: every library board it has is off.
  const before = await readScopeFlagState(ORG, "default");
  await patchScopeFlags(ORG, { expected_revision: before.revision, flags: Object.fromEntries(Object.keys(before.flags).map((id) => [id, false])) }, "default");
  const enabled = async () => (await listScopeTemplates(ORG, "default")).map((template) => String(template.id)).sort();
  const profile = (...ids: string[]) => ({ services: work(...ids), lead_flow: { job_known: null, first_call: null, visit: null, handoff: null, answered: false } });

  // Re-roofs and roof repairs: the library's Roof Replacement board, and a Roof repairs board of its own.
  const boards = await syncWorkBoards(ORG, "default", profile("roof_replacement", "roof_repair"), "user_owner");
  assert.deepEqual(Object.fromEntries(Object.entries(boards).map(([id, entry]) => [id, entry.template_id])), { roof_replacement: "roof_replacement", roof_repair: "work_roof_repair" });
  assert.deepEqual(await enabled(), ["roof_replacement", "work_roof_repair"], "Settings and Projects show a board for each");
  const repair = await readScopeTemplate(ORG, "default", "work_roof_repair") as any;
  assert.equal(repair.name, "Roof repairs");
  assert.deepEqual(templateCategoryIds(repair.definition), ["production"]);
  assert.equal((repair.definition as any).work_plan.root_nodes[0].title, "Roof repairs");
  assert.deepEqual((repair.definition as any).metadata.work_board, { service: "roof_repair", from: "repairs" }, "copied from the library's Repairs board");
  assert.notEqual((repair.definition as any).metadata.preset, true, "the organization's own board, not a copy that follows the library");

  // Gutters instead of repairs: the Gutters board comes on, the Roof repairs board this made goes off (kept, not deleted).
  await syncWorkBoards(ORG, "default", profile("roof_replacement", "gutters"), "user_owner");
  assert.deepEqual(await enabled(), ["gutters", "roof_replacement"]);
  assert.equal(((await readScopeTemplate(ORG, "default", "work_roof_repair")) as any).status, "active");
  // Picked again, the same board comes back on; nothing is made twice.
  await syncWorkBoards(ORG, "default", profile("roof_replacement", "gutters", "roof_repair"), "user_owner");
  assert.deepEqual(await enabled(), ["gutters", "roof_replacement", "work_roof_repair"]);
  assert.equal((await readScopeTemplate(ORG, "default", "work_roof_repair")).version, 1);

  // A board that was already on stays on when its work is no longer picked; one this turned on goes off.
  const flags = await readScopeFlagState(ORG, "default");
  await patchScopeFlags(ORG, { expected_revision: flags.revision, flags: { siding_replacement: true } }, "default");
  await syncWorkBoards(ORG, "default", profile("siding"), "user_owner");
  assert.deepEqual((await readWorkBoards(ORG, "default")).siding, { template_id: "siding_replacement", turned_on: false });
  await syncWorkBoards(ORG, "default", profile("gutters"), "user_owner");
  assert.deepEqual(await enabled(), ["gutters", "siding_replacement"]);

  // The board a sold job is handed to stays on while the Automations Hub hands jobs off to it.
  await syncWorkBoards(ORG, "default", profile("roof_replacement"), "user_owner");
  await syncWorkBoards(ORG, "default", { ...profile("gutters"), lead_flow: { ...profile().lead_flow, handoff: "separate" } }, "user_owner");
  assert.ok((await enabled()).includes("roof_replacement"));
});
