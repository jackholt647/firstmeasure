import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const data = response.body ? JSON.parse(response.body) : null;
    return { statusCode: response.statusCode, data, body: response.body };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-stats-test-"));
  process.env.NODE_ENV = "test";
  if (process.env.TEST_POSTGRES_URL) Object.assign(process.env, {
    FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL,
    DATABASE_ADMIN_URL: process.env.TEST_POSTGRES_URL, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false"
  });
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.STATS_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  process.env.OPENAI_API_KEY = "test-openai-key";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await (await import("../src/database/postgres.js")).closePostgresPools();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  const { closeWorkDatabase } = await import("../work/storage.js");
  (await closeWorkDatabase());
  const { closeStatsDatabase } = await import("../stats/storage.js");
  (await closeStatsDatabase());
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `stats-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Stats Owner",
    company: "Stats Test Org",
    organization_id: `org_stats_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function seedOrganization(orgId: string) {
  const { upsertDocument } = await import("../platform/storage.js");
  const { createPlanRecord, updatePlanRecord, createEventRecord } = await import("../work/storage.js");
  const now = new Date().toISOString();

  const project = (id: string, data: Record<string, unknown>) =>
    upsertDocument(orgId, "projects", { id, data: { title: id, ...data } });

  await project("proj_a", { source: "website", custom_fields: { roof_squares: 30 } });
  await project("proj_b", { source: "website", custom_fields: { roof_squares: 20 } });
  await project("proj_c", { source: "referral", assigned_user_id: "user_rep_1" });
  await project("proj_d", { source: "canvassing", lead_status: "lost" });
  await project("proj_e", { source: "referral" });
  await project("proj_f", { source: "website", branch_id: "north" });

  // proj_a: sold and completed production work.
  const planA = (await createPlanRecord({
    organization_id: orgId, project_id: "proj_a", title: "Roof Replacement", status: "active",
    metadata: { scope_template_kind: "production" }, template_id: "roof_replacement"
  }));
  (await updatePlanRecord(orgId, String(planA.plan?.id), { status: "completed", started_at: now, completed_at: now }));

  // proj_b: sold, still in production.
  const planB = (await createPlanRecord({
    organization_id: orgId, project_id: "proj_b", title: "Roof Replacement", status: "active",
    metadata: { scope_template_kind: "production" }, template_id: "roof_replacement"
  }));
  (await updatePlanRecord(orgId, String(planB.plan?.id), { status: "active", started_at: now }));

  // Money: contract 5000.00 fully collected on proj_a; 3000.00 partly allocated on proj_b.
  await upsertDocument(orgId, "payment_obligations", { data: { project_id: "proj_a", amount_cents: 500_000, allocated_cents: 500_000, status: "active" } });
  await upsertDocument(orgId, "payment_transactions", { data: { project_id: "proj_a", amount_cents: 500_000, direction: "inbound", status: "settled" } });
  await upsertDocument(orgId, "payment_obligations", { data: { project_id: "proj_b", amount_cents: 300_000, allocated_cents: 100_000, status: "active" } });

  for (const projectId of ["proj_a", "proj_b", "proj_c"]) {
    (await createEventRecord({
      organization_id: orgId, project_id: projectId, type: "project.created",
      visibility: "activity", actor_user_id: "user_rep_1", idempotency_key: `seed:${projectId}`
    }));
  }
}

