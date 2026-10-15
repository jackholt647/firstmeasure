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
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method, url, payload,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-agent-how-to-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  // Building the app registers every agent, automation and publication the entries may name.
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
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
    phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple",
    name: "Owner User", company: "How-To Index Test Co", organization_id: `org_howto_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string, userId: data.user?.id as string };
}

const agentRun = (agentId: string, orgId: string, userId: string, signedIn = true) => ({
  agentId, orgId, branchId: "default", userId, userName: "Owner User", ctx: signedIn ? {} : null,
  settings: {}, subjectId: "", input: {}, changeLog: [], actions: [], trace: [], renders: [], scratch: {}
}) as any;

async function tool(name: string) {
  const { platformAgentTools } = await import("../agents/platform_tools.js");
  const found = platformAgentTools.find((entry) => entry.name === name);
  assert.ok(found, `${name} is a shared platform tool`);
  return found;
}

test("every how-to entry is well formed and names only registered ids", async () => {
  const { howToProblems } = await import("../agents/how-tos/validate.js");
  const { HOW_TO_ENTRIES } = await import("../agents/how-tos/index.js");
  assert.ok(HOW_TO_ENTRIES.length >= 1);
  // A failure here names the entry, the step and the id. Fix the entry, or mark
  // the step `planned` if the thing it names is not built yet.
  assert.deepEqual(howToProblems(), []);
});

test("the check catches an unregistered id of every kind and exempts only planned steps", async () => {
  const { howToProblems } = await import("../agents/how-tos/validate.js");
  const entry = (steps: any[], extra: Record<string, unknown> = {}) => ({ id: "sample_entry", title: "Sample", use_when: "Testing the check.", steps, ...extra }) as any;
  const step = (refs: Record<string, string[]>, extra: Record<string, unknown> = {}) => ({ title: "Do it", detail: "Do the thing.", refs, ...extra });

  const sound = { automations: ["project.patch.v1"], events: ["call.completed"], data: ["custom-fields-project.contract"], actions: ["custom-fields.project.write"],
    field_types: ["organization_user"], tools: ["platform_search", "scope.save_scope_template", "assistant.get_project"] };
  assert.deepEqual(howToProblems([entry([step(sound)])]), []);

  const stale = { automations: ["payroll.payRule.apply.v1"], events: ["communication.call.ended"], data: ["custom-fields-project.nope"], actions: ["pay-rules.write"],
    field_types: ["payee"], tools: ["platform_nope", "scope.nope", "nobody.save_scope_template"] };
  const problems = howToProblems([entry([step(stale)])]);
  for (const id of Object.values(stale).flat()) assert.ok(problems.some((problem) => problem.includes(`'${id}' is not registered`)), `${id} is reported`);
  assert.equal(problems.length, 8);

  // The same ids on a planned step are allowed, but the step must say what is missing.
  assert.deepEqual(howToProblems([entry([step(stale, { planned: "Pay rules are not built." })])]), []);
  assert.ok(howToProblems([entry([step(stale, { planned: " " })])]).some((problem) => problem.includes("must say what is missing")));

  assert.ok(howToProblems([entry([step({ widgets: ["x"] })])]).some((problem) => problem.includes("unknown reference kind")));
  assert.ok(howToProblems([entry([step({}), step({})]), entry([step({})])]).some((problem) => problem.includes("used twice")));
  assert.ok(howToProblems([entry([step({})], { id: "Bad-Id" })]).some((problem) => problem.includes("snake_case")));
  assert.ok(howToProblems([entry([])]).some((problem) => problem.includes("steps")));
  assert.ok(howToProblems([entry([step({}, { detail: "x".repeat(901) })])]).some((problem) => problem.includes("detail")));
  assert.ok(howToProblems([entry([step({}, { detail: "Assign the crew." })])]).some((problem) => problem.includes("assignee")));
});

test("the shared prompt carries ids and titles, never entry bodies", async () => {
  const { platformAgentInstructions } = await import("../agents/platform_tools.js");
  const { HOW_TO_ENTRIES, howToPromptIndex } = await import("../agents/how-tos/index.js");
  assert.ok(platformAgentInstructions.includes(howToPromptIndex()));
  assert.ok(platformAgentInstructions.includes("platform_how_to_read"));
  for (const entry of HOW_TO_ENTRIES) {
    assert.ok(platformAgentInstructions.includes(`- ${entry.id}: ${entry.title}`));
    for (const body of [entry.use_when, ...entry.steps.flatMap((step) => [step.detail, step.planned || ""]), ...(entry.notes || [])].filter(Boolean)) {
      assert.ok(!platformAgentInstructions.includes(body), `${entry.id}: bodies are fetched with platform_how_to_read`);
    }
  }
  assert.equal(howToPromptIndex([]), "");
});

test("agents search and read how-tos through the shared platform tools, with planned steps labelled unavailable", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const search = await tool("platform_how_to_search");
  const read = await tool("platform_how_to_read");

  const all = await search.execute(agentRun("assistant", orgId, userId), {}) as any;
  assert.ok(all.how_tos.some((entry: any) => entry.id === "pay_for_project_role" && entry.planned_steps === 1));
  assert.ok(!JSON.stringify(all).includes("custom_field_values"), "search returns summaries, not bodies");
  const found = await search.execute(agentRun("assistant", orgId, userId), { query: "commission booked" }) as any;
  assert.deepEqual(found.how_tos.map((entry: any) => entry.id), ["pay_for_project_role"]);
  assert.deepEqual((await search.execute(agentRun("assistant", orgId, userId), { query: "zebra" }) as any).how_tos, []);

  const entry = await read.execute(agentRun("assistant", orgId, userId), { id: "pay_for_project_role" }) as any;
  assert.equal(entry.available, true);
  assert.deepEqual(entry.steps.map((step: any) => [step.step, step.status]), [[1, "available"], [2, "available"], [3, "planned"]]);
  assert.equal(entry.steps[2].unavailable, true);
  assert.match(entry.steps[2].warning, /NOT BUILT YET/);
  assert.ok(entry.steps[2].missing);
  assert.ok(Object.keys(entry.steps[2]).indexOf("warning") < Object.keys(entry.steps[2]).indexOf("detail"), "the label comes before the step text");
  assert.equal(entry.steps[0].unavailable, undefined);
  assert.deepEqual(entry.steps[1].refs.automations, ["project.patch.v1"]);
  // Template tools belong to the Automations Agent; the assistant is told so, the Automations Agent is not.
  assert.deepEqual(entry.steps[0].tools_of_another_agent.map((agent: any) => agent.agent), ["scope"]);
  assert.equal(entry.steps[0].unavailable_to_you, undefined, "an owner may read project field definitions");
  const forScopeAgent = await read.execute(agentRun("scope", orgId, userId), { id: "pay_for_project_role" }) as any;
  assert.equal(forScopeAgent.steps[0].tools_of_another_agent, undefined);

  const unknown = await read.execute(agentRun("assistant", orgId, userId), { id: "nope" }) as any;
  assert.equal(unknown.available, false);
  assert.ok(unknown.known_ids.includes("pay_for_project_role"));
  // Like the other platform tools, these need a current human user.
  await assert.rejects(async () => await read.execute(agentRun("assistant", orgId, userId, false), { id: "pay_for_project_role" }), /current human user/);
});

// pay_for_project_role, steps 1 and 2(b), run for real. If an assertion marked
// GAP starts failing, the platform changed: update the entry's notes with it.
test("pay_for_project_role: a completed call fills an assignee field through project.patch.v1 exactly as the entry says", async () => {
  const { payForProjectRole } = await import("../agents/how-tos/entries/pay_for_project_role.js");
  const recipe = payForProjectRole.steps[1]!.detail;
  for (const literal of ["custom_field_values", "{{event.context.actor_user_id}}", "call.completed", "onCompleted", "context.actor_user_id"]) assert.ok(recipe.includes(literal), `step 2 still names ${literal}`);

  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = "project_booked_by";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId, title: "How-To Project", address: "1 Recipe Way", events: [],
      custom_field_schema: { fields: [
        { path: "booked_by", label: "Booked by", type: "organization_user" },
        { path: "closer", label: "Closer", type: "organization_user" },
        { path: "setter", label: "Setter", type: "organization_user" },
        { path: "lead_note", label: "Lead note", type: "text" }
      ] },
      custom_field_values: { lead_note: "keep me" }
    },
    metadata: { kind: "platform_project" }
  });
  const reference = (subjectId: string) => ({ subject_type: "organization_user", subject_id: subjectId });
  const patch = (id: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, automation: "project.patch.v1", input: { values }, ...extra });
  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_booked_by", title: "Booking", source_key: "test:how-to", metadata: { hide_from_boards: true },
    // A project-level event never reaches a binding keyed by its name.
    automation_bindings: { "call.completed": [patch("scope_level", { scope_binding_ran: "yes" })] },
    root_nodes: [{
      id: "contact", title: "Contact lead", terminology_key: "work.task", actionable: true,
      external_triggers: [{ event: "call.completed", transition: "completed" }],
      automation_bindings: {
        "call.completed": [patch("node_level", { node_binding_ran: "yes" })],
        onCompleted: [patch("set_booked_by", { custom_field_values: { booked_by: reference("{{event.context.actor_user_id}}") } },
          { conditions: { match: "all", rules: [{ field: "context.actor_user_id", operator: "is_present" }] } })],
        onReady: [
          patch("wrong_key", { custom_fields: { setter: reference(userId) } }),
          patch("unchecked_id", { custom_field_values: { closer: reference("user_that_does_not_exist") } }, { depends_on: ["wrong_key"] })
        ]
      }
    }]
  });
  const { readDocument } = await import("../platform/storage.js");
  const read = async () => (await readDocument(orgId, "projects", projectId)).data as Record<string, any>;
  let project = await read();
  assert.equal(project.custom_field_values.booked_by, undefined, "nothing is written before the role is decided");
  // GAP: project.patch.v1 does not check that the referenced user exists or may hold the role.
  assert.deepEqual(project.custom_field_values.closer, reference("user_that_does_not_exist"), "an unchecked id was stored");
  // GAP: a value written under custom_fields instead of custom_field_values is dropped without an error.
  assert.equal(project.custom_field_values.setter, undefined);
  assert.equal(project.custom_fields.setter, undefined);

  // The work event a finished call emits is project-level and carries the handling user as context.actor_user_id.
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, { event: "call.completed", project_id: projectId, payload: { disposition: "answered", outcome: "scheduled" } });
  project = await read();
  assert.deepEqual(project.custom_field_values.booked_by, reference(userId));
  assert.deepEqual(project.custom_fields.booked_by, reference(userId), "both stored spellings agree");
  assert.equal(project.custom_field_values.lead_note, "keep me", "other field values survive the patch");
  assert.equal(project.scope_binding_ran, undefined);
  assert.equal(project.node_binding_ran, undefined);

  // The same value reads back through the published project field export.
  const { platformAgentTools } = await import("../agents/platform_tools.js");
  const values = await platformAgentTools.find((entry) => entry.name === "platform_read")!.execute(agentRun("assistant", orgId, userId), {
    source: { provider: "custom-fields-project", export: "values", target: { scope: "project", organizationId: orgId, projectId } }
  }) as any;
  assert.deepEqual(values.value?.booked_by, reference(userId));
});
