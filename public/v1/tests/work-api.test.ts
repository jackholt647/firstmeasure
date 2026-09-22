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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-work-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.MESSAGING_STORAGE_ROOT = path.join(storageRoot, 'messaging');
  process.env.CHANNELS_STORAGE_ROOT = path.join(storageRoot, 'channels');
  process.env.CUSTOMER_CALL_WORKER_DISABLED = '1';
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  (await closeWorkDatabase());
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
    email: `work-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Work Owner",
    company: "Work Test Org",
    organization_id: `org_work_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

test("scope presets are versioned and exposed by the Scope API", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const response = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates`);
  assert.equal(response.count, 11);
  const roof = response.templates.find((item: any) => item.id === "roof_replacement");
  assert.equal(roof.name, "Roof Replacement");
  assert.equal(roof.version, 1);
  assert.equal(roof.definition.work_plan.root_nodes[0].terminology_key, "work.phase");
  assert.ok(roof.definition.work_plan.root_nodes[0].children.some((item: any) => item.terminology_key === "work.stage"));
  assert.deepEqual(
    roof.definition.work_plan.root_nodes[0].children.map((item: any) => item.title),
    ["Pending Deposit", "Newly Sold", "Scheduled", "Pre-Production", "Production Completed"]
  );
  assert.equal(roof.definition.work_plan.metadata.board_color, "#dc2626");
  assert.equal(roof.definition.work_plan.metadata.canceled_column.title, "Cancelled");
  assert.equal(roof.definition.work_plan.root_nodes[0].automation_bindings.onStarted[0].automation, "notification.create.v1");
  assert.deepEqual(roof.definition.commissions.roles.map((role: any) => [role.key, role.assignment_source, role.custom_field_path]), [
    ["estimator", "project_custom_field", "assignments.estimator"],
    ["inside_salesperson", "project_custom_field", "assignments.inside_salesperson"]
  ]);
  assert.deepEqual(
    roof.definition.custom_fields.fields.map((field: any) => field.path),
    [
      "assignments.estimator",
      "assignments.inside_salesperson",
      "assignments.project_manager",
      "assignments.production_team"
    ]
  );
  assert.equal(roof.definition.communications.email_forwarding.target.custom_field_path, "assignments.project_manager");
  const sales = response.templates.find((item: any) => item.id === "sales_pipeline");
  assert.deepEqual(
    sales.definition.custom_fields.fields.map((field: any) => field.path),
    ["assignments.estimator", "assignments.inside_salesperson"]
  );
  assert.equal(sales.definition.custom_fields.fields[0].default_from.event_type_id, "sales_appointment");
  assert.equal(sales.definition.custom_fields.fields[1].default_from.source, "event_scheduler");
  assert.equal(sales.definition.communications.email_forwarding.target.custom_field_path, "assignments.estimator");
  const estimatorCommission = roof.definition.commissions.rules.find((rule: any) => rule.payee_role === "estimator");
  const insideSalesCommission = roof.definition.commissions.rules.find((rule: any) => rule.payee_role === "inside_salesperson");
  assert.equal(estimatorCommission.calculation.rate_bps, 1000);
  assert.deepEqual(estimatorCommission.installments.map((installment: any) => [installment.id, installment.share_bps, installment.recognition.node_id]), [
    ["deposit", 5000, "deposit_paid"],
    ["completion", 5000, "finish_project"]
  ]);
  assert.equal(insideSalesCommission.calculation.fixed_amount_cents, 10000);
  assert.equal(insideSalesCommission.installments[0].recognition.node_id, "deposit_paid");
  const newlySold = roof.definition.work_plan.root_nodes[0].children.find((item: any) => item.id === "newly_sold_stage");
  const welcomeCall = newlySold.children.find((item: any) => item.id === "welcome_call");
  assert.equal(welcomeCall.automation_bindings.onReady[0].automation, "crm.callLists.add.v1");
  assert.equal(welcomeCall.automation_bindings.onReady[0].input.list.key, "new_customers");
  assert.equal(welcomeCall.automation_bindings.onCompleted[0].automation, "crm.callLists.remove.v1");
  assert.equal(welcomeCall.metadata.call_list_kind, "signature");
  const scheduling = roof.definition.work_plan.root_nodes[0].children.find((item: any) => item.id === "scheduled_stage");
  const deliveries = scheduling.children.find((item: any) => item.id === "schedule_material_deliveries");
  assert.deepEqual(deliveries.children.map((item: any) => item.id), ["schedule_dry_in_delivery", "schedule_shingle_delivery"]);
  const shareSchedule = scheduling.children.find((item: any) => item.id === "share_project_schedule_with_customer");
  assert.equal(shareSchedule.title, "Share project schedule with customer");
  assert.equal(shareSchedule.actionable, true);
  assert.equal(shareSchedule.show_in_todo_list, true);
  assert.deepEqual(shareSchedule.depends_on, ["schedule_material_deliveries", "schedule_crew_arrival"]);
  assert.deepEqual(shareSchedule.metadata.frontend_action, { kind: "open_project_scheduling", tab: "schedule" });

  const saved = await client.request("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement`, {
    ...roof.definition,
    details: "Updated roof workflow details.",
    expected_version: roof.version
  });
  assert.equal(saved.template.version, 2);
  assert.equal(saved.template.details, "Updated roof workflow details.");
  const versions = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement/versions`);
  assert.deepEqual(versions.versions.map((item: any) => item.version), [2, 1]);

  const concurrent = await Promise.all([
    client.raw("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement`, {
      ...saved.template.definition,
      details: "First concurrent edit.",
      expected_version: 2
    }),
    client.raw("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement`, {
      ...saved.template.definition,
      details: "Second concurrent edit.",
      expected_version: 2
    })
  ]);
  assert.deepEqual(concurrent.map((result) => result.statusCode).sort(), [200, 409]);
  const concurrentVersions = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement/versions`);
  assert.deepEqual(concurrentVersions.versions.map((item: any) => item.version), [3, 2, 1]);

  const stale = await client.raw("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/roof_replacement`, {
    ...roof.definition,
    details: "This edit is stale.",
    expected_version: 1
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.data.error, "scope_template_version_conflict");

  const guardedReset = await client.raw("POST", `/v1/scopes/organizations/${orgId}/branches/default/templates/reset-defaults`, {});
  assert.equal(guardedReset.statusCode, 409);
  assert.equal(guardedReset.data.error, "custom_scope_templates_exist");

  const reset = await client.request("POST", `/v1/scopes/organizations/${orgId}/branches/default/templates/reset-defaults`, { force: true });
  const resetRoof = reset.templates.find((item: any) => item.id === "roof_replacement");
  assert.equal(resetRoof.version, 1);
  assert.equal(resetRoof.details, roof.details);
  assert.equal(resetRoof.definition.metadata.preset, true);

  const legacyProjectId = "legacy_roof_board_project";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${legacyProjectId}`, {
    data: { id: legacyProjectId, title: "Legacy Roof Project", branch_id: "default", address: "12 Legacy Way" },
    metadata: { kind: "platform_project" }
  });
  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${legacyProjectId}/plans`, {
    source_type: "signed_proposal_scope",
    source_key: `legacy_roof:${legacyProjectId}`,
    template_id: "roof_replacement",
    template_version: 1,
    title: "Legacy Roof Replacement",
    root_nodes: [{
      id: "roof_replacement_phase",
      title: "Roof Replacement",
      terminology_key: "work.phase",
      completion_mode: "all_children",
      children: [
        { id: "contract_stage", title: "Contract", terminology_key: "work.stage", actionable: true },
        { id: "onboarding_stage", title: "Onboarding", terminology_key: "work.stage", actionable: true, depends_on: ["contract_stage"] },
        { id: "scheduling_stage", title: "Scheduling", terminology_key: "work.stage", actionable: true, depends_on: ["onboarding_stage"] },
        { id: "production_stage", title: "Production", terminology_key: "work.stage", actionable: true, depends_on: ["scheduling_stage"] },
        { id: "closeout_stage", title: "Closeout", terminology_key: "work.stage", actionable: true, depends_on: ["production_stage"] }
      ]
    }]
  });
  const migratedBoards = await client.request("GET", `/v1/work/organizations/${orgId}/boards?include_completed=1`);
  const migratedRoofBoard = migratedBoards.boards.find((item: any) => item.id === "roof_replacement");
  assert.equal(migratedRoofBoard.color, "#dc2626");
  assert.deepEqual(migratedRoofBoard.columns.map((column: any) => column.title), ["Pending Deposit", "Newly Sold", "Scheduled", "Pre-Production", "Production Completed", "Cancelled"]);
  assert.equal(migratedRoofBoard.columns[0].cards[0].project_id, legacyProjectId);
});

