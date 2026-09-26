// Fault injection for the global assistant: malformed or hostile model output,
// provider failures, runaway tool loops, concurrent use and scheduled-agent
// failures must all end in a clear, persisted outcome and a usable thread.
import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method, url, payload,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}) }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    return response;
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-assistant-robustness-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), EMAIL_OUTBOUND_DISABLED: "1",
    V1_LOG_LEVEL: "error", OPENAI_API_KEY: "test-openai-key"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const cleanup = rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
  if (process.platform === "win32") await Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 5000))]);
  else await cleanup;
});

async function setup() {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Owner User", company: "Robustness Co", organization_id: `org_robust_${suffix}`
  });
  const orgId = data.organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const base = `/v1/assistant/organizations/${orgId}`;
  const thread = (await client.request("POST", `${base}/threads`, {})).thread.id as string;
  return { client, orgId, base, thread };
}

type Step = Record<string, unknown> | { status: number; body?: unknown } | { throws: string } | { delayMs: number; then: Record<string, unknown> };

/** Scripted Responses API. Steps may return HTTP errors, throw, or delay. */
function mockOpenAI(script: Step[]) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  let index = 0;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body || "{}")));
    const step: any = script[Math.min(index, script.length - 1)];
    index += 1;
    if (step.throws) throw new Error(step.throws);
    if (step.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, step.delayMs);
        init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("This operation was aborted")); });
      });
      return new Response(JSON.stringify(step.then), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (typeof step.status === "number") return new Response(step.body === undefined ? "upstream error" : JSON.stringify(step.body), { status: step.status });
    return new Response(JSON.stringify(step), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const call = (name: string, args: unknown, id: string) => ({ type: "function_call", name, arguments: typeof args === "string" ? args : JSON.stringify(args), call_id: id });
const say = (text: string) => ({ type: "message", content: [{ type: "output_text", text }] });
const done = (summary = "Done.") => ({ output: [call("report_result", { status: "success", summary }, `r_${Math.random()}`)] });
const lastToolOutput = (mock: { calls: any[] }, index: number) => JSON.parse(mock.calls[index].input.at(-1).output);

async function send(ctx: Awaited<ReturnType<typeof setup>>, message: unknown, thread = ctx.thread) {
  return await ctx.client.raw("POST", `${ctx.base}/threads/${thread}/messages`, { message });
}

test("malformed, unknown and schema-invalid function calls are reported back to the model", async () => {
  const ctx = await setup();
  const mock = mockOpenAI([
    { output: [call("list_agents", "{not json", "c1")] },
    { output: [call("delete_everything", {}, "c2")] },
    { output: [call("create_artifact", { kind: "donut", title: 42 }, "c3")] },
    { output: [call("update_agent", { agent_id: ["x"] }, "c4")] },
    done(), { output: [say("Recovered.")] }
  ]);
  try {
    const response = await send(ctx, "Show my agents");
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.status, "success");
    assert.equal(body.assistant_message.content, "Recovered.");
    assert.ok(lastToolOutput(mock, 2).error.includes("Unknown tool"));
    assert.ok(lastToolOutput(mock, 3).error, "wrong argument types are rejected before execution");
    assert.ok(lastToolOutput(mock, 4).error, "array agent ids are rejected");
    const trace = body.assistant_message.data.trace.map((entry: any) => [entry.tool, entry.ok]);
    assert.deepEqual(trace.slice(0, 4).map((entry: any) => entry[1]), [true, false, false, false]);
  } finally { mock.restore(); }
});

test("provider errors, network failures and non-JSON replies end in a persisted failure and a free thread", async () => {
  const ctx = await setup();
  for (const script of [
    [{ status: 500 }, { status: 503 }],
    [{ throws: "getaddrinfo ENOTFOUND api.openai.com" }],
    [{ status: 200, body: undefined }],
    [{ status: 401, body: { error: { message: "Incorrect API key provided: sk-live-SECRET" } } }]
  ] as Step[][]) {
    const mock = mockOpenAI(script);
    try {
      const response = await send(ctx, "Hello");
      assert.equal(response.statusCode, 200, response.body);
      const body = JSON.parse(response.body);
      assert.equal(body.status, "failed");
      assert.ok(body.assistant_message.content.length > 0);
      assert.ok(!/sk-live|SECRET/.test(body.assistant_message.content), `provider details leak: ${body.assistant_message.content}`);
    } finally { mock.restore(); }
  }
  const retry = mockOpenAI([{ status: 429 }, done(), { output: [say("Back again.")] }]);
  try {
    const body = JSON.parse((await send(ctx, "Hello again")).body);
    assert.equal(body.status, "success", "one retryable failure is retried");
  } finally { retry.restore(); }
  const thread = await ctx.client.request("GET", `${ctx.base}/threads/${ctx.thread}`);
  assert.equal(thread.thread.status, "idle");
  assert.equal(thread.messages.filter((message: any) => message.role === "user").length, 5);
});

test("an endless stream of distinct tool calls stops at the round limit", async () => {
  const ctx = await setup();
  let n = 0;
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    n += 1;
    return new Response(JSON.stringify({ output: [call("get_workspace_context", {}, `loop_${n}`), call("list_agents", {}, `loop_b_${n}`)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const body = JSON.parse((await send(ctx, "Loop forever")).body);
    assert.equal(body.status, "failed");
    assert.ok(requests <= 16, `stopped after ${requests} model rounds`);
    assert.match(body.assistant_message.content, /stopped|limit/i);
  } finally { globalThis.fetch = original; }
  let varied = 0;
  globalThis.fetch = (async () => {
    varied += 1;
    return new Response(JSON.stringify({ output: [call("search_my_conversation_history", { query: `term number ${varied}` }, `v_${varied}`)] }), { status: 200 });
  }) as typeof fetch;
  try {
    const body = JSON.parse((await send(ctx, "Search forever")).body);
    assert.equal(body.status, "failed");
    assert.ok(varied <= 16);
  } finally { globalThis.fetch = original; }
});

test("an empty model reply and a reply without report_result fail clearly", async () => {
  const ctx = await setup();
  for (const script of [[{ output: [] }], [{ output: [say("I did it!")] }], [{}]] as Step[][]) {
    const mock = mockOpenAI(script);
    try {
      const body = JSON.parse((await send(ctx, "Do something")).body);
      assert.equal(body.status, "failed");
      assert.ok(body.assistant_message.content.trim().length > 0);
    } finally { mock.restore(); }
  }
});

test("a second message while the thread is working is refused without wedging it", async () => {
  const ctx = await setup();
  const mock = mockOpenAI([{ delayMs: 400, then: done() }, { output: [say("First done.")] }]);
  try {
    const first = send(ctx, "Slow request");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await send(ctx, "Impatient follow-up");
    assert.equal(second.statusCode, 400);
    assert.equal(JSON.parse(second.body).error, "agent_thread_busy");
    assert.equal((await first).statusCode, 200);
  } finally { mock.restore(); }
  const after = mockOpenAI([done(), { output: [say("Ready.")] }]);
  try { assert.equal(JSON.parse((await send(ctx, "Now?")).body).status, "success"); } finally { after.restore(); }
});

test("messages are validated: empty, oversized and non-string input", async () => {
  const ctx = await setup();
  const mock = mockOpenAI([done(), { output: [say("ok")] }]);
  try {
    assert.equal((await send(ctx, "   ")).statusCode, 400, "blank messages are rejected");
    assert.equal((await send(ctx, "x".repeat(40_001))).statusCode, 400, "oversized messages are rejected");
    assert.equal((await send(ctx, { nested: true })).statusCode, 400, "non-string messages are rejected");
    assert.equal(mock.calls.length, 0, "rejected input never reaches the model");
    assert.equal((await ctx.client.raw("POST", `${ctx.base}/threads/agent_thread_missing/messages`, { message: "hi" })).statusCode, 404);
  } finally { mock.restore(); }
});

test("agent tools reject bad schedules, other users' agents and limits", async () => {
  const ctx = await setup();
  const other = await setup();
  const make = (title: string, extra: Record<string, unknown>, id: string) => call("create_agent", { title, summary: "s", instructions: "i", ...extra }, id);
  const mock = mockOpenAI([
    { output: [make("Past", { at: "2001-01-01T10:00" }, "a1")] },
    { output: [make("Garbage", { cron: "every morning" }, "a2")] },
    { output: [make("Both", { cron: "0 9 * * *", at: "2030-01-01T10:00" }, "a3")] },
    { output: [make("Never", { cron: "0 0 31 2 *" }, "a4")] },
    { output: [make("Nothing", {}, "a5")] },
    { output: [make("   ", { cron: "0 9 * * *" }, "a6")] },
    { output: [make("Mine", { cron: "0 9 * * *" }, "a7")] },
    done(), { output: [say("Set up.")] }
  ]);
  let agentId = "";
  try {
    const body = JSON.parse((await send(ctx, "Set things up")).body);
    for (const index of [1, 2, 3, 4, 5, 6]) assert.ok(lastToolOutput(mock, index).errors?.length || lastToolOutput(mock, index).error, `call ${index} rejected`);
    agentId = body.actions.find((action: any) => action.kind === "agent").agent_id;
  } finally { mock.restore(); }
  const probe = mockOpenAI([
    { output: [call("update_agent", { agent_id: agentId, status: "paused" }, "o1"), call("delete_agent", { agent_id: agentId }, "o2"), call("run_agent_now", { agent_id: agentId }, "o3")] },
    done(), { output: [say("no")] }
  ]);
  try {
    await send(other, "Mess with their agent");
    const outputs = probe.calls[1].input.filter((item: any) => item.type === "function_call_output").map((item: any) => JSON.parse(item.output));
    assert.equal(outputs.length, 3);
    for (const output of outputs) assert.match(String(output.errors?.[0] || output.error), /No such agent/);
  } finally { probe.restore(); }
  assert.equal((await ctx.client.request("GET", `${ctx.base}/agents`)).agents[0].status, "active");
  assert.equal((await other.client.raw("DELETE", `${ctx.base}/agents/${agentId}`)).statusCode >= 400, true);
  assert.equal((await ctx.client.raw("PATCH", `${ctx.base}/agents/${agentId}`, { status: "deleted" })).statusCode, 400);
  assert.equal((await ctx.client.raw("PATCH", `${ctx.base}/agents/${agentId}`, { title: "x".repeat(40) })).statusCode, 400);
});

test("artifacts survive hostile or oversized specs", async () => {
  const { normalizeArtifact } = await import("../assistant/agent/agents.js");
  const huge = normalizeArtifact({ kind: "bar", title: "<script>alert(1)</script>", labels: Array.from({ length: 500 }, (_, i) => `L${i}`),
    series: Array.from({ length: 20 }, () => ({ name: "s", values: Array.from({ length: 500 }, () => "NaN") })) }) as any;
  assert.equal(huge.labels.length, 60);
  assert.equal(huge.series.length, 6);
  assert.ok(huge.series.every((entry: any) => entry.values.every((value: number) => Number.isFinite(value))));
  assert.equal(typeof normalizeArtifact({ kind: "table", title: "t", columns: [], rows: [] }), "string");
  assert.equal(typeof normalizeArtifact({ kind: "pie", title: "t", labels: ["a"], series: [] }), "string");
  assert.equal(typeof normalizeArtifact({ kind: "html", title: "t" }), "string");
  const table = normalizeArtifact({ kind: "table", title: "t", columns: ["a"], rows: [[{ evil: true }, 1], "not a row"] }) as any;
  assert.deepEqual(table.rows[0], ["[object Object]"]);
  assert.deepEqual(table.rows[1], []);
});

test("scheduled agent failures are delivered as attention items; revoked authors are cancelled", async () => {
  const ctx = await setup();
  const create = mockOpenAI([
    { output: [call("create_agent", { title: "Numbers", summary: "Daily numbers.", instructions: "Report numbers.", cron: "0 11 * * *" }, "c1")] },
    done(), { output: [say("Set up.")] }
  ]);
  let agentId = "";
  try { agentId = JSON.parse((await send(ctx, "Daily numbers please")).body).actions[0].agent_id; } finally { create.restore(); }
  const { runAssistantAgentLane } = await import("../assistant/agent/agents.js");
  const store = await import("../agents/storage.js");
  const main = (await ctx.client.request("GET", `${ctx.base}/context`)).main_thread.id;

  await ctx.client.request("POST", `${ctx.base}/agents/${agentId}/run`, {});
  const outage = mockOpenAI([{ status: 500 }, { status: 500 }]);
  try { assert.equal((await runAssistantAgentLane()).handled, 1); } finally { outage.restore(); }
  const delivered = (await ctx.client.request("GET", `${ctx.base}/threads/${main}`)).messages.at(-1);
  assert.equal(delivered.data.status, "failed");
  assert.equal(delivered.data.source, "agent");
  assert.ok(!/upstream error|\(500\)/.test(delivered.content) || delivered.content.length < 400);
  assert.equal((await store.readAgentSchedule(agentId))?.last_run_status, "failed");
  const { readDocument } = await import("../platform/storage.js");
  assert.match(String(((await readDocument(ctx.orgId, "notifications", `assistant_agent_${delivered.id}`)).data as any).title), /needs attention/);

  // A second queued run while the lane is already busy is left for the next tick.
  await ctx.client.request("POST", `${ctx.base}/agents/${agentId}/run`, {});
  const slow = mockOpenAI([{ delayMs: 300, then: done() }, { output: [say("Slow but fine.")] }]);
  try {
    const [first, second] = await Promise.all([runAssistantAgentLane(), runAssistantAgentLane()]);
    assert.equal(first.handled + second.handled, 1);
    assert.equal([first, second].filter((result) => result.skipped).length, 1);
  } finally { slow.restore(); }

  // Losing access cancels queued work instead of running it as that user.
  await ctx.client.request("POST", `${ctx.base}/agents/${agentId}/run`, {});
  await (await operatorFixtureClient(app, ctx.orgId)).request("PUT", `/v1/platform/organizations/${ctx.orgId}/capabilities`, { values: { "apps.assistant": false } });
  const never = mockOpenAI([done()]);
  try {
    await runAssistantAgentLane();
    assert.equal(never.calls.length, 0, "no model call for a disabled assistant");
  } finally { never.restore(); }
  const job = await store.getAgentsDatabase().prepare("SELECT state FROM agent_wakeup_jobs WHERE kind='assistant_agent' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(job?.state, "cancelled");
});

test("a deleted agent's queued run is cancelled and its thread is gone", async () => {
  const ctx = await setup();
  const create = mockOpenAI([
    { output: [call("create_agent", { title: "Temp", summary: "s", instructions: "i", cron: "0 11 * * *" }, "c1")] },
    done(), { output: [say("ok")] }
  ]);
  let agentId = "";
  try { agentId = JSON.parse((await send(ctx, "Temp agent")).body).actions[0].agent_id; } finally { create.restore(); }
  const detail = await ctx.client.request("GET", `${ctx.base}/agents/${agentId}`);
  await ctx.client.request("POST", `${ctx.base}/agents/${agentId}/run`, {});
  await ctx.client.request("DELETE", `${ctx.base}/agents/${agentId}`);
  const { runAssistantAgentLane } = await import("../assistant/agent/agents.js");
  const mock = mockOpenAI([done()]);
  try { await runAssistantAgentLane(); assert.equal(mock.calls.length, 0); } finally { mock.restore(); }
  assert.equal((await ctx.client.raw("GET", `${ctx.base}/threads/${detail.agent.thread_id}`)).statusCode, 404);
  assert.equal((await ctx.client.raw("GET", `${ctx.base}/agents/${agentId}`)).statusCode, 404);
});
