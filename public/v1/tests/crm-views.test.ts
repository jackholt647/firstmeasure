import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// The CRM app's server (docs/architecture/crm.md): collections built from the records,
// saved views with sharing and pins, the query, results, sources with spend, and the
// funnel read from history.

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crm-views-test-"));
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

test("CRM collections, saved views, the query, results, sources and the funnel", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const base = `/v1/crm/organizations/${orgId}`;
  const { receiveLead } = await import("../leads/receive.js");
  const { drainWorkEvents } = await import("../work/engine.js");

  // A source catalog: a paid search source with a campaign that matches the form's UTM source.
  await client.request("PUT", `${base}/sources`, { sources: [
    { id: "paid", label: "Paid", channel: "paid" },
    { id: "google", label: "Google", parent_id: "paid", channel: "paid", rules: { match: "all", rules: [{ field: "lead_source.utm_source", operator: "equals", value: "google" }] } },
    { id: "calls", label: "Phone calls", channel: "phone", rules: { match: "all", rules: [{ field: "lead_source.kind", operator: "equals", value: "missed_call" }] } }
  ] });
  await receiveLead(orgId, { project_id: "crm_lead_a", source: { kind: "web_form", utm_source: "google" }, address: "1 Elm St", contacts: [{ name: "Ada Park", phone: "555-070-1000", email: "ada@example.test" }] });
  await receiveLead(orgId, { project_id: "crm_lead_b", source: { kind: "missed_call" }, contacts: [{ phone: "555-070-2000" }] });
  await receiveLead(orgId, { project_id: "crm_lead_c", source: { kind: "web_form" }, address: "3 Oak St", contacts: [{ name: "Cy Ray", email: "cy@example.test" }] });
  await drainWorkEvents();

  const meta = await client.request("GET", `${base}/meta`);
  assert.deepEqual(meta.collections.map((c: any) => c.id), ["opportunities", "contacts", "follow_ups", "appointments"]);
  assert.ok(meta.outcomes.some((o: any) => o.action === "lost"));

  // Opportunities: every lead with its stamped source, state and contact.
  const all = await client.request("POST", `${base}/query`, { collection: "opportunities", definition: { sort: [{ key: "created_at", dir: "asc" }] } });
  const rows = Object.fromEntries(all.rows.map((r: any) => [r.id, r]));
  assert.deepEqual([rows.crm_lead_a.source_id, rows.crm_lead_b.source_id, rows.crm_lead_c.source_id], ["google", "calls", ""]);
  assert.deepEqual([rows.crm_lead_a.state, rows.crm_lead_b.state, rows.crm_lead_b.new_lead], ["open", "new_lead", true], "routing leaves missed calls unscoped");
  assert.equal(rows.crm_lead_a.contact_name, "Ada Park");
  assert.ok(all.fields.some((f: any) => f.key === "milestone.lead"), "funnel milestones are fields");
  assert.ok(rows.crm_lead_a["milestone.lead"], "lead received is the lead milestone");

  // Filters in the one condition contract, grouping with counts, search.
  const newLeads = await client.request("POST", `${base}/query`, { collection: "opportunities", definition: { filter: { match: "all", rules: [{ field: "new_lead", operator: "equals", value: "true" }] } } });
  assert.deepEqual(newLeads.rows.map((r: any) => r.id), ["crm_lead_b"]);
  const grouped = await client.request("POST", `${base}/query`, { collection: "opportunities", definition: { group_by: "state" } });
  assert.deepEqual(Object.fromEntries(grouped.groups.filter((g: any) => g.count).map((g: any) => [g.value, g.count])), { new_lead: 1, open: 2 });
  assert.deepEqual((await client.request("POST", `${base}/query`, { collection: "opportunities", search: "oak" })).rows.map((r: any) => r.id), ["crm_lead_c"]);
  const invalid = await client.raw("POST", `${base}/query`, { collection: "opportunities", definition: { filter: { match: "all", rules: [{ field: "state", operator: "no_such_operator", value: "x" }] } } });
  assert.equal(invalid.statusCode, 400);

  // Contacts with what their projects say.
  const contacts = await client.request("POST", `${base}/query`, { collection: "contacts", definition: { filter: { match: "all", rules: [{ field: "lead", operator: "equals", value: "true" }] } } });
  assert.equal(contacts.total, 3);
  assert.ok(contacts.rows.every((c: any) => c.state === "lead" || c.state === "new_lead"));

  // Saved views: private by default, pinned for the owner, $me resolved per viewer.
  const created = await client.request("POST", `${base}/views`, { name: "My follow-ups", collection: "follow_ups", definition: { filter: { match: "all", rules: [{ field: "assigned_user_ids", operator: "contains", value: "$me" }] }, sort: [{ key: "due_at", dir: "asc" }] } });
  assert.deepEqual([created.view.visibility, created.view.owner_user_id], ["private", userId]);
  let views = (await client.request("GET", `${base}/views`)).views;
  assert.deepEqual(views.filter((v: any) => v.pinned).map((v: any) => v.name).sort(), ["Follow-ups due", "My follow-ups", "New leads", "Pipeline", "Upcoming appointments"], "the base views install themselves; pinned ones show for everyone");
  assert.ok(views.some((v: any) => v.name === "Referral partners" && !v.pinned));
  await client.request("PUT", `${base}/views/${created.view.id}/preference`, { pinned: false });
  views = (await client.request("GET", `${base}/views`)).views;
  assert.equal(views.find((v: any) => v.id === created.view.id).pinned, false);
  for (const view of views) await client.request("POST", `${base}/query`, { view_id: view.id });
  const shared = await client.request("POST", `${base}/views`, { name: "New leads", collection: "opportunities", visibility: "everyone", definition: { filter: { match: "all", rules: [{ field: "new_lead", operator: "equals", value: "true" }] } } });
  assert.equal(shared.view.visibility, "everyone", "an owner who manages company settings can share");

  // A result: "follow up again" on a lead creates a follow-up for the person who recorded it; it shows in their view.
  const followUp = meta.outcomes.find((o: any) => o.action === "reschedule");
  const recorded = await client.request("POST", `${base}/results`, { project_id: "crm_lead_c", disposition: "no_answer", outcome_id: followUp.id, note: "Left a message" });
  assert.equal(recorded.result.path, "follow_up_created");
  const mine = await client.request("POST", `${base}/query`, { view_id: created.view.id });
  assert.deepEqual(mine.rows.map((r: any) => r.project_id), ["crm_lead_c"]);
  assert.equal((await client.request("GET", `${base}/projects/crm_lead_c/results`)).results[0].note, "Left a message");
  const touched = (await client.request("POST", `${base}/query`, { collection: "opportunities", search: "oak" })).rows[0];
  assert.ok(touched.last_touch_at && touched.next_follow_up_at, "last touch and next follow-up come from results and to-dos");

  // A "lost" result loses the lead with the outcome as the reason.
  const lost = meta.outcomes.find((o: any) => o.action === "lost");
  await client.request("POST", `${base}/results`, { project_id: "crm_lead_b", disposition: "answered", outcome_id: lost.id });
  const afterLost = (await client.request("POST", `${base}/query`, { collection: "opportunities", definition: { filter: { match: "all", rules: [{ field: "state", operator: "equals", value: "lost" }] } } })).rows;
  assert.deepEqual(afterLost.map((r: any) => r.id), ["crm_lead_b"]);

  // Spend and the funnel report: a cohort by lead date, grouped by source, with cost per lead.
  const today = new Date().toISOString().slice(0, 10);
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": true, "crm.source_spend": true });
  await client.request("PUT", `${base}/spend/new`, { source_id: "google", period_start: today, period_end: today, amount_cents: 30000 });
  const report = await client.request("GET", `${base}/funnel/report?from=${today}&to=${today}&group=source`);
  const google = report.groups.find((g: any) => g.key === "google");
  assert.deepEqual([google.milestones[0].count, google.spend_cents, google.milestones[0].cost_cents], [1, 30000, 30000]);
  assert.equal(report.totals.milestones[0].count, 3);
  assert.deepEqual(google.milestones[0].project_ids, ["crm_lead_a"], "a report cell names its leads");
});

