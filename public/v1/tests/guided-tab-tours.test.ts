import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// The project tab tours beside Materials (docs/architecture/guided-experiences.md): Photos, Reports and Customer
// Portal. Each is valid data, plays the first time its tab opens where the tab is available, and can be replayed
// from the agent's "Show me the tutorial again" question on that tab.
const dir = await mkdtemp(path.join(os.tmpdir(), "guided-tab-tours-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

// `sources`: the files that draw the tab, where every target's hooks must be found.
const TOURS = [
  { id: "photos.tab_tutorial", tab: "project.photos", capability: "platform.project_photos", sources: ["libraries/apps/photos/project.js", "libraries/apps/photos/feed.js"] },
  { id: "reports.tab_tutorial", tab: "project.measurements", capability: "apps.firstmeasure", sources: ["libraries/apps/measurements/project.js", "portal/scripts/project_viewer.js"] },
  { id: "customer_portal.tab_tutorial", tab: "project.customer_portal", capability: "platform.customer_portal", sources: ["libraries/apps/customer-portal/project.js"] }
];
const ORG = "org_tab_tours";
const ALL_ON = Object.fromEntries(TOURS.map((tour) => [tour.capability, true]));
const person = (userId: string, capabilities: Record<string, boolean> | null, extra: Record<string, unknown> = {}) => ({ orgId: ORG, userId, role: "member", permissions: { view_projects: true }, branchId: "default", organization: { data: {} }, ...(capabilities ? { capabilities: { effectiveByKey: capabilities } } : {}), ...extra }) as any;

test("each tab tour registers, validates, and words every step with a gx_ key", async () => {
  const service = await import("../guided-experiences/service.js"), { experience, listExperiences, tabFaqs } = await import("../guided-experiences/registry.js"), { experienceSchema } = await import("../guided-experiences/contracts.js");
  service.ensureGuidedDefinitions();
  service.ensureGuidedDefinitions(); // registering again is a no-op, never a "registered twice"
  const texts = new Map<string, string>();
  for (const definition of listExperiences()) for (const step of definition.steps as any[]) for (const field of ["title", "body", "subtitle"]) if (step[field]) texts.set(step[field].key, texts.get(step[field].key) ?? step[field].text);
  for (const entry of TOURS) {
    const tour = experience(entry.id)!;
    assert.ok(tour, `${entry.id} is registered`);
    assert.equal(experienceSchema.safeParse(tour).success, true, `${entry.id} is valid`);
    assert.equal(tour.kind, "overlay");
    assert.equal(tour.scope, "person");
    assert.equal(tour.replayable, true);
    assert.equal(tour.tab, entry.tab);
    assert.deepEqual(tour.eligibility.capabilities, [entry.capability], "shown only where the tab is available");
    assert.equal(JSON.stringify(tour).includes("configuration"), false, "no configuration id is checked");
    assert.deepEqual(tour.triggers.map((trigger: any) => [trigger.kind, trigger.tab, trigger.once, trigger.when]), [["tab_opened", entry.tab, true, undefined]], "plays the first time the tab opens");
    const steps = tour.steps as any[];
    assert.match(tour.title.key, /^gx_/);
    for (const step of steps) {
      for (const field of ["title", "body"]) {
        assert.match(step[field].key, /^gx_[a-z0-9_]+$/, `${entry.id}/${step.id} ${field} uses a gx_ key`);
        assert.ok(step[field].text.length > 0 && step[field].text.length <= 160, `${entry.id}/${step.id} ${field} is short`);
        assert.equal(texts.get(step[field].key), step[field].text, `${step[field].key} means one text everywhere`);
      }
    }
    assert.equal(steps[0].id, "intro");
    assert.deepEqual(steps[0].targets, []);
    assert.equal(steps.at(-1).id, "outro");
    assert.match(steps.at(-1).body.text, /Show me the tutorial again/);
    const middle = steps.slice(1, -1);
    assert.ok(middle.length >= 3 && middle.length <= 6, `${entry.id} has 3 to 6 steps on real controls, has ${middle.length}`);
    for (const step of middle) assert.ok(step.targets.length > 0, `${entry.id}/${step.id} points at a control`);
    // The replay chip sits beside the tab's existing questions (registered in materials.ts), whichever registers first.
    const faqs = tabFaqs(entry.tab)!;
    assert.ok(faqs.questions.some((question) => question.action === "play" && question.experience === entry.id), `${entry.tab} offers the replay`);
    assert.ok(faqs.questions.filter((question) => question.action === "ask").length >= 2, `${entry.tab} keeps its questions`);
    assert.ok(faqs.questions.length <= 8);
  }
  assert.equal(experience("documents.tab_tutorial"), null, "no Docs tour while the Documents tab is being changed");
});

test("every tour target names hooks the tab's own source draws", async () => {
  const service = await import("../guided-experiences/service.js"), { experience } = await import("../guided-experiences/registry.js");
  service.ensureGuidedDefinitions();
  for (const entry of TOURS) {
    const source = (await Promise.all(entry.sources.map((file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8")))).join("\n");
    for (const step of experience(entry.id)!.steps as any[]) for (const selector of step.targets as string[]) {
      const hooks = [...selector.matchAll(/#([\w-]+)|\[([\w-]+)(?:="([^"]+)")?\]|\.([\w-]+)/g)].map(([, id, attr, value, cls]) => id ? [`id="${id}"`] : attr ? [attr, ...(value && attr === "data-tab" ? [new RegExp(`id:\\s*'${value}'`)] : [])] : [cls]).flat();
      for (const hook of hooks) assert.ok(typeof hook === "string" ? source.includes(hook) : hook!.test(source), `${entry.id}/${step.id}: ${hook} (from ${selector}) is drawn by ${entry.sources.join(", ")}`);
    }
  }
});

test("each tab's questions are one library entry, checked for the limit, unique ids and the experiences they play", async () => {
  const { registerAllLibraryKinds } = await import("../config-library/kinds/index.js"), { checkEntry } = await import("../config-library/writes.js"), { libraryEntries } = await import("../config-library/library.js");
  registerAllLibraryKinds();
  const t = (key: string, text: string) => ({ key, text });
  assert.deepEqual(libraryEntries("guided_tab_faqs").map((entry) => entry.id), ["portal.equipment", "project.customer_portal", "project.docs", "project.map", "project.materials", "project.measurements", "project.photos"]);
  const ask = (i: number) => ({ id: `q.n${i}`, text: t(`gx_test_q_${i}`, "More") });
  assert.deepEqual(checkEntry("guided_tab_faqs", "test.tab", { tab: "test.tab", questions: [ask(1)] }, null).errors, []);
  assert.match(checkEntry("guided_tab_faqs", "test.tab", { tab: "test.tab", questions: [ask(1), ask(1)] }, null).errors.join(" "), /same id/);
  assert.match(checkEntry("guided_tab_faqs", "test.tab", { tab: "test.tab", questions: Array.from({ length: 9 }, (_, i) => ask(i)) }, null).errors.join(" "), /8/);
  assert.match(checkEntry("guided_tab_faqs", "test.tab", { tab: "other.tab", questions: [ask(1)] }, null).errors.join(" "), /not the entry's id/);
  assert.match(checkEntry("guided_tab_faqs", "test.tab", { tab: "test.tab", questions: [{ id: "q.play", text: t("gx_test_q_play", "Again"), action: "play", experience: "no.such_tour" }] }, null).errors.join(" "), /not an experience/);
});

test("a fresh organization's people get each tour on first view where the tab is on, and not where it is off", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Tab tours" });
  await enableExpandedPlatformFixture(ORG, ALL_ON);
  const service = await import("../guided-experiences/service.js");
  for (const entry of TOURS) {
    // Capabilities as the organization resolves them (no per-request override).
    const listed = await service.availableExperiences(person("fresh", null), { tab: entry.tab, projectId: "p1" });
    const tour = listed.experiences.find((item) => item.id === entry.id);
    assert.ok(tour, `${entry.id} is offered on a fresh organization`);
    assert.equal(tour!.progress, null, "never seen");
    assert.deepEqual(tour!.triggers.map((trigger: any) => trigger.kind), ["tab_opened"], "armed for the first view");
    assert.ok(listed.faqs!.questions.some((question) => question.action === "play" && question.experience === entry.id), "the replay chip is offered");
    // Where the tab is off, there is no tour and no replay chip.
    const off = await service.availableExperiences(person("off", { ...ALL_ON, [entry.capability]: false }), { tab: entry.tab });
    assert.equal(off.experiences.some((item) => item.id === entry.id), false, `${entry.id} is not offered without ${entry.capability}`);
    assert.equal(off.faqs?.questions.some((question) => question.experience === entry.id) ?? false, false, "no replay chip without the tour");
  }
});

// Steps on features an organization can switch off, and the capability each names (step eligibility, checked on the
// server). `a|b` is either.
const GATED = [
  { tour: "reports.tab_tutorial", tab: "project.measurements", step: "support", capability: "firstmeasure.report_followup" },
  { tour: "reports.tab_tutorial", tab: "project.measurements", step: "summary", capability: "firstmeasure.measurement_report_summary" },
  { tour: "customer_portal.tab_tutorial", tab: "project.customer_portal", step: "options", capability: "scheduling.customer_rescheduling|customer_portal.guest_links" },
  { tour: "customer_portal.tab_tutorial", tab: "project.customer_portal", step: "media", capability: "platform.customer_portal_media" }
];

test("a step on a feature that can be switched off names a registered capability", async () => {
  const service = await import("../guided-experiences/service.js"), { experience } = await import("../guided-experiences/registry.js"), { capabilityDefinition } = await import("../platform/capabilities.js");
  service.ensureGuidedDefinitions();
  for (const entry of TOURS) for (const step of experience(entry.id)!.steps as any[]) {
    const gate = GATED.find((item) => item.tour === entry.id && item.step === step.id);
    assert.deepEqual(step.eligibility?.capabilities ?? [], gate ? [gate.capability] : [], `${entry.id}/${step.id} eligibility`);
    for (const key of (gate?.capability || "").split("|").filter(Boolean)) assert.ok(capabilityDefinition(key), `${key} is a registered capability`);
  }
});

test("a tour is served without a step whose feature is off, and with it when it is on", async () => {
  const service = await import("../guided-experiences/service.js");
  const stepsFor = async (userId: string, tour: string, tab: string, capabilities: Record<string, boolean>) => {
    const listed = await service.availableExperiences(person(userId, capabilities), { tab, projectId: "p1" });
    return listed.experiences.find((item) => item.id === tour)!.steps.map((step: any) => step.id);
  };
  const everyGate = Object.fromEntries(GATED.flatMap((gate) => gate.capability.split("|")).map((key) => [key, true]));
  for (const gate of GATED) {
    const off = { ...ALL_ON, ...everyGate, ...Object.fromEntries(gate.capability.split("|").map((key) => [key, false])) };
    assert.equal((await stepsFor("gate_off", gate.tour, gate.tab, off)).includes(gate.step), false, `${gate.tour}/${gate.step} is not sent without ${gate.capability}`);
    assert.ok((await stepsFor("gate_on", gate.tour, gate.tab, { ...ALL_ON, ...everyGate })).includes(gate.step), `${gate.tour}/${gate.step} is sent with ${gate.capability}`);
    for (const key of gate.capability.split("|")) {
      const one = { ...off, [key]: true };
      assert.ok((await stepsFor("gate_one", gate.tour, gate.tab, one)).includes(gate.step), `${gate.tour}/${gate.step} is sent with ${key} alone`);
    }
  }
  // Reports with Support off (the default, and the MVP platform's): every other step still plays, in order.
  assert.deepEqual(await stepsFor("support_off", "reports.tab_tutorial", "project.measurements", { ...ALL_ON, "firstmeasure.measurement_report_summary": true, "firstmeasure.report_followup": false }), ["intro", "standard", "customer", "model", "summary", "outro"]);
  assert.deepEqual(await stepsFor("support_on", "reports.tab_tutorial", "project.measurements", { ...ALL_ON, "firstmeasure.measurement_report_summary": true, "firstmeasure.report_followup": true }), ["intro", "standard", "customer", "model", "summary", "support", "outro"]);
  // A fresh organization resolves its own capabilities: report follow-up is off by default, so there is no Support step.
  assert.equal((await service.availableExperiences(person("fresh_reports", null), { tab: "project.measurements" })).experiences.find((item) => item.id === "reports.tab_tutorial")!.steps.some((step: any) => step.id === "support"), false);
});

test("finishing a tour disarms its first-view trigger; the replay chip still plays it", async () => {
  const service = await import("../guided-experiences/service.js");
  const ann = person("ann", ALL_ON);
  for (const entry of TOURS) {
    await service.recordGuidedEvent(ann, entry.id, { type: "start" });
    await service.recordGuidedEvent(ann, entry.id, { type: "complete", step_id: "outro" });
    const listed = await service.availableExperiences(ann, { tab: entry.tab });
    const tour = listed.experiences.find((item) => item.id === entry.id)!;
    assert.equal(tour.progress!.status, "completed");
    assert.deepEqual(tour.triggers, [], "it does not play again on its own");
    assert.ok(listed.faqs!.questions.some((question) => question.action === "play" && question.experience === entry.id), "the replay stays offered");
    assert.equal((await service.recordGuidedEvent(ann, entry.id, { type: "replay" })).progress!.status, "started");
  }
});