test("completed manual to-dos can be explicitly reopened for undo and completed again", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    id: "undoable_manual_todo",
    title: "Confirm appointment"
  });
  const nodeId = created.todo.id;
  assert.equal(created.todo.status, "ready");

  const completed = await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${nodeId}/transition`, {
    status: "completed",
    reason: "manual"
  });
  assert.equal(completed.node.status, "completed");
  assert.ok(completed.node.completed_at);

  const normalReopen = await client.raw("POST", `/v1/work/organizations/${orgId}/nodes/${nodeId}/transition`, {
    status: "ready"
  });
  assert.equal(normalReopen.statusCode, 400);

  const reopened = await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${nodeId}/transition`, {
    status: "ready",
    allow_reopen: true,
    reason: "undo_manual_completion"
  });
  assert.equal(reopened.node.status, "ready");
  assert.equal(reopened.node.completed_at, null);

  const plan = await client.request("GET", `/v1/work/organizations/${orgId}/plans/${created.plan.id}`);
  assert.equal(plan.plan.status, "active");
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${nodeId}/transition`, {
    status: "completed",
    reason: "redo_manual_completion"
  });

  const dependentPlan = await client.request("POST", `/v1/work/organizations/${orgId}/projects/undo_dependency_project/plans`, {
    id: "undo_dependency_plan",
    title: "Undo dependencies",
    source_key: "test:undo-dependencies",
    root_nodes: [
      { id:"first", title:"First", actionable:true },
      { id:"second", title:"Second", actionable:true, depends_on:["first"] }
    ]
  });
  const first = dependentPlan.tree.root_nodes.find((item: any) => item.template_node_id === "first");
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${first.id}/transition`, { status:"completed" });
  const progressed = await client.request("GET", `/v1/work/organizations/${orgId}/plans/undo_dependency_plan`);
  assert.equal(progressed.plan.root_nodes.find((item: any) => item.template_node_id === "second").status, "ready");
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${first.id}/transition`, {
    status:"ready",
    allow_reopen:true,
    reason:"undo_manual_completion"
  });
  const rolledBack = await client.request("GET", `/v1/work/organizations/${orgId}/plans/undo_dependency_plan`);
  assert.equal(rolledBack.plan.root_nodes.find((item: any) => item.template_node_id === "second").status, "blocked");
});

test("organization scope flags filter new choices without hiding templates or versions", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const flagsUrl = `/v1/scopes/organizations/${orgId}/scope-flags?branch_id=default`;
  const templatesUrl = `/v1/scopes/organizations/${orgId}/branches/default/templates`;

  const defaults = await client.request("GET", flagsUrl);
  assert.equal(defaults.revision, 1);
  assert.equal(defaults.catalog.length, 11);
  assert.equal(defaults.enabled_scope_ids.length, 11);
  assert.ok(defaults.catalog.every((item: any) => item.enabled === true));
  assert.ok(defaults.catalog.every((item: any) => defaults.flags[item.id] === true));

  const disabled = await client.request("PATCH", flagsUrl, {
    expected_revision: defaults.revision,
    flags: { roof_replacement: false }
  });
  assert.equal(disabled.revision, 2);
  assert.equal(disabled.flags.roof_replacement, false);
  assert.ok(!disabled.enabled_scope_ids.includes("roof_replacement"));

  const visible = await client.request("GET", templatesUrl);
  assert.equal(visible.count, 10);
  assert.ok(!visible.templates.some((item: any) => item.id === "roof_replacement"));

  const all = await client.request("GET", `${templatesUrl}?include_disabled=1`);
  assert.equal(all.count, 11);
  assert.equal(all.templates.find((item: any) => item.id === "roof_replacement").enabled, false);

  const direct = await client.request("GET", `${templatesUrl}/roof_replacement`);
  assert.equal(direct.template.id, "roof_replacement");
  assert.equal(direct.template.enabled, false);
  const historical = await client.request("GET", `${templatesUrl}/roof_replacement/versions/1`);
  assert.equal(historical.version.version, 1);
  assert.equal(historical.version.definition.id, "roof_replacement");

  const stale = await client.raw("PATCH", flagsUrl, {
    expected_revision: defaults.revision,
    flags: { roof_replacement: true }
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.data.error, "scope_flags_revision_conflict");

  const unknown = await client.raw("PATCH", flagsUrl, {
    expected_revision: disabled.revision,
    flags: { scope_that_does_not_exist: false }
  });
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.data.error, "scope_flag_template_not_found");

  const renamed = await client.request("PUT", `${templatesUrl}/roof_replacement`, {
    ...direct.template.definition,
    name: "Roofing Replacement",
    expected_version: direct.template.version
  });
  assert.equal(renamed.template.name, "Roofing Replacement");
  assert.equal(renamed.template.enabled, false);
  const afterRename = await client.request("GET", flagsUrl);
  assert.equal(afterRename.flags.roof_replacement, false);

  const repairs = await client.request("GET", `${templatesUrl}/repairs`);
  const custom = await client.request("PUT", `${templatesUrl}/custom_exterior`, {
    ...repairs.template.definition,
    id: "custom_exterior",
    name: "Custom Exterior",
    description: "A custom scope type."
  });
  assert.equal(custom.template.enabled, true);
  const visibleWithCustom = await client.request("GET", templatesUrl);
  assert.equal(visibleWithCustom.count, 11);
  assert.ok(visibleWithCustom.templates.some((item: any) => item.id === "custom_exterior" && item.enabled === true));
  const finalFlags = await client.request("GET", flagsUrl);
  assert.equal(finalFlags.flags.custom_exterior, true);
  assert.ok(finalFlags.enabled_scope_ids.includes("custom_exterior"));
});

test("branch terminology is persisted and inherited by new work plans", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const defaults = await client.request("GET", `/v1/work/organizations/${orgId}/branches/default/config`);
  assert.equal(defaults.configuration.terminology.stage, "Stage");
  const saved = await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/config`, {
    expected_revision: defaults.configuration.revision,
    terminology: { phase: "Program", stage: "Board", task: "Work Item", board: "Pipeline" }
  });
  assert.equal(saved.configuration.terminology.task, "Work Item");

  const projectId = "project_custom_terms";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Custom Terms", branch_id: "default", events: [] },
    metadata: { kind: "platform_project" }
  });
  const plans = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans?include_tree=1`);
  const sales = plans.plans.find((plan: any) => plan.template_id === "sales_pipeline");
  assert.equal(sales.terminology.phase, "Program");
  assert.equal(sales.terminology.board, "Pipeline");
});

test("work nodes progress dependencies, roll up parents, run automations, and deduplicate events", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_work_engine";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Work Engine Project", branch_id: "default", events: [] },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_work_engine",
    title: "Test Work",
    source_key: "test:work-engine",
    root_nodes: [{
      id: "phase",
      title: "Production",
      terminology_key: "work.phase",
      completion_mode: "all_children",
      children: [
        {
          id: "stage_one",
          title: "First Stage",
          terminology_key: "work.stage",
          completion_mode: "all_children",
          children: [{
            id: "first_task",
            title: "First Task",
            terminology_key: "work.task",
            actionable: true,
            automation_bindings: {
              onCompleted: [{ id: "mark_project", automation: "project.patch.v1", input: { values: { work_test_complete: true } } }]
            }
          }]
        },
        {
          id: "stage_two",
          title: "Second Stage",
          terminology_key: "work.stage",
          completion_mode: "all_children",
          depends_on: ["stage_one"],
          children: [{ id: "second_task", title: "Second Task", terminology_key: "work.task", actionable: true }]
        }
      ]
    }]
  });
  assert.equal(created.created, true);
  const firstTask = created.tree.root_nodes[0].children[0].children[0];
  const secondStage = created.tree.root_nodes[0].children[1];
  assert.equal(firstTask.status, "ready");
  assert.equal(secondStage.status, "blocked");
  const currentTodos = await client.request("GET", `/v1/work/organizations/${orgId}/todos?project_id=${projectId}&all_users=1&include_unassigned=1`);
  assert.ok(currentTodos.todos.some((item: any) => item.template_node_id === "first_task"));
  assert.ok(!currentTodos.todos.some((item: any) => item.template_node_id === "second_task"));
  assert.equal(currentTodos.todos.find((item: any) => item.template_node_id === "first_task").project_title, "Work Engine Project");
  const projectTodos = await client.request("GET", `/v1/work/organizations/${orgId}/todos?project_id=${projectId}&all_users=1&include_unassigned=1&include_future=1`);
  assert.equal(projectTodos.todos.find((item: any) => item.template_node_id === "first_task").status, "ready");
  assert.equal(projectTodos.todos.find((item: any) => item.template_node_id === "second_task").status, "blocked");

  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${firstTask.id}/transition`, { status: "completed" });
  const progressed = await client.request("GET", `/v1/work/organizations/${orgId}/plans/plan_work_engine`);
  assert.equal(progressed.plan.root_nodes[0].children[0].status, "completed");
  assert.equal(progressed.plan.root_nodes[0].children[1].status, "active");
  assert.equal(progressed.plan.root_nodes[0].children[1].children[0].status, "ready");

  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(project.document.data.work_test_complete, true);

  const executions = await client.request("GET", `/v1/work/organizations/${orgId}/executions`);
  assert.equal(executions.executions.filter((item: any) => item.automation === "project.patch.v1").length, 1);

  const duplicate = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    title: "Duplicate",
    source_key: "test:work-engine",
    root_nodes: [{ id: "ignored", title: "Ignored", actionable: true }]
  });
  assert.equal(duplicate.created, false);

  const secondTask = progressed.plan.root_nodes[0].children[1].children[0];
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${secondTask.id}/transition`, { status: "completed" });
  const completed = await client.request("GET", `/v1/work/organizations/${orgId}/plans/plan_work_engine`);
  assert.equal(completed.plan.status, "completed");
  assert.equal(completed.plan.root_nodes[0].status, "completed");
});

test("scope call-list automations create queues and dispositions complete their work nodes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_scope_call_list";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      title: "Scope Call Project",
      address: "90 Welcome Lane",
      contacts: [{ name: "Jamie Customer", phone: "+12065550199" }]
    },
    metadata: { kind: "platform_project" }
  });
  const created = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_scope_call_list",
    title: "Roof Replacement",
    source_key: "test:scope-call-list",
    template_id: "roof_replacement",
    root_nodes: [{
      id: "welcome_call",
      title: "Welcome call",
      actionable: true,
      automation_bindings: {
        onReady: [{
          id: "queue_welcome_call",
          automation: "crm.callLists.add.v1",
          input: {
            list: { key: "new_customers", title: "New Customers", kind: "signature", assigned_role_ids: ["office"] }
          }
        }],
        onCompleted: [{ id: "remove_welcome_call", automation: "crm.callLists.remove.v1", input: {} }]
      }
    }]
  });
  const nodeId = created.tree.root_nodes[0].id;
  const queue = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { role_ids: ["office"] });
  const newCustomers = queue.columns.find((column: any) => column.key === "new_customers");
  assert.equal(newCustomers.tasks[0].work_node_id, nodeId);
  assert.equal(newCustomers.tasks[0].name, "Jamie Customer");

  await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${newCustomers.tasks[0].id}/disposition`, {
    actor_email: "office@example.test",
    disposition: "answered",
    note_text: "Welcome call complete."
  });
  const plan = await client.request("GET", `/v1/work/organizations/${orgId}/plans/plan_scope_call_list`);
  assert.equal(plan.plan.root_nodes[0].status, "completed");
  const after = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { role_ids: ["office"] });
  assert.equal(after.columns.find((column: any) => column.key === "new_customers").tasks.length, 0);
});