test("industry presets, tracking tags and the cancellation window", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const base = `/v1/crm/organizations/${orgId}`;
  const { receiveLead } = await import("../leads/receive.js");
  const { drainWorkEvents } = await import("../work/engine.js");
  const { listNodeRecords, listPlanRecords, updateNodeRecord } = await import("../work/storage.js");
  const { transitionWorkNode } = await import("../work/service.js");
  const { readDocument } = await import("../platform/storage.js");

  // A roofing company of 30: sources, a funnel, cancellation rules, the insurance scope and features for its size.
  const presets = await client.request("GET", `${base}/presets?employees=30`);
  assert.ok(presets.packs.some((p: any) => p.id === "roofing"));
  assert.equal(presets.tier.tier, "mid");
  const roofing = (await client.request("POST", `${base}/presets/apply`, { industry: "roofing", employees: 30, capabilities: true })).applied;
  assert.ok(roofing.sources > 5 && roofing.funnel && roofing.rescission);
  assert.deepEqual(roofing.scopes, ["insurance_roof_sale"]);
  assert.equal(roofing.capabilities["crm.source_spend"], true);
  const again = (await client.request("POST", `${base}/presets/apply`, { industry: "roofing", employees: 30 })).applied;
  assert.deepEqual([again.views, again.sources, again.funnel, again.rescission, again.scopes], [0, 0, false, false, []], "applying again adds nothing");
  // A second pack only adds what is missing: its scope and views, not another catalog or funnel.
  const inHome = (await client.request("POST", `${base}/presets/apply`, { industry: "in_home" })).applied;
  assert.deepEqual([inHome.sources, inHome.funnel, inHome.scopes], [0, false, ["in_home_sale"]]);
  const views = (await client.request("GET", `${base}/views`)).views;
  assert.ok(views.some((v: any) => v.name === "Open claims") && views.some((v: any) => v.name === "In the cancellation window"));
  for (const view of views) await client.request("POST", `${base}/query`, { view_id: view.id });
  const fields = (await client.request("POST", `${base}/query`, { collection: "opportunities" })).fields;
  assert.ok(fields.some((f: any) => f.key === "cf.claim.status" && f.options?.some((o: any) => o.value === "approved")), "scope fields are filterable before any project has them");
  assert.ok((await client.request("GET", `${base}/funnel`)).funnel.milestones.some((m: any) => m.id === "net"));

  // A form lead from an ad: the page's tracking tags are kept and pick the most specific source.
  await receiveLead(orgId, { project_id: "crm_ad_lead", source: { kind: "web_form", page_url: "https://roof.example.test/quote?utm_source=google&utm_campaign=spring&gclid=abc123" }, address: "9 Pine St", contacts: [{ name: "Ida Moss", phone: "555-070-3000" }] });
  const tagged = (await readDocument(orgId, "projects", "crm_ad_lead")).data as any;
  assert.deepEqual([tagged.lead_source.utm_source, tagged.lead_source.utm_campaign, tagged.lead_source.gclid, tagged.lead_source.source_id], ["google", "spring", "abc123", "google_ads"]);

  // Selling through the in-home scope: the sale is won at signing and waits out the window before production.
  async function sellToWindow(projectId: string) {
    // A missed call is left unscoped by routing, so this scope is the only one on the lead.
    await receiveLead(orgId, { project_id: projectId, source: { kind: "missed_call" }, address: `${projectId} Rd`, contacts: [{ name: `Buyer ${projectId}`, phone: "555-070-4000" }] });
    await client.request("POST", `/v1/scopes/organizations/${orgId}/projects/${projectId}/scopes`, { template_id: "in_home_sale" });
    await drainWorkEvents();
    for (let round = 0; round < 30; round++) {
      const nodes = await listNodeRecords(orgId, { project_id: projectId });
      const window = nodes.find((n: any) => n.template_node_id === "rescission_window");
      if (window && !["pending", "blocked"].includes(String(window.status))) { await drainWorkEvents(); return window; }
      const next = nodes.filter((n: any) => String(n.terminology_key).endsWith("task") && n.template_node_id !== "rescission_window" && ["ready", "active"].includes(String(n.status)));
      assert.ok(next.length, `the scope moves on (round ${round})`);
      for (const node of next) await transitionWorkNode(orgId, String(node.id), "completed", { reason: "test" });
      await drainWorkEvents();
    }
    throw new Error("The cancellation window never opened.");
  }
  const sold = await sellToWindow("crm_sale_cancelled");
  const windowNode = (await listNodeRecords(orgId, { project_id: "crm_sale_cancelled" })).find((n: any) => n.id === sold.id) as any;
  assert.ok(windowNode.due_at && windowNode.metadata.rescission.rule_id === "federal_cooling_off", "the end of the window comes from the federal rule");
  const plan = (await listPlanRecords(orgId, { project_id: "crm_sale_cancelled", sales: true }))[0] as any;
  assert.equal(plan.outcome, "won");
  let row = (await client.request("POST", `${base}/query`, { collection: "opportunities", search: "crm_sale_cancelled" })).rows.find((r: any) => r.id === "crm_sale_cancelled");
  assert.equal(row.rescission_until, windowNode.due_at);
  await client.request("POST", `${base}/projects/crm_sale_cancelled/cancel-sale`, { reason: "Changed their mind" });
  await drainWorkEvents();
  assert.equal((await listPlanRecords(orgId, { project_id: "crm_sale_cancelled", sales: true }))[0]!.outcome, "lost");
  assert.equal((await listNodeRecords(orgId, { project_id: "crm_sale_cancelled" })).find((n: any) => n.id === sold.id)!.status, "canceled");
  const closed = await client.raw("POST", `${base}/projects/crm_sale_cancelled/cancel-sale`, {});
  assert.equal(closed.statusCode, 409, "a sale without an open window cannot be cancelled this way");

  // The window ends on its own: the step completes and the net sale milestone is reached.
  const stands = await sellToWindow("crm_sale_stands");
  await updateNodeRecord(orgId, String(stands.id), { due_at: new Date(Date.now() - 60_000).toISOString() });
  const { runWorkSchedulerTick } = await import("../work/scheduler.js");
  await runWorkSchedulerTick();
  await drainWorkEvents();
  assert.equal((await listNodeRecords(orgId, { project_id: "crm_sale_stands" })).find((n: any) => n.id === stands.id)!.status, "completed");
  row = (await client.request("POST", `${base}/query`, { collection: "opportunities", search: "crm_sale_stands" })).rows.find((r: any) => r.id === "crm_sale_stands");
  assert.ok(row["milestone.net"], "the net sale milestone is the window ending");
});
