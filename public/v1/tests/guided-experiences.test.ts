import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// The guided-experience engine (guided-experiences/*, docs/architecture/guided-experiences.md).
const dir = await mkdtemp(path.join(os.tmpdir(), "guided-experiences-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const ORG = "org_guided";
const person = (userId: string, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "owner", permissions: { "*": true }, branchId: "default", organization: { data: { address: { state: "TX" } } }, capabilities: { effectiveByKey: { "platform.materials": true } }, ...extra }) as any;
const t = (key: string, text: string) => ({ key, text });
const context = (org: string, extra: Record<string, unknown> = {}) => ({ organization: { id: org, region: "south", state: "TX", timezone: "", size: { users: 3, tier: "small" }, industry: "", capabilities: {}, flags: { assistant: true }, ...extra }, person: { id: "u", role: "owner", permissions: {} }, surface: { tab: "", project_id: "" } }) as any;

const TOUR = {
  id: "test.tour", version: 1, kind: "overlay", scope: "person", replayable: true, title: t("gx_test_title", "Tour"),
  triggers: [{ kind: "tab_opened", tab: "project.photos" }, { kind: "manual" }],
  variants: [{ id: "a", weight: 1 }, { id: "b", weight: 1 }],
  steps: [
    { id: "one", title: t("gx_test_1", "One"), body: t("gx_test_1b", "First"), targets: ["#one"] },
    { id: "two", title: t("gx_test_2", "Two"), body: t("gx_test_2b", "Second"), targets: ["#two"], next: { branches: [{ when: { "selections.skip_three": "yes" }, to: "four" }] } },
    { id: "three", title: t("gx_test_3", "Three"), body: t("gx_test_3b", "Third"), targets: [] },
    { id: "four", title: t("gx_test_4", "Four"), body: t("gx_test_4b", "Fourth"), targets: [] }
  ]
};

test("definitions are checked when registered", async () => {
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  assert.equal(experienceSchema.safeParse(TOUR).success, true);
  const bad = (patch: Record<string, unknown>, pattern: RegExp) => { const result = experienceSchema.safeParse({ ...TOUR, ...patch }); assert.equal(result.success, false); assert.match(JSON.stringify(result.error!.issues), pattern); };
  bad({ steps: [{ ...TOUR.steps[0], next: "nowhere" }] }, /not a step/);
  bad({ variants: [{ id: "a", weight: 0 }] }, /weight above 0/);
  bad({ variants: [{ id: "a", weight: 1, steps: ["missing"] }] }, /not a step/);
  bad({ kind: "agentic" }, /does not suit/);
  bad({ eligibility: { when: { field: "organization.size.users", operator: "greater_than", value: "lots" } } }, /must be a number/);
  bad({ title: { key: "not-a-key", text: "x" } }, /key/);
});

test("the chooser is deterministic, splits by weight, filters by conditions and keeps a remembered variant", async () => {
  const { experienceSchema } = await import("../guided-experiences/contracts.js"), { bucketOf, chooseVariant, regionForState } = await import("../guided-experiences/chooser.js");
  const tour = experienceSchema.parse(TOUR);
  assert.equal(bucketOf("organization:x", "e", "v1"), bucketOf("organization:x", "e", "v1"));
  assert.notEqual(bucketOf("organization:x", "e", "v1"), bucketOf("organization:x", "e", "v2"), "a new salt reshuffles");
  const counts: Record<string, number> = { a: 0, b: 0 };
  for (let i = 0; i < 2000; i++) {
    const first = chooseVariant(tour, { ...context(`org_${i}`), person: { id: `p${i}`, role: "", permissions: {} } })!;
    const again = chooseVariant(tour, { ...context(`org_${i}`), person: { id: `p${i}`, role: "", permissions: {} } })!;
    assert.equal(first.variant.id, again.variant.id);
    assert.ok(first.bucket >= 0 && first.bucket < 1);
    counts[first.variant.id]!++;
  }
  assert.ok(Math.abs(counts.a! - 1000) < 120, `an even split, got ${JSON.stringify(counts)}`);
  const weighted = experienceSchema.parse({ ...TOUR, variants: [{ id: "a", weight: 3 }, { id: "b", weight: 1 }, { id: "c", weight: 0 }] });
  const shares: Record<string, number> = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 2000; i++) shares[chooseVariant(weighted, { ...context("org"), person: { id: `p${i}`, role: "", permissions: {} } })!.variant.id]!++;
  assert.equal(shares.c, 0, "weight 0 is never chosen");
  assert.ok(shares.a! > 1350 && shares.a! < 1650, `three to one, got ${JSON.stringify(shares)}`);
  const conditional = experienceSchema.parse({ ...TOUR, variants: [{ id: "assistant", weight: 1, when: { field: "organization.flags.assistant", operator: "equals", value: true } }, { id: "plain", weight: 1, when: { field: "organization.flags.assistant", operator: "not_equals", value: true } }] });
  assert.equal(chooseVariant(conditional, context("o"))!.variant.id, "assistant");
  assert.equal(chooseVariant(conditional, context("o", { flags: { assistant: false } }))!.variant.id, "plain");
  assert.equal(chooseVariant(tour, context("o"), "b")!.variant.id, "b", "a remembered variant stays");
  assert.equal(chooseVariant(conditional, context("o", { flags: { assistant: false } }), "assistant")!.variant.id, "plain", "unless it no longer suits");
  assert.equal(regionForState("ny"), "northeast");
  assert.equal(regionForState(""), "national");
});