test("tagged follow-up to-dos are the single source for Calls and configured outcomes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_canonical_follow_up";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Canonical Follow-up",
      address: "14 Unified Way",
      branch_id: "default",
      stage: "new_lead",
      stage_id: "new_lead",
      contacts: [{ name: "Taylor Lead", phone: "+12065550140" }],
      events: []
    },
    metadata: { kind: "platform_project" }
  });
  const initialQueue = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { branch_id: "default" });
  assert.equal(initialQueue.follow_up_configuration.default_time, "");
  assert.deepEqual(initialQueue.follow_up_configuration.retry_policy.steps.map((item: any) => item.label), ["Day 1", "Day 2", "Day 3", "Day 5", "Then weekly"]);
  const currentConfiguration = await client.request("GET", `/v1/work/organizations/${orgId}/branches/default/config`);
  const configuredSteps = initialQueue.follow_up_configuration.retry_policy.steps.map((step: any, index: number) => index === 0 ? { ...step, label: "Three-day first retry", amount: 3 } : step);
  await client.request("PUT", `/v1/work/organizations/${orgId}/branches/default/config`, {
    expected_revision: currentConfiguration.configuration.revision,
    follow_ups: {
      ...initialQueue.follow_up_configuration,
      retry_policy: { ...initialQueue.follow_up_configuration.retry_policy, steps: configuredSteps }
    }
  });
  const newLeadEntry = initialQueue.columns.find((column: any) => column.key === "new_leads").tasks[0];
  const firstAutomaticRetry = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${newLeadEntry.id}/disposition`, {
    disposition: "no_answer",
    actor_email: "owner@example.test"
  });
  assert.equal(firstAutomaticRetry.follow_up_result.successor.metadata.follow_up.policy_step_index, 0);
  assert.equal(firstAutomaticRetry.follow_up_result.successor.metadata.follow_up.policy_step_label, "Three-day first retry");
  assert.equal(firstAutomaticRetry.follow_up_result.successor.metadata.follow_up.policy_trigger, "no_answer");
  assert.match(firstAutomaticRetry.follow_up_result.successor.due_at, /^\d{4}-\d{2}-\d{2}$/);
  const expectedFirstRetry = new Date();
  expectedFirstRetry.setDate(expectedFirstRetry.getDate() + 3);
  const expectedFirstRetryDate = `${expectedFirstRetry.getFullYear()}-${String(expectedFirstRetry.getMonth() + 1).padStart(2, "0")}-${String(expectedFirstRetry.getDate()).padStart(2, "0")}`;
  assert.equal(firstAutomaticRetry.follow_up_result.successor.due_at, expectedFirstRetryDate);

  const automaticNodeId = firstAutomaticRetry.follow_up_result.successor.id;
  await client.request("PATCH", `/v1/work/organizations/${orgId}/nodes/${automaticNodeId}`, { due_at: new Date(Date.now() - 45_000).toISOString() });
  const automaticDueQueue = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { branch_id: "default" });
  const automaticEntry = automaticDueQueue.columns.find((column: any) => column.key === "follow_ups").tasks.find((task: any) => task.work_node_id === automaticNodeId);
  const secondAutomaticRetry = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${automaticEntry.id}/disposition`, {
    disposition: "voicemail",
    actor_email: "owner@example.test"
  });
  assert.equal(secondAutomaticRetry.follow_up_result.successor.metadata.follow_up.policy_step_index, 1);
  assert.equal(secondAutomaticRetry.follow_up_result.successor.metadata.follow_up.policy_trigger, "voicemail");

  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const created = await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    kind: "follow_up",
    title: "Call Taylor back",
    project_id: projectId,
    due_at: dueAt
  });
  assert.equal(created.todo.metadata.kind, "follow_up");
  assert.deepEqual(created.todo.metadata.type_tags, ["follow_up"]);
  const directCompletion = await client.raw("POST", `/v1/work/organizations/${orgId}/nodes/${created.todo.id}/transition`, {
    status: "completed",
    reason: "manual"
  });
  assert.equal(directCompletion.statusCode, 400);
  assert.equal(directCompletion.data.error, "follow_up_outcome_required");

  const today = new Date();
  const todayDateOnly = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const untimedToday = await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    kind: "follow_up", title: "Untimed follow-up", project_id: projectId, due_at: todayDateOnly
  });
  const laterToday = new Date();
  laterToday.setHours(23, 59, 59, 999);
  const timedLaterToday = await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    kind: "follow_up", title: "Timed follow-up later today", project_id: projectId, due_at: laterToday.toISOString()
  });

  const queue = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { branch_id: "default" });
  assert.deepEqual(queue.follow_up_configuration.quick_options.map((item: any) => item.label), ["1 day", "2 days", "1 week", "1 month"]);
  const followUpList = queue.columns.find((column: any) => column.key === "follow_ups");
  assert.equal(followUpList.tasks.length, 3);
  assert.equal(followUpList.tasks[0].work_node_id, created.todo.id);
  assert.equal(followUpList.tasks[1].work_node_id, untimedToday.todo.id);
  assert.equal(followUpList.tasks[2].work_node_id, timedLaterToday.todo.id);

  const nextDueAt = new Date(Date.now() + 86_400_000).toISOString();
  const disposition = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${followUpList.tasks[0].id}/disposition`, {
    actor_email: "owner@example.test",
    disposition: "answered",
    outcome: "follow_up",
    followup: { due_at: nextDueAt }
  });
  assert.equal(disposition.follow_up_result.outcome.action, "reschedule");
  assert.equal(disposition.follow_up_result.successor.metadata.follow_up.parent_follow_up_id, created.todo.id);
  assert.deepEqual(disposition.follow_up_result.successor.metadata.type_tags, ["follow_up"]);

  const afterReschedule = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { branch_id: "default" });
  assert.equal(afterReschedule.columns.find((column: any) => column.key === "follow_ups").tasks.length, 2);
  const successorId = disposition.follow_up_result.successor.id;
  await client.request("PATCH", `/v1/work/organizations/${orgId}/nodes/${successorId}`, { due_at: new Date(Date.now() - 30_000).toISOString() });
  const dueAgain = await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-lists/queue`, { branch_id: "default" });
  const lostEntry = dueAgain.columns.find((column: any) => column.key === "follow_ups").tasks[0];
  await client.request("POST", `/v1/internal/crm/organizations/${orgId}/call-list-entries/${lostEntry.id}/disposition`, {
    actor_email: "owner@example.test",
    disposition: "answered",
    outcome: "lost"
  });
  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(project.document.data.lifecycle.status, "lost");
  assert.equal(project.document.data.lead_status, "lost");
});

