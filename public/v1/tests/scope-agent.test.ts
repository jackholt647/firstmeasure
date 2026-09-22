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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-scope-agent-test-"));
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
    company: "Scope Agent Test Co",
    organization_id: `org_agent_${suffix}`
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

test("scope event map is authenticated and includes registered actions and automatic setup", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const url = `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement/event-map`;
  const anonymous = await createSessionClient().raw("GET", url);
  assert.equal(anonymous.statusCode, 401);
  const result = await client.request("GET", url);
  assert.equal(result.template.id, "roof_replacement");
  assert.ok(result.events.some((event: any) => event.connections.some((entry: any) => entry.source === "Automatic setup")));
  assert.ok(result.actions.some((action: any) => action.id === "materials.initializeFromScope.v1" && action.description));
  const artifactUrl=url.replace("event-map","artifacts");
  const catalog=await client.request("GET",artifactUrl);
  const todo=catalog.artifacts.find((a:any)=>a.type==="todos" && a.origin==="Created by automation");
  assert.ok(todo);
  const save=await client.request("PATCH",artifactUrl,{expected_version:catalog.template.version,artifact_id:todo.id,changes:{title:"Verify delivery with foreman"}});
  assert.equal(save.template.version,catalog.template.version+1);
  const stale=await client.raw("PATCH",artifactUrl,{expected_version:catalog.template.version,artifact_id:todo.id,changes:{title:"Stale edit"}});
  assert.equal(stale.statusCode,409);
  const reread=await client.request("GET",url);
  assert.ok(reread.events.some((event:any)=>event.connections.some((c:any)=>c.input?.title==="Verify delivery with foreman")));
  const denied=await createSessionClient().raw("PATCH",artifactUrl,{expected_version:save.template.version,artifact_id:todo.id,changes:{title:"Unauthorized"}});
  assert.equal(denied.statusCode,401);
});

test("automation inventory exposes explainers and hides machinery; visibility is patchable", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const url = `/v1/scopes/organizations/${orgId}/branches/default/templates/sales_pipeline/automation-inventory`;
  const visible = await client.request("GET", url);
  assert.ok(visible.entries.length >= 4, "seeded sales explainers are visible");
  assert.ok(visible.entries.every((entry: any) => entry.explainer));
  assert.ok(!visible.entries.some((entry: any) => entry.key.includes("remove_completed")), "machinery bindings without explainers are hidden");

  const everything = await client.request("GET", `${url}?include_hidden=1`);
  assert.ok(everything.entries.length > visible.entries.length);

  const target = visible.entries.find((entry: any) => entry.key.includes("activate_signed_scopes"));
  const patched = await client.request("PATCH", url, { key: target.key, customer_visible: false });
  const hidden = patched.entries.find((entry: any) => entry.key === target.key);
  assert.equal(hidden.customer_visible, false);
  const afterPatch = await client.request("GET", url);
  assert.ok(!afterPatch.entries.some((entry: any) => entry.key === target.key));
});

test("custom boards can be disabled, soft-deleted, restored, and re-enabled without losing versions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const templateId = "custom_install_board";
  const templateUrl = `/v1/scopes/organizations/${orgId}/branches/default/templates/${templateId}`;
  const definition = {
    schema_version: 1,
    id: templateId,
    kind: "production",
    name: "Custom Install",
    description: "A manually created production board.",
    color: "#2563eb",
    icon: "fa-hammer",
    status: "active",
    proposal: { piece_types: [templateId], selectable: true },
    fields: [],
    work_plan: {
      title: "Custom Install",
      terminology: { phase: "Phase", stage: "Stage", task: "To-do", board: "Board" },
      metadata: { board_color: "#2563eb" },
      root_nodes: [{
        id: "custom_install_phase",
        title: "Custom Install",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        children: [
          { id: "planning_stage", title: "Planning", terminology_key: "work.stage", actionable: true, completion_mode: "manual", metadata: { color: "#2563eb" } },
          { id: "install_stage", title: "Install", terminology_key: "work.stage", actionable: true, completion_mode: "manual", depends_on: ["planning_stage"], metadata: { color: "#059669" } }
        ]
      }]
    },
    metadata: { preset: false, created_in: "automation_assistant" }
  };

  const created = await client.request("PUT", templateUrl, definition);
  assert.equal(created.template.version, 1);
  assert.equal(created.template.enabled, true);

  const disabled = await client.request("PATCH", `${templateUrl}/state`, { enabled: false });
  assert.equal(disabled.state.enabled, false);
  const defaultList = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates`);
  assert.ok(!defaultList.templates.some((item: any) => item.id === templateId));

  const trashed = await client.request("PATCH", `${templateUrl}/state`, { trashed: true });
  assert.equal(trashed.state.trashed, true);
  const withTrash = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates?include_disabled=1&include_archived=1`);
  assert.equal(withTrash.templates.find((item: any) => item.id === templateId).status, "archived");

  const versionsInTrash = await client.request("GET", `${templateUrl}/versions`);
  assert.deepEqual(versionsInTrash.versions.map((item: any) => item.version), [1]);

  const restored = await client.request("PATCH", `${templateUrl}/state`, { trashed: false });
  assert.equal(restored.state.trashed, false);
  assert.equal(restored.state.enabled, false, "restore preserves the previous disabled state");
  const enabled = await client.request("PATCH", `${templateUrl}/state`, { enabled: true });
  assert.equal(enabled.state.enabled, true);
  assert.equal(enabled.template.version, 1, "lifecycle changes do not rewrite immutable board definitions");
});

