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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-workforce-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
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
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function registerOwner(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `workforce-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Workforce Owner",
    company: "Workforce Test Org",
    organization_id: `org_workforce_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  return {
    orgId: String(registered.organization.id),
    userId: String(registered.user.id)
  };
}

test('department defaults preserve user preferences but explicit restrictions gate apps and scoped powers stay scoped',async()=>{
  const owner=createSessionClient(); const {orgId}=await registerOwner(owner);
  const created=await owner.request('POST',`/v1/platform/organizations/${orgId}/users`,{data:{name:'Scoped member',email:`scoped-${Date.now()}@example.test`,password:'test-only-member-pass',send_invite:false,status:'active'}});
  const userId=created.document.id;
  const catalog=await owner.request('GET',`/v1/workforce/organizations/${orgId}/departments`);
  await owner.request('PUT',`/v1/workforce/organizations/${orgId}/departments`,{revision:catalog.revision,legacy_token:catalog.legacy_token,departments:[...catalog.departments,{id:'sales',label:'Sales',subject_keys:[`organization_user:${userId}`],app_defaults:{'portal.feedback':{restricted:true},'portal.stats':{visible:{desktop:false,mobile:false}}}}]});
  const role=await owner.request('POST',`/v1/workforce/organizations/${orgId}/access/roles`,{name:'Call supervisor',permissions:{manage_communications:true,view_comms:true}});
  const profile=await owner.request('PATCH',`/v1/workforce/organizations/${orgId}/users/${userId}/profile`,{access_role_ids:['viewer'],scoped_access_assignments:[{role_id:role.role.id,scope:{kind:'department',id:'sales'}}],app_access_overrides:{'portal.feedback':{visible:{desktop:true,mobile:true}},'portal.stats':{visible:{desktop:true,mobile:true}}}});
  assert.equal(profile.user.access_profile.effective_permissions.manage_communications,undefined);
  assert.equal(profile.user.access_profile.scoped_access_grants[0].permissions.manage_communications,true);
  // A restriction beats the person's own setting; a department's plain default does not (docs/architecture/app-experience.md).
  const app=(id:string)=>profile.user.app_entitlements.find((entry:any)=>entry.id===id);
  if(app('portal.feedback'))assert.equal(app('portal.feedback').allowed,false);
  if(app('portal.stats'))assert.equal(app('portal.stats').allowed,true);
  assert.equal(profile.user.access_profile.organization_structure,undefined,'The full membership directory is not serialized as an access profile.');
  const {backgroundAuthContext,hasAppEntitlement,hasResourcePermission}=await import('../platform/auth.js');
  const auth=await backgroundAuthContext(orgId,userId);
  assert.equal(hasAppEntitlement(auth,'feedback'),false);
  assert.equal(hasResourcePermission(auth,'manage_communications',{department_id:'sales'}),true);
  assert.equal(hasResourcePermission(auth,'manage_communications',{}),false);
  const rejected=await owner.raw('PATCH',`/v1/workforce/organizations/${orgId}/users/${userId}/profile`,{scoped_access_assignments:[{permissions:{manage_company_settings:true},scope:{kind:'department',id:'sales'}}]});
  assert.equal(rejected.statusCode,400);
});

