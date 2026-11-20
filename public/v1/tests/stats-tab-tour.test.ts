import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { closePlatformFixtureStores, enableExpandedPlatformFixture } from "./helpers/platform-fixture.js";

// GP-132: the Stats header is one row (the views dropdown, the period, the view's pen, the assistant as an icon), and
// a first-run tour (`stats.tab_tutorial`, config library) walks it on a computer and a phone alike.
const dir = await mkdtemp(path.join(os.tmpdir(), "stats-tab-tour-"));
Object.assign(process.env, { NODE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PRICEBOOK_STORAGE_ROOT: path.join(dir, "pricebook"), FIRSTMEASURE_STORAGE_ROOT: path.join(dir, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(dir, "index.sqlite"), PLATFORM_HEARTBEAT_DISABLED: "1" });
after(async () => { await closePlatformFixtureStores(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

const TOUR = "stats.tab_tutorial", TAB = "portal.stats", ORG = "org_stats_tour";
const source = await readFile(new URL("../../libraries/apps/stats/app.js", import.meta.url), "utf8");
const person = (userId: string, capabilities: Record<string, boolean> | null) => ({ orgId: ORG, userId, role: "member", permissions: { view_projects: true }, branchId: "default", organization: { data: {} }, ...(capabilities ? { capabilities: { effectiveByKey: capabilities } } : {}) }) as any;

test("the Stats header is one row: views dropdown, period, pen, then the assistant as an icon", () => {
  const top = source.slice(source.indexOf('<div class="st-top">'), source.indexOf('<div class="st-body">'));
  const order = ['data-st="views"', 'data-st="range"', 'data-st="edit-view"', 'data-st="chat-toggle"'].map((hook) => top.indexOf(hook));
  assert.ok(order.every((at) => at > 0), "every control is in the header");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in that order");
  const toggle = top.slice(top.indexOf('data-st="chat-toggle"'), top.indexOf("</button>", top.indexOf('data-st="chat-toggle"')));
  assert.match(toggle, /aria-label=/, "the assistant button is named for screen readers");
  assert.doesNotMatch(toggle.replace(/<i [^>]*><\/i>/g, "").replace(/^[^>]*>/, ""), /\S/, "and shows only its icon");
  assert.equal(source.includes("st-view-pill"), false, "no row of view pills");
  // The dropdown lists the views, adds one from a preset or blank, and replays the tour.
  for (const hook of ['data-st="view-pick"', 'data-st="views-menu"', "data-view=", "data-preset=", 'data-st="add-view"', 'data-st="tour"']) assert.ok(source.includes(hook), `${hook} is drawn`);
  assert.match(source, new RegExp(`STATS_TOUR = '${TOUR.replace(".", "\\.")}'`));
});

test("the Stats tour is valid library data on the tab's own hooks, and replays from the tab's questions", async () => {
  const service = await import("../guided-experiences/service.js"), { experience, tabFaqs } = await import("../guided-experiences/registry.js"), { experienceSchema } = await import("../guided-experiences/contracts.js");
  service.ensureGuidedDefinitions();
  const tour = experience(TOUR)!;
  assert.ok(tour, `${TOUR} is registered`);
  assert.equal(experienceSchema.safeParse(tour).success, true);
  assert.deepEqual([tour.kind, tour.scope, tour.replayable, tour.tab], ["overlay", "person", true, TAB]);
  assert.deepEqual(tour.eligibility.capabilities, ["apps.stats"]);
  assert.deepEqual(tour.triggers.map((trigger: any) => [trigger.kind, trigger.tab, trigger.once]), [["tab_opened", TAB, true]]);
  const steps = tour.steps as any[];
  assert.deepEqual(steps.map((step) => step.id), ["intro", "views", "period", "assistant", "outro"]);
  assert.deepEqual(steps[0].targets, []);
  for (const step of steps) {
    for (const field of ["title", "body"]) {
      assert.match(step[field].key, /^gx_st_[a-z0-9_]+$/, `${step.id} ${field} uses a gx_ key`);
      assert.ok(step[field].text.length <= 160, `${step.id} ${field} is short`);
    }
    // Targets are data-st hooks the app draws on a computer and a phone alike.
    for (const selector of step.targets) {
      const hook = /^\[data-st="([\w-]+)"\]$/.exec(selector)?.[1];
      assert.ok(hook, `${step.id}: ${selector} is a data-st hook`);
      assert.ok(source.includes(`data-st="${hook}"`), `${step.id}: ${selector} is drawn by stats/app.js`);
    }
  }
  assert.match(steps.find((step) => step.id === "views").body.text, /preset/);
  assert.match(steps.find((step) => step.id === "assistant").body.text, /assistant/i);
  assert.match(steps.at(-1).body.text, /Show me around Stats/, "the outro names the dropdown's replay");
  assert.ok(source.includes("Show me around Stats"));
  assert.ok(tabFaqs(TAB)!.questions.some((question) => question.action === "play" && question.experience === TOUR));
});

test("a fresh organization's people get the Stats tour where Stats is on, and not where it is off", async () => {
  const s = await import("../platform/storage.js");
  await s.createOrganization({ id: ORG, name: "Stats tour" });
  await enableExpandedPlatformFixture(ORG, { "apps.stats": true });
  const service = await import("../guided-experiences/service.js");
  const listed = await service.availableExperiences(person("fresh", null), { tab: TAB });
  const tour = listed.experiences.find((item) => item.id === TOUR);
  assert.ok(tour, "offered on a fresh organization");
  assert.equal(tour!.progress, null);
  const off = await service.availableExperiences(person("off", { "apps.stats": false }), { tab: TAB });
  assert.equal(off.experiences.some((item) => item.id === TOUR), false, "not offered without apps.stats");
});
