import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

type Json = Record<string, any>;
type TestClient = ReturnType<typeof createSessionClient>;

const MANAGEMENT_PORTAL_APP_IDS = [
  "portal.viewer",
  "portal.contacts",
  "portal.photos_feed",
  "portal.proposals",
  "portal.scheduling",
  "portal.calls",
  "portal.canvassing",
  "portal.company_settings"
];
const MANAGEMENT_PROJECT_APP_IDS = [
  "project.map",
  "project.photos",
  "project.proposal",
  "project.docs",
  "project.materials",
  "project.money",
  "project.customer_portal",
  "project.schedule",
  "project.measurements",
  "project.checklists"
];
const MANAGEMENT_APP_IDS = [...MANAGEMENT_PORTAL_APP_IDS, ...MANAGEMENT_PROJECT_APP_IDS];
const OWNER_MANAGEMENT_APP_IDS = [...MANAGEMENT_APP_IDS, "portal.invoices", "portal.financials", "portal.payroll"];

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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-crew-api-test-"));
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
  const [{ closeWorkforceDatabase }, { closeWorkDatabase }, { closePayrollDatabase }] = await Promise.all([
    import("../workforce/storage.js"),
    import("../work/storage.js"),
    import("../payroll/storage.js")
  ]);
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  (await closePayrollDatabase());
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
    email: `crew-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Crew Test Owner",
    company: "Crew API Test Org",
    organization_id: `org_crew_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = String(registered.organization.id);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true,
          documents: true,
          materials: true,
          pricebook: true,
          money: true,
          proposals: true
        }
      }
    }
  }, { replace: false });
  return { orgId, suffix, userId: String(registered.user.id) };
}

async function createCrewUser(
  owner: TestClient,
  orgId: string,
  suffix: string,
  kind: "member" | "foreman" | "supervisor",
  appAccessOverrides: Json = {}
) {
  const email = `crew-${kind}-${suffix}@example.test`;
  const password = `crew ${kind} password`;
  const names = { member: "Morgan Member", foreman: "Casey Foreman", supervisor: "Sydney Supervisor" };
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email,
      password,
      name: names[kind],
      status: "active",
      role: "viewer",
      send_invite: false
    }
  });
  const userId = String(created.document.id);
  const roleId = kind === "member" ? "crew_member" : kind === "foreman" ? "crew_foreman" : "supervisor";
  const profile = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: [roleId],
    application_access: {
      management: { enabled: false, role_id: "viewer", permissions: {} },
      field: { enabled: true, role_id: roleId, permissions: {} }
    },
    app_access_overrides: appAccessOverrides
  });
  assert.deepEqual(profile.user.access_role_ids, [roleId]);
  assert.equal(profile.user.application_access.field.enabled, true);
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, roleId, client, profile };
}

async function createPermissionOnlyAdmin(owner: TestClient, orgId: string, suffix: string) {
  const email = `access-admin-${suffix}@example.test`;
  const password = "access admin password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email,
      password,
      name: "Access Administrator",
      status: "active",
      role: "custom",
      org_permissions: {
        level: "custom",
        items: { manage_company_user_permissions: true }
      },
      send_invite: false
    }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), client };
}

