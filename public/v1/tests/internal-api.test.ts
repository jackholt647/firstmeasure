import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import bcrypt from "bcryptjs";

let app: any = null;
let storageRoot = "";
let platformStorage: any = null;

async function inject(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const input = payload as Record<string, unknown> | undefined;
  const teamId = String(input?.team_id || input?.team || "");
  if (teamId && (url === "/v1/internal/users" || input?.action === "save_user")) {
    const { saveInternalDocument } = await import("../internal/storage.js");
    await saveInternalDocument("teams", teamId, { name: teamId, manager_user_ids: [], archived: false });
  }
  const response = await app.inject({ method, url, payload, headers });
  let json: any = null;
  try {
    json = response.body ? JSON.parse(response.body) : null;
  } catch {
    json = null;
  }
  assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
  return json;
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-internal-api-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.MEASURE_INTERNAL_ROOT = path.join(storageRoot, "measure", "internal");
  process.env.MEASURE_INTERNAL_TUTORIALS_ROOT = path.join(storageRoot, "measure", "internal", "storage", "tutorials");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";

  platformStorage = await import("../platform/storage.js");
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  if (storageRoot) {
    for (const dir of ["platform", "internal", "measure", "pricebook"]) {
      try {
        await rm(path.join(storageRoot, dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (error: any) {
        if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
      }
    }
  }
});

test("Internal API manages employee users separately from Platform organization users", async () => {
  const created = await inject("POST", "/v1/internal/users", {
    email: "tech@example.test",
    name: "Tech User",
    role: "manager",
    department: "production",
    team_id: "alpha",
    training_complete: true,
    shift_rate: 940,
    permissions: { queue_view: true }
  });
  assert.equal(created.success, true);
  assert.equal(created.user.account_type, "employee");
  assert.equal(created.user.email, "tech@example.test");

  const listed = await inject("GET", "/v1/internal/users?department=production");
  assert.equal(listed.count, 1);
  assert.equal(listed.users[0].team_id, "alpha");

  const live = await inject("GET", "/v1/internal/queue/live-trained-users");
  assert.equal(live.count, 1);
  assert.equal(live.users[0].email, "tech@example.test");

  const teams = await inject("GET", "/v1/internal/queue/admin-teams");
  assert.deepEqual(teams.teams, [{ id: "alpha", label: "alpha" }]);

  const shifts = await inject("GET", "/v1/internal/shifts/schedules");
  assert.equal(shifts.schedules[0].shift_rate, 940);
  assert.deepEqual(shifts.schedules[0].recurring, {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: []
  });
  assert.ok(shifts.schedules[0].week.monday);

  const savedSchedule = await inject("POST", "/v1/internal/legacy-action", {
    action: "shift_save_schedule",
    actor_email: "tech@example.test",
    target_email: "tech@example.test",
    recurring: JSON.stringify({ monday: [{ start: "13:00", end: "21:00", role: "technician" }] }),
    overrides: JSON.stringify({})
  });
  assert.equal(savedSchedule.success, true);
  assert.equal(savedSchedule.user.shift_schedule.recurring.monday[0].start, "13:00");

  const savedOverride = await inject("POST", "/v1/internal/legacy-action", {
    action: "shift_save_day_override",
    actor_email: "tech@example.test",
    target_email: "tech@example.test",
    date: "2026-06-01",
    blocks: JSON.stringify([{ start: "14:00", end: "18:00", role: "technician" }])
  });
  assert.equal(savedOverride.success, true);
  assert.equal(savedOverride.user.shift_schedule.overrides["2026-06-01"][0].start, "14:00");

  const queueMode = await inject("POST", "/v1/internal/legacy-action", {
    action: "get_user_queue_mode",
    email: "tech@example.test"
  });
  assert.equal(queueMode.success, true);
  assert.equal(queueMode.queue_mode, "disabled");

  const updatedQueueMode = await inject("POST", "/v1/internal/legacy-action", {
    action: "set_user_queue_mode",
    email: "tech@example.test",
    queue_mode: "hot_swap"
  });
  assert.equal(updatedQueueMode.success, true);
  assert.equal(updatedQueueMode.queue_mode, "hot_swap");

  const hotSwap = await inject("POST", "/v1/internal/legacy-action", {
    action: "check_hot_swap",
    current_folder: "project_1"
  });
  assert.equal(hotSwap.success, true);
  assert.equal(hotSwap.has_swap, false);
});

test("Shift editing is manager-only and statistics are full-admin-only", async () => {
  await inject("POST", "/v1/internal/users", {
    email: "permissions-tech@example.test",
    name: "Permissions Tech",
    role: "technician",
    department: "production"
  });
  await inject("POST", "/v1/internal/users", {
    email: "permissions-admin@example.test",
    name: "Permissions Admin",
    role: "admin",
    department: "production"
  });

  const techSchedules = await inject("POST", "/v1/internal/legacy-action", {
    action: "shift_get_schedules",
    actor_email: "permissions-tech@example.test"
  });
  assert.equal(techSchedules.edit_level, "none");

  const managerSchedules = await inject("POST", "/v1/internal/legacy-action", {
    action: "shift_get_schedules",
    actor_email: "tech@example.test"
  });
  assert.equal(managerSchedules.edit_level, "all");

  const deniedShift = await app.inject({
    method: "POST",
    url: "/v1/internal/legacy-action",
    payload: {
      action: "shift_save_schedule",
      actor_email: "permissions-tech@example.test",
      target_email: "permissions-tech@example.test",
      recurring: JSON.stringify({ monday: [{ start: "09:00", end: "17:00", role: "technician" }] })
    }
  });
  assert.equal(deniedShift.statusCode, 403);
  assert.equal(JSON.parse(deniedShift.body).error, "manager_required");

  const deniedDirectShift = await app.inject({
    method: "POST",
    url: "/v1/internal/shifts/schedules/permissions-tech%40example.test",
    headers: { "x-internal-user-email": "permissions-tech@example.test" },
    payload: { recurring: { monday: [{ start: "09:00", end: "17:00", role: "technician" }] } }
  });
  assert.equal(deniedDirectShift.statusCode, 403);
  assert.equal(JSON.parse(deniedDirectShift.body).error, "manager_required");

  const deniedStats = await app.inject({
    method: "POST",
    url: "/v1/internal/legacy-action",
    payload: { action: "stats_data", actor_email: "tech@example.test" }
  });
  assert.equal(deniedStats.statusCode, 403);
  assert.equal(JSON.parse(deniedStats.body).error, "admin_required");

  const deniedStatsOverview = await app.inject({
    method: "GET",
    url: "/v1/internal/stats/overview",
    headers: { "x-internal-user-email": "tech@example.test" }
  });
  assert.equal(deniedStatsOverview.statusCode, 403);
  assert.equal(JSON.parse(deniedStatsOverview.body).error, "admin_required");

  const adminStats = await inject("POST", "/v1/internal/legacy-action", {
    action: "stats_data",
    actor_email: "permissions-admin@example.test"
  });
  assert.equal(adminStats.success, true);
});

test("Internal staff users sync to Platform auth with sanitized public responses", async () => {
  const created = await inject("POST", "/v1/internal/users", {
    email: "qa-login@example.test",
    name: "QA Login",
    role: "qa",
    department: "production",
    team_id: "qa",
    password: "correct horse staple",
    permissions: { manage_qa: true },
    training_complete: true
  });
  assert.equal(created.success, true);
  assert.equal(created.platform_login.synced, true);
  assert.equal(created.platform_login.org_id, "legacy_internal");
  assert.equal(created.platform_login.login_ready, true);
  assert.equal(created.platform_login.password_source, "submitted_password");
  assert.equal(created.user.email, "qa-login@example.test");
  assert.equal(created.user.password_hash, undefined);
  assert.equal(created.user.password, undefined);

  const listed = await inject("GET", "/v1/internal/users?q=qa-login");
  assert.equal(listed.count, 1);
  assert.equal(listed.users[0].password_hash, undefined);
  assert.equal(listed.users[0].password, undefined);

  const login = await inject("POST", "/v1/platform/auth/login", {
    email: "qa-login@example.test",
    password: "correct horse staple",
    organization_id: "legacy_internal"
  });
  assert.equal(login.authenticated, true);
  assert.equal(login.membership.organization_id, "legacy_internal");
  assert.equal(login.user.email, "qa-login@example.test");
});

test("Internal staff sync preserves legacy PHP password hashes without reset", async () => {
  const phpHash = (await bcrypt.hash("legacy-password", 10)).replace("$2b$", "$2y$");
  const created = await inject("POST", "/v1/internal/users", {
    email: "legacy-hash@example.test",
    name: "Legacy Hash",
    role: "qa",
    department: "production",
    team_id: "legacy",
    password_hash: phpHash,
    password_algo: "php-password-hash",
    training_complete: true
  });
  assert.equal(created.success, true);
  assert.equal(created.platform_login.login_ready, true);
  assert.equal(created.platform_login.password_source, "stored_password_hash");
  assert.equal(created.user.password_hash, undefined);

  const login = await inject("POST", "/v1/platform/auth/login", {
    email: "legacy-hash@example.test",
    password: "legacy-password",
    organization_id: "legacy_internal"
  });
  assert.equal(login.authenticated, true);
  assert.equal(login.membership.organization_id, "legacy_internal");

  const audit = await inject("GET", "/v1/internal/admin/users-login-audit?all=1");
  const row = audit.rows.find((entry: any) => entry.email === "legacy-hash@example.test");
  assert.equal(row.status, "ok");
  assert.equal(row.has_stored_password_hash, true);
});

test("Internal staff sync creates pending Platform identities and repairs passwords later", async () => {
  const created = await inject("POST", "/v1/internal/users", {
    email: "pending-login@example.test",
    name: "Pending Login",
    role: "qa",
    department: "production",
    team_id: "pending",
    training_complete: true
  });
  assert.equal(created.success, true);
  assert.equal(created.platform_login.synced, true);
  assert.equal(created.platform_login.login_ready, false);
  assert.equal(created.platform_login.password_source, "pending");

  const audit = await inject("GET", "/v1/internal/admin/users-login-audit?all=1");
  const pending = audit.rows.find((entry: any) => entry.email === "pending-login@example.test");
  assert.equal(pending.status, "missing_password");
  assert.equal(pending.has_stored_password_hash, false);

  const dryRun = await inject("POST", "/v1/internal/admin/users-login-sync", {
    dry_run: true,
    all: true
  });
  const dryRow = dryRun.results.find((entry: any) => entry.email === "pending-login@example.test");
  assert.equal(dryRow.action, "would_need_password");

  const repaired = await inject("POST", "/v1/internal/admin/users-login-sync", {
    dry_run: false,
    all: true,
    default_password: "temporary repaired password"
  });
  const repairedRow = repaired.results.find((entry: any) => entry.email === "pending-login@example.test");
  assert.equal(repairedRow.status, "ok");
  assert.equal(repairedRow.platform_login.login_ready, true);

  const login = await inject("POST", "/v1/platform/auth/login", {
    email: "pending-login@example.test",
    password: "temporary repaired password",
    organization_id: "legacy_internal"
  });
  assert.equal(login.authenticated, true);
});

test("Internal API exposes organization dashboard/detail and credit adjustments from Platform storage", async () => {
  const org = await platformStorage.createOrganization({
    id: "org_internal_test",
    name: "Internal Test Org",
    global: {
      credits_balance: 25,
      credits_ledger: [{ ts: "2026-01-01T00:00:00.000Z", delta: 25, reason: "seed" }],
      contact: { email: "owner@example.test" }
    }
  });
  await platformStorage.upsertDocument(org.id, "users", {
    id: "customer_owner",
    data: { email: "owner@example.test", name: "Owner", role: "owner" }
  });
  await platformStorage.upsertDocument(org.id, "users", {
    id: "legacy_customer",
    data: {
      email: "legacy@example.test",
      name: "Legacy Customer",
      projects: ["legacy_project_ref"],
      stats: { projects_ordered: 1 }
    }
  });
  await platformStorage.upsertDocument(org.id, "projects", {
    id: "project_1",
    data: { id: "project_1", created_at: new Date().toISOString(), status: "completed" }
  });
  await platformStorage.upsertDocument(org.id, "projects", {
    id: "project_older",
    data: { id: "project_older", created_at: new Date(Date.now() - 10 * 86_400_000).toISOString(), status: "completed" }
  });
  await platformStorage.upsertDocument(org.id, "projects", {
    id: "platform_duplicate_project",
    data: {
      id: "platform_duplicate_project",
      address: "14 Duplicate Way, Testville, WA",
      created_at: "2026-01-05T00:00:00.000Z",
      status: "completed",
      measurement_project: {
        project_id: "indexed_duplicate_project",
        created_at: "2026-01-05T00:00:00.000Z",
        status: "completed"
      }
    }
  });
  const indexedOnlyProject = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: "indexed_only_project",
      address: "228 Index Lane, Testville, WA",
      status: "completed",
      organization_ref: { id: org.id },
      owner_ref: { email: "index-owner@example.test", name: "Index Owner" },
      issuer: { email: "index-issuer@example.test", name: "Index Issuer" },
      amount_charged: 50
    },
    headers: { "content-type": "application/json" }
  });
  assert.equal(indexedOnlyProject.statusCode, 201, indexedOnlyProject.body);
  const indexedDuplicateProject = await app.inject({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: "indexed_duplicate_project",
      address: "14 Duplicate Way, Testville, WA",
      status: "completed",
      created_at: "2026-01-05T00:00:00.000Z",
      organization_ref: { id: org.id },
      owner_ref: { email: "owner@example.test", name: "Owner" },
      issuer: { email: "owner@example.test", name: "Owner" },
      amount_charged: 50
    },
    headers: { "content-type": "application/json" }
  });
  assert.equal(indexedDuplicateProject.statusCode, 201, indexedDuplicateProject.body);

  const dashboard = await inject("GET", "/v1/internal/organizations/dashboard");
  assert.equal(dashboard.totals.organizations, 1);
  assert.equal(dashboard.organizations[0].credits_balance, 25);
  assert.equal(dashboard.organizations[0].user_count, 2);
  assert.equal(dashboard.organizations[0].users.length, 2);
  assert.equal(dashboard.organizations[0].lifetimeOrders, 5);
  assert.equal(dashboard.organizations[0].orders_count, 5);
  assert.equal(dashboard.organizations[0].rolling7, 2);

  const detail = await inject("GET", "/v1/internal/organizations/org_internal_test/detail");
  assert.equal(detail.org.name, "Internal Test Org");
  assert.equal(detail.counts.users, 2);
  assert.equal(detail.org.credits_balance, 25);
  assert.equal(detail.users.length, 2);
  assert.equal(detail.projects.length, 5);
  assert.equal(detail.org.lifetimeOrders, 5);
  assert.equal(detail.org.rolling7, 2);
  assert.equal(detail.projects.some((project: any) => project.id === "legacy_project_ref" && project.source === "user_project_reference"), true);
  assert.equal(detail.projects.some((project: any) => project.id === "indexed_only_project" && project.source === "firstmeasure_project_index"), true);
  assert.equal(detail.projects.filter((project: any) => project.id === "indexed_duplicate_project" || project.id === "platform_duplicate_project").length, 1);
  assert.equal(detail.users.find((user: any) => user.email === "legacy@example.test")?.orderCount, 1);

  const adjusted = await inject("POST", "/v1/internal/organizations/org_internal_test/credits/adjust", {
    amount: 10,
    reason: "manual_test"
  }, { "x-internal-user-email": "admin@example.test" });
  assert.equal(adjusted.balance, 35);
  assert.equal(adjusted.ledger_count, 2);

  const credits = await inject("GET", "/v1/internal/organizations/org_internal_test/credits");
  assert.equal(credits.balance, 35);
  assert.equal(credits.ledger[0].reason, "manual_test");
});