test("generated ids are organization-safe and targeted events only advance their own scope plan", async () => {
  const firstClient = createSessionClient();
  const secondClient = createSessionClient();
  const first = await register(firstClient);
  const second = await register(secondClient);
  const projectId = "project_shared_identifier";
  for (const [client, orgId] of [[firstClient, first.orgId], [secondClient, second.orgId]] as const) {
    await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
      data: { id: projectId, title: "Shared Identifier", branch_id: "default", events: [] },
      metadata: { kind: "platform_project" }
    });
  }
  const definition = {
    title: "Scoped Work",
    source_key: "same-source-key",
    root_nodes: [{
      id: "schedule_work",
      title: "Schedule work",
      actionable: true,
      external_triggers: [{
        event: "project.event_scheduled",
        transition: "completed",
        conditions: { "payload.event_type_default_id": "project_work" }
      }]
    }]
  };
  const firstPlan = await firstClient.request("POST", `/v1/work/organizations/${first.orgId}/projects/${projectId}/plans`, definition);
  const secondPlan = await secondClient.request("POST", `/v1/work/organizations/${second.orgId}/projects/${projectId}/plans`, definition);
  assert.notEqual(firstPlan.plan.id, secondPlan.plan.id);

  const parallelPlans = await Promise.all([
    firstClient.request("POST", `/v1/work/organizations/${first.orgId}/projects/${projectId}/plans`, { ...definition, source_key: "parallel-source-key" }),
    firstClient.request("POST", `/v1/work/organizations/${first.orgId}/projects/${projectId}/plans`, { ...definition, source_key: "parallel-source-key" })
  ]);
  assert.deepEqual(parallelPlans.map((result) => result.created).sort(), [false, true]);
  assert.equal(parallelPlans[0].plan.id, parallelPlans[1].plan.id);
  assert.equal(parallelPlans[0].tree.root_nodes.length, 1);
  assert.equal(parallelPlans[1].tree.root_nodes.length, 1);

  const anotherPlan = await firstClient.request("POST", `/v1/work/organizations/${first.orgId}/projects/${projectId}/plans`, {
    ...definition,
    source_key: "another-scope-piece"
  });
  await firstClient.request("POST", `/v1/work/organizations/${first.orgId}/events/emit`, {
    event: "project.event_scheduled",
    project_id: projectId,
    payload: {
      event_type_default_id: "project_work",
      event: { id: "event_targeted", work_plan_id: firstPlan.plan.id, event_type_default_id: "project_work" }
    }
  });
  const progressed = await firstClient.request("GET", `/v1/work/organizations/${first.orgId}/plans/${firstPlan.plan.id}`);
  const untouched = await firstClient.request("GET", `/v1/work/organizations/${first.orgId}/plans/${anotherPlan.plan.id}`);
  assert.equal(progressed.plan.root_nodes[0].status, "completed");
  assert.equal(untouched.plan.root_nodes[0].status, "ready");
});

