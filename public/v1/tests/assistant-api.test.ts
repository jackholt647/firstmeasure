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
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-assistant-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.OPENAI_API_KEY = "test-openai-key";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Assistant Test Co",
    organization_id: `org_assistant_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

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

test("assistant settings round-trip with normalization", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const initial = await client.request("GET", `/v1/assistant/organizations/${orgId}/settings`);
  assert.equal(initial.settings.enabled, true);
  assert.equal(initial.settings.allow_messaging, false);
  assert.equal(initial.settings.data_scope.projects, true);

  const saved = await client.request("PUT", `/v1/assistant/organizations/${orgId}/settings`, {
    settings: {
      assistant_name: "  Skipper  ",
      custom_instructions: "Always call projects 'jobs'.",
      allow_actions: false,
      data_scope: { stats: false }
    }
  });
  assert.equal(saved.settings.assistant_name, "Skipper");
  assert.equal(saved.settings.allow_actions, false);
  assert.equal(saved.settings.data_scope.stats, false);
  assert.equal(saved.settings.data_scope.projects, true, "unspecified scopes keep defaults");

  const reread = await client.request("GET", `/v1/assistant/organizations/${orgId}/settings`);
  assert.equal(reread.settings.assistant_name, "Skipper");
  assert.equal(reread.settings.allow_actions, false);
});

test("assistant answers a lookup question through tools and reports success", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const created = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads`, {});
  const threadId = created.thread.id as string;
  assert.ok(threadId);

  const mock = mockOpenAI([
    { output: [functionCall("get_workspace_context", {}, "call_1")] },
    { output: [functionCall("list_projects", { limit: 5 }, "call_2")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "You have no projects yet." }, "call_3"),
        messageOutput("You do not have any projects yet — want me to create one as a to-do?")
      ]
    },
    { output: [messageOutput("You do not have any projects yet — want me to create one as a to-do?")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads/${threadId}/messages`, {
      message: "How many projects do we have?"
    });
    assert.equal(result.status, "success");
    assert.match(String(result.assistant_message.content), /projects yet/);
    const trace = result.assistant_message.data.trace as Array<Record<string, unknown>>;
    assert.ok(trace.some((entry) => entry.tool === "get_workspace_context"));
    assert.ok(trace.some((entry) => entry.tool === "list_projects"));

    // The system prompt is the first input message and carries the manifest.
    const firstCall = mock.calls[0] as Record<string, any>;
    assert.equal(firstCall.model, "gpt-5.6-sol");
    const system = String(firstCall.input[0].content);
    assert.match(system, /FirstMate/);
    assert.match(system, /metric DSL/i);

    const thread = await client.request("GET", `/v1/assistant/organizations/${orgId}/threads/${threadId}`);
    assert.equal(thread.messages.length, 2);
  } finally {
    mock.restore();
  }
});

test("assistant can create a to-do and the navigation chip is recorded", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads`, {});
  const threadId = created.thread.id as string;

  const mock = mockOpenAI([
    { output: [functionCall("create_task", { title: "Call the roofing supplier", priority: "high" }, "call_1")] },
    {
      output: [
        functionCall("suggest_navigation", { label: "Open your to-dos", kind: "tab", tab: "channels" }, "call_2"),
        functionCall("report_result", { status: "success", summary: "Created the to-do." }, "call_3"),
        messageOutput("Done — I created the to-do 'Call the roofing supplier'.")
      ]
    },
    { output: [messageOutput("Done — I created the to-do 'Call the roofing supplier'.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads/${threadId}/messages`, {
      message: "Remind me to call the roofing supplier"
    });
    assert.equal(result.status, "success");
    assert.ok(result.changes.some((entry: string) => entry.includes("Call the roofing supplier")));
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].kind, "tab");

    // The to-do actually exists in the work store.
    const todos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?include_all=1`);
    const items = (todos.action_items || todos.items || []) as Array<Record<string, unknown>>;
    assert.ok(items.some((item) => item.title === "Call the roofing supplier"));
  } finally {
    mock.restore();
  }
});

test("failed runs cancel to-dos created during the run", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads`, {});
  const threadId = created.thread.id as string;

  const mock = mockOpenAI([
    { output: [functionCall("create_task", { title: "Doomed task" }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "failed", summary: "I could not finish that." }, "call_2"),
        messageOutput("I could not finish that.")
      ]
    },
    { output: [messageOutput("I could not finish that.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads/${threadId}/messages`, {
      message: "Do something impossible"
    });
    assert.equal(result.status, "failed");
    assert.equal(result.assistant_message.data.reverted.length, 1);
    const todos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?include_all=1&include_canceled=1&include_future=1`);
    const items = (todos.action_items || todos.items || []) as Array<Record<string, unknown>>;
    const doomed = items.find((item) => item.title === "Doomed task");
    assert.ok(doomed, "task exists");
    assert.equal(doomed?.status, "canceled");
  } finally {
    mock.restore();
  }
});

test("write tools refuse when actions are disabled in settings", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("PUT", `/v1/assistant/organizations/${orgId}/settings`, {
    settings: { allow_actions: false }
  });
  const created = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads`, {});
  const threadId = created.thread.id as string;

  const mock = mockOpenAI([
    { output: [functionCall("create_task", { title: "Should not exist" }, "call_1")] },
    {
      output: [
        functionCall("report_result", { status: "success", summary: "Actions are off, so I could not create it." }, "call_2"),
        messageOutput("Actions are turned off for the assistant in your company settings.")
      ]
    },
    { output: [messageOutput("Actions are turned off for the assistant in your company settings.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads/${threadId}/messages`, {
      message: "Create a task"
    });
    const trace = result.assistant_message.data.trace as Array<Record<string, unknown>>;
    const createTrace = trace.find((entry) => entry.tool === "create_task");
    assert.ok(createTrace);
    assert.equal(createTrace?.ok, false);
    const todos = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?include_all=1`);
    const items = (todos.action_items || todos.items || []) as Array<Record<string, unknown>>;
    assert.ok(!items.some((item) => item.title === "Should not exist"));
  } finally {
    mock.restore();
  }
});

test("threads are personal and capability-gated", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/assistant/organizations/${orgId}/threads`, {});
  const threadId = created.thread.id as string;

  // A second owner in a different org cannot see the thread (different org id
  // in the URL fails auth; same org with a different user cannot read it).
  const other = createSessionClient();
  await register(other);
  const stolen = await other.raw("GET", `/v1/assistant/organizations/${orgId}/threads/${threadId}`);
  assert.ok(stolen.statusCode >= 400);

  // Turning the capability off blocks the API.
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: { "apps.assistant": false }
  });
  const blocked = await client.raw("GET", `/v1/assistant/organizations/${orgId}/threads`);
  assert.equal(blocked.statusCode, 403);
});