test("Internal API exposes bootstrap and admin utility routes", async () => {
  await inject("POST", "/v1/internal/users", {
    email: "admin@example.test",
    name: "Admin User",
    role: "admin",
    permissions: { "*": true }
  });

  const me = await inject("GET", "/v1/internal/me", undefined, { "x-internal-user-email": "admin@example.test" });
  assert.equal(me.authenticated, true);
  assert.equal(me.user.email, "admin@example.test");

  const root = await inject("GET", "/v1/internal");
  assert.equal(root.api, "internal");
  assert.ok(root.routes.users);
  assert.equal(root.routes.diagnostics, "/diagnostics");

  const diagnostics = await inject("GET", "/v1/internal/diagnostics/summary");
  assert.equal(diagnostics.success, true);
  assert.equal(diagnostics.config.storage, "memory");
  assert.ok(diagnostics.runtime);
  assert.ok(Array.isArray(diagnostics.by_area));

  const runtime = await inject("GET", "/v1/internal/diagnostics/runtime?limit=5");
  assert.equal(runtime.success, true);
  assert.ok(Array.isArray(runtime.samples));

  const rush = await inject("GET", "/v1/internal/admin/rush-modes/current");
  assert.equal(rush.success, true);

  await platformStorage.createOrganization({
    id: "org_api_key_admin",
    name: "API Key Admin Org",
    global: {
      credits_balance: 100,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: true, payment_method_id: "pm_admin_key_test" }
      }
    }
  });

  const headers = { "x-internal-user-email": "admin@example.test" };
  const createdKey = await inject("POST", "/v1/internal/admin/firstmeasure-api-keys", {
    org_id: "org_api_key_admin",
    name: "Portal generated key",
    mode: "test",
    expires_at: "2035-01-31",
    revoke_existing: false
  }, headers);
  assert.equal(createdKey.success, true);
  assert.match(createdKey.key, /^fmk_test_/);
  assert.equal(createdKey.record.org_id, "org_api_key_admin");
  assert.equal(createdKey.record.secret_hash, undefined);
  assert.equal(createdKey.record.expires_at, "2035-01-31T23:59:59.999Z");

  const listedKeys = await inject("GET", "/v1/internal/admin/firstmeasure-api-keys?org_id=org_api_key_admin", undefined, headers);
  assert.equal(listedKeys.count, 1);
  assert.equal(listedKeys.keys[0].secret_hash, undefined);
  assert.equal(listedKeys.keys[0].key_prefix.startsWith("fmk_test_"), true);

  const rerolledKey = await inject("POST", `/v1/internal/admin/firstmeasure-api-keys/${createdKey.record.key_id}/reroll`, {
    expires_at: "2036-02-01"
  }, headers);
  assert.equal(rerolledKey.success, true);
  assert.match(rerolledKey.key, /^fmk_test_/);
  assert.equal(rerolledKey.old_record.status, "revoked");
  assert.equal(rerolledKey.record.expires_at, "2036-02-01T23:59:59.999Z");

  const revokedKey = await inject("POST", `/v1/internal/admin/firstmeasure-api-keys/${rerolledKey.record.key_id}/revoke`, {}, headers);
  assert.equal(revokedKey.record.status, "revoked");
});