test("due hooks emit once and can run notification automations", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_due_engine";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Due Project", branch_id: "default", events: [] },
    metadata: { kind: "platform_project" }
  });
  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    title: "Due Plan",
    source_key: "test:due-plan",
    root_nodes: [{
      id: "due_task",
      title: "Due Task",
      actionable: true,
      due_offset_minutes: -1,
      automation_bindings: {
        onDue: [{ id: "due_notification", automation: "notification.create.v1", input: { id: "notification_due_test", title: "Task is due" } }]
      }
    }]
  });
  const { runWorkSchedulerTick } = await import("../work/scheduler.js");
  await runWorkSchedulerTick();
  await runWorkSchedulerTick();
  const events = await client.request("GET", `/v1/work/organizations/${orgId}/events?project_id=${projectId}`);
  assert.equal(events.events.filter((item: any) => item.type === "work.node.due").length, 1);
  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.ok(notifications.notifications.some((item: any) => item.id === "notification_due_test"));
});

test("scheduled project events emit started and completed lifecycle triggers", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_event_lifecycle";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Lifecycle Project", branch_id: "default", events: [] },
    metadata: { kind: "platform_project" }
  });
  const plan = await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    title: "Lifecycle Work",
    source_key: "test:event-lifecycle",
    root_nodes: [{
      id: "production",
      title: "Production",
      completion_mode: "all_children",
      children: [
        {
          id: "start",
          title: "Start",
          actionable: true,
          external_triggers: [{ event: "project.event.started", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
        },
        {
          id: "finish",
          title: "Finish",
          actionable: true,
          depends_on: ["start"],
          external_triggers: [{ event: "project.event.completed", transition: "completed", conditions: { "payload.event_kind": "project_work" } }]
        }
      ]
    }]
  });
  await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    id: "event_lifecycle",
    event_type_default_id: "project_work",
    kind: "project_work",
    work_plan_id: plan.plan.id,
    start_at: new Date(Date.now() - 120_000).toISOString(),
    duration_minutes: 1
  });
  const { processProjectEventLifecycleForOrg } = await import("../platform/api.js");
  await processProjectEventLifecycleForOrg(orgId);
  const completed = await client.request("GET", `/v1/work/organizations/${orgId}/plans/${plan.plan.id}`);
  assert.equal(completed.plan.status, "completed");
  assert.equal(completed.plan.root_nodes[0].children[0].status, "completed");
  assert.equal(completed.plan.root_nodes[0].children[1].status, "completed");
  const project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const event = project.document.data.events.find((item: any) => item.id === "event_lifecycle");
  assert.equal(event.status, "completed");
  assert.ok(event.started_emitted_at);
  assert.ok(event.completed_emitted_at);
});