test("progress: exposure once, step navigation and branches, skip, dismiss, replay and trigger once", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Guided" });
  await enableExpandedPlatformFixture(ORG, { "platform.materials": true });
  const { registerExperience } = await import("../guided-experiences/registry.js");
  const service = await import("../guided-experiences/service.js");
  registerExperience(TOUR as any);
  registerExperience({ ...TOUR, id: "test.once", replayable: false } as any);
  const ann = person("ann");

  const first = await service.recordGuidedEvent(ann, "test.tour", { type: "exposure" });
  assert.equal(first.recorded, true);
  assert.equal((await service.recordGuidedEvent(ann, "test.tour", { type: "exposure" })).recorded, false, "an exposure counts once per unit");
  await service.recordGuidedEvent(ann, "test.tour", { type: "start" });
  const viewed = await service.recordGuidedEvent(ann, "test.tour", { type: "step_view", step_id: "two", selections: { skip_three: "yes" } });
  assert.equal(viewed.progress!.step_id, "two");
  const done = await service.recordGuidedEvent(ann, "test.tour", { type: "step_done", step_id: "two" }) as any;
  assert.equal(done.next_step, "four", "a branch over the selections so far picks the next step");
  await service.recordGuidedEvent(ann, "test.tour", { type: "step_view", step_id: "two", selections: { skip_three: "no" } });
  assert.equal((await service.recordGuidedEvent(ann, "test.tour", { type: "step_done", step_id: "two" }) as any).next_step, "three");
  assert.equal((await service.recordGuidedEvent(ann, "test.tour", { type: "step_skip", step_id: "three" })).progress!.step_id, "three");
  await assert.rejects(() => service.recordGuidedEvent(ann, "test.tour", { type: "step_view", step_id: "nope" }), /not part of this experience/);
  await assert.rejects(() => service.recordGuidedEvent(ann, "test.tour", { type: "step_view", step_id: "one", selections: { html: "<b>" } }), /plain values/);

  // Progress belongs to the person: Bob has not seen the tour.
  const bob = person("bob");
  const listed = (await service.availableExperiences(bob, { tab: "project.photos" })).experiences.find((entry) => entry.id === "test.tour")!;
  assert.equal(listed.progress, null);
  assert.ok(listed.triggers.some((trigger: any) => trigger.kind === "tab_opened"));

  const finished = await service.recordGuidedEvent(ann, "test.tour", { type: "complete", step_id: "four" });
  assert.equal(finished.progress!.status, "completed");
  const after = (await service.availableExperiences(ann, {})).experiences.find((entry) => entry.id === "test.tour")!;
  assert.equal(after.progress!.status, "completed", "a replayable experience stays listed");
  assert.deepEqual(after.triggers.map((trigger: any) => trigger.kind), ["manual"], "a once trigger is disarmed after it finished");
  assert.equal((await service.recordGuidedEvent(ann, "test.tour", { type: "replay" })).progress!.status, "started", "a replay restarts it");

  await service.recordGuidedEvent(ann, "test.once", { type: "dismiss", step_id: "one" });
  assert.equal((await service.availableExperiences(ann, {})).experiences.some((entry) => entry.id === "test.once"), false, "a dismissed, non-replayable experience does not come back");
  const { listEvents } = await import("../guided-experiences/store.js");
  const types = (await listEvents(ORG, "test.tour")).map((event) => event.type);
  for (const type of ["exposure", "start", "step_view", "step_done", "step_skip", "complete", "replay"]) assert.ok(types.includes(type), `${type} is recorded for analysis`);
  assert.ok((await listEvents(ORG, "test.tour")).every((event) => ["a", "b"].includes(event.variant_id)), "every event carries its variant");
});