async function createManagementViewer(owner: TestClient, orgId: string, suffix: string) {
  const email = `management-viewer-${suffix}@example.test`;
  const password = "management viewer password";
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email,
      password,
      name: "Management Viewer",
      status: "active",
      role: "viewer",
      send_invite: false
    }
  });
  const userId = String(created.document.id);
  await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${userId}/profile`, {
    access_role_ids: ["viewer"],
    application_access: {
      management: { enabled: true, role_id: "viewer", permissions: {} },
      field: { enabled: false, role_id: "crew_member", permissions: {} }
    }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId, client };
}

function projectEvent(id: string, assignment: Json, schedule: Json) {
  return {
    id,
    kind: "project_work",
    event_type_default_id: "project_work",
    status: "scheduled",
    ...assignment,
    ...schedule
  };
}

async function seedProject(orgId: string, id: string, title: string, event: Json) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id,
    data: {
      branch_id: "default",
      title,
      address: `${title} Address`,
      stage: "production",
      notes: `${title} crew notes`,
      contacts: [{ id: `${id}_customer`, name: `${title} Customer`, phone: "555-0100", primary: true }],
      events: [event]
    },
    metadata: { kind: "platform_project", branch_id: "default", source: "crew_api_test" }
  }, { replace: true });
}

function entitlement(profile: Json, id: string) {
  const found = (profile.app_entitlements || []).find((entry: Json) => entry.id === id);
  assert.ok(found, `Missing app entitlement '${id}'.`);
  return found;
}

test("Crew API centralizes access and isolates assigned field workflows", async (t) => {
  const owner = createSessionClient();
  const { orgId, suffix, userId: ownerUserId } = await registerOwner(owner);
  const accessBase = `/v1/workforce/organizations/${orgId}/access`;
  const branchBase = `/v1/workforce/organizations/${orgId}/branches/default`;
  const crewBase = `/v1/workforce/organizations/${orgId}/crew`;

  await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${ownerUserId}/profile`, {
    access_role_ids: ["super_admin"],
    application_access: {
      management: { enabled: true, role_id: "super_admin", permissions: {} },
      field: { enabled: false, role_id: "crew_member", permissions: {} }
    }
  });

  await t.test("catalog and seeded role defaults keep app relevance separate from permissions", async () => {
    const catalog = await owner.request("GET", `${accessBase}/catalog`);
    // 33 management+crew apps plus the 4 sales apps; 8 seeded roles plus the
    // salesperson persona.
    assert.equal(catalog.apps.length, 37);
    assert.equal(catalog.roles.length, 9);
    assert.deepEqual(
      new Set(catalog.apps.filter((entry: Json) => entry.application_id === "management").map((entry: Json) => entry.id)),
      new Set(OWNER_MANAGEMENT_APP_IDS)
    );
    assert.ok(catalog.apps.filter((entry: Json) => entry.application_id === "management")
      .every((entry: Json) => entry.default_enabled === true));
    assert.ok(catalog.apps.filter((entry: Json) => entry.application_id === "field")
      .every((entry: Json) => entry.default_enabled === false));
    const schedule = catalog.apps.find((entry: Json) => entry.id === "portal.crew_schedule");
    assert.equal(schedule.runtime_app_id, undefined);
    assert.equal(schedule.default_params.variant, "mobile_crew");
    assert.equal(catalog.apps.some((entry: Json) => entry.id === "portal.crew_projects"), false);
    const receipts = catalog.apps.find((entry: Json) => entry.id === "portal.crew_receipts");
    assert.deepEqual(receipts.required_permissions, ["crew.receipts.upload"]);
    const projectApps = catalog.apps.filter((entry: Json) => entry.surface === "project_modal");
    assert.equal(projectApps.length, 19);
    const crewProjectApps = projectApps.filter((entry: Json) => entry.application_id === "field");
    assert.equal(crewProjectApps.length, 9);
    assert.ok(crewProjectApps.every((entry: Json) => entry.layout.left_column === "none"));
    const signatures = crewProjectApps.find((entry: Json) => entry.id === "project.crew_signatures");
    assert.deepEqual(signatures.devices, ["mobile", "desktop"]);
    assert.deepEqual(signatures.required_permissions, ["crew.signatures.present"]);

    const roles = Object.fromEntries(catalog.roles.map((role: Json) => [role.id, role]));
    assert.equal(roles.super_admin.permissions["*"], true);
    assert.equal(roles.super_admin.app_defaults["portal.crew_overview"].enabled, false);
    assert.equal(roles.crew_member.app_defaults["project.crew_payments"].enabled, false);
    assert.equal(roles.crew_member.permissions["crew.checklists.complete"], true);
    assert.equal(roles.crew_member.permissions["crew.checklists.manage"], undefined);
    // Crew roles are production-focused: payments and change-order issuing
    // belong to the supervisor (closing-out) role by default.
    assert.equal(roles.crew_foreman.app_defaults["project.crew_payments"].enabled, false);
    assert.equal(roles.crew_foreman.permissions["crew.checklists.manage"], true);
    assert.equal(roles.crew_foreman.permissions["crew.payments.take"], undefined);
    assert.equal(roles.crew_foreman.permissions["crew.change_orders.manage"], undefined);
    assert.equal(roles.supervisor.app_defaults["project.crew_payments"].enabled, true);
    assert.equal(roles.supervisor.permissions["crew.payments.take"], true);
    assert.equal(roles.supervisor.permissions["crew.projects.view_all_production"], true);
    assert.equal(roles.supervisor.permissions["crew.signatures.present"], true);
    assert.equal(roles.supervisor.permissions["crew.workflows.add"], true);
    assert.equal(roles.supervisor.app_defaults["project.crew_signatures"].enabled, true);
    assert.equal(roles.repairman.permissions["crew.checklists.manage"], true);
    assert.equal(roles.repairman.metadata.field_mode, "solo");

    const ownerAccess = await owner.request("GET", `${accessBase}/me`);
    assert.deepEqual(new Set(ownerAccess.access_profile.allowed_app_ids), new Set(OWNER_MANAGEMENT_APP_IDS));
    assert.ok(OWNER_MANAGEMENT_APP_IDS.every((id) => entitlement(ownerAccess.access_profile, id).source === "catalog_default"));
    assert.ok(ownerAccess.app_entitlements.filter((entry: Json) => entry.application_id === "field")
      .every((entry: Json) => entry.allowed === false));

    const createdRole = await owner.request("POST", `${accessBase}/roles`, {
      id: "hybrid_supervisor",
      name: "Field Operations Supervisor",
      description: "A renameable role spanning both application shells.",
      application_ids: ["management", "field"],
      permissions: { view_projects: true, "crew.dashboard.view": true },
      app_defaults: {
        "portal.crew_overview": { enabled: true, params: { mode: "crew" } },
        "portal.calls": { enabled: false }
      }
    });
    assert.deepEqual(createdRole.role.application_ids, ["management", "field"]);
    assert.equal(createdRole.role.application_id, "management");
    assert.equal(createdRole.role.app_defaults["portal.calls"].enabled, false);
    const patchedRole = await owner.request("PATCH", `${accessBase}/roles/${createdRole.role.id}`, {
      expected_revision: createdRole.role.revision,
      name: "Site Operations Supervisor"
    });
    assert.equal(patchedRole.role.name, "Site Operations Supervisor");
    assert.equal(patchedRole.role.app_defaults["portal.calls"].enabled, false);
    assert.equal(patchedRole.role.revision, createdRole.role.revision + 1);
    const staleRolePatch = await owner.raw("PATCH", `${accessBase}/roles/${createdRole.role.id}`, {
      expected_revision: createdRole.role.revision,
      name: "Stale update"
    });
    assert.equal(staleRolePatch.statusCode, 409);
    assert.equal(staleRolePatch.data.error, "access_role_revision_conflict");
    const fieldRoles = await owner.request("GET", `${accessBase}/roles?application_id=field`);
    assert.ok(fieldRoles.roles.some((role: Json) => role.id === createdRole.role.id));
    const archivedRole = await owner.request("DELETE", `${accessBase}/roles/${createdRole.role.id}?expected_revision=${patchedRole.role.revision}`);
    assert.equal(archivedRole.role.status, "archived");
    const activeRoles = await owner.request("GET", `${accessBase}/roles`);
    assert.equal(activeRoles.roles.some((role: Json) => role.id === createdRole.role.id), false);
  });

  await t.test("management catalog defaults remain visible and a user hide override removes one tab", async () => {
    const viewer = await createManagementViewer(owner, orgId, suffix);
    const initialSession = await viewer.client.request("GET", "/v1/platform/auth/session");
    assert.deepEqual(initialSession.membership.access_role_ids, ["viewer"]);
    assert.deepEqual(new Set(initialSession.access_profile.allowed_app_ids), new Set(MANAGEMENT_APP_IDS));
    assert.ok(MANAGEMENT_APP_IDS.every((id) => {
      const app = entitlement(initialSession.access_profile, id);
      return app.allowed === true && app.enabled === true && app.source === "catalog_default";
    }));
    assert.ok(initialSession.app_entitlements.filter((entry: Json) => entry.application_id === "field")
      .every((entry: Json) => entry.allowed === false));

    const profile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${viewer.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${viewer.userId}/profile`, {
      expected_revision: profile.user.revision,
      app_access_overrides: { "portal.calls": "hide" }
    });
    const hiddenSession = await viewer.client.request("GET", "/v1/platform/auth/session");
    assert.equal(entitlement(hiddenSession.access_profile, "portal.calls").allowed, false);
    assert.equal(entitlement(hiddenSession.access_profile, "portal.calls").source, "user_override");
    assert.ok(entitlement(hiddenSession.access_profile, "portal.viewer").allowed);
    assert.deepEqual(
      new Set(hiddenSession.access_profile.allowed_app_ids),
      new Set(MANAGEMENT_APP_IDS.filter((id) => id !== "portal.calls"))
    );
  });

  const memberOverrides = {
    "portal.crew_receipts": "inherit",
    "portal.crew_payouts": "hide",
    "project.crew_payments": "show"
  };
  const member = await createCrewUser(owner, orgId, suffix, "member", memberOverrides);
  const foreman = await createCrewUser(owner, orgId, suffix, "foreman");
  const supervisor = await createCrewUser(owner, orgId, suffix, "supervisor");

  await t.test("permission-only administrators can edit access but not compensation", async () => {
    const accessAdmin = await createPermissionOnlyAdmin(owner, orgId, suffix);
    const allowed = await accessAdmin.client.request(
      "PATCH",
      `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`,
      {
        access_role_ids: ["crew_member"],
        permission_overrides: { "crew.receipts.upload": false },
        app_access_overrides: { "portal.crew_receipts": "hide" },
        application_access: {
          field: { enabled: true, role_id: "crew_member", permissions: {} }
        }
      }
    );
    assert.equal(allowed.user.permission_overrides["crew.receipts.upload"], false);
    assert.equal(allowed.user.app_access_overrides["portal.crew_receipts"], "hide");

    const compensationMutation = await accessAdmin.client.raw(
      "PATCH",
      `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`,
      { compensation_profile: { components: [] } }
    );
    assert.equal(compensationMutation.statusCode, 403);
    assert.equal(compensationMutation.data.error, "workforce_profile_fields_forbidden");
    assert.deepEqual(compensationMutation.data.details.forbidden_fields, ["compensation_profile"]);

    // Restore the receipt/app defaults used by the remaining Crew workflow
    // tests. A full administrator retains authority over every profile field.
    const current = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    const restored = await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: current.user.revision,
      access_role_ids: ["crew_member"],
      permission_overrides: {},
      app_access_overrides: memberOverrides
    });
    assert.deepEqual(restored.user.access_role_ids, ["crew_member"]);
  });

  await t.test("profile overrides persist and session bootstrap carries effective entitlements", async () => {
    const persisted = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    assert.deepEqual(persisted.user.app_access_overrides, memberOverrides);

    const memberSession = await member.client.request("GET", "/v1/platform/auth/session");
    assert.equal(memberSession.membership.application_access.management.enabled, false);
    assert.equal(memberSession.membership.application_access.field.enabled, true);
    assert.deepEqual(memberSession.membership.access_role_ids, ["crew_member"]);
    assert.deepEqual(memberSession.access_profile.allowed_app_ids, [
      "portal.crew_overview",
      "portal.crew_schedule",
      "portal.crew_receipts",
      "project.crew_overview",
      "project.crew_materials",
      "project.crew_payouts",
      "project.crew_change_orders",
      "project.crew_checklists",
      "project.field_customer"
    ]);
    const inheritedReceipt = entitlement(memberSession.access_profile, "portal.crew_receipts");
    assert.equal(inheritedReceipt.allowed, true);
    assert.equal(inheritedReceipt.source, "role_default");
    const hiddenPayouts = entitlement(memberSession.access_profile, "portal.crew_payouts");
    assert.equal(hiddenPayouts.enabled, false);
    assert.equal(hiddenPayouts.allowed, false);
    assert.equal(hiddenPayouts.source, "user_override");
    const requestedPayment = entitlement(memberSession.access_profile, "project.crew_payments");
    assert.equal(requestedPayment.enabled, true);
    assert.equal(requestedPayment.allowed, false);
    assert.equal(requestedPayment.permission_allowed, false);
    assert.ok(requestedPayment.reasons.includes("permission_denied"));

    const memberAccess = await member.client.request("GET", `${accessBase}/me`);
    assert.deepEqual(memberAccess.access_profile.allowed_app_ids, memberSession.access_profile.allowed_app_ids);
    assert.ok(MANAGEMENT_APP_IDS.every((id) => {
      const app = entitlement(memberSession.access_profile, id);
      return app.allowed === false && app.application_enabled === false;
    }));
    const forbiddenCatalog = await member.client.raw("GET", `${accessBase}/catalog`);
    assert.equal(forbiddenCatalog.statusCode, 403);

    const foremanSession = await foreman.client.request("GET", "/v1/platform/auth/session");
    assert.deepEqual(foremanSession.membership.access_role_ids, ["crew_foreman"]);
    assert.equal(foremanSession.access_profile.allowed_app_ids.length, 10);
    assert.equal(entitlement(foremanSession.access_profile, "project.crew_payments").allowed, false);
    assert.equal(entitlement(foremanSession.access_profile, "project.crew_payments").params.can_take_payment, false);
    assert.equal(entitlement(foremanSession.access_profile, "project.crew_checklists").params.can_manage, true);
  });

  const groupResponse = await owner.request("POST", `${branchBase}/resource-groups`, {
    id: "north_crew",
    name: "North Crew",
    primary_member_user_id: foreman.userId,
    members: [
      { user_id: member.userId, role: "member", is_lead: false },
      { user_id: foreman.userId, role: "foreman", is_lead: true }
    ]
  });
  const groupId = String(groupResponse.resource_group.id);
  const groupAssignment = { work_resource_ref: { kind: "resource_group", id: groupId, name: "North Crew" } };
  const targetDate = "2030-01-03";

  await seedProject(orgId, "crew_early", "Early Timed", projectEvent("event_early", groupAssignment, {
    start_at: `${targetDate}T08:00:00.000Z`,
    end_at: `${targetDate}T09:00:00.000Z`,
    all_day: false,
    schedule_granularity: "time"
  }));
  await seedProject(orgId, "crew_late", "Late Timed", projectEvent("event_late", groupAssignment, {
    start_at: `${targetDate}T13:00:00.000Z`,
    end_at: `${targetDate}T15:00:00.000Z`,
    all_day: false,
    schedule_granularity: "time"
  }));
  await seedProject(orgId, "crew_all_day", "All Day", projectEvent("event_all_day", groupAssignment, {
    start_date: "2030-01-02",
    end_date: targetDate,
    all_day: true,
    schedule_granularity: "date"
  }));
  await seedProject(orgId, "crew_overdue", "Overdue", projectEvent("event_overdue", groupAssignment, {
    start_date: "2029-12-31",
    end_date: "2030-01-01",
    all_day: true,
    schedule_granularity: "date"
  }));
  await seedProject(orgId, "member_direct", "Member Direct", projectEvent("event_member", {
    assigned_user_ids: [member.userId]
  }, {
    start_date: "2030-02-01",
    end_date: "2030-02-01",
    all_day: true,
    schedule_granularity: "date"
  }));
  await seedProject(orgId, "other_crew", "Other Crew", projectEvent("event_other", {
    work_resource_ref: { kind: "resource_group", id: "some_other_crew", name: "Some Other Crew" }
  }, {
    start_date: targetDate,
    end_date: targetDate,
    all_day: true,
    schedule_granularity: "date"
  }));

  await t.test("Crew users can read only their own payroll earnings while managers can query reusable payee sets", async () => {
    const payrollBase = `/v1/payroll/organizations/${orgId}`;
    const schedule = (await owner.request("POST", `${payrollBase}/schedules`, {
      id: "crew_weekly",
      name: "Crew Weekly",
      timezone: "America/Los_Angeles",
      recurrence: { frequency: "weekly", weekday: 5 },
      delay: { periods: 0 },
      timing_basis: "worked"
    })).schedule;
    await owner.request("POST", `${payrollBase}/ledger`, {
      entries: [
        {
          payee: { type: "organization_user", id: member.userId, name: "Morgan Member", worker_type: "employee" },
          schedule_id: schedule.id,
          kind: "piece_rate",
          state: "accrued",
          amount_cents: 12_500,
          project_id: "crew_early",
          project_title: "Early Timed",
          worked_at: `${targetDate}T09:00:00.000Z`,
          source_event_id: "crew-earnings-accrued",
          description: "Early Timed labor"
        },
        {
          payee: { type: "organization_user", id: member.userId, name: "Morgan Member", worker_type: "employee" },
          schedule_id: schedule.id,
          kind: "piece_rate",
          state: "projected",
          amount_cents: 4_000,
          project_id: "crew_all_day",
          project_title: "All Day",
          worked_at: `${targetDate}T10:00:00.000Z`,
          source_event_id: "crew-earnings-projected",
          description: "All Day projected labor"
        },
        {
          payee: { type: "organization_user", id: foreman.userId, name: "Casey Foreman", worker_type: "employee" },
          schedule_id: schedule.id,
          kind: "piece_rate",
          state: "accrued",
          amount_cents: 9_900,
          project_id: "crew_early",
          project_title: "Early Timed",
          worked_at: `${targetDate}T09:00:00.000Z`,
          source_event_id: "foreman-earnings-accrued",
          description: "Foreman labor"
        }
      ]
    });

    const mine = await member.client.request("GET", `${payrollBase}/earnings/me`);
    assert.equal(mine.earnings.subject.id, member.userId);
    assert.equal(mine.earnings.totals.owed_cents, 12_500);
    assert.equal(mine.earnings.totals.projected_cents, 4_000);
    assert.deepEqual(new Set(mine.earnings.projects.map((project: Json) => project.project_id)), new Set(["crew_early", "crew_all_day"]));
    assert.equal(mine.earnings.entries.some((entry: Json) => Object.hasOwn(entry, "source_event_id")), false);

    const projectOnly = await member.client.request("GET", `${payrollBase}/earnings/me?project_id=crew_early`);
    assert.equal(projectOnly.earnings.projects.length, 1);
    assert.equal(projectOnly.earnings.projects[0].project_id, "crew_early");
    assert.equal(projectOnly.earnings.totals.owed_cents, 12_500);
    assert.equal(projectOnly.earnings.totals.projected_cents, 0);

    const forbiddenOtherPayee = await member.client.raw("GET", `${payrollBase}/earnings/payees/organization_user/${foreman.userId}`);
    assert.equal(forbiddenOtherPayee.statusCode, 403);

    const managedForeman = await owner.request("GET", `${payrollBase}/earnings/payees/organization_user/${foreman.userId}`);
    assert.equal(managedForeman.earnings.subject.id, foreman.userId);
    assert.equal(managedForeman.earnings.totals.owed_cents, 9_900);

    const payeeQuery = [member.userId, foreman.userId]
      .map((id) => `payee=${encodeURIComponent(`organization_user:${id}`)}`).join("&");
    const managedSet = await owner.request("GET", `${payrollBase}/earnings?${payeeQuery}`);
    assert.equal(managedSet.earnings.length, 2);
    assert.deepEqual(new Set(managedSet.earnings.map((report: Json) => report.subject.id)), new Set([member.userId, foreman.userId]));
  });

  await t.test("assignment resolution isolates users and dashboard ordering puts overdue work last", async () => {
    const dashboard = await member.client.request("GET", `${crewBase}/me/dashboard?date=${targetDate}`);
    assert.deepEqual(dashboard.projects.map((project: Json) => project.id), [
      "crew_early",
      "crew_late",
      "crew_all_day",
      "crew_overdue"
    ]);
    assert.deepEqual(dashboard.today.map((project: Json) => project.id), ["crew_early", "crew_late", "crew_all_day"]);
    assert.deepEqual(dashboard.overdue.map((project: Json) => project.id), ["crew_overdue"]);
    assert.equal(dashboard.projects[0].schedule.specific_time, true);
    assert.equal(dashboard.projects[2].schedule.day_indicator, "2/2");
    assert.equal(dashboard.projects[3].schedule.overdue_day, true);
    assert.equal(dashboard.projects[3].overdue, true);

    const memberProjects = await member.client.request("GET", `${crewBase}/me/projects`);
    assert.deepEqual(new Set(memberProjects.projects.map((project: Json) => project.id)), new Set([
      "crew_early", "crew_late", "crew_all_day", "crew_overdue", "member_direct"
    ]));
    const foremanProjects = await foreman.client.request("GET", `${crewBase}/me/projects`);
    assert.deepEqual(new Set(foremanProjects.projects.map((project: Json) => project.id)), new Set([
      "crew_early", "crew_late", "crew_all_day", "crew_overdue"
    ]));
    const assignedSearch = await member.client.request("GET", `${crewBase}/me/projects?search=Early%20Timed`);
    assert.deepEqual(assignedSearch.projects.map((project: Json) => project.id), ["crew_early"]);
    const unassignedSearch = await member.client.request("GET", `${crewBase}/me/projects?search=Other%20Crew`);
    assert.deepEqual(unassignedSearch.projects, []);
    const assignedGlobalSearch = await member.client.request("GET", `/v1/platform/organizations/${orgId}/search?q=Early%20Timed&types=projects,contacts`);
    assert.ok(assignedGlobalSearch.results.length > 0);
    assert.ok(assignedGlobalSearch.results.every((result: Json) => result.project_id === "crew_early"));
    const unassignedGlobalSearch = await member.client.request("GET", `/v1/platform/organizations/${orgId}/search?q=Other%20Crew&types=projects,contacts`);
    assert.deepEqual(unassignedGlobalSearch.results, []);
    const managementGlobalSearch = await owner.request("GET", `/v1/platform/organizations/${orgId}/search?q=Other%20Crew&types=projects`);
    assert.deepEqual(managementGlobalSearch.results.map((result: Json) => result.project_id), ["other_crew"]);

    const direct = await member.client.request("GET", `${crewBase}/projects/member_direct`);
    assert.equal(direct.project.id, "member_direct");
    const foremanDirect = await foreman.client.raw("GET", `${crewBase}/projects/member_direct`);
    assert.equal(foremanDirect.statusCode, 403);
    assert.equal(foremanDirect.data.error, "crew_project_forbidden");
    const unrelated = await member.client.raw("GET", `${crewBase}/projects/other_crew`);
    assert.equal(unrelated.statusCode, 403);
    assert.equal(unrelated.data.error, "crew_project_forbidden");
  });

  await t.test("time clock enforces one active shift and valid break transitions", async () => {
    // The clock is compensation-derived: without an hourly component the
    // member cannot clock in at all.
    const notApplicable = await member.client.raw("POST", `${crewBase}/me/time-clock/actions`, { action: "clock_in" });
    assert.equal(notApplicable.statusCode, 403);
    assert.equal(notApplicable.data.error, "time_clock_not_applicable");
    const inapplicableClock = await member.client.request("GET", `${crewBase}/me/time-clock`);
    assert.equal(inapplicableClock.applicable, false);
    const noCompSession = await member.client.request("GET", "/v1/platform/auth/session");
    assert.equal(entitlement(noCompSession.access_profile, "portal.crew_overview").params.time_clock_enabled, false);
    const memberProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: memberProfile.user.revision,
      compensation_profile: { components: [{ kind: "hourly", rate_cents: 2_500 }] }
    });

    const initial = await member.client.request("GET", `${crewBase}/me/time-clock`);
    assert.equal(initial.applicable, true);
    assert.equal(initial.time_clock.active, false);
    // The entitlement param follows compensation too, so the clock UI only
    // renders for hourly workers.
    const hourlySession = await member.client.request("GET", "/v1/platform/auth/session");
    assert.equal(entitlement(hourlySession.access_profile, "portal.crew_overview").params.time_clock_enabled, true);

    const breakBeforeShift = await member.client.raw("POST", `${crewBase}/me/time-clock/actions`, { action: "break_start" });
    assert.equal(breakBeforeShift.statusCode, 409);
    assert.equal(breakBeforeShift.data.error, "time_clock_not_active");

    const clockedIn = await member.client.request("POST", `${crewBase}/me/time-clock/actions`, {
      action: "clock_in",
      metadata: {
        project_id: "crew_early",
        location: { status: "captured", latitude: 34.0522, longitude: -118.2437, accuracy_meters: 12, captured_at: new Date().toISOString() }
      }
    });
    assert.equal(clockedIn.active, true);
    assert.equal(clockedIn.current_shift.status, "active");
    const duplicateClockIn = await member.client.raw("POST", `${crewBase}/me/time-clock/actions`, { action: "clock_in" });
    assert.equal(duplicateClockIn.statusCode, 409);
    assert.equal(duplicateClockIn.data.error, "time_clock_already_active");

    const breakStarted = await member.client.request("POST", `${crewBase}/me/time-clock/actions`, { action: "break_start" });
    assert.equal(breakStarted.current_shift.on_break, true);
    const duplicateBreak = await member.client.raw("POST", `${crewBase}/me/time-clock/actions`, { action: "break_start" });
    assert.equal(duplicateBreak.statusCode, 409);
    assert.equal(duplicateBreak.data.error, "time_clock_break_active");

    const clockedOut = await member.client.request("POST", `${crewBase}/me/time-clock/actions`, {
      action: "clock_out",
      metadata: { location: { status: "captured", latitude: 34.0524, longitude: -118.2435, accuracy_meters: 18, captured_at: new Date().toISOString() } }
    });
    assert.equal(clockedOut.active, false);
    assert.equal(clockedOut.clocked_out, true);
    assert.equal(clockedOut.shift.status, "closed");
    assert.equal(clockedOut.automatic_break_event.action, "break_end");
    assert.equal(clockedOut.automatic_break_event.data.automatic, true);
    assert.ok(clockedOut.shift.break_seconds >= 0);
    assert.ok(clockedOut.shift.worked_seconds <= clockedOut.shift.elapsed_seconds);

    const finalClock = await member.client.request("GET", `${crewBase}/me/time-clock`);
    assert.equal(finalClock.time_clock.active, false);
    assert.deepEqual(new Set(finalClock.time_clock.events.map((event: Json) => event.action)), new Set([
      "clock_in", "break_start", "break_end", "clock_out"
    ]));
    const secondClockOut = await member.client.raw("POST", `${crewBase}/me/time-clock/actions`, { action: "clock_out" });
    assert.equal(secondClockOut.statusCode, 409);
    assert.equal(secondClockOut.data.error, "time_clock_not_active");
    const foremanClock = await foreman.client.request("GET", `${crewBase}/me/time-clock`);
    assert.equal(foremanClock.time_clock.active, false);

    const payrollBase = `/v1/payroll/organizations/${orgId}`;
    const memberTimesheets = await member.client.raw("GET", `${payrollBase}/timesheets`);
    assert.equal(memberTimesheets.statusCode, 403);
    const listed = await owner.request("GET", `${payrollBase}/timesheets`);
    const listedShift = listed.timesheets.find((shift: Json) => shift.id === clockedOut.shift.id);
    assert.equal(listedShift.approval_status, "pending");
    assert.equal(listedShift.project.id, "crew_early");
    assert.equal(listedShift.clock_in_location.status, "captured");
    assert.equal(listedShift.clock_out_location.status, "captured");
    assert.equal(listedShift.clock_in_location.accuracy_meters, 12);

    const corrected = await owner.request("PATCH", `${payrollBase}/timesheets/${clockedOut.shift.id}`, {
      expected_revision: listedShift.revision,
      clocked_in_at: "2030-02-01T08:00:00.000Z",
      clocked_out_at: "2030-02-01T16:00:00.000Z",
      break_seconds: 1800,
      project_id: "crew_early",
      manager_note: "Verified against the daily log"
    });
    assert.equal(corrected.timesheet.worked_seconds, 27_000);
    const schedules = await owner.request("GET", `${payrollBase}/schedules`);
    const weekly = schedules.schedules.find((schedule: Json) => schedule.name === "Crew Weekly");
    await owner.request("PUT", `${payrollBase}/policies/organization_user/${member.userId}`, {
      schedule_id: weekly.id,
      earning_kind: "hourly"
    });
    const approved = await owner.request("POST", `${payrollBase}/timesheets/${clockedOut.shift.id}/approve`, {
      expected_revision: corrected.timesheet.revision
    });
    assert.equal(approved.timesheet.approval_status, "approved");
    assert.ok(approved.timesheet.payroll_entry_id);
    const payrollEntry = await owner.request("GET", `${payrollBase}/ledger/${approved.timesheet.payroll_entry_id}`);
    assert.equal(payrollEntry.entry.kind, "hourly");
    assert.equal(payrollEntry.entry.amount_cents, 18_750);
    assert.equal(payrollEntry.entry.project_id, "crew_early");
  });

  await t.test("checklists expose completion-only member mode and full foreman management", async () => {
    const created = await foreman.client.request("POST", `${crewBase}/projects/crew_early/checklist/items`, {
      title: "Photograph completed roof",
      description: "Capture all elevations",
      sort_order: 10
    });
    assert.equal(created.item.completed, false);

    const memberChecklist = await member.client.request("GET", `${crewBase}/projects/crew_early/checklist`);
    assert.equal(memberChecklist.mode, "complete");
    assert.deepEqual(memberChecklist.permissions, { view: true, complete: true, manage: false });
    const memberCreate = await member.client.raw("POST", `${crewBase}/projects/crew_early/checklist/items`, { title: "Not allowed" });
    assert.equal(memberCreate.statusCode, 403);
    assert.equal(memberCreate.data.error, "crew_permission_denied");

    const completed = await member.client.request("PATCH", `${crewBase}/projects/crew_early/checklist/items/${created.item.id}`, {
      expected_revision: created.item.revision,
      completed: true
    });
    assert.equal(completed.mode, "complete");
    assert.equal(completed.item.completed, true);
    assert.equal(completed.item.completed_by_user_id, member.userId);
    const memberEdit = await member.client.raw("PATCH", `${crewBase}/projects/crew_early/checklist/items/${created.item.id}`, {
      expected_revision: completed.item.revision,
      title: "Member cannot rename"
    });
    assert.equal(memberEdit.statusCode, 400);
    assert.equal(memberEdit.data.error, "checklist_manage_required");

    const foremanChecklist = await foreman.client.request("GET", `${crewBase}/projects/crew_early/checklist`);
    assert.equal(foremanChecklist.mode, "manage");
    assert.deepEqual(foremanChecklist.permissions, { view: true, complete: true, manage: true });
    const renamed = await foreman.client.request("PATCH", `${crewBase}/projects/crew_early/checklist/items/${created.item.id}`, {
      expected_revision: completed.item.revision,
      title: "Photograph roof and gutters"
    });
    assert.equal(renamed.item.title, "Photograph roof and gutters");
  });

  await t.test("authorized field users can review workflow history and launch field-enabled scopes", async () => {
    const memberTimeline = await member.client.raw("GET", `${crewBase}/projects/crew_early/workflows`);
    assert.equal(memberTimeline.statusCode, 403);
    assert.equal(memberTimeline.data.error, "crew_permission_denied");

    const initial = await supervisor.client.request("GET", `${crewBase}/projects/crew_early/workflows`);
    assert.equal(initial.can_add_work, true);
    assert.ok(initial.library.some((entry: Json) => entry.id === "same_day_service_sales" && entry.frequent === true));

    const launched = await supervisor.client.request("POST", `${crewBase}/projects/crew_early/workflows/scopes/same_day_service_sales`, {});
    assert.equal(launched.created, true);
    assert.equal(launched.plan.template_id, "same_day_service_sales");
    assert.equal(launched.plan.source_type, "field_added_work");
    assert.ok(launched.items.some((entry: Json) => entry.scope === "Same-Day Service Sales"));

    const refreshed = await supervisor.client.request("GET", `${crewBase}/projects/crew_early/workflows`);
    assert.ok(refreshed.items.some((entry: Json) => entry.scope === "Same-Day Service Sales"));
  });

  await t.test("scheduled events project scope-defined visit workflows and persist visit transitions", async () => {
    const { readDocument, upsertDocument } = await import("../platform/storage.js");
    const genericVisit = await supervisor.client.request("GET", `${crewBase}/projects/crew_late/visit?event_id=event_late`);
    assert.equal(genericVisit.configured, true);
    assert.equal(genericVisit.workflow.id, "default_field_visit");
    assert.deepEqual(genericVisit.workflow.steps.map((step: Json) => step.navigation_title), ["En route", "Arrived", "Work", "Done"]);

    const lateStored = await readDocument(orgId, "projects", "crew_late");
    const lateProject = { ...lateStored.data } as Json;
    lateProject.events = (lateProject.events || []).map((event: Json) => event.id === "event_late"
      ? { ...event, event_type_default_id:"sales_appointment", kind:"sales_appointment", assigned_user_ids:[supervisor.userId] }
      : event);
    await upsertDocument(orgId, "projects", { id:"crew_late", data:lateProject, metadata:lateStored.metadata }, { replace:true });
    const salesVisit = await supervisor.client.request("GET", `${crewBase}/projects/crew_late/visit?event_id=event_late`);
    assert.equal(salesVisit.workflow.id, "default_sales_visit");
    assert.deepEqual(salesVisit.workflow.steps.map((step: Json) => step.navigation_title), ["En route", "Arrived", "Proposal", "Outcome", "Done"]);
    await supervisor.client.request("POST", `${crewBase}/projects/crew_late/visit/steps/en_route/actions`, { event_id:"event_late", skip_notification:true });
    await supervisor.client.request("POST", `${crewBase}/projects/crew_late/visit/steps/arrived/actions`, { event_id:"event_late" });
    const followUpVisit = await supervisor.client.request("POST", `${crewBase}/projects/crew_late/visit/steps/outcome/actions`, { event_id:"event_late", action_id:"follow_up" });
    assert.deepEqual(followUpVisit.workflow.steps.map((step: Json) => step.navigation_title), ["En route", "Arrived", "Proposal", "Outcome", "Follow-up", "Done"]);
    assert.equal(followUpVisit.state.current_step_id, "follow_up");
    assert.equal(followUpVisit.integrations.follow_ups.length, 1);
    assert.equal(followUpVisit.state.step_results.outcome.follow_up_node_id, followUpVisit.integrations.follow_ups[0].id);
    const roofingStored = await readDocument(orgId, "projects", "crew_late");
    const roofingProject = { ...roofingStored.data } as Json;
    roofingProject.events = (roofingProject.events || []).map((event: Json) => event.id === "event_late"
      ? { ...event, scope_template_id:"roofing_sales_appointment", visit_state:{} }
      : event);
    await upsertDocument(orgId, "projects", { id:"crew_late", data:roofingProject, metadata:roofingStored.metadata }, { replace:true });
    const roofingVisit = await supervisor.client.request("GET", `${crewBase}/projects/crew_late/visit?event_id=event_late`);
    assert.equal(roofingVisit.workflow.id, "standard_roofing_sales_visit");
    assert.deepEqual(roofingVisit.workflow.steps.map((step: Json) => step.navigation_title), ["En route", "Arrived", "Appointment", "Price", "Present", "Notes", "Summary"]);
    const restoredLate = await readDocument(orgId, "projects", "crew_late");
    const restoredLateProject = { ...restoredLate.data } as Json;
    restoredLateProject.events = (restoredLateProject.events || []).map((event: Json) => event.id === "event_late"
      ? { ...event, event_type_default_id:"project_work", kind:"project_work", scope_template_id:"", visit_state:{}, assigned_user_ids:[] }
      : event);
    await upsertDocument(orgId, "projects", { id:"crew_late", data:restoredLateProject, metadata:restoredLate.metadata }, { replace:true });

    const stored = await readDocument(orgId, "projects", "crew_early");
    const project = { ...stored.data } as Json;
    project.contacts = [{ id:"crew_early_customer", name:"Early Customer", phone:"206-555-0199", primary:true }];
    project.events = (project.events || []).map((event: Json) => event.id === "event_early"
      ? { ...event, scope_template_id: "same_day_service_production" }
      : event);
    await upsertDocument(orgId, "projects", { id:"crew_early", data:project, metadata:stored.metadata }, { replace:true });

    const visit = await supervisor.client.request("GET", `${crewBase}/projects/crew_early/visit?event_id=event_early`);
    assert.equal(visit.configured, true);
    assert.equal(visit.workflow.id, "same_day_production_visit");
    assert.deepEqual(visit.workflow.steps.map((step: Json) => step.navigation_title), ["En route", "Arrived", "Install", "Payment", "Sign", "Added work", "Done"]);

    const enRoute = await supervisor.client.request("POST", `${crewBase}/projects/crew_early/visit/steps/en_route/actions`, { event_id:"event_early" });
    assert.ok(enRoute.state.completed_step_ids.includes("en_route"));
    assert.equal(enRoute.state.status, "en_route");
    assert.equal(enRoute.notification.requested, true);
    const repeatedEnRoute = await supervisor.client.request("POST", `${crewBase}/projects/crew_early/visit/steps/en_route/actions`, { event_id:"event_early" });
    assert.equal(repeatedEnRoute.idempotent, true);
    assert.equal(repeatedEnRoute.notification.already_processed, true);
    assert.equal(repeatedEnRoute.notification.message_id, enRoute.notification.message_id);
    assert.equal(repeatedEnRoute.state.completed_step_ids.filter((id: string) => id === "en_route").length, 1);
  });

  await t.test("supervisor payment and change-order facades reuse the shared financial domains", async () => {
    const { upsertDocument } = await import("../platform/storage.js");
    await upsertDocument(orgId, "projects", {
      id: "crew_early",
      data: { contract_total_cents: 250_000 },
      metadata: { source: "crew_payment_contract_test" }
    }, { replace: false });
    // A sales-stage project with no scheduled work: even production-scope
    // roles cannot reach it.
    await upsertDocument(orgId, "projects", {
      id: "sales_only",
      data: { title: "Sales Only", address: "Sales Only Address", events: [] },
      metadata: { kind: "platform_project", source: "crew_payment_contract_test" }
    }, { replace: true });

    const memberPayments = await member.client.raw("GET", `${crewBase}/projects/crew_early/payments`);
    assert.equal(memberPayments.statusCode, 403);
    assert.equal(memberPayments.data.error, "crew_permission_denied");
    // Foremen are production-focused: no payment access by default.
    const foremanPayments = await foreman.client.raw("GET", `${crewBase}/projects/crew_early/payments`);
    assert.equal(foremanPayments.statusCode, 403);
    assert.equal(foremanPayments.data.error, "crew_permission_denied");
    const unassignedPayments = await supervisor.client.raw("GET", `${crewBase}/projects/sales_only/payments`);
    assert.equal(unassignedPayments.statusCode, 403);
    assert.equal(unassignedPayments.data.error, "crew_project_forbidden");
    const unassignedPaymentWrite = await supervisor.client.raw("POST", `${crewBase}/projects/sales_only/payments`, {
      amount_cents: 1000,
      allocate: false
    });
    assert.equal(unassignedPaymentWrite.statusCode, 403);
    assert.equal(unassignedPaymentWrite.data.error, "crew_project_forbidden");

    // Supervisors take payments on any production project, even without a
    // crew assignment of their own.
    const initialPayments = await supervisor.client.request("GET", `${crewBase}/projects/crew_early/payments`);
    assert.equal(initialPayments.payment_summary.project_id, "crew_early");
    assert.equal(initialPayments.payment_summary.total_cents, 250_000);
    assert.equal(initialPayments.payment_summary.due_cents, 250_000);
    assert.equal(initialPayments.payment_summary.sources.project_contract_total_cents, 250_000);

    const cardSpoof = await supervisor.client.raw("POST", `${crewBase}/projects/crew_early/payments`, {
      amount_cents: 12500,
      method: { kind: "card", last4: "4242" },
      processor: { kind: "stripe", payment_intent_id: "pi_spoof" },
      status: "settled"
    });
    assert.equal(cardSpoof.statusCode, 400);
    assert.equal(cardSpoof.data.error, "crew_payment_method_unsupported");
    const achSpoof = await supervisor.client.raw("POST", `${crewBase}/projects/crew_early/payments`, {
      amount_cents: 12500,
      method: { kind: "ach" },
      status: "settled"
    });
    assert.equal(achSpoof.statusCode, 400);
    assert.equal(achSpoof.data.error, "crew_payment_method_unsupported");

    const paid = await supervisor.client.request("POST", `${crewBase}/projects/crew_early/payments`, {
      amount_cents: 12500,
      allocate: false,
      method: { kind: "check", reference: "CREW-CHECK-1" },
      notes: "Collected on site"
    });
    assert.equal(paid.payment.project_id, "crew_early");
    assert.equal(paid.payment.amount_cents, 12500);
    assert.equal(paid.payment.direction, "inbound");
    assert.equal(paid.payment.metadata.source, "crew_app");
    assert.equal(paid.payment.metadata.received_by_user_id, supervisor.userId);
    assert.deepEqual(paid.payment.processor, {});
    assert.equal(paid.payment_summary.paid_cents, 12500);
    assert.equal(paid.payment_summary.due_cents, 237_500);
    assert.equal(paid.payment_summary.payments.length, 1);

    // Crew members can now review change orders (read-only) but cannot create
    // or send them.
    const memberChangeOrders = await member.client.raw("GET", `${crewBase}/projects/crew_early/change-orders`);
    assert.equal(memberChangeOrders.statusCode, 200);
    const memberChangeOrderWrite = await member.client.raw("POST", `${crewBase}/projects/crew_early/change-orders`, {
      title: "Unauthorized change order",
      items: [{ id: "nope", name: "Nope", quantity: 1, unit_price_cents: 100, total_cents: 100 }]
    });
    assert.equal(memberChangeOrderWrite.statusCode, 403);
    assert.equal(memberChangeOrderWrite.data.error, "crew_permission_denied");
    // Foremen can review change orders but issuing them belongs to the
    // supervisor role.
    const foremanChangeOrders = await foreman.client.raw("GET", `${crewBase}/projects/crew_early/change-orders`);
    assert.equal(foremanChangeOrders.statusCode, 200);
    const foremanChangeOrderWrite = await foreman.client.raw("POST", `${crewBase}/projects/crew_early/change-orders`, {
      title: "Foreman change order",
      items: [{ id: "nope", name: "Nope", quantity: 1, unit_price_cents: 100, total_cents: 100 }]
    });
    assert.equal(foremanChangeOrderWrite.statusCode, 403);
    assert.equal(foremanChangeOrderWrite.data.error, "crew_permission_denied");
    const createdChangeOrder = await supervisor.client.request("POST", `${crewBase}/projects/crew_early/change-orders`, {
      title: "Replace damaged fascia",
      details: "Customer approved replacing twelve additional feet.",
      items: [{
        id: "fascia_change",
        name: "Additional fascia",
        quantity: 12,
        unit: "lf",
        unit_price_cents: 4000,
        total_cents: 48000
      }]
    });
    assert.equal(createdChangeOrder.change_order.project_id, "crew_early");
    assert.equal(createdChangeOrder.change_order.document_kind, "change_order");
    assert.equal(createdChangeOrder.change_order.proposal_type, "change_order");
    assert.equal(createdChangeOrder.change_order.change_order.created_in_crew_app, true);
    assert.equal(createdChangeOrder.change_order.total_cents, 48000);
    assert.equal(createdChangeOrder.change_order.editable.scope.root_items[0].unit_price, 40);
    assert.equal(createdChangeOrder.change_order.editable.scope.root_items[0].amount, 480);
    assert.equal(createdChangeOrder.change_order.editable.pricing.total, 480);
    const memberSend = await member.client.raw("POST", `${crewBase}/change-orders/${createdChangeOrder.change_order.id}/send`, {
      include_pdf: false,
      include_portal: true
    });
    assert.equal(memberSend.statusCode, 403);
    assert.equal(memberSend.data.error, "crew_permission_denied");

    const linkReady = await supervisor.client.request("POST", `${crewBase}/change-orders/${createdChangeOrder.change_order.id}/send`, {
      recipients: [],
      include_pdf: false,
      include_portal: true
    });
    assert.equal(linkReady.proposal.status, "draft");
    assert.equal(linkReady.proposal.delivery.state, "not_sent");
    assert.equal(linkReady.delivery_result.delivered, false);
    assert.equal(linkReady.delivery_result.delivery_state, "link_ready");
    assert.ok(linkReady.portal.public_token);
    assert.match(linkReady.portal.app_url, /\/v1\/proposals\/public\/.+\/app$/);
    const publicLink = await supervisor.client.request("GET", `/v1/proposals/public/${linkReady.portal.public_token}`);
    assert.equal(publicLink.snapshot.proposal_id, createdChangeOrder.change_order.id);

    const sent = await supervisor.client.request("POST", `${crewBase}/change-orders/${createdChangeOrder.change_order.id}/send`, {
      recipients: [{ role: "customer", name: "Early Timed Customer", email: "early-customer@example.test" }],
      include_pdf: false,
      include_portal: true
    });
    assert.equal(sent.proposal.status, "sent");
    assert.equal(sent.proposal.delivery.state, "sent");
    assert.equal(sent.snapshot.proposal_id, createdChangeOrder.change_order.id);
    assert.ok(sent.snapshot.delivery.public_token);
    assert.equal(sent.delivery_result.delivered, true);
    assert.equal(sent.delivery_result.delivery_state, "sent");
    const changeOrders = await supervisor.client.request("GET", `${crewBase}/projects/crew_early/change-orders`);
    assert.equal(changeOrders.count, 1);
    assert.equal(changeOrders.change_orders[0].id, createdChangeOrder.change_order.id);

    const payout = await foreman.client.request("GET", `${crewBase}/projects/crew_early/payouts`);
    assert.equal(payout.payout.project_id, "crew_early");
    assert.ok(Number.isInteger(payout.payout.projected_cents));
    const unassignedPayout = await foreman.client.raw("GET", `${crewBase}/projects/other_crew/payouts`);
    assert.equal(unassignedPayout.statusCode, 403);
    assert.equal(unassignedPayout.data.error, "crew_project_forbidden");
    const globalPayouts = await foreman.client.request("GET", `${crewBase}/me/payouts`);
    assert.equal(globalPayouts.payouts.some((item: Json) => item.project_id === "other_crew"), false);

    const otherChangeOrder = await owner.request("POST", `${crewBase}/projects/other_crew/change-orders`, {
      title: "Other crew change",
      items: [{ name: "Other work", quantity: 1 }]
    });
    const unassignedSend = await foreman.client.raw("POST", `${crewBase}/change-orders/${otherChangeOrder.change_order.id}/send`, {
      include_pdf: false,
      include_portal: true
    });
    assert.equal(unassignedSend.statusCode, 403);
    assert.equal(unassignedSend.data.error, "crew_permission_denied");
  });

  await t.test("production scope lets supervisors see all scheduled work while crews stay assignment-bound", async () => {
    const supervisorDashboard = await supervisor.client.request("GET", `${crewBase}/me/dashboard?date=${targetDate}`);
    assert.deepEqual(new Set(supervisorDashboard.projects.map((project: Json) => project.id)), new Set([
      "crew_early", "crew_late", "crew_all_day", "crew_overdue", "other_crew"
    ]));
    const supervisorProjects = await supervisor.client.request("GET", `${crewBase}/me/projects`);
    assert.ok(supervisorProjects.projects.some((project: Json) => project.id === "other_crew"));
    assert.equal(supervisorProjects.projects.some((project: Json) => project.id === "sales_only"), false);
    const supervisorDetail = await supervisor.client.request("GET", `${crewBase}/projects/other_crew`);
    assert.equal(supervisorDetail.project.id, "other_crew");
    const supervisorSalesOnly = await supervisor.client.raw("GET", `${crewBase}/projects/sales_only`);
    assert.equal(supervisorSalesOnly.statusCode, 403);
    assert.equal(supervisorSalesOnly.data.error, "crew_project_forbidden");
    const memberStillScoped = await member.client.raw("GET", `${crewBase}/projects/other_crew`);
    assert.equal(memberStillScoped.statusCode, 403);
  });

  await t.test("assigned Crew members can append manual materials but cannot mutate other crews' projects", async () => {
    const unassignedAdd = await member.client.raw("POST", `${crewBase}/projects/other_crew/materials/items`, {
      name: "Should not be added",
      quantity: 1
    });
    assert.equal(unassignedAdd.statusCode, 403);
    assert.equal(unassignedAdd.data.error, "crew_project_forbidden");

    const added = await member.client.request("POST", `${crewBase}/projects/crew_early/materials/items`, {
      name: "Ice and water membrane",
      quantity: 2,
      unit: "roll",
      notes: "Picked up on site"
    });
    assert.equal(added.item.name, "Ice and water membrane");
    assert.equal(added.item.quantity, 2);
    assert.equal(added.item.metadata.source, "crew_manual");
    assert.equal(added.item.metadata.added_by_user_id, member.userId);
    assert.equal(added.version.reason, "manual");
    assert.ok(added.material_list.current_items.some((item: Json) => item.id === added.item.id));

    const materials = await foreman.client.request("GET", `${crewBase}/projects/crew_early/materials`);
    assert.equal(materials.count, 1);
    assert.ok(materials.material_lists[0].current_items.some((item: Json) => (
      item.name === "Ice and water membrane" && item.metadata.source === "crew_manual"
    )));

    const receiptText = "North Supply\nReceipt #CREW-100\nPurchase date 01/03/2030\nTotal $84.50\n";
    const uploaded = await member.client.request("POST", `/v1/payments/organizations/${orgId}/receipts`, {
      file_name: "crew-materials-receipt.txt",
      content_type: "text/plain",
      file_base64: Buffer.from(receiptText).toString("base64"),
      owner: { kind: "organization_user", id: member.userId },
      metadata: { source_surface: "crew_receipts" }
    });
    assert.equal(uploaded.receipt.uploaded_by.user_id, member.userId);
    assert.equal(uploaded.receipt.project_id, "");

    const imported = await member.client.request("POST", `${crewBase}/projects/crew_early/materials/from-receipt`, {
      receipt_id: uploaded.receipt.id,
      reviewed_items: [
        { id: "membrane_line", description: "Starter strip", quantity: 3, unit: "bundle", total_cents: 6450 },
        { id: "fastener_line", description: "Roofing nails", quantity: 2, unit: "box", total_cents: 2000 }
      ]
    });
    assert.equal(imported.idempotent, false);
    assert.equal(imported.imported_count, 2);
    assert.equal(imported.receipt.project_id, "crew_early");
    assert.ok(imported.receipt.associations.some((association: Json) => (
      association.kind === "project" && association.id === "crew_early"
    )));
    assert.ok(imported.items.every((item: Json) => (
      item.metadata.source === "crew_receipt"
      && item.metadata.receipt_id === uploaded.receipt.id
      && item.metadata.added_by_user_id === member.userId
    )));
    assert.deepEqual(imported.items.map((item: Json) => item.paid_total), [64.5, 20]);

    const duplicateImport = await member.client.request("POST", `${crewBase}/projects/crew_early/materials/from-receipt`, {
      receipt_id: uploaded.receipt.id,
      reviewed_items: [
        { id: "membrane_line", description: "Starter strip", quantity: 3, unit: "bundle", total_cents: 6450 },
        { id: "fastener_line", description: "Roofing nails", quantity: 2, unit: "box", total_cents: 2000 }
      ]
    });
    assert.equal(duplicateImport.idempotent, true);
    assert.equal(duplicateImport.imported_count, 0);

    let accessProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: accessProfile.user.revision,
      permission_overrides: { "crew.materials.append": false }
    });
    const noMaterialAppend = await member.client.raw("POST", `${crewBase}/projects/crew_early/materials/from-receipt`, {
      receipt_id: uploaded.receipt.id,
      reviewed_items: [{ id: "blocked_material", description: "Blocked", quantity: 1, total_cents: 100 }]
    });
    assert.equal(noMaterialAppend.statusCode, 403);
    assert.equal(noMaterialAppend.data.error, "crew_permission_denied");
    assert.equal(noMaterialAppend.data.details.permission, "crew.materials.append");

    accessProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: accessProfile.user.revision,
      permission_overrides: { "crew.receipts.upload": false }
    });
    const noReceiptUpload = await member.client.raw("POST", `${crewBase}/projects/crew_early/materials/from-receipt`, {
      receipt_id: uploaded.receipt.id,
      reviewed_items: [{ id: "blocked_receipt", description: "Blocked", quantity: 1, total_cents: 100 }]
    });
    assert.equal(noReceiptUpload.statusCode, 403);
    assert.equal(noReceiptUpload.data.error, "crew_permission_denied");
    assert.equal(noReceiptUpload.data.details.permission, "crew.receipts.upload");

    accessProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: accessProfile.user.revision,
      permission_overrides: {}
    });

    const foremanReceipt = await foreman.client.request("POST", `/v1/payments/organizations/${orgId}/receipts`, {
      file_name: "foreman-only-receipt.txt",
      content_type: "text/plain",
      file_base64: Buffer.from("Private Supplier\nTotal $22.00\n").toString("base64"),
      owner: { kind: "organization_user", id: foreman.userId }
    });
    const foreignReceiptImport = await member.client.raw("POST", `${crewBase}/projects/crew_early/materials/from-receipt`, {
      receipt_id: foremanReceipt.receipt.id,
      reviewed_items: [{ id: "private_line", description: "Private item", quantity: 1, total_cents: 2200 }]
    });
    assert.equal(foreignReceiptImport.statusCode, 403);
    assert.equal(foreignReceiptImport.data.error, "receipt_forbidden");

    const memberProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: memberProfile.user.revision,
      permission_overrides: { "crew.receipts.upload": false }
    });
    const deniedUpload = await member.client.raw("POST", `/v1/payments/organizations/${orgId}/receipts`, {
      file_name: "permission-revoked.txt",
      content_type: "text/plain",
      file_base64: Buffer.from("Denied receipt\nTotal $10.00\n").toString("base64")
    });
    assert.equal(deniedUpload.statusCode, 403);
    assert.equal(deniedUpload.data.error, "crew_permission_denied");
    const deniedList = await member.client.raw("GET", `/v1/payments/organizations/${orgId}/receipts`);
    assert.equal(deniedList.statusCode, 403);
    const deniedRead = await member.client.raw("GET", `/v1/payments/organizations/${orgId}/receipts/${uploaded.receipt.id}`);
    assert.equal(deniedRead.statusCode, 403);
    const deniedFile = await member.client.raw("GET", `/v1/payments/organizations/${orgId}/receipts/${uploaded.receipt.id}/file`);
    assert.equal(deniedFile.statusCode, 403);

    const managementList = await owner.request(
      "GET",
      `/v1/payments/organizations/${orgId}/receipts?association_kind=organization_user&association_id=${member.userId}`
    );
    assert.ok(managementList.receipts.some((receipt: Json) => receipt.id === uploaded.receipt.id));
    const managementRead = await owner.request("GET", `/v1/payments/organizations/${orgId}/receipts/${uploaded.receipt.id}`);
    assert.equal(managementRead.receipt.id, uploaded.receipt.id);

    const deniedProfile = await owner.request("GET", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`);
    await owner.request("PATCH", `/v1/workforce/organizations/${orgId}/users/${member.userId}/profile`, {
      expected_revision: deniedProfile.user.revision,
      permission_overrides: {}
    });
  });
});