test("stats warehouse backfills, answers DSL queries, and serves cached results", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await seedOrganization(orgId);

  const synced = await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);
  assert.equal(synced.sync.backfill_done, true);
  assert.ok(synced.result.projects_refreshed >= 6, `expected >=6 refreshed, got ${synced.result.projects_refreshed}`);

  const schema = await client.request("GET", `/v1/stats/organizations/${orgId}/schema`);
  assert.ok(schema.schema.fields.projects.some((field: any) => field.key === "contract_cents"));
  assert.ok(schema.schema.sources.includes("website"));

  const queried = await client.request("POST", `/v1/stats/organizations/${orgId}/query`, {
    queries: {
      total: { source: "projects", agg: "count" },
      sold: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }] },
      completed: { source: "projects", agg: "count", filters: [{ field: "status", op: "eq", value: "completed" }] },
      lost: { source: "projects", agg: "count", filters: [{ field: "status", op: "eq", value: "lost" }] },
      contract: { source: "projects", agg: "sum", measure: "contract_cents" },
      collected: { source: "projects", agg: "sum", measure: "collected_cents" },
      squares: { source: "projects", agg: "sum", measure: "attr:roof_squares" },
      by_source: { source: "projects", agg: "count", group_by: "source" },
      close_rate: {
        formula: "sold / leads * 100",
        inputs: {
          sold: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "created_at", preset: "this_month" } },
          leads: { source: "projects", agg: "count", time: { field: "created_at", preset: "this_month" } }
        }
      },
      events_created: { source: "events", agg: "count", filters: [{ field: "type", op: "eq", value: "project.created" }] },
      lead_trend: { source: "projects", agg: "count", time: { field: "created_at", preset: "last_30_days", bucket: "day" } }
    }
  });
  const rows = (key: string) => queried.results[key].rows;
  assert.equal(rows("total")[0].value, 6);
  assert.equal(rows("sold")[0].value, 2);
  assert.equal(rows("completed")[0].value, 1);
  assert.equal(rows("lost")[0].value, 1);
  assert.equal(rows("contract")[0].value, 800_000);
  assert.equal(rows("collected")[0].value, 500_000);
  assert.equal(rows("squares")[0].value, 50);
  const bySource = new Map(rows("by_source").map((row: any) => [row.group, row.value]));
  assert.equal(bySource.get("website"), 3);
  assert.equal(bySource.get("referral"), 2);
  assert.equal(bySource.get("canvassing"), 1);
  assert.ok(Math.abs(Number(rows("close_rate")[0].value) - (2 / 6) * 100) < 0.01);
  assert.equal(rows("events_created")[0].value, 3);
  assert.ok(rows("lead_trend").length >= 1);
  assert.ok(rows("lead_trend").every((row: any) => typeof row.bucket === "string"));

  // Identical query → served from the version-keyed cache.
  const again = await client.request("POST", `/v1/stats/organizations/${orgId}/query`, {
    queries: { total: { source: "projects", agg: "count" } }
  });
  assert.equal(again.results.total.cached, true);
  assert.equal(again.results.total.rows[0].value, 6);

  // Unknown fields are rejected, not silently ignored.
  const bad = await client.raw("POST", `/v1/stats/organizations/${orgId}/query`, {
    queries: { evil: { source: "projects", agg: "sum", measure: "nonexistent_field" } }
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.data.error, "stats_unknown_field");
});

test("incremental sync picks up new projects from the event tail and bumps the cache version", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await seedOrganization(orgId);
  await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);

  const first = await client.request("POST", `/v1/stats/organizations/${orgId}/query`, {
    queries: { total: { source: "projects", agg: "count" } }
  });
  assert.equal(first.results.total.rows[0].value, 6);

  const { upsertDocument } = await import("../platform/storage.js");
  const { createEventRecord } = await import("../work/storage.js");
  await upsertDocument(orgId, "projects", { id: "proj_new", data: { title: "proj_new", source: "website" } });
  (await createEventRecord({
    organization_id: orgId, project_id: "proj_new", type: "project.created",
    visibility: "activity", idempotency_key: "seed:proj_new"
  }));

  const synced = await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);
  assert.ok(synced.result.events_processed >= 1);
  const second = await client.request("POST", `/v1/stats/organizations/${orgId}/query`, {
    queries: { total: { source: "projects", agg: "count" } }
  });
  assert.equal(second.results.total.rows[0].value, 7);
  assert.equal(second.results.total.cached, false);
  assert.ok(second.data_version > first.data_version);
});