test("the historical pricebook setup remains manually replayable and Operations owns first-use", async () => {
  const service = await import("../guided-experiences/service.js"), { experience, tabFaqs } = await import("../guided-experiences/registry.js");
  service.ensureGuidedDefinitions();
  const setup = experience("materials.pricebook_setup.roofing")!, tour = experience("materials.tab_tutorial")!;
  assert.equal(setup.kind, "agentic");
  assert.deepEqual(setup.completion.then, [{ handoff: "assistant_tray" }, { resume: true }, { play: "materials.tab_tutorial" }]);
  assert.equal(tour.replayable, true);
  assert.ok(tabFaqs("project.materials")!.questions.some((question) => question.action === "play" && question.experience === "materials.tab_tutorial"));
  const owner = person("owner");
  const listed = await service.availableExperiences(owner, { tab: "project.materials" });
  const offered = listed.experiences.find((entry) => entry.id === "materials.pricebook_setup.roofing")!;
  assert.ok(offered, "an owner may set up the price book");
  assert.equal(offered.variant.id, "modal", "the assistant is off in this fixture, so the setup plays as a modal");
  assert.equal(offered.kind, "modal");
  const brands = (offered.steps[0] as any).options.brands.map((brand: any) => brand.id).sort();
  for (const id of ["certainteed", "gaf", "malarkey", "owens_corning"]) assert.ok(brands.includes(id), `${id} is offered`);
  assert.equal((offered.steps[0] as any).options.region.id, "south", "Texas prices");
  // Two paths from the roof types: shingle goes to the manufacturers and defaults, anything else to the default
  // material; both then go to suppliers.
  const variant = setup.variants.find((entry) => entry.id === "modal")!;
  assert.deepEqual(offered.steps.map((step: any) => step.id), ["roof_types", "brands", "defaults", "material", "suppliers"]);
  assert.equal(service.nextStep(setup, variant, "roof_types", { roof_types: ["metal", "shingle"] }), "brands");
  assert.equal(service.nextStep(setup, variant, "roof_types", { roof_types: ["metal", "tpo"] }), "material");
  assert.equal(service.nextStep(setup, variant, "brands", {}), "defaults");
  assert.equal(service.nextStep(setup, variant, "defaults", {}), "suppliers", "the shingle path skips the default material");
  assert.equal(service.nextStep(setup, variant, "material", {}), "suppliers");
  assert.ok(listed.faqs!.questions.length >= 4);
  const crew = person("crew", { role: "member", permissions: { view_projects: true }, accessProfile: { roles: [], app_restrictions: [] } });
  assert.equal((await service.availableExperiences(crew, {})).experiences.some((entry) => entry.id === "materials.pricebook_setup.roofing"), false, "only someone who may change company settings is asked");
  // The old manufacturer questionnaire is available only when explicitly requested.
  assert.deepEqual(offered.triggers.map((trigger: any) => trigger.kind), ["manual"]);
  // Onboarding sequencing: until the tour is done, Materials shows only on projects with a report.
  assert.deepEqual(listed.reveals, [], "Operations is offered before measurements");
  const tourForOwner = listed.experiences.find((entry) => entry.id === "materials.tab_tutorial")!;
  assert.equal(tourForOwner.triggers.some((trigger: any) => trigger.kind === "tab_opened"), false, "the owner's tour waits for the setup");
  // Someone who is not asked to set the price book up gets the tour on their first view straight away.
  const crewList = await service.availableExperiences(crew, {});
  assert.deepEqual(crewList.experiences.find((entry) => entry.id === "materials.tab_tutorial")!.triggers.map((trigger: any) => trigger.kind), ["after_experience", "tab_opened"]);
  await service.recordGuidedEvent(crew, "materials.tab_tutorial", { type: "dismiss", step_id: "intro" });
  assert.deepEqual((await service.availableExperiences(crew, {})).reveals, [], "closing the tour counts as having been through it");
  assert.equal((await service.availableExperiences(owner, {})).reveals.length, 0, "no report prerequisite for anyone");
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  assert.equal(experienceSchema.safeParse({ ...experience("materials.tab_tutorial"), reveal: [{ tab: "project.materials", when: { "organization.size": 3 } }] }).success, false, "a reveal reads project facts only");
  assert.equal(await service.guidedConversationContext(owner, "project:p1"), "", "no setup open on that conversation");
});