test("Internal API stores PHP-replacement state modules in Node storage", async () => {
  const flags = await inject("PUT", "/v1/internal/feature-flags", {
    portal_v2: true,
    crm_node_api: true
  });
  assert.equal(flags.flags.portal_v2, true);

  const status = await inject("PUT", "/v1/internal/portal/status", {
    mode: "open",
    message: "Ready"
  });
  assert.equal(status.status.mode, "open");

  const coupon = await inject("POST", "/v1/internal/coupons", {
    code: "SAVE10",
    percent: 10,
    status: "active"
  });
  assert.equal(coupon.coupon.data.code, "SAVE10");

  const listedCoupons = await inject("GET", "/v1/internal/coupons?q=save");
  assert.equal(listedCoupons.count, 1);

  const shiftStatus = await inject("POST", "/v1/internal/shifts/current-status", {
    active: 3,
    idle: 1
  });
  assert.equal(shiftStatus.status.active, 3);

  await inject("PUT", "/v1/internal/data-agent/settings", {
    enabled: true,
    model: "gpt-5-mini"
  });
  const dataAgent = await inject("GET", "/v1/internal/data-agent/settings");
  assert.equal(dataAgent.settings.enabled, true);

  const bootstrap = await inject("GET", "/v1/internal/bootstrap");
  assert.equal(bootstrap.feature_flags.portal_v2, true);
  assert.equal(bootstrap.portal_status.mode, "open");
});