test("Kanban lists empty enabled templates, hides disabled or trashed boards, and folds legacy Sales into the scope board", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const boardsUrl = `/v1/work/organizations/${orgId}/boards`;
  const templateUrl = (templateId: string) => `/v1/scopes/organizations/${orgId}/branches/default/templates/${templateId}`;

  const emptyBoards = await client.request("GET", boardsUrl);
  assert.equal(emptyBoards.boards.length, 11);
  assert.ok(emptyBoards.boards.every((board: any) => board.columns.length > 0));
  assert.ok(emptyBoards.boards.some((board: any) => board.id === "maintenance" && board.cards.length === 0));

  await client.request("PATCH", `${templateUrl("maintenance")}/state`, { enabled: false });
  const withoutDisabled = await client.request("GET", boardsUrl);
  assert.ok(!withoutDisabled.boards.some((board: any) => board.id === "maintenance"));

  await client.request("PATCH", `${templateUrl("maintenance")}/state`, { enabled: true });
  await client.request("PATCH", `${templateUrl("maintenance")}/state`, { trashed: true });
  const withoutTrashed = await client.request("GET", boardsUrl);
  assert.ok(!withoutTrashed.boards.some((board: any) => board.id === "maintenance"));

  await client.request("PATCH", `${templateUrl("maintenance")}/state`, { trashed: false });
  const restored = await client.request("GET", boardsUrl);
  assert.ok(restored.boards.some((board: any) => board.id === "maintenance"));

  await client.request("POST", `/v1/work/organizations/${orgId}/projects/legacy_sales_only/plans`, {
    id: "legacy_project_sales_plan",
    source_type: "project_sales",
    source_key: "legacy:project_sales_only",
    template_id: "sales",
    title: "Sales",
    root_nodes: [{
      id: "sales_phase",
      title: "Sales",
      terminology_key: "work.phase",
      completion_mode: "all_children",
      children: [
        { id: "new_lead_stage", title: "New Lead", terminology_key: "work.stage", actionable: true },
        { id: "appointment_stage", title: "Appointment", terminology_key: "work.stage", actionable: true, depends_on: ["new_lead_stage"] },
        { id: "proposal_stage", title: "Proposal", terminology_key: "work.stage", actionable: true, depends_on: ["appointment_stage"] },
        { id: "closing_stage", title: "Pending Deposit", terminology_key: "work.stage", actionable: true, depends_on: ["proposal_stage"] }
      ]
    }]
  });
  const merged = await client.request("GET", boardsUrl);
  assert.equal(merged.boards.filter((board: any) => board.title === "Sales").length, 1);
  assert.ok(!merged.boards.some((board: any) => board.id === "sales"));
  assert.ok(merged.boards.find((board: any) => board.id === "sales_pipeline").cards.some((card: any) => card.project_id === "legacy_sales_only"));
});

