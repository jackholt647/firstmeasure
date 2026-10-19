import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Lead routing and scoring (docs/architecture/crm.md, "Lead routing and scoring"): settings generate
// organization rules whose action is a sandbox program; the program selects from the published CRM leads
// and writes through crm.leads.update.

let app: any = null;
let storageRoot = "";
function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}
function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => await (app.inject as any)({
    method, url, payload, headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) { cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; "); csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf); }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}
before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crm-routing-test-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error; }
});

test("routing assigns new leads by rotation, capacity and rules; scoring adds points; untouched leads are passed on", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner User", company: "Routing Test Co", organization_id: `org_route_${suffix}` });
  const orgId = registered.organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const reps: string[] = [];
  for (const name of ["Rep Ada", "Rep Bo", "Rep Cy"]) {
    const created = await client.request("POST", `/v1/platform/organizations/${orgId}/users`, { data: { name, email: `${name.replace(/\W/g, "").toLowerCase()}-${suffix}@example.test`, password: "test-only-member-pass", send_invite: false, status: "active" } });
    reps.push(created.document.id);
  }
  const [ada, bo, cy] = reps as [string, string, string];
  const base = `/v1/crm/organizations/${orgId}`;
  const { receiveLead } = await import("../leads/receive.js");
  const { drainWorkEvents } = await import("../work/engine.js");
  const { readDocument } = await import("../platform/storage.js");
  const ownerOf = async (projectId: string) => {
    const data = (await readDocument(orgId, "projects", projectId)).data as any;
    return data.custom_field_values?.crm?.owner?.subject_id || "";
  };
  const lead = async (projectId: string, source: { kind: string } & Record<string, unknown> = { kind: "missed_call" }) => {
    await receiveLead(orgId, { project_id: projectId, source, address: `${projectId} St`, contacts: [{ name: `Buyer ${projectId}`, phone: nextTestPhone() }] });
    await drainWorkEvents();
  };

  // Rotation between Ada and Bo, with no more than two open leads each; Cy is the fallback.
  const saved = await client.request("PUT", `${base}/routing`, { routing: { enabled: true, method: "rotation", user_ids: [ada, bo], max_open_leads: 2, fallback_user_ids: [cy] } });
  assert.equal(saved.routing.routing.method, "rotation");
  const rules = (await client.request("GET", `/v1/work/organizations/${orgId}/branches/default/automation-rules`)).rules;
  assert.ok(rules.some((r: any) => r.id === "crm_routing_assign" && r.automation === "scope.code.run.v1"), "the settings became an organization rule running a program");
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) await lead(id);
  assert.deepEqual([await ownerOf("r1"), await ownerOf("r2"), await ownerOf("r3"), await ownerOf("r4"), await ownerOf("r5")], [ada, bo, ada, bo, cy], "turns alternate, a full person is skipped, the fallback takes the rest");

  // Rules: a referral goes to Cy; anything else rotates between Ada and Bo (no capacity limit now).
  await client.request("PUT", `${base}/routing`, { routing: { enabled: true, method: "rules", user_ids: [ada, bo], rules: [{ id: "referrals", label: "Referrals", conditions: { match: "all", rules: [{ field: "source_kind", operator: "equals", value: "referral" }] }, user_ids: [cy] }] } });
  await lead("r6", { kind: "referral" });
  assert.equal(await ownerOf("r6"), cy, "the first matching rule picks the people");

  // Scoring: referrals +20, missed calls -5.
  await client.request("PUT", `${base}/routing`, { routing: { enabled: false }, scoring: { enabled: true, rules: [
    { id: "referral", label: "Referral", conditions: { match: "all", rules: [{ field: "source_kind", operator: "equals", value: "referral" }] }, points: 20 },
    { id: "missed", label: "Missed call", conditions: { match: "all", rules: [{ field: "source_kind", operator: "equals", value: "missed_call" }] }, points: -5 }
  ] } });
  await lead("s1", { kind: "referral" });
  await lead("s2", { kind: "missed_call" });
  const score = async (projectId: string) => ((await readDocument(orgId, "projects", projectId)).data as any).custom_field_values?.crm?.score;
  assert.deepEqual([await score("s1"), await score("s2")], [20, -5]);
  const rows = (await client.request("POST", `${base}/query`, { collection: "opportunities", definition: { filter: { match: "all", rules: [{ field: "cf.crm.score", operator: "greater_or_equal", value: 10 }] } } })).rows;
  assert.deepEqual(rows.map((r: any) => r.id), ["s1"], "the score is a field views filter on");

  // Reassignment: a lead nobody touched 30 minutes after it was routed goes to the next person.
  await client.request("PUT", `${base}/routing`, { routing: { enabled: true, method: "rotation", user_ids: [ada, bo], reassign_after_minutes: 30 } });
  await lead("t1");
  const first = await ownerOf("t1");
  const { updateProjectData } = await import("../platform/project_document_mutation.js");
  await updateProjectData(orgId, "t1", (data: any) => ({ ...data, custom_field_values: { ...data.custom_field_values, crm: { ...data.custom_field_values.crm, routed_at: new Date(Date.now() - 45 * 60_000).toISOString() } } }));
  // The schedule's own event, as the scheduler emits it every five minutes.
  const { emitWorkEvent } = await import("../work/engine.js");
  await emitWorkEvent({ organization_id: orgId, branch_id: "default", type: "time.cron", idempotency_key: `time.cron:test:${Date.now()}`, payload: { rule_id: "crm_routing_reassign", fired_at: new Date().toISOString(), cron: "*/5 * * * *" } });
  await drainWorkEvents();
  const second = await ownerOf("t1");
  assert.ok(first && second && second !== first, `passed on (${first} -> ${second})`);
});

test("a program in a rule must be the saved one and runs as whoever saved the rules", async () => {
  const { ROUTING_PROGRAM } = await import("../crm/routing.js");
  assert.ok(ROUTING_PROGRAM.includes("api.data.select"), "presets select from the data layer");
  const { normalizeRouting } = await import("../crm/routing.js");
  assert.throws(() => normalizeRouting({ routing: { enabled: true, user_ids: [] } }), /Choose the people/);
  assert.throws(() => normalizeRouting({ scoring: { enabled: true, rules: [{ id: "x", conditions: { match: "all", rules: [{ field: "a", operator: "nope", value: 1 }] }, points: 1 }] } }));
});
