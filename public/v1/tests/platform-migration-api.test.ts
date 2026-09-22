import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import bcrypt from "bcryptjs";

import { runLegacyPlatformMigration } from "../platform/legacy_migration.js";

let app: any = null;
let root = "";
let orgId = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const request = async (method: string, url: string, payload?: unknown, options: { allowFailure?: boolean; includeResponse?: boolean } = {}) => {
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
    let json: any = null;
    try {
      json = response.body ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    if (!options.allowFailure) assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return options.includeResponse ? { response, json } : json;
  };
  return { request };
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-migration-api-"));
  const source = path.join(root, "legacy");
  const target = path.join(root, "platform");
  orgId = "abcdefabcdefabcdefabcdef";
  const passwordHash = await bcrypt.hash("owner-password", 12);

  await writeJson(path.join(source, "organizations", orgId, "manifest.json"), {
    id: orgId,
    name: "Migrated API Roofing",
    created_at: "2026-02-01T00:00:00+00:00",
    created_by_user_id: "owner123",
    created_by_email: "owner-api@example.test",
    users: ["owner123"],
    users_meta: { owner123: { email: "owner-api@example.test", name: "Owner API" } },
    credits_balance: 50,
    credits_ledger: [{ ts: "2026-02-02T00:00:00+00:00", delta: 50, reason: "purchase" }],
    billing: { auto_topup: { enabled: true, threshold_dollars: 70, topup_dollars: 70, status: "idle" }, stripe: { has_payment_method: true, brand: "visa", last4: "4242" } },
    report_settings: { general: { nfva_ratio: 300 }, customer: { page_3d: true } },
    contact: { email: "office-api@example.test", phone: "555-0100", address: "10 Main" },
    branding: { colors: { primary: "#DB0000", secondary: "#111111" } }
  });

  await writeJson(path.join(source, "users", "owner-api@example.test.json"), {
    id: "owner123",
    email: "owner-api@example.test",
    password_hash: passwordHash,
    name: "Owner API",
    phone: "555-0101",
    company: "Migrated API Roofing",
    organization_id: orgId,
    org_permissions: { level: "super_admin", items: {} },
    is_verified: true,
    role: "user",
    account_type: "customer",
    team_id: "default",
    projects: []
  });

  const migration = await runLegacyPlatformMigration({ sourceRoot: source, targetRoot: target, mode: "fresh", confirmFresh: true });
  assert.equal(migration.ok, true);

  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = target;
  process.env.CRM_STORAGE_ROOT = path.join(root, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  if (root) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

test("migrated org/user data supports portal state, credits, and Node-created org users", async () => {
  const owner = createSessionClient();
  const login = await owner.request("POST", "/v1/platform/auth/login", {
    email: "owner-api@example.test",
    password: "owner-password"
  });
  assert.equal(login.authenticated, true);
  assert.equal(login.organization.id, orgId);

  const me = await owner.request("GET", "/v1/platform/me");
  assert.equal(me.user.email, "owner-api@example.test");
  assert.equal(me.global.data.credits_balance, 50);

  const portalState = await owner.request("GET", `/v1/platform/organizations/${orgId}/portal-state`);
  assert.equal(portalState.organization.name, "Migrated API Roofing");
  assert.equal(portalState.credits.balance, 50);
  assert.equal(portalState.billing.stripe.last4, "4242");
  assert.equal(portalState.report_settings.general.nfva_ratio, 300);

  const charged = await owner.request("POST", `/v1/platform/organizations/${orgId}/credits/charge`, {
    amount: 7,
    reason: "order_submitted",
    meta: { project_id: "firstmeasure_1" }
  });
  assert.equal(charged.balance, 43);
  assert.equal(charged.ledger_entry.delta, -7);

  const refunded = await owner.request("POST", `/v1/platform/organizations/${orgId}/credits/refund`, {
    amount: 2,
    reason: "test_refund"
  });
  assert.equal(refunded.balance, 45);

  const credits = await owner.request("GET", `/v1/platform/organizations/${orgId}/credits?limit=10`);
  assert.equal(credits.balance, 45);
  assert.equal(credits.ledger_count, 3);

  const insufficient = await owner.request("POST", `/v1/platform/organizations/${orgId}/credits/charge`, {
    amount: 999,
    reason: "order_submitted",
    meta: { project_id: "firstmeasure_overdraw" }
  }, { allowFailure: true, includeResponse: true });
  assert.equal(insufficient.response.statusCode, 402);
  assert.equal(insufficient.json.error, "insufficient_credits");
  assert.deepEqual(insufficient.json.details, { balance: 45, required: 999 });

  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email: "manager-api@example.test",
      password: "manager-password",
      name: "Manager API",
      status: "active",
      role: "manager",
      permissions: { manage_billing: true, manage_company_users: true }
    }
  });
  assert.equal(created.document.data.email, "manager-api@example.test");
  assert.equal(created.document.data.role, "manager");

  const manager = createSessionClient();
  const managerLogin = await manager.request("POST", "/v1/platform/auth/login", {
    email: "manager-api@example.test",
    password: "manager-password",
    organization_id: orgId
  });
  assert.equal(managerLogin.user.email, "manager-api@example.test");
  assert.equal(managerLogin.membership.permissions.manage_billing, true);

  const invitedCreated = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email: "invited-api@example.test",
      password: "invited-password",
      name: "Invited API",
      status: "invited",
      role: "orderer",
      permissions: { order_reports: true }
    }
  });
  assert.equal(invitedCreated.document.data.email, "invited-api@example.test");
  assert.equal(invitedCreated.document.data.status, "invited");
  const invitedIdentity = await owner.request("POST", "/v1/platform/auth/resolve", {
    email: "invited-api@example.test"
  });
  assert.equal(invitedIdentity.identity.status, "active");

  const invited = createSessionClient();
  const invitedLogin = await invited.request("POST", "/v1/platform/auth/login", {
    email: "invited-api@example.test",
    password: "invited-password",
    organization_id: orgId
  });
  assert.equal(invitedLogin.authenticated, true);
  assert.equal(invitedLogin.user.email, "invited-api@example.test");

  const orderUserCreated = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: {
      email: "order-api@example.test",
      password: "order-password",
      name: "Order API",
      status: "active",
      role: "orderer",
      permissions: { order_reports: true }
    }
  });
  assert.equal(orderUserCreated.document.data.email, "order-api@example.test");

  const orderer = createSessionClient();
  await orderer.request("POST", "/v1/platform/auth/login", {
    email: "order-api@example.test",
    password: "order-password",
    organization_id: orgId
  });
  const orderCharge = await orderer.request("POST", `/v1/platform/organizations/${orgId}/credits/charge`, {
    amount: 4,
    reason: "order_submitted",
    meta: { charge_token: "test-order-token" }
  });
  assert.equal(orderCharge.ledger_entry.delta, -4);

  const orderRefund = await orderer.request("POST", `/v1/platform/organizations/${orgId}/credits/order-refund`, {
    charge_token: "test-order-token"
  });
  assert.equal(orderRefund.refunded_amount, 4);
  assert.equal(orderRefund.ledger_entry.delta, 4);
});