test("workforce architecture keeps users canonical and unifies internal and external work resources", async (t) => {
  const owner = createSessionClient();
  const { orgId, userId } = await registerOwner(owner);
  const branchBase = `/v1/workforce/organizations/${orgId}/branches/default`;

  await t.test("access profiles and employment terms work independently of the workforce rollout flag", async () => {
    const profile = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
      access_role_ids: ["super_admin"],
      worker_classification: "independent_contractor",
      payment_terms: { basis: "net_days", net_days: 30 }
    });
    assert.equal(Object.prototype.hasOwnProperty.call(profile.user, "user_type_ids"), false);
    assert.equal(profile.user.application_access, undefined);
    assert.equal(Object.hasOwn(profile.user, "compensation_profile"), false, "how someone is paid is a pay setup, not part of their profile");
    assert.equal(profile.user.worker_classification, "independent_contractor");
    assert.deepEqual(profile.user.payment_terms, { basis: "net_days", net_days: 30 });

    const profiles = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users?include_disabled=1`);
    const listedProfile = profiles.users.find((user: any) => user.id === userId);
    assert.equal(listedProfile.worker_classification, "independent_contractor");
    assert.equal(listedProfile.payment_terms.net_days, 30);

  });


  await t.test("people who only work assigned jobs authenticate, and a route that belongs to an app needs it", async () => {
    const suffix = Math.random().toString(36).slice(2, 9);
    const email = `field-only-${suffix}@example.test`;
    const password = "field worker password";
    const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
      data: {
        email,
        password,
        name: "Field Only User",
        status: "active",
        role: "viewer",
        permissions: { view_projects: true },
        send_invite: false
      }
    });
    const fieldUserId = String(created.document.id);
    const profile = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${fieldUserId}/profile`, {
      access_role_ids: ["crew_member"]
    });
    assert.deepEqual(profile.user.access_role_ids, ["crew_member"]);

    const fieldClient = createSessionClient();
    await fieldClient.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
    const session = await fieldClient.request("GET", "/v1/platform/auth/session");
    assert.equal(session.membership.application_access, undefined);
    const mediaDenied = await fieldClient.raw("GET", `/v1/platform/organizations/${orgId}/media/storage`);
    assert.equal(mediaDenied.statusCode, 403);
    assert.equal(mediaDenied.data.error, "app_access_denied");
  });

  const scopeCatalog = await owner.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates?include_disabled=1`);
  assert.ok(scopeCatalog.templates.some((template: any) => template.id === "roof_replacement"));
  assert.ok(scopeCatalog.templates.some((template: any) => template.id === "repairs"));

  let group: any;
  await t.test("resource groups attach existing users and carry no pay of their own", async () => {
    const configuration = await owner.request("GET", `${branchBase}/configuration`);
    assert.equal(configuration.configuration.terminology.resource_group.singular, "Crew");
    assert.equal(configuration.configuration.terminology.organization_connection.singular, "Subcontractor");
    assert.equal(configuration.configuration.terminology.applications, undefined);

    const organizationUsers = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users`);
    assert.ok(organizationUsers.users.some((user: any) => user.id === userId));

    const created = await owner.request("POST", `${branchBase}/resource-groups`, {
      name: "Alpha Resource Group",
      primary_member_user_id: userId,
      members: [{ user_id: userId, role: "lead", is_lead: true }],
      capability_scope_ids: ["roof_replacement"]
    });
    group = created.resource_group;
    assert.equal(group.members.length, 1);
    assert.equal(group.members[0].user_id, userId);
    assert.equal(group.members[0].user.name, "Workforce Owner");
    for (const key of ["compensation_profile", "compensation_plan"]) assert.equal(Object.hasOwn(group, key), false, key);
    for (const key of ["compensation_source", "compensation_plan", "effective_compensation_profile"]) assert.equal(Object.hasOwn(group.members[0], key), false, key);
    assert.deepEqual(group.capability_scope_ids, ["roof_replacement"]);

    const invalidCapability = await owner.raw("POST", `${branchBase}/resource-groups`, {
      name: "Invalid Capability Group",
      members: [{ user_id: userId }],
      capability_scope_ids: ["scope_that_does_not_exist"]
    });
    assert.equal(invalidCapability.statusCode, 400);
  });

  let connection: any;
  let salesGroup: any;
  await t.test("resource group kinds, person and group tags, and assignment policies are data driven", async () => {
    const currentConfiguration = await owner.request("GET", `${branchBase}/configuration`);
    const configured = await owner.request("PUT", `${branchBase}/configuration`, {
      expected_revision: currentConfiguration.configuration.revision,
      resource_group_kinds: [
        { id: "crew", name: "Crew" },
        { id: "sales_team", name: "Sales team" }
      ],
      assignment_tags: [
        { id: "drywall", name: "Drywall" },
        { id: "premium_leads", name: "Premium leads" }
      ]
    });
    assert.deepEqual(
      configured.configuration.resource_group_kinds.map((kind: any) => kind.id),
      ["crew", "sales_team"]
    );
    assert.deepEqual(
      configured.configuration.assignment_tags.map((tag: any) => tag.id),
      ["drywall", "premium_leads"]
    );

    const taggedOwner = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
      assignment_tag_ids: ["drywall"]
    });
    assert.deepEqual(taggedOwner.user.assignment_tag_ids, ["drywall"]);

    const created = await owner.request("POST", `${branchBase}/resource-groups`, {
      name: "Premium Sales Pod",
      kind_id: "sales_team",
      assignment_tag_ids: ["premium_leads"],
      members: [{ user_id: userId }]
    });
    salesGroup = created.resource_group;
    assert.equal(salesGroup.kind_id, "sales_team");
    assert.deepEqual(salesGroup.assignment_tag_ids, ["premium_leads"]);

    const resolved = await owner.request("POST", `${branchBase}/assignable-subjects/resolve`, {
      policy: {
        allow_unassigned: false,
        rules: [
          { subject_types: ["organization_user"], assignment_tag_ids: ["drywall"] },
          { subject_types: ["resource_group"], group_kind_ids: ["sales_team"], assignment_tag_ids: ["premium_leads"] }
        ]
      }
    });
    assert.deepEqual(new Set(resolved.subjects.map((subject: any) => subject.id)), new Set([userId, salesGroup.id]));
    assert.equal(resolved.policy.allow_unassigned, false);

    const peopleOnly = await owner.request("POST", `${branchBase}/assignable-subjects/resolve`, {
      policy: { rules: [{ subject_types: ["organization_user"], assignment_tag_ids: ["drywall"] }] }
    });
    assert.deepEqual(peopleOnly.subjects.map((subject: any) => subject.id), [userId]);

    await owner.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/scheduling`, {
      data: {
        event_types: {
          sales_appointment: {
            id: "sales_appointment",
            label: "Sales Appointment",
            assignment_policy: {
              allow_unassigned: false,
              rules: [{
                subject_types: ["resource_group"],
                group_kind_ids: ["sales_team"],
                assignment_tag_ids: ["premium_leads"]
              }]
            }
          }
        }
      }
    });
    const projectId = "project_assignment_policy";
    await owner.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
      data: { id: projectId, title: "Assignment Policy Project", branch_id: "default", events: [] },
      metadata: { kind: "platform_project" }
    });
    const assignedEvent = await owner.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
      branch_id: "default",
      event: {
        id: "sales_team_event",
        event_type_default_id: "sales_appointment",
        start_at: new Date(Date.now() + 60_000).toISOString(),
        resource_refs: [{ kind: "resource_group", id: salesGroup.id, name: salesGroup.name, role: "crew" }]
      }
    });
    assert.equal(assignedEvent.event.resource_refs[0].id, salesGroup.id);
    assert.equal(assignedEvent.event.assignment_policy.allow_unassigned, false);

    const rejectedAssignment = await owner.raw("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
      branch_id: "default",
      event: {
        id: "wrong_group_event",
        event_type_default_id: "sales_appointment",
        start_at: new Date(Date.now() + 120_000).toISOString(),
        resource_refs: [{ kind: "resource_group", id: group.id, name: group.name, role: "crew" }]
      }
    });
    assert.equal(rejectedAssignment.statusCode, 400);
    assert.equal(rejectedAssignment.data.error, "event_assignment_not_allowed");

    const workPlan = await owner.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
      source_key: "assignment-policy-work-plan",
      title: "Policy-driven work",
      root_nodes: [{
        id: "qualified_sales_follow_up",
        title: "Qualified sales follow-up",
        actionable: true,
        assigned_resource_group_ids: [salesGroup.id],
        assignment_policy: {
          allow_unassigned: false,
          rules: [{
            subject_types: ["resource_group"],
            group_kind_ids: ["sales_team"],
            assignment_tag_ids: ["premium_leads"]
          }]
        }
      }]
    });
    const workNode = workPlan.tree.root_nodes[0];
    assert.deepEqual(workNode.assigned_resource_group_ids, [salesGroup.id]);
    assert.equal(workNode.assignment_policy.allow_unassigned, false);
    const rejectedWorkAssignment = await owner.raw("PATCH", `/v1/work/organizations/${orgId}/nodes/${workNode.id}`, {
      assigned_resource_group_ids: [group.id]
    });
    assert.equal(rejectedWorkAssignment.statusCode, 400);
    assert.equal(rejectedWorkAssignment.data.error, "work_assignment_not_allowed");

    const invalidKind = await owner.raw("POST", `${branchBase}/resource-groups`, {
      name: "Unknown Kind",
      kind_id: "not_configured"
    });
    assert.equal(invalidKind.statusCode, 400);
    assert.equal(invalidKind.data.error, "resource_group_kind_not_found");

    const invalidTag = await owner.raw("PATCH", `${branchBase}/resource-groups/${salesGroup.id}`, {
      expected_revision: salesGroup.revision,
      assignment_tag_ids: ["not_configured"]
    });
    assert.equal(invalidTag.statusCode, 400);
    assert.equal(invalidTag.data.error, "assignment_tag_not_found");
  });

  await t.test("organization connections are first-class resources", async () => {
    const created = await owner.request("POST", `/v1/connections/organizations/${orgId}/organization-connections`, {
      name: "Exterior Partner LLC",
      legal_name: "Exterior Partner Holdings LLC",
      relationship_type_ids: ["work_provider"],
      branch_ids: ["default"],
      contacts: [{ name: "Pat Partner", email: "pat@example.test", primary: true }],
      address: { city: "Tacoma", region: "WA" },
      payment_metadata: { terms: "net_15" },
      payment_terms: { basis: "net_days", net_days: 15 },
      capability_scope_ids: ["roof_replacement"]
    });
    connection = created.organization_connection;
    assert.equal(connection.name, "Exterior Partner LLC");
    assert.deepEqual(connection.branch_ids, ["default"]);
    for (const key of ["compensation_profile", "compensation_plan"]) assert.equal(Object.hasOwn(connection, key), false, key);
    assert.equal(connection.payment_terms.net_days, 15);

    const invalidCapability = await owner.raw("POST", `/v1/connections/organizations/${orgId}/organization-connections`, {
      name: "Invalid Scope Connection",
      branch_ids: ["default"],
      capability_scope_ids: ["scope_that_does_not_exist"]
    });
    assert.equal(invalidCapability.statusCode, 400);
  });

  await t.test("assignable resources filter by scope and expose canonical plus compatibility projections", async () => {
    const roof = await owner.request("GET", `${branchBase}/assignable-resources?scope_template_id=roof_replacement`);
    assert.equal(roof.count, 2);
    assert.deepEqual(new Set(roof.resources.map((resource: any) => resource.resource_kind)), new Set(["resource_group", "organization_connection"]));
    for (const resource of roof.resources) {
      assert.equal(resource.work_resource_ref.id, resource.resource_id);
      assert.equal(resource.work_resource_ref.kind, resource.resource_kind);
      assert.equal(resource.id, resource.resource_id);
      assert.ok(resource.name);
      assert.deepEqual(resource.project_types, ["roof_replacement"]);
    }

    const repairs = await owner.request("GET", `${branchBase}/assignable-resources?scope_template_id=repairs`);
    assert.equal(repairs.count, 0);
  });

  await t.test("revisions reject stale writes and delete archives resources", async () => {
    const oldGroupRevision = group.revision;
    const groupPatch = await owner.request("PATCH", `${branchBase}/resource-groups/${group.id}`, {
      expected_revision: oldGroupRevision,
      name: "Alpha Resource Group Updated",
      primary_member_user_id: null
    });
    group = groupPatch.resource_group;
    assert.equal(group.name, "Alpha Resource Group Updated");
    assert.equal(group.primary_member_user_id, "");
    const staleGroup = await owner.raw("PATCH", `${branchBase}/resource-groups/${group.id}`, {
      expected_revision: oldGroupRevision,
      name: "Stale Group Name"
    });
    assert.equal(staleGroup.statusCode, 409);

    const oldConnectionRevision = connection.revision;
    const connectionPatch = await owner.request("PATCH", `/v1/connections/organizations/${orgId}/organization-connections/${connection.id}`, {
      expected_revision: oldConnectionRevision,
      payment_metadata: { terms: "net_30" },
      payment_terms: { basis: "net_days", net_days: 30 }
    });
    connection = connectionPatch.organization_connection;
    assert.equal(connection.payment_metadata.terms, "net_30");
    assert.equal(connection.payment_terms.net_days, 30);
    const staleConnection = await owner.raw("PATCH", `/v1/connections/organizations/${orgId}/organization-connections/${connection.id}`, {
      expected_revision: oldConnectionRevision,
      legal_name: "Stale Legal Name"
    });
    assert.equal(staleConnection.statusCode, 409);

    const archivedGroup = await owner.request("DELETE", `${branchBase}/resource-groups/${group.id}?expected_revision=${group.revision}`);
    assert.equal(archivedGroup.resource_group.status, "archived");
    const archivedConnection = await owner.request("DELETE", `/v1/connections/organizations/${orgId}/organization-connections/${connection.id}?expected_revision=${connection.revision}`);
    assert.equal(archivedConnection.organization_connection.status, "archived");

    const assignable = await owner.request("GET", `${branchBase}/assignable-resources?scope_template_id=roof_replacement`);
    assert.equal(assignable.count, 0);
    const connections = await owner.request("GET", `/v1/connections/organizations/${orgId}/organization-connections?branch_id=default`);
    assert.equal(connections.count, 0);
  });
});