test("sales pipeline scope template drives plans, board colors, and automations", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const templateUrl = `/v1/scopes/organizations/${orgId}/branches/default/templates/sales_pipeline`;
  const current = await client.request("GET", templateUrl);
  assert.equal(current.template.definition.kind, "pipeline");
  assert.equal(current.template.definition.work_plan.root_nodes[0].children.length, 4);

  const customized = {
    ...current.template.definition,
    name: "Residential Sales",
    description: "Qualified residential opportunities.",
    color: "#245f73",
    work_plan: {
      ...current.template.definition.work_plan,
      title: "Residential Sales",
      metadata: { ...current.template.definition.work_plan.metadata, board_color: "#245f73" },
      root_nodes: [{
        id: "sales_phase",
        title: "Residential Sales",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        metadata: { color: "#245f73" },
        children: [{
          id: "qualification",
          title: "Qualification",
          description: "Confirm fit and contact details.",
          terminology_key: "work.stage",
          completion_mode: "all_children",
          metadata: { color: "#b35c25" },
          automation_bindings: {
            onStarted: [{
              id: "welcome_sms",
              automation: "communications.sendSms.v1",
              input: { to: "{{project.customer_phone}}", text: "Thanks for contacting us about {{project.address}}." }
            }]
          },
          children: [{
            id: "call_lead",
            title: "Call lead",
            terminology_key: "work.task",
            actionable: true,
            assigned_role_ids: ["sales"],
            due_offset_minutes: 60
          }]
        }]
      }]
    }
  };
  const saved = await client.request("PUT", templateUrl, {
    ...customized,
    expected_version: current.template.version
  });
  assert.equal(saved.template.name, "Residential Sales");

  const projectId = "crm_board_project";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "CRM Board Project", branch_id: "default", address: "10 Main St" },
    metadata: { kind: "platform_project" }
  });
  const plans = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans?include_tree=1`);
  const salesPlan = plans.plans.find((plan: any) => plan.source_type === "pipeline");
  assert.equal(salesPlan.template_id, "sales_pipeline");
  assert.equal(salesPlan.title, "Residential Sales");
  assert.equal(salesPlan.root_nodes[0].children[0].title, "Qualification");
  assert.equal(salesPlan.root_nodes[0].children[0].metadata.color, "#b35c25");
  assert.equal(salesPlan.root_nodes[0].children[0].automation_bindings.onStarted[0].automation, "communications.sendSms.v1");

  const boards = await client.request("GET", `/v1/work/organizations/${orgId}/boards`);
  const board = boards.boards.find((item: any) => item.id === "sales_pipeline");
  assert.equal(board.kind, "pipeline");
  assert.equal(board.title, "Residential Sales");
  assert.equal(board.color, "#245f73");
  assert.equal(board.columns[0].color, "#b35c25");

  const projectDoc = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  const projection = projectDoc.document.data.work_projection;
  assert.equal(projection.lifecycle.status, "open");
  assert.equal(projection.active_instances[0].template_id, "sales_pipeline");
  assert.equal(projection.active_instances[0].kind, "pipeline");
  assert.equal(projection.active_instances[0].stage_id, "qualification");
});

test("manual stage movement is feature-gated, updates board placement, and yields to real workflow progress", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "manual_stage_project";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Manual Stage Project", branch_id: "default", address: "42 Boardwalk Ave" },
    metadata: { kind: "platform_project" }
  });
  const plans = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/plans?include_tree=1`);
  const plan = plans.plans.find((item: any) => item.template_id === "sales_pipeline");
  assert.ok(plan?.id);

  const denied = await client.raw("PUT", `/v1/work/organizations/${orgId}/plans/${plan.id}/manual-stage`, { stage_id: "proposal_stage" });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.data.error, "capability_denied");

  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, { data: { app_flags: { platform: { expanded_access: true, manual_project_stage_movement: true } } } }, { replace: false });
  const unchanged = await client.request("PUT", `/v1/work/organizations/${orgId}/plans/${plan.id}/manual-stage`, { stage_id: "new_lead_stage" });
  assert.equal(unchanged.stage.stage_id, "new_lead_stage");
  assert.equal(unchanged.stage.manual_override, false);
  assert.equal(unchanged.projection.active_instances[0].manual_override, undefined);

  const moved = await client.request("PUT", `/v1/work/organizations/${orgId}/plans/${plan.id}/manual-stage`, { stage_id: "proposal_stage" });
  assert.equal(moved.stage.stage_id, "proposal_stage");
  assert.equal(moved.stage.manual_override, true);
  assert.equal(moved.projection.active_instances[0].stage_id, "proposal_stage");
  assert.equal(moved.projection.active_instances[0].manual_override, true);

  const boards = await client.request("GET", `/v1/work/organizations/${orgId}/boards`);
  const sales = boards.boards.find((item: any) => item.id === "sales_pipeline");
  const proposal = sales.columns.find((item: any) => item.id === "proposal_stage");
  assert.ok(proposal.cards.some((card: any) => card.project_id === projectId && card.manual_stage_override === true));

  const restored = await client.request("PUT", `/v1/work/organizations/${orgId}/plans/${plan.id}/manual-stage`, { stage_id: "new_lead_stage" });
  assert.equal(restored.stage.manual_override, false);
  assert.equal(restored.projection.active_instances[0].manual_override, undefined);
  await client.request("PUT", `/v1/work/organizations/${orgId}/plans/${plan.id}/manual-stage`, { stage_id: "proposal_stage" });

  const contactLead = plan.root_nodes[0].children[0].children.find((item: any) => item.template_node_id === "contact_lead");
  await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${contactLead.id}/transition`, { status: "completed" });
  const projection = await client.request("GET", `/v1/work/organizations/${orgId}/projects/${projectId}/projection`);
  assert.equal(projection.projection.active_instances[0].stage_id, "appointment_stage");
  assert.equal(projection.projection.active_instances[0].manual_override, undefined);
});
