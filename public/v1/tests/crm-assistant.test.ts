import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// The CRM in the shared assistant (FM-551, crm/assistant.ts): the crm_* tools read the
// collections the tab reads, compute statistics, change what the tab shows and save views
// marked as made by the assistant; the mark survives a person's later edits.

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crm-assistant-test-"));
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

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Owner User", company: "CRM Views Test Co", organization_id: `org_crm_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string, userId: data.user?.id as string };
}


test("The assistant reads, counts, shows and saves CRM views with its crm tools", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  await enableExpandedPlatformFixture(orgId, { "apps.assistant": true });
  const base = `/v1/crm/organizations/${orgId}`;
  const { receiveLead } = await import("../leads/receive.js");
  await receiveLead(orgId, { project_id: "ai_lead_a", source: { kind: "web_form" }, address: "1 Elm St", contacts: [{ name: "Ada Park", phone: "555-071-1000" }] });
  await receiveLead(orgId, { project_id: "ai_lead_b", source: { kind: "missed_call" }, contacts: [{ phone: "555-071-2000" }] });
  await receiveLead(orgId, { project_id: "ai_lead_c", source: { kind: "web_form" }, address: "3 Oak St", contacts: [{ name: "Cy Ray", phone: "555-071-3000" }] });

  const { crmTools, crmConversationContext } = await import("../crm/assistant.js");
  const { backgroundAuthContext } = await import("../platform/auth.js");
  const ctx = await backgroundAuthContext(orgId, userId);
  const tool = (name: string) => crmTools.find((entry) => entry.name === name)!;
  const newRun = (subject = "main"): any => ({ agentId: "assistant", orgId, branchId: "default", userId, ctx, subjectId: subject, input: {}, scratch: {}, settings: {}, actions: [], changeLog: [], renders: [], trace: [] });
  const run = newRun();

  const fields: any = await tool("crm_fields").execute(run, { collection: "opportunities" });
  assert.match(fields.guide, /condition contract/);
  const stateField = fields.fields.find((f: any) => f.key === "state");
  assert.ok(stateField.values.some((v: any) => v.value === "new_lead") && stateField.operators.includes("in"), "choice fields list their values and operators");

  const newLeads = JSON.stringify({ filter: { match: "all", rules: [{ field: "state", operator: "in", value: ["new_lead", "open"] }] }, sort: [{ key: "created_at", dir: "desc" }] });
  const rows: any = await tool("crm_rows").execute(run, { collection: "opportunities", definition: newLeads, fields: ["contact_name", "state", "source_kind"], limit: 2 });
  assert.equal(rows.total, 3);
  assert.equal(rows.rows.length, 2);
  assert.ok(rows.rows.every((row: any) => /^(New lead|Open) \(/.test(String(row.state))), "select values come back named");

  const stats: any = await tool("crm_stats").execute(run, { collection: "opportunities", measures: [{ op: "avg", field: "age_days" }, { op: "distinct", field: "contact_name" }], group_by: ["source_kind"] });
  assert.equal(stats.matching, 3);
  assert.equal(stats.overall.count, 3);
  const byKind = Object.fromEntries(stats.groups.map((g: any) => [g.source_kind, g.count]));
  assert.equal(byKind["web form"] ?? byKind.web_form, 2);
  assert.equal(stats.groups[0].count, 2, "groups come largest first");
  const byMonth: any = await tool("crm_stats").execute(run, { collection: "opportunities", filter: JSON.stringify({ match: "all", rules: [{ field: "created_at", operator: "after", value: "now-30d" }] }), group_by: ["created_at"], bucket: "month" });
  assert.equal(byMonth.groups.length, 1);
  assert.equal(byMonth.groups[0].count, 3);
  const unknown: any = await tool("crm_stats").execute(run, { collection: "opportunities", group_by: ["nope"] });
  assert.equal(unknown.ok, false);

  // crm_show changes the CRM tab only from its own conversation, and checks the definition first.
  assert.equal((await tool("crm_show").execute(run, { collection: "opportunities", definition: newLeads }) as any).ok, false);
  const inCrm = newRun("crm");
  const bad: any = await tool("crm_show").execute(inCrm, { collection: "opportunities", definition: JSON.stringify({ filter: { match: "all", rules: [{ field: "made_up", operator: "equals", value: "x" }] } }) });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join(" "), /made_up/);
  assert.equal(inCrm.renders.length, 0);
  const shown: any = await tool("crm_show").execute(inCrm, { collection: "opportunities", definition: JSON.stringify({ filter: { match: "all", rules: [{ field: "source_kind", operator: "in", value: ["web_form"] }] }, layout: "board" }) });
  assert.equal(shown.ok, true);
  assert.equal(shown.matching, 2);
  assert.equal(inCrm.renders[0].type, "crm_view");
  assert.equal(inCrm.renders[0].definition.group_by, "stage_id", "a board gets the collection's grouping");

  // A saved view is the person's own, private and pinned, and marked as made by the assistant.
  const saved: any = await tool("crm_save_view").execute(inCrm, { name: "Web form leads", collection: "opportunities", definition: JSON.stringify({ filter: { match: "all", rules: [{ field: "source_kind", operator: "in", value: ["web_form"] }] } }) });
  assert.equal(saved.ok, true);
  assert.equal(saved.matching, 2);
  assert.deepEqual(inCrm.renders.map((r: any) => r.type), ["crm_view"]);
  assert.equal(inCrm.renders[0].view_id, saved.view_id);
  let views = (await client.request("GET", `${base}/views`)).views;
  let view = views.find((v: any) => v.id === saved.view_id);
  assert.equal(view.definition.origin, "ai");
  assert.equal(view.visibility, "private");
  assert.equal(view.pinned, true);
  // The person edits it in the tab, which sends no origin: it stays marked.
  await client.request("PUT", `${base}/views/${saved.view_id}`, { name: "Web leads", collection: "opportunities", definition: { filter: view.definition.filter, sort: [{ key: "created_at", dir: "asc" }], group_by: "", layout: "list", columns: [] }, expected_revision: view.revision });
  views = (await client.request("GET", `${base}/views`)).views;
  view = views.find((v: any) => v.id === saved.view_id);
  assert.equal(view.name, "Web leads");
  assert.equal(view.definition.origin, "ai");
  // A view a person makes is not marked.
  const own = await client.request("POST", `${base}/views`, { name: "Mine", collection: "contacts", definition: {} });
  assert.equal(own.view.definition.origin, "");
  const listed: any = await tool("crm_views").execute(run, {});
  assert.equal(listed.views.find((v: any) => v.view_id === saved.view_id).ai_generated, true);
  assert.equal(listed.views.find((v: any) => v.view_id === own.view.id).ai_generated, false);

  // The magic button's conversation: one per person, with the CRM context.
  const first = await client.request("POST", `${base}/assistant/conversation`, {});
  const again = await client.request("POST", `${base}/assistant/conversation`, {});
  assert.equal(first.thread.subject_id, "crm");
  assert.equal(first.thread.id, again.thread.id);
  assert.match(await crmConversationContext(ctx, "crm"), /CRM tab/);
  assert.equal(await crmConversationContext(ctx, "main"), "");
});
