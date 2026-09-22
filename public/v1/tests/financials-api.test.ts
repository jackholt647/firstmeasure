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
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
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
      cookie = [sessionCookie, csrfCookie].filter(Boolean).join("; ") || cookie;
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.body ? JSON.parse(response.body) : null;
  };
  return { request };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-financials-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.OPENAI_API_KEY = "";
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
}, { timeout: 15_000 });

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closePayrollDatabase }, { closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../payroll/storage.js"),
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closePayrollDatabase());
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => null);
});

test("financial read API aggregates the full population before paginating details", { timeout: 20_000 }, async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `financials-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Financials Owner",
    company: "Financials Test Org",
    organization_id: `org_financials_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = String(registered.organization.id);
  const { upsertDocument } = await import("../platform/storage.js");
  const { PAYMENT_OBLIGATION_COLLECTION, PAYMENT_TRANSACTION_COLLECTION } = await import("../payments/storage.js");

  for (let index = 1; index <= 3; index += 1) {
    const projectId = `financial_project_${index}`;
    await upsertDocument(orgId, "projects", {
      id: projectId,
      data: { id: projectId, title: `Financial project ${index}`, stage: "in_progress", branch_id: "default", created_at: "2026-06-01T00:00:00.000Z" },
      metadata: { kind: "platform_project" }
    }, { replace: true });
    await upsertDocument(orgId, PAYMENT_OBLIGATION_COLLECTION, {
      id: `financial_obligation_${index}`,
      data: { id: `financial_obligation_${index}`, project_id: projectId, amount_cents: index * 10_000, allocated_cents: 0, status: "pending", label: "Final payment", due_at: "2026-07-20T12:00:00.000Z" },
      metadata: { kind: "payment_obligation", project_id: projectId }
    }, { replace: true });
    await upsertDocument(orgId, PAYMENT_TRANSACTION_COLLECTION, {
      id: `financial_payment_${index}`,
      data: { id: `financial_payment_${index}`, project_id: projectId, amount_cents: index * 1_000, direction: "inbound", status: "settled", paid_at: "2026-07-10T12:00:00.000Z", created_at: "2026-07-10T12:00:00.000Z" },
      metadata: { kind: "payment_transaction", project_id: projectId }
    }, { replace: true });
  }

  const first = await client.request("GET", `/v1/financials/organizations/${orgId}/projects?from=2026-07-01&through=2026-08-01&limit=2`);
  assert.equal(first.totals.matching_project_count, 3);
  assert.equal(first.totals.projected_revenue_cents, 60_000);
  assert.equal(first.projects.items.length, 2);
  assert.equal(first.projects.has_more, true);
  assert.ok(first.projects.next_cursor);
  assert.ok(first.snapshot_id);

  const second = await client.request("GET", `/v1/financials/organizations/${orgId}/projects?from=2026-07-01&through=2026-08-01&limit=2&cursor=${encodeURIComponent(first.projects.next_cursor)}`);
  assert.equal(second.totals.projected_revenue_cents, 60_000);
  assert.equal(second.snapshot_id, first.snapshot_id);
  assert.equal(second.as_of, first.as_of);
  assert.equal(second.projects.items.length, 1);
  assert.equal(second.projects.has_more, false);

  const cash = await client.request("GET", `/v1/financials/organizations/${orgId}/cash-flow?from=2026-07-01&through=2026-08-01&limit=1&clearing_hours=48`);
  assert.equal(cash.transactions.items.length, 1);
  assert.equal(cash.transactions.has_more, true);
  assert.equal(cash.series.length, 31);
  assert.ok(cash.totals.expected_in_cents > 0);
});
