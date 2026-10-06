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
  const raw = async (method: string, url: string, payload?: unknown) => await (app.inject as any)({
    method, url, payload,
    headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
  });
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-automation-contracts-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
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
    name: "Owner User", company: "Automation Contracts Test Co", organization_id: `org_contracts_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string, userId: data.user?.id as string };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string, extra: Record<string, unknown> = {}) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Contracts Project", address: "1 Contract Way", events: [], ...extra },
    metadata: { kind: "platform_project" }
  });
}

async function readProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  const { readDocument } = await import("../platform/storage.js");
  return (await readDocument(orgId, "projects", projectId)).data as Record<string, any>;
}

const patch = (id: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, automation: "project.patch.v1", input: { values }, ...extra });

function pipelineDefinition(id: string, overrides: { contact?: Record<string, unknown>; extraTasks?: Record<string, unknown>[] } = {}) {
  return {
    schema_version: 1, id, kind: "pipeline", name: "Contracts Pipeline", status: "active",
    work_plan: { title: "Contracts Pipeline", root_nodes: [{
      id: "phase", title: "Sales", terminology_key: "work.phase", completion_mode: "all_children",
      children: [{
        id: "lead_stage", title: "New Lead", terminology_key: "work.stage", completion_mode: "all_children",
        children: [{
          id: "contact", title: "Contact lead", terminology_key: "work.task", actionable: true,
          external_triggers: [{ event: "communication.received", transition: "completed" }],
          ...(overrides.contact || {})
        }, ...(overrides.extraTasks || [])]
      }, {
        id: "won_stage", title: "Won", terminology_key: "work.stage", completion_mode: "all_children", depends_on: ["lead_stage"],
        children: [{ id: "celebrate", title: "Celebrate", terminology_key: "work.task", actionable: true,
          automation_bindings: { onReady: [patch("mark_won", { stage_marker: "won" })] } }]
      }]
    }] }
  };
}

test("conditions: one contract covers the equality map, operator groups, numbers and relative dates", async () => {
  const { evaluateConditions, explainConditions, validateConditions, allConditions } = await import("../work/conditions.js");
  const now = "2026-10-06T12:00:00.000Z";
  const context = {
    payload: { payment_kind: "deposit", amount_cents: 250000, received_at: "2026-10-05T12:00:00.000Z" },
    project: { claims: {}, tags: ["roof", "insurance"], lead_source: { kind: "Referral" }, total_cents: "1500000" }
  };
  // The original map form keeps its meaning, including the payload fallback and "" for missing.
  assert.equal(evaluateConditions({ payment_kind: "deposit", "project.claims.welcome_call": "" }, context), true);
  assert.equal(evaluateConditions({ "payload.payment_kind": ["final", "progress"] }, context), false);
  assert.equal(evaluateConditions({}, context), true);

  const group = { match: "all", rules: [
    { field: "project.total_cents", operator: "greater_than", value: 1000000 },
    { field: "payload.received_at", operator: "after", value: "now-3d" },
    { field: "project.tags", operator: "contains", value: "insurance" },
    { match: "any", rules: [{ field: "payload.payment_kind", operator: "in", value: ["deposit", "final"] }, { field: "project.missing", operator: "is_present" }] }
  ] };
  assert.equal(evaluateConditions(group, context, { now }), true);
  assert.equal(evaluateConditions({ match: "all", rules: [{ field: "payload.received_at", operator: "before", value: "now-3d" }] }, context, { now }), false);
  assert.equal(evaluateConditions({ match: "any", rules: [{ field: "project.total_cents", operator: "less_than", value: 5 }, { field: "project.nope", operator: "is_missing" }] }, context), true);
  // A non-numeric field never satisfies a numeric comparison.
  assert.equal(evaluateConditions({ rules: [{ field: "project.lead_source.kind", operator: "greater_than", value: 1 }] }, context), false);
  // Maps and groups combine.
  assert.equal(evaluateConditions(allConditions({ payment_kind: "deposit" }, group, {}), context, { now }), true);
  assert.deepEqual(allConditions({}, undefined), {});

  const trace = explainConditions(group, context, { now });
  assert.equal(trace.rules?.[0]?.actual, "1500000");
  assert.equal(trace.rules?.[3]?.kind, "group");

  // Intake routing compares case-insensitively and reads comma lists.
  assert.equal(evaluateConditions({ field: "lead_source.kind", operator: "equals", value: "referral, web" }, context.project, { caseInsensitive: true, commaLists: true, payloadFallback: false }), true);

  assert.deepEqual(validateConditions(group), []);
  assert.equal(validateConditions({ rules: [{ field: "a", operator: "roughly", value: 1 }] }).length, 1);
  assert.equal(validateConditions({ rules: [{ field: "a", operator: "greater_than", value: "lots" }] }).length, 1);
  assert.equal(validateConditions({ rules: [{ field: "a", operator: "before", value: "someday" }] }).length, 1);
  assert.equal(validateConditions({ "project.x": { nested: true } }).length, 1);
});

test("binding keys: a hook is exactly one event and both spellings merge without shadowing", async () => {
  const { bindingsForEvent, eventForBindingKey, bindingKeyForEvent, normalizeBindingKeys } = await import("../work/bindings.js");
  assert.equal(eventForBindingKey("onCompleted", "node"), "work.node.completed");
  assert.equal(eventForBindingKey("onStatusChanged", "node"), "work.node.status_changed");
  assert.equal(eventForBindingKey("onStarted", "plan"), "work.plan.started");
  assert.equal(eventForBindingKey("payment.received", "node"), "payment.received");
  assert.equal(bindingKeyForEvent("work.node.status_changed", "node"), "onStatusChanged");
  assert.equal(bindingKeyForEvent("work.plan.completed", "node"), "work.plan.completed");

  const bindings = { onCompleted: [{ id: "a", automation: "x" }], "work.node.completed": [{ id: "b", automation: "y" }, { id: "a", automation: "dup" }], "project.event.completed": [{ id: "c", automation: "z" }] };
  assert.deepEqual(bindingsForEvent(bindings, "work.node.completed", "node").map((binding) => binding.id), ["a", "b"]);
  // A hook no longer answers another domain's event that shares its suffix.
  assert.deepEqual(bindingsForEvent(bindings, "project.event.completed", "node").map((binding) => binding.id), ["c"]);
  assert.deepEqual(bindingsForEvent({ onCompleted: [{ id: "a" }] }, "project.event.completed", "node"), []);
  assert.deepEqual(Object.keys(normalizeBindingKeys(bindings, "node")).sort(), ["onCompleted", "project.event.completed"]);
  assert.deepEqual((normalizeBindingKeys(bindings, "node").onCompleted as any[]).map((binding) => binding.id), ["a", "b"]);
});

test("sequences compile to timers and bindings, and recompile idempotently", async () => {
  const { compileNodeSequence, workSequenceSchema } = await import("../work/sequences.js");
  const node = {
    id: "follow_up", title: "Follow up",
    automation_bindings: { onReady: [{ id: "own", automation: "project.patch.v1", input: {} }] },
    timers: [{ id: "manual", anchor: "ready", offset_minutes: 5 }],
    sequence: { steps: [
      { id: "now", actions: [{ automation: "communications.sendSms.v1", input: { text: "hi" } }] },
      { id: "later", wait: { days: 2 }, conditions: { "project.replied": "" }, actions: [{ id: "email", automation: "communications.sendEmail.v1", input: { subject: "s" } }, { automation: "work.createTodo.v1", input: { title: "Call" } }] },
      { id: "last", wait: { hours: 12 }, enabled: false, actions: [{ automation: "work.createTodo.v1", input: { title: "x" } }] },
      { id: "final", wait: { weeks: 1 }, actions: [{ automation: "work.createTodo.v1", input: { title: "Close out" } }] }
    ] }
  };
  const compiled = compileNodeSequence(node) as any;
  assert.deepEqual(compiled.timers.map((timer: any) => [timer.id, timer.offset_minutes]), [["manual", 5], ["sequence:later", 2880], ["sequence:final", 2880 + 720 + 10080]]);
  assert.deepEqual(compiled.automation_bindings.onReady.map((binding: any) => binding.id), ["own", "sequence_now_1"]);
  assert.deepEqual(compiled.automation_bindings.onTimer.map((binding: any) => binding.id), ["sequence_later_email", "sequence_later_2", "sequence_final_1"]);
  assert.deepEqual(compiled.automation_bindings.onTimer[0].conditions, { match: "all", rules: [{ "payload.timer_id": "sequence:later" }, { "project.replied": "" }] });
  assert.deepEqual(compileNodeSequence(compiled), compiled, "recompiling changes nothing");
  // Removing the sequence removes what it compiled and leaves hand-written entries.
  const cleared = compileNodeSequence({ ...compiled, sequence: undefined }) as any;
  assert.deepEqual(cleared.timers.map((timer: any) => timer.id), ["manual"]);
  assert.deepEqual(Object.keys(cleared.automation_bindings), ["onReady"]);
  assert.equal(workSequenceSchema.safeParse({ steps: [{ id: "a", actions: [{ automation: "x" }] }, { id: "a", actions: [{ automation: "x" }] }] }).success, false);
  assert.equal(workSequenceSchema.safeParse({ steps: [{ id: "a", wait: { fortnights: 1 }, actions: [{ automation: "x" }] }] }).success, false);
});

test("every registered action has an authoring contract consistent with its runtime input contract", async () => {
  const { registerBuiltinWorkAutomations } = await import("../work/automations/builtins.js");
  const { listWorkAutomationDefinitions } = await import("../work/registry.js");
  const { ACTION_CATALOG } = await import("../work/automations/catalog.js");
  const { Ajv } = await import("ajv");
  registerBuiltinWorkAutomations();
  const definitions = listWorkAutomationDefinitions().filter((action) => !/^(test\.|scope-test\.)/.test(action.id));
  const ajv = new Ajv({ strict: false });
  for (const action of definitions) {
    assert.ok(ACTION_CATALOG[action.id], `${action.id} needs a catalog entry in work/automations/catalog.ts`);
    assert.ok(action.title, `${action.id} has a title`);
    assert.doesNotThrow(() => ajv.compile(action.input_schema as object), `${action.id} input schema compiles`);
    // Every input the handler documents is a typed property.
    for (const key of Object.keys(action.input || {})) assert.ok((action.input_schema as any).properties?.[key], `${action.id}.${key} is typed in the catalog`);
  }
  for (const id of Object.keys(ACTION_CATALOG)) assert.ok(definitions.some((action) => action.id === id), `${id} is registered`);
});

test("the authoring catalog describes events, fields, operators, actions and hooks", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { catalog } = await client.request("GET", `/v1/scopes/organizations/${orgId}/automation-catalog`);
  const timer = catalog.events.find((event: any) => event.name === "work.node.timer");
  assert.ok(timer.fields.some((field: any) => field.field === "payload.timer_id"));
  assert.deepEqual(timer.usable_as, ["binding", "organization_rule"]);
  assert.ok(catalog.conditions.operators.some((operator: any) => operator.id === "greater_than"));
  const sms = catalog.actions.find((action: any) => action.id === "communications.sendSms.v1");
  assert.equal(sms.title, "Send a text message");
  assert.equal(sms.input_schema.properties.text["x-control"], "template_long_text");
  assert.ok(!catalog.actions.some((action: any) => action.internal), "setup actions are left out by default");
  assert.ok(catalog.hooks.work_item.some((hook: any) => hook.key === "onReady" && hook.event === "work.node.ready"));
  const internal = await client.request("GET", `/v1/scopes/organizations/${orgId}/automation-catalog?include_internal=1`);
  assert.ok(internal.catalog.actions.some((action: any) => action.id === "materials.initializeFromScope.v1"));
});

test("organization rules run several actions in order with per-action conditions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_multi_action";
  await createProject(client, orgId, projectId, { total_cents: 2500000 });
  const saved = await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [{
      id: "big_deposit", title: "Big deposit", event: "test.deposit",
      conditions: { match: "all", rules: [{ field: "project.total_cents", operator: "greater_than", value: 1000000 }] },
      automation: "project.patch.v1", input: { values: { first: "ran" } },
      actions: [
        { id: "second", automation: "project.patch.v1", input: { values: { second: "after {{project.first}}" } } },
        { id: "gated", automation: "project.patch.v1", input: { values: { gated: "ran" } }, conditions: { "payload.flavor": "special" } },
        { id: "third", automation: "project.patch.v1", input: { values: { third: "ran" } }, conditions: { "project.second": "after ran" } }
      ]
    }, {
      id: "small_only", event: "test.deposit", conditions: { rules: [{ field: "project.total_cents", operator: "less_than", value: 1000 }] },
      actions: [{ id: "only", automation: "project.patch.v1", input: { values: { small: "ran" } } }]
    }]
  });
  assert.equal(saved.rules.find((rule: any) => rule.id === "big_deposit").actions.length, 3);
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, { event: "test.deposit", project_id: projectId, payload: { flavor: "plain" } });
  const project = await readProject(client, orgId, projectId);
  assert.equal(project.first, "ran");
  assert.equal(project.second, "after ran", "a later action sees what an earlier one wrote");
  assert.equal(project.third, "ran");
  assert.equal(project.gated, undefined);
  assert.equal(project.small, undefined);

  const invalid = await client.raw("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [{ id: "bad", event: "test.x", actions: [{ id: "a", automation: "project.patch.v1" }, { id: "a", automation: "project.patch.v1" }] }]
  });
  assert.equal(invalid.statusCode, 400);
  const badCondition = await client.raw("PUT", `/v1/work/organizations/${orgId}/branches/default/automation-rules`, {
    rules: [{ id: "bad", event: "test.x", conditions: { rules: [{ field: "a", operator: "roughly", value: 1 }] }, automation: "project.patch.v1" }]
  });
  assert.equal(badCondition.statusCode, 400);
});

test("a sequence runs its first step at once and later steps from the scheduler, and stops when the work item completes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_sequence";
  await createProject(client, orgId, projectId);
  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_sequence", title: "Sequence", source_key: "test:sequence", metadata: { hide_from_boards: true },
    root_nodes: [{
      id: "cadence", title: "Follow-up cadence", terminology_key: "work.task", actionable: true,
      external_triggers: [{ event: "communication.received", transition: "completed" }],
      sequence: { steps: [
        { id: "first", actions: [patch("p1", { step_one: "ran" })] },
        { id: "second", wait: { minutes: 0.0001 }, actions: [patch("p2", { step_two: "ran" })] },
        { id: "third", wait: { days: 3 }, actions: [patch("p3", { step_three: "ran" })] }
      ] }
    }]
  });
  assert.equal((await readProject(client, orgId, projectId)).step_one, "ran");
  const { runWorkSchedulerTick } = await import("../work/scheduler.js");
  await new Promise((resolve) => setTimeout(resolve, 25));
  await runWorkSchedulerTick();
  let project = await readProject(client, orgId, projectId);
  assert.equal(project.step_two, "ran");
  assert.equal(project.step_three, undefined, "the three-day step has not fired");
  // The reply completes the work item; its remaining timer is no longer a candidate.
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, { event: "communication.received", project_id: projectId, payload: {} });
  const { timerCandidateNodes } = await import("../work/storage.js");
  assert.equal((await timerCandidateNodes()).filter((candidate) => candidate.plan_id === "plan_sequence").length, 0);
});

test("saving a template stores one spelling per event and rejects malformed conditions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const definition = pipelineDefinition("contracts_save", { contact: {
    automation_bindings: { "work.node.completed": [patch("raw", { a: 1 })], onCompleted: [patch("hook", { b: 1 })], "payment.received": [patch("pay", { c: 1 })] }
  } });
  const saved = await client.request("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/contracts_save`, definition);
  const contact = saved.template.definition.work_plan.root_nodes[0].children[0].children[0];
  assert.deepEqual(Object.keys(contact.automation_bindings).sort(), ["onCompleted", "payment.received"]);
  assert.deepEqual(contact.automation_bindings.onCompleted.map((binding: any) => binding.id), ["hook", "raw"]);

  const bad = pipelineDefinition("contracts_save_bad", { contact: { automation_bindings: { onReady: [patch("x", {}, { conditions: { rules: [{ field: "project.total", operator: "bigger", value: 1 }] } })] } } });
  const response = await client.raw("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/contracts_save_bad`, bad);
  assert.equal(response.statusCode, 400);
  assert.equal(JSON.parse(response.body).error, "scope_template_conditions");
});