test("Internal API owns Sample Reports state and legacy bridge", async () => {
  const empty = await inject("GET", "/v1/internal/sample-reports/projects?actor_role=admin&page=1&limit=5");
  assert.equal(empty.success, true);
  assert.deepEqual(empty.projects, []);

  const projectId = "abcdef1234567890abcdef1234567890";
  const added = await inject("POST", "/v1/internal/sample-reports/favorites?actor_role=admin", {
    folder: projectId,
    favorite: true,
    label: "Pinned Sample"
  });
  assert.equal(added.success, true);
  assert.equal(added.favorite, true);
  assert.ok(added.favorite_ids.includes(projectId));
  assert.equal(added.favorite_configs[0].label, "Pinned Sample");

  const legacy = await inject("POST", "/v1/internal/legacy-action", {
    action: "list_sample_projects",
    actor_role: "admin",
    page: 1,
    limit: 5
  });
  assert.equal(legacy.success, true);
  assert.ok(legacy.favorite_ids.includes(projectId));

  const removed = await inject("POST", "/v1/internal/sample-reports/favorites?actor_role=admin", {
    folder: projectId,
    favorite: false
  });
  assert.equal(removed.success, true);
  assert.equal(removed.favorite_ids.includes(projectId), false);
});

test("Internal legacy-action owns Script Settings state", async () => {
  await inject("POST", "/v1/internal/users", {
    email: "scripts-manager@example.test",
    name: "Scripts Manager",
    role: "sales_manager",
    permissions: { manage_sales_users: true }
  });

  const created = await inject("POST", "/v1/internal/legacy-action", {
    action: "call_script_save",
    actor_email: "scripts-manager@example.test",
    title: "Opening Script",
    description: "Quick opener",
    body: "Hello from Node"
  });
  assert.equal(created.success, true);
  assert.equal(created.script.title, "Opening Script");

  const listed = await inject("POST", "/v1/internal/legacy-action", {
    action: "call_script_list",
    actor_email: "scripts-manager@example.test"
  });
  assert.equal(listed.success, true);
  assert.equal(listed.can_manage, true);
  assert.ok(listed.scripts.some((script: any) => script.id === created.script.id));

  const touched = await inject("POST", "/v1/internal/legacy-action", {
    action: "call_script_touch",
    actor_email: "scripts-manager@example.test",
    id: created.script.id
  });
  assert.equal(touched.success, true);
  assert.equal(touched.script.usage_count, 1);

  const deleted = await inject("POST", "/v1/internal/legacy-action", {
    action: "call_script_delete",
    actor_email: "scripts-manager@example.test",
    id: created.script.id
  });
  assert.equal(deleted.success, true);
  assert.equal(deleted.scripts.some((script: any) => script.id === created.script.id), false);
});