test("Operations uses the shared document workflow and optional setup hub before its materials tour", async () => {
 const service=await import('../guided-experiences/service.js');
 const {experience}=await import('../guided-experiences/registry.js');
 const {experienceSchema}=await import('../guided-experiences/contracts.js');
 service.ensureGuidedDefinitions();
 const setup=experience('operations.setup')!;
 assert.equal(experienceSchema.safeParse(setup).success,true);
 assert.equal(setup.kind,'modal');assert.equal(setup.scope,'organization');
 assert.deepEqual(setup.triggers.map(trigger=>trigger.kind),['tab_opened']);
 assert.deepEqual(setup.steps.map(step=>(step as any).widget),['operations-path','operations-document','operations-ready']);
 assert.equal(setup.completion.action?.id,'operations.setup.complete');
 assert.deepEqual(setup.completion.then,[{resume:true},{play:'materials.tab_tutorial'}],'generate materials before the tutorial looks for its targets');
 assert.equal(setup.completion.action?.target,'project');
 assert.deepEqual(setup.completion.then,[{play:'materials.tab_tutorial'}]);
 const cards=(setup.steps.find(step=>step.id==='ready') as any).options.setups;
 assert.deepEqual(cards.map((card:any)=>[card.id,card.minutes]),[['suppliers',5],['equipment',3],['workforce',5],['proposals',10]]);
 assert.equal(cards.find((card:any)=>card.id==='workforce').terminologyKey,'workforce.resource_group_plural');
 for(const id of ['operations.suppliers.setup','operations.workforce.setup','operations.proposal.setup']){
   const optional=experience(id)!;
   assert.equal(experienceSchema.safeParse(optional).success,true,id);
   assert.deepEqual(optional.triggers.map(trigger=>trigger.kind),['manual'],`${id} only starts when chosen`);
 }
 assert.equal((experience('operations.proposal.setup')!.steps[0] as any).options.path,'proposal');
 const operator=person('operations-editor',{permissions:{manage_projects:true}});
 const listed=await service.availableExperiences(operator,{tab:'project.materials'});
 assert.ok(listed.experiences.some(item=>item.id==='operations.setup'),'a project editor does not need company-settings permission to build a scope');
 assert.equal(listed.experiences.find(item=>item.id==='materials.tab_tutorial')!.triggers.some(trigger=>trigger.kind==='tab_opened'),false,'the tutorial waits for Operations setup, not the retired pricebook setup');
 const {writeProgress}=await import('../guided-experiences/store.js');
 await writeProgress(ORG,'','operations.setup',{status:'completed',variant_id:'default',userId:'operations-editor'});
 const nextPerson=await service.availableExperiences(person('another-editor',{permissions:{manage_projects:true}}),{tab:'project.materials'});
 assert.equal(nextPerson.experiences.find(item=>item.id==='operations.setup')?.progress?.status,'completed','setup progress belongs to the organization');
 assert.equal(nextPerson.experiences.find(item=>item.id==='materials.tab_tutorial')!.triggers.some(trigger=>trigger.kind==='tab_opened'),true,'the tour can run once scope setup is complete');
});
