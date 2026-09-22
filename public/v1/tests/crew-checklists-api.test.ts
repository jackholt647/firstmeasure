import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;
type TestClient = ReturnType<typeof createSessionClient>;

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
    let data: any = null;
    try {
      data = response.body ? JSON.parse(response.body) : null;
    } catch {
      data = null;
    }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crew-checklists-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
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
  const [{ closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOwner(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `checklist-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Checklist Test Owner",
    company: "Checklist API Test Org",
    organization_id: `org_checklists_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return { orgId: String(registered.organization.id), suffix, userId: String(registered.user.id) };
}

async function createFieldUser(
  owner: TestClient,
  orgId: string,
  suffix: string,
  roleId: "crew_member" | "crew_foreman" | "supervisor"
) {
  const email = `checklist-${roleId}-${suffix}@example.test`;
  const password = `checklist ${roleId} password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name: `Test ${roleId}`, status: "active", role: "viewer", send_invite: false }
  });
  const userId = String(created.document.id);
  await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: [roleId],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: roleId, permissions: {} }
    }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client };
}

async function seedProject(orgId: string, id: string, assignedUserIds: string[]) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id,
    data: {
      branch_id: "default",
      title: `${id} Project`,
      address: `${id} Address`,
      events: [{
        id: `${id}_event`,
        kind: "project_work",
        event_type_default_id: "project_work",
        status: "scheduled",
        assigned_user_ids: assignedUserIds,
        start_date: "2026-07-20",
        end_date: "2026-07-22",
        all_day: true
      }]
    },
    metadata: { kind: "platform_project", branch_id: "default", source: "crew_checklists_test" }
  }, { replace: true });
}

test("Project checklists support audiences, ratings, notes, and role permissions", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix } = await registerOwner(owner);
  const member = await createFieldUser(owner, orgId, suffix, "crew_member");
  const supervisor = await createFieldUser(owner, orgId, suffix, "supervisor");
  const projectId = "checklist_project";
  await seedProject(orgId, projectId, [member.userId, supervisor.userId]);
  const base = `/v1/workforce/organizations/${orgId}/crew/projects/${projectId}/checklists`;

  await t.test("supervisor role is seeded with supervise + payment permissions", async () => {
    const roles = await owner.request("GET", `/v1/workforce/organizations/${orgId}/access/roles?application_id=field`);
    const seeded = roles.roles.find((role: Json) => role.id === "supervisor");
    assert.ok(seeded, "Supervisor role should be seeded");
    assert.equal(seeded.permissions["crew.checklists.supervise"], true);
    assert.equal(seeded.permissions["crew.checklists.manage"], true);
    assert.equal(seeded.permissions["crew.payments.take"], true);
    assert.equal(seeded.app_defaults["project.crew_payments"].enabled, true);
    const memberRole = roles.roles.find((role: Json) => role.id === "crew_member");
    assert.equal(memberRole.permissions["crew.change_orders.view"], true);
    assert.equal(memberRole.permissions["crew.change_orders.manage"], undefined);
    assert.equal(memberRole.permissions["crew.payments.view"], undefined);
  });

  let workChecklist: Json = null as any;
  let safetyChecklist: Json = null as any;
  let completionChecklist: Json = null as any;

  await t.test("scope checklists seed and members only see crew audiences", async () => {
    // Checklists are pure scope data now — no blessed defaults. Instantiate
    // the repairs template's checklists the way a scope activation does.
    const { initializeProjectChecklistsFromScope } = await import("../workforce/crew_storage.js");
    const { DEFAULT_SCOPE_TEMPLATES } = await import("../scopes/presets/index.js");
    const repairs = DEFAULT_SCOPE_TEMPLATES.find((template: any) => template.id === "repairs") as any;
    (await initializeProjectChecklistsFromScope(orgId, projectId, repairs, "repairs"));
    const memberView = await member.client.request("GET", base);
    assert.equal(memberView.checklists.length, 2);
    assert.deepEqual(memberView.checklists.map((entry: Json) => entry.source_key).sort(),
      ["scope:repairs:safety", "scope:repairs:work"]);
    assert.ok(memberView.checklists.every((entry: Json) => entry.audience === "crew"));
    assert.ok(memberView.checklists.every((entry: Json) => entry.can_complete === true));
    assert.ok(memberView.checklists.every((entry: Json) => entry.can_edit === false));
    assert.equal(memberView.permissions.supervise, false);

    const ownerView = await owner.request("GET", base);
    assert.equal(ownerView.checklists.length, 3);
    workChecklist = ownerView.checklists.find((entry: Json) => entry.source_key === "scope:repairs:work");
    safetyChecklist = ownerView.checklists.find((entry: Json) => entry.source_key === "scope:repairs:safety");
    completionChecklist = ownerView.checklists.find((entry: Json) => entry.source_key === "scope:repairs:completion");
    assert.equal(completionChecklist.audience, "supervisor");
    assert.equal(completionChecklist.kind, "quality");
    assert.ok(completionChecklist.items.every((item: Json) => item.item_type === "rating"));
    assert.equal(workChecklist.crew_editable, true);
    assert.equal(safetyChecklist.crew_editable, false);
    assert.ok(workChecklist.items.length > 0);

    const supervisorView = await supervisor.client.request("GET", base);
    assert.equal(supervisorView.checklists.length, 3);
    const supervisorCompletion = supervisorView.checklists.find((entry: Json) => entry.source_key === "scope:repairs:completion");
    assert.equal(supervisorCompletion.can_complete, true);
    assert.equal(supervisorCompletion.can_edit, true);
  });

  await t.test("checklists use global eligibility policies and resolved assignees", async () => {
    const created = await owner.request("POST", base, {
      title: "Assigned sales-style checklist",
      assignment_policy: {
        schema_version: 1,
        mode: "any",
        allow_unassigned: false,
        rules: [{ id: "crew_people", subject_types: ["organization_user"], role_ids: ["crew_member"] }]
      },
      items: [{ title: "Confirm project handoff" }]
    });
    const ownerView = await owner.request("GET", base);
    let checklist = ownerView.checklists.find((entry: Json) => entry.id === created.checklist.id);
    assert.equal(checklist.assignment_required, true);
    assert.deepEqual(checklist.assigned_user_ids, []);

    const unresolvedCompletion = await owner.raw("PATCH", `${base}/${checklist.id}/items/${checklist.items[0].id}`, { completed: true });
    assert.equal(unresolvedCompletion.statusCode, 400);
    assert.equal(unresolvedCompletion.data.error, "checklist_assignment_required");

    const invalidAssignment = await owner.raw("PATCH", `${base}/${checklist.id}`, {
      assigned_user_ids: [supervisor.userId]
    });
    assert.equal(invalidAssignment.statusCode, 400);
    assert.equal(invalidAssignment.data.error, "checklist_assignment_invalid");

    await owner.request("PATCH", `${base}/${checklist.id}`, {
      assigned_user_ids: [member.userId]
    });
    const memberView = await member.client.request("GET", base);
    checklist = memberView.checklists.find((entry: Json) => entry.id === checklist.id);
    assert.ok(checklist);
    assert.equal(checklist.can_complete, true);
    assert.equal(checklist.assignment_required, false);
    assert.equal(checklist.assigned_user_names[member.userId], "Test crew_member");

    const completed = await member.client.request("PATCH", `${base}/${checklist.id}/items/${checklist.items[0].id}`, { completed: true });
    assert.equal(completed.item.completed, true);
  });

  await t.test("members complete crew items but cannot touch supervisor checklists", async () => {
    const item = workChecklist.items[0];
    const completed = await member.client.request("PATCH", `${base}/${workChecklist.id}/items/${item.id}`, {
      completed: true
    });
    assert.equal(completed.item.completed, true);
    assert.equal(completed.item.completed_by_user_id, member.userId);

    const supervisorItem = completionChecklist.items[0];
    const denied = await member.client.raw("PATCH", `${base}/${completionChecklist.id}/items/${supervisorItem.id}`, {
      rating: "good"
    });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.data.error, "checklist_complete_forbidden");

    const memberAdd = await member.client.raw("POST", `${base}/${workChecklist.id}/items`, { title: "Member add" });
    assert.equal(memberAdd.statusCode, 403);
    assert.equal(memberAdd.data.error, "crew_permission_denied");
  });

  await t.test("supervisors rate quality items and bad ratings require a note", async () => {
    const item = completionChecklist.items[0];
    const missingNote = await supervisor.client.raw("PATCH", `${base}/${completionChecklist.id}/items/${item.id}`, {
      rating: "bad"
    });
    assert.equal(missingNote.statusCode, 400);
    assert.equal(missingNote.data.error, "checklist_note_required");

    const bad = await supervisor.client.request("PATCH", `${base}/${completionChecklist.id}/items/${item.id}`, {
      rating: "bad",
      note: "Flashing lifted on the north slope."
    });
    assert.equal(bad.item.rating, "bad");
    assert.equal(bad.item.completed, true);
    assert.equal(bad.item.note, "Flashing lifted on the north slope.");
    assert.equal(bad.item.completed_by_user_id, supervisor.userId);

    const good = await supervisor.client.request("PATCH", `${base}/${completionChecklist.id}/items/${completionChecklist.items[1].id}`, {
      rating: "good"
    });
    assert.equal(good.item.rating, "good");

    const cleared = await supervisor.client.request("PATCH", `${base}/${completionChecklist.id}/items/${completionChecklist.items[1].id}`, {
      rating: ""
    });
    assert.equal(cleared.item.rating, "");
    assert.equal(cleared.item.completed, false);

    const invalid = await supervisor.client.raw("PATCH", `${base}/${completionChecklist.id}/items/${item.id}`, {
      rating: "amazing"
    });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.data.error, "checklist_rating_invalid");
  });

  await t.test("crew_editable governs field edits while management always edits", async () => {
    // Supervisors hold checklists.manage but the safety checklist is locked for
    // the field, so structure edits are refused.
    const lockedAdd = await supervisor.client.raw("POST", `${base}/${safetyChecklist.id}/items`, { title: "Locked" });
    assert.equal(lockedAdd.statusCode, 403);
    assert.equal(lockedAdd.data.error, "checklist_edit_forbidden");

    const allowedAdd = await supervisor.client.request("POST", `${base}/${workChecklist.id}/items`, {
      title: "Confirm dumpster pickup",
      item_type: "todo"
    });
    assert.equal(allowedAdd.item.title, "Confirm dumpster pickup");

    const managementAdd = await owner.request("POST", `${base}/${safetyChecklist.id}/items`, {
      title: "Verify permit posted"
    });
    assert.equal(managementAdd.item.checklist_id, safetyChecklist.id);
  });

  await t.test("management creates, reconfigures, and deletes checklists without an assignment", async () => {
    const created = await owner.request("POST", base, {
      title: "Punch list",
      audience: "crew",
      kind: "todo",
      crew_editable: true
    });
    assert.equal(created.checklist.title, "Punch list");

    const patched = await owner.request("PATCH", `${base}/${created.checklist.id}`, {
      audience: "supervisor",
      crew_editable: false,
      title: "Final punch list"
    });
    assert.equal(patched.checklist.audience, "supervisor");
    assert.equal(patched.checklist.crew_editable, false);
    const deletedItem = await owner.request("POST", `${base}/${created.checklist.id}/items`, { title:"Touch up the trim" });

    const memberView = await member.client.request("GET", base);
    assert.equal(memberView.checklists.some((entry: Json) => entry.id === created.checklist.id), false);

    const removed = await owner.request("DELETE", `${base}/${created.checklist.id}`);
    assert.equal(removed.deleted, true);
    const ownerView = await owner.request("GET", base);
    assert.equal(ownerView.checklists.some((entry: Json) => entry.id === created.checklist.id), false);
    const deletedChecklist = ownerView.deleted_checklists.find((entry: Json) => entry.id === created.checklist.id);
    assert.equal(deletedChecklist.title, "Final punch list");
    assert.ok(deletedChecklist.deleted_at);
    assert.equal(deletedChecklist.items[0].id, deletedItem.item.id);
    assert.deepEqual(memberView.deleted_checklists, []);
  });

  await t.test("to-dos carry role assignment and priority; field feeds only show assigned items", async () => {
    const workBase = `/v1/work/organizations/${orgId}`;
    const crewBase = `/v1/workforce/organizations/${orgId}/crew`;

    const unassigned = await owner.request("POST", `${workBase}/todos`, {
      title: "Order dumpster",
      project_id: projectId
    });
    assert.deepEqual(unassigned.todo.assigned_user_ids, []);
    assert.deepEqual(unassigned.todo.assigned_role_ids, []);
    assert.equal(unassigned.todo.priority, 0);

    const supervisorTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Close out the final walkthrough",
      project_id: projectId,
      assigned_role_ids: ["supervisor"],
      priority: 1
    });
    assert.equal(supervisorTodo.todo.priority, 1);
    assert.deepEqual(supervisorTodo.todo.assigned_role_ids, ["supervisor"]);

    const crewTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Stage materials for the crew",
      project_id: projectId,
      assigned_role_ids: ["crew_member", "crew_foreman"]
    });
    assert.equal(crewTodo.todo.priority, 0);

    const memberTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Photograph the finished work",
      project_id: projectId,
      assigned_user_ids: [member.userId]
    });
    assert.deepEqual(memberTodo.todo.assigned_user_ids, [member.userId]);

    const groupResponse = await owner.request("POST", `/v1/workforce/organizations/${orgId}/branches/default/resource-groups`, {
      id: "checklist_test_crew",
      name: "Checklist Test Crew",
      primary_member_user_id: member.userId,
      members: [{ user_id: member.userId, role: "member", is_lead: true }]
    });
    const groupId = String(groupResponse.resource_group.id);
    const groupTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Clean up the jobsite",
      project_id: projectId,
      assigned_resource_group_ids: [groupId]
    });
    assert.deepEqual(groupTodo.todo.assigned_resource_group_ids, [groupId]);

    const personalTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Submit weekly timecard",
      assigned_user_ids: [member.userId]
    });
    const restrictedProjectId = "restricted_todo_project";
    await seedProject(orgId, restrictedProjectId, [supervisor.userId]);
    const inaccessibleTodo = await owner.request("POST", `${workBase}/todos`, {
      title: "Task on an inaccessible project",
      project_id: restrictedProjectId,
      assigned_user_ids: [member.userId]
    });

    // Office project view sees everything, priority items first.
    const officeTodos = await owner.request("GET", `${workBase}/todos?project_id=${projectId}`);
    const officeTitles = officeTodos.todos.map((todo: Json) => todo.title);
    assert.ok(officeTitles.includes("Order dumpster"));
    assert.ok(officeTitles.includes("Close out the final walkthrough"));
    assert.equal(officeTitles[0], "Close out the final walkthrough");

    // Field feeds show only explicitly assigned items -- never unassigned.
    const memberFeed = await member.client.request("GET", `${crewBase}/me/todos`);
    const memberTitles = memberFeed.todos.map((todo: Json) => todo.title);
    assert.ok(memberTitles.includes("Stage materials for the crew"));
    assert.ok(memberTitles.includes("Photograph the finished work"));
    assert.ok(memberTitles.includes("Clean up the jobsite"));
    assert.ok(memberTitles.includes("Submit weekly timecard"));
    assert.equal(memberTitles.includes("Order dumpster"), false);
    assert.equal(memberTitles.includes("Close out the final walkthrough"), false);
    assert.equal(memberTitles.includes("Task on an inaccessible project"), false);
    assert.equal(memberFeed.todos.find((todo: Json) => todo.id === memberTodo.todo.id).project_title.length > 0, true);
    const supervisorFeed = await supervisor.client.request("GET", `${crewBase}/me/todos`);
    assert.deepEqual(supervisorFeed.todos.map((todo: Json) => todo.title), ["Close out the final walkthrough"]);

    const memberProjectTodos = await member.client.request("GET", `${crewBase}/projects/${projectId}/todos`);
    assert.deepEqual(new Set(memberProjectTodos.todos.map((todo: Json) => todo.title)), new Set([
      "Stage materials for the crew",
      "Photograph the finished work",
      "Clean up the jobsite"
    ]));

    // Completion respects assignment: members cannot complete supervisor items.
    const memberDenied = await member.client.raw("POST", `${crewBase}/projects/${projectId}/todos/${supervisorTodo.todo.id}/complete`, {});
    assert.equal(memberDenied.statusCode, 403);
    assert.equal(memberDenied.data.error, "todo_forbidden");
    const completed = await member.client.request("POST", `${crewBase}/projects/${projectId}/todos/${crewTodo.todo.id}/complete`, {});
    assert.equal(completed.todo.status, "completed");
    const reopened = await member.client.request("POST", `${crewBase}/projects/${projectId}/todos/${crewTodo.todo.id}/complete`, { completed: false });
    assert.equal(reopened.todo.status, "ready");

    const personalCompleted = await member.client.request("POST", `${crewBase}/me/todos/${personalTodo.todo.id}/complete`, {});
    assert.equal(personalCompleted.todo.status, "completed");
    const inaccessibleCompletion = await member.client.raw("POST", `${crewBase}/me/todos/${inaccessibleTodo.todo.id}/complete`, {});
    assert.equal(inaccessibleCompletion.statusCode, 403);
    assert.equal(inaccessibleCompletion.data.error, "crew_project_forbidden");

    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/branches/default/resource-groups/${groupId}`, {
      expected_revision: groupResponse.resource_group.revision,
      members: []
    });
    const afterMembershipChange = await member.client.request("GET", `${crewBase}/me/todos`);
    assert.equal(afterMembershipChange.todos.some((todo: Json) => todo.id === groupTodo.todo.id), false);
  });

  await t.test("scope templates instantiate their checklists instead of generic defaults", async () => {
    const scopeProjectId = "scoped_project";
    await seedProject(orgId, scopeProjectId, [member.userId]);
    const { initializeProjectChecklistsFromScope } = await import("../workforce/crew_storage.js");
    const { DEFAULT_SCOPE_TEMPLATES } = await import("../scopes/presets/index.js");
    const roofing = DEFAULT_SCOPE_TEMPLATES.find((template: Json) => template.id === "roof_replacement");
    assert.ok(Array.isArray((roofing as Json).checklists) && (roofing as Json).checklists.length === 3);
    (await initializeProjectChecklistsFromScope(orgId, scopeProjectId, roofing, "roof_replacement"));

    const scopedBase = `/v1/workforce/organizations/${orgId}/crew/projects/${scopeProjectId}/checklists`;
    const ownerView = await owner.request("GET", scopedBase);
    assert.equal(ownerView.checklists.length, 3);
    assert.ok(ownerView.checklists.every((entry: Json) => entry.source === "scope"));
    assert.deepEqual(ownerView.checklists.map((entry: Json) => entry.source_key).sort(), [
      "scope:roof_replacement:completion",
      "scope:roof_replacement:safety",
      "scope:roof_replacement:work"
    ]);
    const completion = ownerView.checklists.find((entry: Json) => entry.source_key.endsWith(":completion"));
    assert.equal(completion.audience, "supervisor");
    assert.ok(completion.items.every((item: Json) => item.item_type === "rating"));
    // Re-running instantiation is idempotent.
    (await initializeProjectChecklistsFromScope(orgId, scopeProjectId, roofing, "roof_replacement"));
    const again = await owner.request("GET", scopedBase);
    assert.equal(again.checklists.length, 3);
  });

  await t.test("required evidence is enforced before completion", async () => {
    const evidenceList = await owner.request("POST", base, {
      title: "Evidence checklist",
      items: [{
        title: "Install drywall",
        metadata: {
          required_attachments: [
            { id: "media_proof", kind: "media", allowed_kinds: ["photo", "video"], min_count: 1 },
            { id: "voice_explanation", kind: "audio", min_count: 1 }
          ]
        }
      }]
    });
    const evidenceView = await owner.request("GET", base);
    const item = evidenceView.checklists.find((entry: Json) => entry.id === evidenceList.checklist.id).items[0];
    const blocked = await owner.raw("PATCH", `${base}/${evidenceList.checklist.id}/items/${item.id}`, { completed: true });
    assert.equal(blocked.statusCode, 400);
    assert.equal(blocked.data.error, "checklist_attachments_required");
    assert.equal(blocked.data.details.unmet_requirements.length, 2);

    const updated = await owner.request("PATCH", `${base}/${evidenceList.checklist.id}/items/${item.id}`, {
      metadata: {
        attachments: [
          { media_id: "media_photo", kind: "photo", content_type: "image/jpeg", requirement_id: "media_proof" },
          { media_id: "media_audio", kind: "audio", content_type: "audio/wav", requirement_id: "voice_explanation" }
        ]
      },
      completed: true
    });
    assert.equal(updated.item.completed, true);
    assert.equal(updated.item.metadata.attachments.length, 2);
  });

  await t.test("customer checklists are hidden by default and enforce portal permissions", async () => {
    const created = await owner.request("POST", base, {
      title: "Customer preparation",
      items: [{ title: "Move the car out of the driveway" }]
    });
    assert.equal(created.checklist.customer_access.visible, false);
    assert.equal(created.checklist.customer_access.voice_mode, "off");

    const portalResult = await owner.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
    const portalUuid = String(portalResult.portal.public_uuid);
    const publicPath = `/v1/platform/customer-portals/${portalUuid}`;
    let publicPortal = await owner.request("GET", publicPath);
    assert.equal(publicPortal.resources.checklists.some((entry: Json) => entry.id === created.checklist.id), false);

    await owner.request("PATCH", `${base}/${created.checklist.id}`, {
      customer_access: {
        visible: true,
        can_complete: false,
        can_edit_items: false,
        voice_mode: "complete"
      }
    });
    publicPortal = await owner.request("GET", publicPath);
    let customerChecklist = publicPortal.resources.checklists.find((entry: Json) => entry.id === created.checklist.id);
    assert.ok(customerChecklist);
    assert.equal(customerChecklist.customer_access.can_complete, false);
    assert.equal(customerChecklist.customer_access.voice_mode, "off");
    const itemId = String(customerChecklist.items[0].id);
    const readOnly = await owner.raw("PATCH", `${publicPath}/checklists/${created.checklist.id}/items/${itemId}`, { completed: true });
    assert.equal(readOnly.statusCode, 403);
    assert.equal(readOnly.data.error, "customer_checklist_read_only");

    await owner.request("PATCH", `${base}/${created.checklist.id}`, {
      customer_access: {
        visible: true,
        can_complete: true,
        can_edit_items: false,
        voice_mode: "off"
      }
    });
    publicPortal = await owner.request("GET", publicPath);
    customerChecklist = publicPortal.resources.checklists.find((entry: Json) => entry.id === created.checklist.id);
    assert.equal(customerChecklist.customer_access.voice_mode, "complete");

    await owner.request("PATCH", `${base}/${created.checklist.id}`, {
      customer_access: {
        visible: true,
        can_complete: false,
        can_edit_items: true,
        voice_mode: "off"
      }
    });
    publicPortal = await owner.request("GET", publicPath);
    customerChecklist = publicPortal.resources.checklists.find((entry: Json) => entry.id === created.checklist.id);
    assert.equal(customerChecklist.customer_access.can_complete, true);
    assert.equal(customerChecklist.customer_access.voice_mode, "edit");

    const added = await owner.request("POST", `${publicPath}/checklists/${created.checklist.id}/items`, {
      title: "Confirm pets are indoors"
    });
    assert.equal(added.item.title, "Confirm pets are indoors");
    const completed = await owner.request("PATCH", `${publicPath}/checklists/${created.checklist.id}/items/${itemId}`, {
      completed: true
    });
    assert.equal(completed.item.completed, true);
    assert.equal(completed.item.completed_by_customer, true);

    await owner.request("PATCH", `${base}/${created.checklist.id}`, {
      customer_access: { visible: false, can_complete: true, can_edit_items: true, voice_mode: "edit" }
    });
    const hiddenMutation = await owner.raw("PATCH", `${publicPath}/checklists/${created.checklist.id}/items/${itemId}`, {
      completed: false
    });
    assert.equal(hiddenMutation.statusCode, 403);
    assert.equal(hiddenMutation.data.error, "customer_checklist_hidden");
  });
});
