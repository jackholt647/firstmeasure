import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Boarding ops console API — /v1/payments/admin/* (payments/admin_api.ts).
 *
 * Covers the FirstMate-staff guard (org users and anonymous callers are
 * rejected), the cross-org pipeline list/detail shapes, plan assignment
 * against the mock provider in both the mutable-application and
 * post-approval paths (plus the rep-mediated pending intent for forward),
 * and the provider go-live switch roundtrip.
 */

let app: any = null;
let storageRoot = "";

const STAFF_EMAIL = "boarding-ops@firstmate.test";
const NON_ADMIN_STAFF_EMAIL = "boarding-tech@firstmate.test";

function staffHeaders(email = STAFF_EMAIL) {
  return { "x-internal-user-email": email, "x-internal-user-name": "Boarding Ops" };
}

async function inject(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return await (app.inject as any)({ method, url, payload, headers });
}

async function injectOk(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const response = await inject(method, url, payload, headers);
  assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
  return response.body ? JSON.parse(response.body) : null;
}

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
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, cookie: () => cookie };
}

async function registerOrg(client: ReturnType<typeof createSessionClient>, label: string) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ownerEmail = `${label}-owner-${suffix}@example.test`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: ownerEmail,
    password: "correct horse battery staple",
    name: `${label} Owner`,
    company: `${label} Boarding Co`,
    organization_id: `org_admin_${label}_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, money: true },
        money: { merchant_processing: true }
      }
    }
  }, { replace: false });
  await client.request("PATCH", `/v1/payments/organizations/${orgId}/merchant-config`, { provider: "mock" });
  return { orgId, ownerEmail };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-payments-admin-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(storageRoot, "internal");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  process.env.FORWARD_PRIVATE_KEY = "";
  process.env.FORWARD_PUBLIC_KEY = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();

  const { saveInternalUser } = await import("../internal/storage.js");
  await saveInternalUser({ email: STAFF_EMAIL, name: "Boarding Ops", role: "admin" });
  await saveInternalUser({ email: NON_ADMIN_STAFF_EMAIL, name: "Boarding Tech", role: "technician" });
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkforceDatabase } = await import("../workforce/storage.js");
  (await closeWorkforceDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

test("staff guard: anonymous, org users, and non-admin staff are rejected", async () => {
  const anonymous = await inject("GET", "/v1/payments/admin/merchant-configs");
  assert.equal(anonymous.statusCode, 401, "no internal actor -> 401");

  const client = createSessionClient();
  const { orgId, ownerEmail } = await registerOrg(client, "guard");

  // An org user presenting their own email as the internal actor has no
  // internal-staff record -> 403 (their platform session is irrelevant here).
  const orgUser = await inject("GET", "/v1/payments/admin/merchant-configs", undefined, {
    "x-internal-user-email": ownerEmail || `guard-owner@example.test`,
    cookie: client.cookie()
  });
  assert.equal(orgUser.statusCode, 403, "org user actor -> 403");

  const nonAdmin = await inject("GET", "/v1/payments/admin/merchant-configs", undefined, staffHeaders(NON_ADMIN_STAFF_EMAIL));
  assert.equal(nonAdmin.statusCode, 403, "internal but non-admin staff -> 403");

  // The claimed role header must not grant anything on its own.
  const roleSpoof = await inject("GET", "/v1/payments/admin/merchant-configs", undefined, {
    "x-internal-user-email": NON_ADMIN_STAFF_EMAIL,
    "x-internal-user-role": "admin"
  });
  assert.equal(roleSpoof.statusCode, 403, "spoofed role header -> still 403");

  const staff = await inject("GET", "/v1/payments/admin/merchant-configs", undefined, staffHeaders());
  assert.equal(staff.statusCode, 200, "internal admin -> 200");
  assert.equal(orgId.length > 0, true);
});

test("pipeline list joins org names, exposes boarding fields, and filters by status/provider", async () => {
  const clientA = createSessionClient();
  const clientB = createSessionClient();
  const orgA = await registerOrg(clientA, "draft");
  const orgB = await registerOrg(clientB, "approved");

  // Org A: draft application. Org B: submitted then approved.
  await clientA.request("POST", `/v1/payments/organizations/${orgA.orgId}/merchant-boarding/applications`, {
    business: { name: "Draft Boarding Co" },
    company: { legal_name: "Draft Boarding Co LLC" },
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  });
  const createdB = await clientB.request("POST", `/v1/payments/organizations/${orgB.orgId}/merchant-boarding/applications`, {
    business: { name: "Approved Boarding Co" },
    company: { legal_name: "Approved Boarding Co LLC" },
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  });
  await clientB.request("POST", `/v1/payments/organizations/${orgB.orgId}/merchant-boarding/applications/${createdB.application.id}/submit`, {});
  await clientB.request("POST", `/v1/payments/organizations/${orgB.orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });

  const list = await injectOk("GET", "/v1/payments/admin/merchant-configs", undefined, staffHeaders());
  assert.equal(list.ok, true);
  const rowA = list.merchant_configs.find((row: any) => row.org_id === orgA.orgId);
  const rowB = list.merchant_configs.find((row: any) => row.org_id === orgB.orgId);
  assert.ok(rowA && rowB, "both orgs appear in the pipeline");
  assert.equal(rowA.org_name, "draft Boarding Co");
  assert.equal(rowA.provider, "mock");
  assert.equal(rowA.boarding_status, "DRAFT");
  assert.equal(rowB.boarding_status, "APPROVED");
  assert.equal(rowB.processing_enabled, true);
  assert.equal(rowB.payouts_enabled, true);
  assert.ok(rowB.account_id.startsWith("acct_mock"), "approved org carries the provider account id");
  assert.ok(rowB.last_event_at, "last_event_at is populated by boarding events");

  const approvedOnly = await injectOk("GET", "/v1/payments/admin/merchant-configs?status=approved", undefined, staffHeaders());
  assert.ok(approvedOnly.merchant_configs.every((row: any) => row.boarding_status === "APPROVED"));
  assert.ok(approvedOnly.merchant_configs.some((row: any) => row.org_id === orgB.orgId));
  assert.ok(!approvedOnly.merchant_configs.some((row: any) => row.org_id === orgA.orgId));

  const mockOnly = await injectOk("GET", "/v1/payments/admin/merchant-configs?provider=mock", undefined, staffHeaders());
  assert.ok(mockOnly.merchant_configs.some((row: any) => row.org_id === orgA.orgId));

  // Detail: config + application snapshot via the boarding adapter + events.
  const detail = await injectOk("GET", `/v1/payments/admin/merchant-configs/${orgB.orgId}`, undefined, staffHeaders());
  assert.equal(detail.org_id, orgB.orgId);
  assert.equal(detail.org_name, "approved Boarding Co");
  assert.equal(detail.merchant_config.provider, "mock");
  assert.equal(detail.application.id, createdB.application.id);
  assert.equal(detail.application.status, "APPROVED");
  assert.ok(Array.isArray(detail.events) && detail.events.length > 0, "recent provider events are returned");
  assert.ok(detail.events.length <= 20);
  assert.ok(detail.events.every((event: any) => typeof event.event_type === "string" && event.event_type.startsWith("v2.")));
  const times = detail.events.map((event: any) => String(event.received_at));
  assert.deepEqual([...times].sort().reverse(), times, "events are newest-first");

  const missing = await inject("GET", "/v1/payments/admin/merchant-configs/org_does_not_exist", undefined, staffHeaders());
  assert.equal(missing.statusCode, 404);
});