test("Internal legacy-action bridge serves index.php legacy payloads from Node", async () => {
  const saved = await inject("POST", "/v1/internal/legacy-action", {
    action: "save_user",
    email: "bridge@example.test",
    name: "Bridge User",
    role: "technician",
    team: "bridge",
    training_complete: "1",
    permissions: JSON.stringify({ view_team_projects: true })
  });
  assert.equal(saved.success, true);
  assert.equal(saved.user.email, "bridge@example.test");

  const users = await inject("POST", "/v1/internal/legacy-action", { action: "fetch_users", q: "bridge" });
  assert.equal(users.success, true);
  assert.equal(users.users.length, 1);

  const config = await inject("POST", "/v1/internal/legacy-action", {
    action: "server_config_set",
    key: "qa_fix_only_mode",
    value: "true"
  });
  assert.equal(config.success, true);
  assert.equal(config.value, true);

  const coupons = await inject("POST", "/v1/internal/legacy-action", {
    action: "coupon_admin_create",
    code: "BRIDGE10",
    credits_total: "70",
    credits_per_redeem: "7",
    max_redemptions: "10"
  });
  assert.equal(coupons.success, true);
  assert.equal(coupons.coupon.code_hash, "bridge10");

  const listedCoupons = await inject("POST", "/v1/internal/legacy-action", { action: "coupon_admin_list" });
  assert.equal(listedCoupons.success, true);
  assert.ok(listedCoupons.coupons.some((coupon: any) => coupon.code_hash === "bridge10"));

  const commissions = await inject("POST", "/v1/internal/legacy-action", { action: "commission_dashboard" }, {
    "x-internal-user-email": "admin@example.test"
  });
  assert.equal(commissions.success, true);
  assert.ok(Array.isArray(commissions.manager_payroll));
});

