import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// The checklists setup and the Checklists tab tour (library entries guided_experience/checklists.*): the setup asks
// "What kind of company are you?" first while it is unanswered, offers the three use-case checklists (tailored to the
// kind of company), and its completion action adds the picked ones to the project, once each.
const dir = await mkdtemp(path.join(os.tmpdir(), "checklists-setup-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
after(async () => {
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  await closeWorkforceDatabase();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

const ORG = "org_checklists_setup";
const PROJECT = "checklists_setup_project";
const flags = { "apps.checklists": true, "apps.crew": true, "platform.documents": true, "checklists.crew_send": true, "platform.customer_portal": true };
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: {} }, capabilities: { effectiveByKey: flags }, ...extra }) as any;
const ids = (experience: any) => experience.steps.map((step: any) => step.id);

test("the checklists setup asks the kind of company first, then adds the picked checklists to the project", async () => {
  const storage = await import("../platform/storage.js");
  await storage.createOrganization({ id: ORG, name: "Checklists setup" }).catch(() => {});
  await enableExpandedPlatformFixture(ORG, flags);
  await storage.upsertDocument(ORG, "projects", { id: PROJECT, data: { branch_id: "default", title: "Setup project" }, metadata: { kind: "platform_project", branch_id: "default" } }, { replace: true });
  const { initializePublication } = await import("../platform/publication/bootstrap.js");
  initializePublication();
  const service = await import("../guided-experiences/service.js");
  service.ensureGuidedDefinitions();
  const owner = person("owner");
  const listed = async () => (await service.availableExperiences(owner, { tab: "project.checklists", projectId: PROJECT })).experiences;
  const setup = async () => (await listed()).find((entry: any) => entry.id === "checklists.setup")!;

  // Unanswered: the company type is asked before the checklists, in the same frame.
  const first = await setup();
  assert.ok(first, "the setup is offered on the Checklists tab");
  assert.deepEqual(ids(first), ["company.type", "use_cases"]);
  assert.ok(first.triggers.some((trigger: any) => trigger.kind === "tab_opened" && trigger.tab === "project.checklists"));
  const tour = (await listed()).find((entry: any) => entry.id === "checklists.tab_tutorial")!;
  assert.ok(tour, "the tour is offered too");
  assert.deepEqual(ids(tour), ["intro", "lists", "assign", "add_item", "comment", "voice_update", "document", "send_crew", "try_voice"]);
  assert.equal((tour.steps.at(-1) as any)?.advance, "click", "the last step waits for them to try creating a checklist by voice (or skip)");

  // Answered (a roofer): asked no more, and the checklists are the roofing ones.
  const { invokeAction } = await import("../platform/publication/actions.js"), { userPublicationContext } = await import("../platform/publication/context.js");
  await invokeAction(userPublicationContext(owner, { mode: "command" }), { action: "company-profile.save", target: { scope: "organization", organizationId: ORG } }, { company_type: "roofing_contractor" }, { idempotencyKey: "type-1" });
  const answered = await setup();
  assert.deepEqual(ids(answered), ["use_cases"]);
  const useCases = (answered.steps[0] as any).options.use_cases;
  // The customer punch list is last, not picked to start with, and empty: the person fills it in (FM-444).
  assert.deepEqual(useCases.map((entry: any) => entry.id), ["crew_safety", "work_completion", "punchlist"]);
  assert.ok(useCases[0].checklist.items.some((item: any) => /harness/i.test(item.title)), "the roofing variant's crew safety list");
  assert.equal(useCases[0].checklist.signature_required, true);
  assert.equal(useCases[2].selected, false, "the punch list starts unpicked");
  assert.deepEqual(useCases[2].checklist.items, [], "the punch list starts empty");
  assert.ok(useCases.slice(0, 2).every((entry: any) => entry.selected !== false), "the crew lists start picked");
  const punchTour = (await listed()).find((entry: any) => entry.id === "checklists.punchlist_tutorial")!;
  assert.ok(punchTour, "the punch list tour is offered");
  assert.ok(!punchTour.tab, "no tab of its own: it goes to the Customer Portal tab and back without ending");
  assert.deepEqual(ids(punchTour), ["punch", "access", "portal_tab", "portal", "back", "done"]);
  assert.ok(punchTour.steps.every((step: any) => step.targets.length), "every step points at something, so it shows nothing without a punch list");
  assert.ok((punchTour.steps.find((step: any) => step.id === "portal_tab") as any).targets[0].includes("[data-fmcl-customer-shared=true]"), "it goes to the portal only when a list is shared with the customer");

  // Finishing it adds the picked checklists to the project, once each.
  const picked = useCases.filter((entry: any) => entry.id !== "work_completion");
  const selections = { checklist_use_cases: picked.map((entry: any) => entry.id), checklist_definitions: picked.map((entry: any) => ({ ...entry.checklist, use_case: entry.id })) };
  const done = await service.completeGuided(owner, "checklists.setup", { project_id: PROJECT, tab: "project.checklists", selections }) as any;
  assert.deepEqual(done.then, [{ play: "checklists.punchlist_tutorial" }, { play: "checklists.tab_tutorial" }]);
  assert.deepEqual(done.result.checklists.map((entry: any) => entry.use_case).sort(), ["crew_safety", "punchlist"]);
  const { listProjectChecklists } = await import("../workforce/crew_storage.js");
  const lists = await listProjectChecklists(ORG, PROJECT);
  const safety = lists.find((entry) => entry.source_key === "setup:crew_safety")!;
  assert.equal(safety.signature_required, true);
  assert.ok(safety.items.length >= 5);
  const punch = lists.find((entry) => entry.source_key === "setup:punchlist")!;
  assert.equal(punch.items.length, 0, "an empty punch list is added");
  assert.equal(punch.customer_access.visible, true);
  assert.equal(punch.customer_access.can_complete, true);
  await service.completeGuided(owner, "checklists.setup", { project_id: PROJECT, tab: "project.checklists", selections: { ...selections, checklist_use_cases: ["punchlist", "crew_safety"] } });
  assert.equal((await listProjectChecklists(ORG, PROJECT)).length, 2, "playing it again adds nothing twice");
  await assert.rejects(() => service.completeGuided(owner, "checklists.setup", { project_id: PROJECT, selections: { checklist_use_cases: [], checklist_definitions: [] } }), /at least one/);
});