test("the scope agent edits explainers through tools and reports success", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const thread = (await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads`, {
    template_id: "sales_pipeline"
  })).thread;

  const mock = mockOpenAI([
    { output: [functionCall("get_automation_inventory", { include_hidden: true }, "call_1")] },
    { output: [functionCall("set_automation_explainer", {
      key: "node:sign_sales_proposal:binding:onCompleted:activate_signed_scopes",
      explainer: "New leads go straight to the call queue so nobody waits."
    }, "call_2")] },
    { output: [functionCall("report_result", { status: "success", summary: "I updated the wording of your new-lead automation." }, "call_3")] },
    { output: [messageOutput("I updated the wording of your new-lead automation — new leads go straight to the call queue so nobody waits.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads/${thread.id}/messages`, {
      message: "Can you make the new lead automation description clearer?",
      references: ["node:sign_sales_proposal:binding:onCompleted:activate_signed_scopes"]
    });
    assert.equal(result.status, "success");
    assert.match(result.assistant_message.content, /call queue/);
    assert.ok(result.changes.length >= 1);

    // The system prompt carries the platform manifest and current inventory.
    const firstBody = mock.calls[0] as any;
    const systemText = String(firstBody.input[0].content);
    assert.match(systemText, /Event catalog/);
    assert.match(systemText, /crm\.callLists\.add\.v1/);

    const inventory = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/sales_pipeline/automation-inventory`);
    const entry = inventory.entries.find((item: any) => item.key === "node:sign_sales_proposal:binding:onCompleted:activate_signed_scopes");
    assert.equal(entry.explainer, "New leads go straight to the call queue so nobody waits.");

    const messages = await client.request("GET", `/v1/scopes/organizations/${orgId}/agent/threads/${thread.id}`);
    assert.equal(messages.messages.length, 2);
  } finally {
    mock.restore();
  }
});

test("the scope agent can manage board lifecycle with reversible actions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const thread = (await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads`, {
    template_id: "repairs"
  })).thread;
  const mock = mockOpenAI([
    { output: [functionCall("manage_scope_template", { action: "disable" }, "call_1")] },
    { output: [functionCall("report_result", { status: "success", summary: "I disabled the Repairs board." }, "call_2")] },
    { output: [messageOutput("I disabled the Repairs board. Its setup and history are still safe.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads/${thread.id}/messages`, {
      message: "Disable this board for now."
    });
    assert.equal(result.status, "success");
    const templates = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates?include_disabled=1`);
    assert.equal(templates.templates.find((item: any) => item.id === "repairs").enabled, false);
  } finally {
    mock.restore();
  }
});

test("failed saves iterate on validation errors and revert when the agent gives up", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const before = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/repairs`);
  const baseVersion = before.template.version;
  const goodDefinition = before.template.definition;
  const brokenDefinition = JSON.parse(JSON.stringify(goodDefinition));
  brokenDefinition.work_plan.root_nodes[0].children.push({
    id: "broken_node",
    title: "Broken",
    terminology_key: "work.task",
    depends_on: ["does_not_exist"]
  });
  const savedButWrongDefinition = JSON.parse(JSON.stringify(goodDefinition));
  savedButWrongDefinition.description = "An intermediate save that must be rolled back.";

  const thread = (await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads`, {
    template_id: "repairs"
  })).thread;

  const mock = mockOpenAI([
    // First: a save that passes validation (recorded, must be reverted later).
    { output: [functionCall("save_scope_template", { template_id: "repairs", definition: JSON.stringify(savedButWrongDefinition), change_note: "Intermediate change." }, "call_1")] },
    // Second: a save that fails validation (unknown dependency).
    { output: [functionCall("save_scope_template", { template_id: "repairs", definition: JSON.stringify(brokenDefinition), change_note: "Broken change." }, "call_2")] },
    // The agent gives up.
    { output: [functionCall("report_result", { status: "failed", summary: "I couldn't finish this change, so I put everything back." }, "call_3")] },
    { output: [messageOutput("I couldn't finish this change, so I put everything back the way it was.")] }
  ]);
  try {
    const result = await client.request("POST", `/v1/scopes/organizations/${orgId}/agent/threads/${thread.id}/messages`, {
      message: "Restructure my repairs board completely."
    });
    assert.equal(result.status, "failed");
    assert.deepEqual(result.reverted_templates, ["repairs"]);

    const after = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/repairs`);
    assert.ok(after.template.version > baseVersion, "revert writes a new version");
    assert.equal(after.template.definition.description, goodDefinition.description, "content matches the pre-run baseline");
  } finally {
    mock.restore();
  }
});