test("a dry run reports what would happen and changes nothing", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_dry_run";
  await createProject(client, orgId, projectId, { customer_phone: "+15555550100", customer_email: "lead@example.test", total_cents: 2000000 });
  const definition = pipelineDefinition("contracts_dry", { contact: {
    sequence: { steps: [
      { id: "text", explainer: "We text new leads right away.", actions: [{ automation: "communications.sendSms.v1", input: { to: "{{project.customer_phone}}", text: "Hi from {{organization.name}}" } }] },
      { id: "nudge", wait: { days: 2 }, conditions: { rules: [{ field: "project.total_cents", operator: "greater_than", value: 1000000 }] },
        actions: [{ automation: "communications.sendEmail.v1", input: { to: "{{project.customer_email}}", text: "missing subject" } }, patch("flag", { nudged: "yes" })] }
    ] }
  } });
  const rules = [{ id: "reply_rule", title: "Reply rule", event: "communication.received", actions: [
    { id: "note", automation: "project.patch.v1", input: { values: { replied: "yes" } } },
    { id: "never", automation: "project.patch.v1", input: { values: { never: "yes" } }, conditions: { "project.replied": "no" } }
  ] }];
  const plansBefore = (await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`)).plans || [];
  const { result } = await client.request("POST", `/v1/scopes/organizations/${orgId}/branches/default/automation-dry-run`, {
    definition, rules, project_id: projectId,
    steps: [{ advance: { days: 2 } }, { event: "communication.received", payload: { channel: "sms" } }, { advance: { days: 30 } }]
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  const actionsOf = (step: any) => step.events.flatMap((event: any) => event.actions);
  const start = actionsOf(result.steps[0]);
  const text = start.find((action: any) => action.automation === "communications.sendSms.v1");
  assert.equal(text.would_run, true);
  assert.equal(text.input.to, "+15555550100", "inputs are interpolated from the real project");
  assert.equal(text.label, "We text new leads right away.");

  const nudge = actionsOf(result.steps[1]);
  const email = nudge.find((action: any) => action.automation === "communications.sendEmail.v1");
  assert.equal(email.would_run, true);
  assert.equal(email.conditions.matched, true);
  assert.ok(email.input_issues.some((issue: string) => issue.includes("subject")), "missing required input is reported");
  assert.equal(nudge.find((action: any) => action.id === "sequence_nudge_flag").would_run, true);

  const reply = result.steps[2].events[0];
  assert.deepEqual(reply.transitions.map((transition: any) => [transition.work_item.id, transition.to, transition.applied]), [["contact", "completed", true]]);
  assert.equal(reply.actions.find((action: any) => action.id === "org_rule:reply_rule:note").would_run, true);
  assert.equal(reply.actions.find((action: any) => action.id === "org_rule:reply_rule:never").reason, "conditions_not_met");
  // Completing the contact step unlocks the next stage, whose onReady action is reported too.
  assert.ok(actionsOf(result.steps[2]).some((action: any) => action.id === "mark_won" && action.would_run));
  assert.equal(result.final.work_items.find((item: any) => item.id === "contact").status, "completed");
  assert.equal(result.final.project_changes.stage_marker, "won");
  // Nothing more fires once the work item is done.
  assert.equal(actionsOf(result.steps[3]).length, 0);

  // Nothing was saved or sent.
  const project = await readProject(client, orgId, projectId);
  assert.equal(project.replied, undefined);
  assert.equal(project.nudged, undefined);
  const plans = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`);
  assert.equal((plans.plans || []).length, plansBefore.length, "no scope instance was created");
  const { listMessageRecords } = await import("../messaging/communications_storage.js");
  assert.equal((await listMessageRecords(orgId, { project_id: projectId })).length, 0);

  const invalid = await client.request("POST", `/v1/scopes/organizations/${orgId}/branches/default/automation-dry-run`, {
    definition: pipelineDefinition("contracts_dry_bad", { contact: { automation_bindings: { onReady: [{ id: "x", automation: "does.not.exist.v1", input: {} }] } } }), steps: []
  });
  assert.equal(invalid.result.ok, false);
  assert.ok(invalid.result.errors[0].includes("does.not.exist.v1"));
});

