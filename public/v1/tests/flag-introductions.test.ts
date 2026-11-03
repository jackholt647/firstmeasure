import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { closePlatformFixtureStores, nextTestPhone } from "./helpers/platform-fixture.js";
import { TEST_LIBRARY_AUTHOR, useLibraryStore } from "./helpers/config-library.js";

// Turning a flag on for an existing organization with an announcement (docs/architecture/feature-flags.md, "Introducing
// a flag"): the state, who gets it and who never does, one finish for the organization, and the billboard's copy.

let app: any = null;
let storageRoot = "";
const FLAG = "firstmeasure.exteriors";
const ID = "exteriors.introduction";
const t = (key: string, text: string) => ({ key, text });
const ANNOUNCEMENT = {
  id: ID, version: 1, kind: "announcement", scope: "organization", salt: "2026-11", title: t("gx_ext_intro_title", "Exteriors are here"), introduces: FLAG,
  eligibility: { capabilities: [FLAG], permissions: ["order_reports"] }, triggers: [{ kind: "app_loaded" }], variants: [{ id: "default", weight: 1 }],
  steps: [{ id: "billboard", widget: "billboard", title: t("gx_ext_intro_title", "Exteriors are here"), required: false, options: { billboard: "exteriors_popup", workflow: "report", order_scope: "full_house" } }],
  completion: { screen: "none" }
};
type Caller = { email: string; cookie: string; csrf: string; orgId: string };