test("Internal legacy-action starts tutorial project instances without PHP bridge", async () => {
  const { createProject, saveAppMetadata, savePdfState } = await import("../firstmeasure/storage.js");
  const source = await createProject({
    id: "tutorial_source_project",
    address: "123 Tutorial Way",
    status: "completed"
  });
  const sourceId = source.manifest.id;
  await (await import("../internal/storage.js")).saveInternalUser({ email: "student@example.test", role: "trainee", status: "active" });
  const curriculumPath = path.join(storageRoot, "measure", "internal", "storage", "tutorials", "master", "curriculum.json");
  await mkdir(path.dirname(curriculumPath), { recursive: true });
  await writeFile(curriculumPath, JSON.stringify({ chapters: [{ projects: [] }, { projects: [{ project_id: sourceId, curriculum_project_id: "practice_one" }] }] }));
  await saveAppMetadata(sourceId, { hasQuadCrop: true });
  await savePdfState(sourceId, {
    report: {
      materials: {
        totalSquares: 12,
        squares: { "6/12": 12 }
      },
      lineLengthsByType: { ridge: 44 }
    }
  });

  const started = await inject("POST", "/v1/internal/legacy-action", {
    action: "start_tutorial_project",
    actor_email: "student@example.test",
    project_id: sourceId,
    chapter_id: 2,
    curriculum_project_id: "practice_one",
    practice_project_name: "Practice One"
  });

  assert.equal(started.success, true);
  assert.match(started.folder, /^tutorial_[a-f0-9]{24,32}$/);
  assert.equal(started.source_project_id, sourceId);
  assert.match(started.editor_url, /editor\.php\?tutorial=1&folder=tutorial_/);

  const tutorialDir = path.join(
    storageRoot,
    "measure",
    "internal",
    "storage",
    "tutorials",
    "users",
    "student@example.test",
    "courses",
    "default",
    "projects",
    started.folder
  );
  const manifest = JSON.parse(await readFile(path.join(tutorialDir, "manifest.json"), "utf8"));
  const answerKey = JSON.parse(await readFile(path.join(tutorialDir, "answer_key.json"), "utf8"));

  assert.equal(manifest.is_tutorial_instance, true);
  assert.equal(manifest.source_project_id, sourceId);
  assert.equal(manifest.chapter_id, 2);
  assert.equal(manifest.curriculum_project_id, "practice_one");
  assert.equal(answerKey.version, 0);
  assert.equal(answerKey.source_project_id, sourceId);
  assert.equal(answerKey.generated_by, "node_placeholder");
  assert.equal(answerKey.metrics, null);
});