test("assign-plan updates a mutable application, applies immediately post-approval on mock, and records a pending intent for forward", async () => {
  const { MOCK_INTERCHANGE_PLUS_PLAN_ID } = await import("../payments/providers/mock.js");

  // Mutable path: draft application gets the plan updated at the provider.
  const clientDraft = createSessionClient();
  const draft = await registerOrg(clientDraft, "planmut");
  const createdDraft = await clientDraft.request("POST", `/v1/payments/organizations/${draft.orgId}/merchant-boarding/applications`, {
    business: { name: "Plan Mutable Co" },
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  });
  const mutableResult = await injectOk("POST", `/v1/payments/admin/merchant-configs/${draft.orgId}/assign-plan`, {
    processing_plan_id: MOCK_INTERCHANGE_PLUS_PLAN_ID
  }, staffHeaders());
  assert.equal(mutableResult.mode, "application_updated");
  assert.equal(mutableResult.application.processing_plan_id, MOCK_INTERCHANGE_PLUS_PLAN_ID);
  assert.equal(mutableResult.merchant_config.forward.processing_plan_id, MOCK_INTERCHANGE_PLUS_PLAN_ID);
  assert.equal(mutableResult.merchant_config.forward.pending_plan_id, "");

  const appAfter = await clientDraft.request("GET", `/v1/payments/organizations/${draft.orgId}/merchant-boarding/applications/${createdDraft.application.id}`);
  assert.equal(appAfter.application.processing_plan_id, MOCK_INTERCHANGE_PLUS_PLAN_ID, "plan persisted on the provider application");

  // Post-approval, mock provider: applied immediately (no rep in the loop).
  const clientApproved = createSessionClient();
  const approved = await registerOrg(clientApproved, "planapp");
  const createdApproved = await clientApproved.request("POST", `/v1/payments/organizations/${approved.orgId}/merchant-boarding/applications`, {
    business: { name: "Plan Approved Co" },
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  });
  await clientApproved.request("POST", `/v1/payments/organizations/${approved.orgId}/merchant-boarding/applications/${createdApproved.application.id}/submit`, {});
  await clientApproved.request("POST", `/v1/payments/organizations/${approved.orgId}/merchant-mock/advance`, { op: "underwriting", to: "APPROVED" });

  const approvedResult = await injectOk("POST", `/v1/payments/admin/merchant-configs/${approved.orgId}/assign-plan`, {
    processing_plan_id: MOCK_INTERCHANGE_PLUS_PLAN_ID
  }, staffHeaders());
  assert.equal(approvedResult.mode, "applied_immediately");
  assert.equal(approvedResult.merchant_config.forward.processing_plan_id, MOCK_INTERCHANGE_PLUS_PLAN_ID);
  assert.equal(approvedResult.merchant_config.forward.pending_plan_id, "");

  // Forward provider without keys post-approval: rep-mediated pending intent,
  // current plan untouched.
  await injectOk("POST", `/v1/payments/admin/merchant-configs/${approved.orgId}/set-provider`, { provider: "forward" }, staffHeaders());
  const forwardResult = await injectOk("POST", `/v1/payments/admin/merchant-configs/${approved.orgId}/assign-plan`, {
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  }, staffHeaders());
  assert.equal(forwardResult.mode, "change_requested");
  assert.equal(forwardResult.merchant_config.forward.processing_plan_id, MOCK_INTERCHANGE_PLUS_PLAN_ID, "active plan unchanged");
  assert.equal(forwardResult.merchant_config.forward.pending_plan_id, "partppl_3HpoNDtV6PtzrHasDxATGCIww6m", "pending intent recorded");

  // Switching back to mock and re-assigning applies and clears the intent.
  await injectOk("POST", `/v1/payments/admin/merchant-configs/${approved.orgId}/set-provider`, { provider: "mock" }, staffHeaders());
  const reapplied = await injectOk("POST", `/v1/payments/admin/merchant-configs/${approved.orgId}/assign-plan`, {
    processing_plan_id: "partppl_3HpoNDtV6PtzrHasDxATGCIww6m"
  }, staffHeaders());
  assert.equal(reapplied.merchant_config.forward.processing_plan_id, "partppl_3HpoNDtV6PtzrHasDxATGCIww6m");
  assert.equal(reapplied.merchant_config.forward.pending_plan_id, "");
});