test("views seed from presets, validate widgets, and support CRUD", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await seedOrganization(orgId);
  await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);

  const seeded = await client.request("GET", `/v1/stats/organizations/${orgId}/views`);
  assert.equal(seeded.views.length, 2);
  assert.ok(seeded.views.some((view: any) => view.preset_id === "sales_overview"));

  // Blank views are allowed (the agent fills them in later).
  const created = await client.request("POST", `/v1/stats/organizations/${orgId}/views`, {
    title: "My Custom View", icon: "fa-star", color: "#175cd3",
    definition: { title: "My Custom View", time_default: "this_month", widgets: [] }
  });
  const viewId = created.view.id as string;
  assert.ok(viewId);

  const updated = await client.request("PUT", `/v1/stats/organizations/${orgId}/views/${viewId}`, {
    title: "My Custom View",
    definition: {
      title: "My Custom View",
      time_default: "this_month",
      widgets: [{ id: "sold_kpi", type: "kpi", title: "Sold", format: "number", metric: { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at" } } }]
    }
  });
  assert.equal(updated.view.definition.widgets.length, 1);

  const invalid = await client.raw("PUT", `/v1/stats/organizations/${orgId}/views/${viewId}`, {
    title: "My Custom View",
    definition: {
      title: "My Custom View",
      widgets: [{ id: "bad", type: "kpi", title: "Bad", metric: { source: "projects", agg: "sum", measure: "not_a_field" } }]
    }
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.data.error, "stats_view_invalid");
  assert.ok(invalid.data.details.errors.some((message: string) => message.includes("not_a_field")));

  const fromPreset = await client.request("POST", `/v1/stats/organizations/${orgId}/views`, { preset_id: "financial_snapshot" });
  assert.equal(fromPreset.view.preset_id, "financial_snapshot");

  await client.request("DELETE", `/v1/stats/organizations/${orgId}/views/${viewId}`);
  const afterDelete = await client.request("GET", `/v1/stats/organizations/${orgId}/views`);
  assert.ok(!afterDelete.views.some((view: any) => view.id === viewId));
});

// Scripts globalThis.fetch to return a queue of OpenAI Responses payloads.
function mockOpenAI(script: Array<Record<string, unknown>>) {
  const original = globalThis.fetch;
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body || "{}")));
    const payload = script[Math.min(index, script.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function functionCall(name: string, args: Record<string, unknown>, callId: string) {
  return { type: "function_call", name, arguments: JSON.stringify(args), call_id: callId };
}

function messageOutput(text: string) {
  return { type: "message", content: [{ type: "output_text", text }] };
}

test("the stats agent answers with live queries, renders widgets inline, and persists the turn", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await seedOrganization(orgId);
  await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);

  const views = await client.request("GET", `/v1/stats/organizations/${orgId}/views`);
  const viewId = views.views[0].id as string;
  const thread = (await client.request("POST", `/v1/stats/organizations/${orgId}/agent/threads`, { view_id: viewId })).thread;
  assert.ok(String(thread.id).startsWith("stats_thread_"));
  const listed = await client.request("GET", `/v1/stats/organizations/${orgId}/agent/threads?view_id=${viewId}`);
  assert.ok(listed.threads.some((item: any) => item.id === thread.id));

  const soldSpec = { source: "projects", agg: "count", filters: [{ field: "sold_at", op: "is_set" }], time: { field: "sold_at", preset: "this_month" } };
  const mock = mockOpenAI([
    { output: [functionCall("run_stats_queries", { queries: JSON.stringify({ sold: soldSpec }) }, "call_1")] },
    { output: [functionCall("render_widget", { widget: JSON.stringify({ type: "kpi", title: "Jobs sold this month", format: "number", metric: soldSpec }) }, "call_2")] },
    { output: [functionCall("report_result", { status: "success", summary: "You sold 2 jobs this month." }, "call_3")] },
    { output: [messageOutput("You sold 2 jobs this month. Want me to add this to your dashboard so you can track it going forward?")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/stats/organizations/${orgId}/agent/threads/${thread.id}/messages`, {
      message: "How many jobs did we sell this month?"
    });
    assert.equal(result.status, "success");
    assert.match(result.assistant_message.content, /sold 2 jobs/);
    assert.equal(result.renders.length, 1);
    assert.equal(result.renders[0].widget.type, "kpi");
    const renderRows = result.renders[0].data["Jobs sold this month"];
    assert.equal(renderRows[0].value, 2);

    // The system prompt carries the stats manifest and warehouse status.
    const firstBody = mock.calls[0] as any;
    const systemText = String(firstBody.input[0].content);
    assert.match(systemText, /metric DSL/);
    assert.match(systemText, /stats warehouse/);
    assert.match(systemText, /tracks 6 projects/);

    const detail = await client.request("GET", `/v1/stats/organizations/${orgId}/agent/threads/${thread.id}`);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.messages[1].role, "assistant");
    assert.equal(detail.messages[1].data.renders.length, 1);
  } finally {
    mock.restore();
  }
});

test("failed agent runs revert dashboard edits", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await seedOrganization(orgId);
  await client.request("POST", `/v1/stats/organizations/${orgId}/sync`);

  const views = await client.request("GET", `/v1/stats/organizations/${orgId}/views`);
  const view = views.views[0];
  const originalWidgetCount = view.definition.widgets.length;
  const thread = (await client.request("POST", `/v1/stats/organizations/${orgId}/agent/threads`, { view_id: view.id })).thread;

  const strippedDefinition = { ...view.definition, widgets: view.definition.widgets.slice(0, 1) };
  const mock = mockOpenAI([
    { output: [functionCall("save_view", { view_id: view.id, definition: JSON.stringify(strippedDefinition), change_note: "Removed widgets." }, "call_1")] },
    { output: [functionCall("report_result", { status: "failed", summary: "I couldn't finish restructuring the dashboard." }, "call_2")] },
    { output: [messageOutput("I couldn't finish that, so I left your dashboard unchanged.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/stats/organizations/${orgId}/agent/threads/${thread.id}/messages`, {
      message: "Rebuild this dashboard from scratch."
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.reverted_views, [view.id]);
    const after = await client.request("GET", `/v1/stats/organizations/${orgId}/views/${view.id}`);
    assert.equal(after.view.definition.widgets.length, originalWidgetCount);
  } finally {
    mock.restore();
  }
});