async function register(label: string): Promise<Caller> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${suffix}@example.test`, orgId = `org_${label}_${suffix}`;
  const created = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: { phone: nextTestPhone(), email, password: "correct horse battery staple", name: label, company: `${label} ${suffix} Co`, organization_id: orgId } });
  assert.equal(created.statusCode, 201, created.body);
  const cookie = String(created.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
  const session = await app.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  return { email, cookie, csrf: String(session.json().csrf_token || ""), orgId };
}
const SYSTEM = { kind: "system" as const, label: "test", can_write: true };
const console_ = () => import("../platform/flag-console.js");
const list = async (who: Caller) => {
  const response = await app.inject({ method: "GET", url: `/v1/guided-experiences/organizations/${who.orgId}/experiences`, headers: { cookie: who.cookie } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().experiences as Array<{ id: string; kind: string; triggers: Array<{ kind: string }> }>;
};
const offered = async (who: Caller) => (await list(who)).some((entry) => entry.id === ID);
const event = (who: Caller, type: string) => app.inject({ method: "POST", url: `/v1/guided-experiences/organizations/${who.orgId}/experiences/${ID}/events`, payload: { type, step_id: "billboard" }, headers: { cookie: who.cookie, origin: "https://app.example.test", "x-platform-csrf": who.csrf } });
const stateOf = async (orgId: string) => (await (await console_()).readOrganizationFlags(orgId)).flags.find((flag: { key: string }) => flag.key === FLAG)!;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-flag-introductions-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    PUBLIC_BASE_URL: "https://app.example.test", CORS_ALLOWED_ORIGINS: "https://app.example.test",
    EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  useLibraryStore();
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  const { saveLibraryEntry } = await import("../platform/capability-library.js");
  await saveLibraryEntry("guided_experience", ID, ANNOUNCEMENT, TEST_LIBRARY_AUTHOR);
});

after(async () => {
  if (app) await app.close();
  await (await console_()).closeFlagConsoleStore();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (!["EBUSY", "EPERM"].includes(error?.code)) throw error; }
});

test("turned on to be introduced: announced once for the whole organization, on stays on", async () => {
  const org = await register("intro");
  const { setFlagForOrganizations } = await console_();
  assert.equal(await offered(org), false, "not on yet");
  const result = await setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [org.orgId] }, SYSTEM);
  assert.equal(result.to_introduce, 1);
  assert.equal((await stateOf(org.orgId)).introduction_state, "waiting");
  const [entry] = (await list(org)).filter((row) => row.id === ID);
  assert.equal(entry?.kind, "announcement");
  assert.deepEqual(entry?.triggers.map((trigger) => trigger.kind), ["app_loaded"]);
  // Shown without being finished (a reload, the billboard not yet published) stays to play.
  assert.equal((await event(org, "exposure")).statusCode, 200);
  assert.equal(await offered(org), true);
  assert.equal((await event(org, "dismiss")).statusCode, 200);
  assert.equal(await offered(org), false);
  assert.equal((await stateOf(org.orgId)).introduction_state, "introduced");
  assert.equal((await stateOf(org.orgId)).effective, true);
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  assert.equal(await isCapabilityEnabled(org.orgId, FLAG), true);
});

test("Try It Now finishes it the same way", async () => {
  const org = await register("tryit");
  await (await console_()).setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [org.orgId] }, SYSTEM);
  assert.equal((await event(org, "complete")).statusCode, 200);
  assert.equal(await offered(org), false);
});

test("an organization that already had it, or got it some other way, never sees it", async () => {
  const { setFlagForOrganizations } = await console_();
  const plain = await register("plain");
  await setFlagForOrganizations({ flag: FLAG, value: true, org_ids: [plain.orgId] }, SYSTEM);
  assert.equal(await offered(plain), false, "plain On");

  // Started on: what signup and a sandbox configuration write.
  const started = await register("started");
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(started.orgId, { [FLAG]: true });
  assert.equal(await offered(started), false, "stored on from signup");
  const bulk = await setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [started.orgId] }, SYSTEM);
  assert.equal(bulk.to_introduce, 0);
  assert.equal(bulk.already_on, 1);
  assert.equal(await offered(started), false, "a list that includes it announces nothing to it");
});

test("a preview shows it as the first time, records nothing, and still needs the flag", async () => {
  const { setFlagForOrganizations } = await console_();
  const preview = (who: Caller) => app.inject({ method: "GET", url: `/v1/guided-experiences/organizations/${who.orgId}/experiences/${ID}/preview`, headers: { cookie: who.cookie } });
  const off = await register("previewoff");
  assert.equal((await preview(off)).statusCode, 403, "without the flag there is nothing to preview");

  // Plain On is never announced, but can be previewed.
  const plain = await register("previewplain");
  await setFlagForOrganizations({ flag: FLAG, value: true, org_ids: [plain.orgId] }, SYSTEM);
  const shown = await preview(plain);
  assert.equal(shown.statusCode, 200, shown.body);
  assert.equal(shown.json().experience.kind, "announcement");
  assert.equal(shown.json().experience.progress, null);
  assert.equal(shown.json().experience.steps[0].options.billboard, "exteriors_popup");
  assert.equal(await offered(plain), false, "previewing does not announce it");

  // Already finished: the preview still shows it fresh, and the organization stays introduced.
  const done = await register("previewdone");
  await setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [done.orgId] }, SYSTEM);
  await event(done, "dismiss");
  assert.equal((await preview(done)).json().experience.progress, null);
  assert.equal(await offered(done), false);
  assert.equal((await stateOf(done.orgId)).introduction_state, "introduced");
});

test("changing your mind: plain On, Off or Auto clear it, and introduce needs On", async () => {
  const org = await register("mind");
  const { setFlagForOrganizations } = await console_();
  await setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [org.orgId] }, SYSTEM);
  await setFlagForOrganizations({ flag: FLAG, value: true, org_ids: [org.orgId] }, SYSTEM);
  assert.equal(await offered(org), false);
  await setFlagForOrganizations({ flag: FLAG, value: null, org_ids: [org.orgId] }, SYSTEM);
  await setFlagForOrganizations({ flag: FLAG, value: true, introduce: true, org_ids: [org.orgId] }, SYSTEM);
  assert.equal(await offered(org), true);
  await setFlagForOrganizations({ flag: FLAG, value: false, org_ids: [org.orgId] }, SYSTEM);
  assert.equal(await offered(org), false);
  await assert.rejects(() => setFlagForOrganizations({ flag: FLAG, value: false, introduce: true, org_ids: [org.orgId] }, SYSTEM), /Only turning a flag on/);
  await assert.rejects(() => setFlagForOrganizations({ flag: "platform.materials", value: true, introduce: true, org_ids: [org.orgId] }, SYSTEM), /no announcement/);
});

test("a percentage introduces only organizations that existed when it covered them", async () => {
  const { nextRolloutSteps, firstRolloutStepCovering, percentCovers, readFlagRollouts } = await import("../platform/flag-rollouts.js");
  const { setFlagRollout } = await console_();
  const { introductionRequested } = await import("../platform/flag-introductions.js");
  // Each step keeps its own decision; a lower percentage adds no step.
  let steps = nextRolloutSteps(null, 10, false, "2026-11-01T00:00:00.000Z");
  steps = nextRolloutSteps({ percent: 10, killed: false, steps }, 20, true, "2026-11-02T00:00:00.000Z");
  steps = nextRolloutSteps({ percent: 20, killed: false, steps }, 5, true, "2026-11-03T00:00:00.000Z");
  assert.deepEqual(steps.map((step) => [step.percent, step.introduce]), [[10, false], [20, true]]);
  assert.deepEqual(nextRolloutSteps({ percent: 7, killed: false, updated_at: "2026-10-01T00:00:00.000Z" }, 9, true, "2026-11-01T00:00:00.000Z").map((step) => step.percent), [7, 9]);

  await setFlagRollout(FLAG, { percent: 100, introduce: true }, SYSTEM);
  await readFlagRollouts(true);
  const rollout = (await readFlagRollouts())[FLAG]!;
  const orgId = "org_any";
  assert.equal(percentCovers(100, FLAG, orgId), true);
  const at = Date.parse(firstRolloutStepCovering(rollout, FLAG, orgId)!.at);
  const before_ = new Date(at - 86400000).toISOString(), after_ = new Date(at + 86400000).toISOString();
  assert.equal(await introductionRequested(orgId, FLAG, {}, before_), true, "existed: told");
  assert.equal(await introductionRequested(orgId, FLAG, {}, after_), false, "created later: started with it");
  assert.equal(await introductionRequested(orgId, FLAG, { app_flags: { firstmeasure: { exteriors: true } } }, before_), false, "stored on already");
  await setFlagRollout(FLAG, { percent: 0 }, SYSTEM);
  await readFlagRollouts(true);
});

test("customers cannot set the state", async () => {
  const { containsAppFlagMutation } = await import("../platform/app_flags.js");
  assert.equal(containsAppFlagMutation({ data: { flag_introductions: {} } }), true);
});

test("an announcement is one step that runs nothing", async () => {
  const { experienceSchema } = await import("../guided-experiences/contracts.js");
  assert.equal(experienceSchema.safeParse(ANNOUNCEMENT).success, true);
  assert.equal(experienceSchema.safeParse({ ...ANNOUNCEMENT, steps: [...ANNOUNCEMENT.steps, { ...ANNOUNCEMENT.steps[0], id: "second" }] }).success, false);
});

test("the billboard is served sandboxed with the watcher added; unpublished is a 404 outside development", async () => {
  const { BILLBOARD_CSP, EXTERIORS_POPUP_TRY_BUTTON_ID, clearBillboardCache, prepareBillboard } = await import("../guided-experiences/billboards.js");
  const prepared = prepareBillboard('<html lang="en"><HEAD class="a"><title>x</title></HEAD><body></body></html>', { url: "https://1m8.ai/billboards/exteriors_popup/", actionElementId: EXTERIORS_POPUP_TRY_BUTTON_ID });
  assert.match(prepared, /<HEAD class="a"><base href="https:\/\/1m8\.ai\/billboards\/exteriors_popup\/"><script>/);
  assert.ok(prepared.includes(JSON.stringify(EXTERIORS_POPUP_TRY_BUTTON_ID)));
  assert.match(BILLBOARD_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(BILLBOARD_CSP, /allow-same-origin/);

  const org = await register("board");
  const real = globalThis.fetch;
  const get = (id = "exteriors_popup", cookie = org.cookie) => app.inject({ method: "GET", url: `/v1/guided-experiences/billboards/${id}`, headers: cookie ? { cookie } : {} });
  try {
    let requested = "";
    globalThis.fetch = (async (url: string) => { requested = String(url); return new Response("<html><head></head><body>Ben</body></html>", { status: 200, headers: { "content-type": "text/html" } }); }) as typeof fetch;
    clearBillboardCache();
    const page = await get();
    assert.equal(page.statusCode, 200, page.body);
    assert.equal(requested, "https://1m8.ai/billboards/exteriors_popup/");
    assert.equal(page.headers["content-security-policy"], BILLBOARD_CSP);
    assert.match(page.body, /Ben/);
    assert.equal((await get("exteriors_popup", "")).statusCode, 401, "sign-in only");
    assert.equal((await get("anything_else")).statusCode, 404, "only listed pages are ever fetched");

    globalThis.fetch = (async () => new Response("Not Found", { status: 404, headers: { "content-type": "text/html" } })) as typeof fetch;
    clearBillboardCache();
    assert.equal((await get()).statusCode, 404);
  } finally { globalThis.fetch = real; clearBillboardCache(); }
});