test("template edits reach running instances only when pushed, and a push keeps progress", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const templateUrl = `/v1/scopes/organizations/${orgId}/branches/default/templates/contracts_push`;
  const first = await client.request("PUT", templateUrl, pipelineDefinition("contracts_push", { contact: {
    external_triggers: [{ event: "test.contacted", transition: "completed" }],
    automation_bindings: { onCompleted: [patch("on_contact", { contacted_by: "v1" })] }
  }, extraTasks: [{ id: "old_step", title: "Old step", terminology_key: "work.task", actionable: true }] }));
  const { instantiateScopeTemplateWorkPlan } = await import("../scopes/service.js");
  const { listNodeRecords } = await import("../work/storage.js");
  for (const projectId of ["project_push_a", "project_push_b"]) {
    await createProject(client, orgId, projectId);
    await instantiateScopeTemplateWorkPlan(orgId, { project_id: projectId, branch_id: "default", template: first.template });
  }
  const second = await client.request("PUT", templateUrl, { ...pipelineDefinition("contracts_push", { contact: {
    title: "Reach the lead",
    external_triggers: [{ event: "test.contacted", transition: "completed" }],
    automation_bindings: { onCompleted: [patch("on_contact", { contacted_by: "v2" })] }
  }, extraTasks: [{ id: "qualify", title: "Qualify", terminology_key: "work.task", actionable: true, automation_bindings: { onReady: [patch("qualify_ready", { qualify: "ready" })] } }] }), expected_version: first.template.version });
  assert.equal(second.instances, undefined, "a plain save does not touch running instances");

  // Unpushed: the running instance still behaves as version 1.
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, { event: "test.contacted", project_id: "project_push_a", payload: {} });
  assert.equal((await readProject(client, orgId, "project_push_a")).contacted_by, "v1");

  const preview = await client.request("GET", `${templateUrl}/instances`);
  assert.equal(preview.needing_update, 2);
  const previewB = preview.instances.find((instance: any) => instance.project_id === "project_push_b");
  assert.deepEqual(previewB.changes.added.map((node: any) => node.id), ["qualify"]);
  assert.deepEqual(previewB.changes.removed.map((node: any) => [node.id, node.action]), [["old_step", "kept"]]);
  assert.ok(previewB.changes.updated.some((node: any) => node.id === "contact" && node.changed.includes("automations") && node.changed.includes("title")));
  assert.equal((await readProject(client, orgId, "project_push_b")).qualify, undefined, "a preview changes nothing");

  const applied = await client.request("POST", `${templateUrl}/instances/update`, { project_ids: ["project_push_b"], removed_work: "skip" });
  assert.equal(applied.updated, 1);
  const nodes = await listNodeRecords(orgId, { project_id: "project_push_b" });
  const byId = Object.fromEntries(nodes.map((node) => [node.template_node_id, node]));
  assert.equal(byId.contact.title, "Reach the lead");
  assert.equal(byId.contact.status, "ready", "existing work keeps its status");
  assert.equal(byId.qualify.status, "ready", "new work becomes ready through the normal rules");
  assert.equal(byId.old_step.status, "skipped");
  assert.equal((await readProject(client, orgId, "project_push_b")).qualify, "ready", "the new work item's automation ran");
  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, { event: "test.contacted", project_id: "project_push_b", payload: {} });
  assert.equal((await readProject(client, orgId, "project_push_b")).contacted_by, "v2");

  const after = await client.request("GET", `${templateUrl}/instances`);
  assert.equal(after.instances.find((instance: any) => instance.project_id === "project_push_b").up_to_date, true);
  assert.equal(after.needing_update, 1, "the other project was left alone");

  // Saving with apply_to_instances pushes in the same request.
  const third = await client.request("PUT", templateUrl, { ...second.template.definition, description: "v3", expected_version: second.template.version, apply_to_instances: "open" });
  assert.equal(third.template.definition.apply_to_instances, undefined);
  assert.ok(third.instances.updated >= 1);
});