test("set-provider roundtrip flips mock -> forward -> cleared and validates input", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client, "provider");

  const toForward = await injectOk("POST", `/v1/payments/admin/merchant-configs/${orgId}/set-provider`, { provider: "forward" }, staffHeaders());
  assert.equal(toForward.merchant_config.provider, "forward");

  const cleared = await injectOk("POST", `/v1/payments/admin/merchant-configs/${orgId}/set-provider`, { provider: null }, staffHeaders());
  assert.equal(cleared.merchant_config.provider, "");

  const backToMock = await injectOk("POST", `/v1/payments/admin/merchant-configs/${orgId}/set-provider`, { provider: "mock" }, staffHeaders());
  assert.equal(backToMock.merchant_config.provider, "mock");

  const invalid = await inject("POST", `/v1/payments/admin/merchant-configs/${orgId}/set-provider`, { provider: "stripe" }, staffHeaders());
  assert.equal(invalid.statusCode, 400);

  const config = await client.request("GET", `/v1/payments/organizations/${orgId}/merchant-config`);
  assert.equal(config.merchant_config.provider, "mock", "org-facing read reflects the staff switch");
});

test("processing-plans returns the org-agnostic plan union including the interchange-plus plan", async () => {
  const { MOCK_INTERCHANGE_PLUS_PLAN_ID } = await import("../payments/providers/mock.js");
  const data = await injectOk("GET", "/v1/payments/admin/processing-plans", undefined, staffHeaders());
  assert.ok(data.count >= 3, "mock catalog has at least the three seeded plans");
  const ids = data.processing_plans.map((plan: any) => plan.id);
  assert.ok(ids.includes("partppl_3HpoNDtV6PtzrHasDxATGCIww6m"));
  assert.ok(ids.includes(MOCK_INTERCHANGE_PLUS_PLAN_ID), "interchange-plus plan is offered for the pricing switch");
  assert.ok(data.processing_plans.every((plan: any) => plan.name && plan.source));
});
