import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("public FirstMeasure customer API end-to-end and load behavior", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "public-firstmeasure-api-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure-index.sqlite");
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.CRM_STORAGE_ROOT = path.join(root, "crm");
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";
  process.env.PUBLIC_FIRSTMEASURE_API_KEY_SECRET = "customer-api-test-secret-with-sufficient-entropy";
  process.env.FIRSTMEASURE_INTERNAL_API_SECRET = "internal-api-test-secret";
  process.env.PLATFORM_SESSION_SECRET = "platform-test-secret";
  process.env.STRIPE_SECRET_KEY = "";
  process.env.STRIPE_LIVE_SECRET_KEY = "";
  process.env.STRIPE_TEST_SECRET_KEY = "";

  const [{ buildApp }, storage, keys] = await Promise.all([
    import("../src/app.js"),
    import("../platform/storage.js"),
    import("../public-firstmeasure/keys.js")
  ]);

  const organization = await storage.createOrganization({
    name: "Customer API Test Organization",
    global: {
      credits_balance: 500,
      credits_ledger: [],
      billing: {
        stripe: { has_payment_method: false },
        auto_topup: { enabled: false }
      }
    }
  });
  const otherOrganization = await storage.createOrganization({
    name: "Other Customer API Organization",
    global: { credits_balance: 100, credits_ledger: [] }
  });
  const failedTopupOrganization = await storage.createOrganization({
    name: "Failed Auto Top-up Organization",
    global: {
      credits_balance: 5,
      credits_ledger: [],
      billing: {
        stripe: {
          has_payment_method: true,
          payment_method_id: "pm_failed_topup_test",
          customer_id: "cus_failed_topup_test"
        },
        auto_topup: {
          enabled: true,
          threshold_dollars: 50,
          topup_dollars: 100,
          status: "idle"
        }
      }
    }
  });
  const orgId = String(organization.id);
  const otherOrgId = String(otherOrganization.id);
  const failedTopupOrgId = String(failedTopupOrganization.id);
  const testKey = await keys.createPublicFirstMeasureApiKey({ orgId, mode: "test", requireBilling: false });
  const liveKey = await keys.createPublicFirstMeasureApiKey({ orgId, mode: "live" });
  const otherKey = await keys.createPublicFirstMeasureApiKey({ orgId: otherOrgId, mode: "test", requireBilling: false });
  const readOnlyKey = await keys.createPublicFirstMeasureApiKey({
    orgId,
    mode: "test",
    requireBilling: false,
    scopes: ["firstmeasure:reports:read"]
  });
  const expiredKey = await keys.createPublicFirstMeasureApiKey({
    orgId,
    mode: "test",
    requireBilling: false,
    expiresAt: "2020-01-01T00:00:00.000Z"
  });
  const failedTopupKey = await keys.createPublicFirstMeasureApiKey({ orgId: failedTopupOrgId, mode: "live" });
  const loadTestKeys = await Promise.all(Array.from({ length: 100 }, (_, index) => keys.createPublicFirstMeasureApiKey({
    orgId,
    name: `Test load key ${index}`,
    mode: "test",
    requireBilling: false
  })));
  const loadLiveKeys = await Promise.all(Array.from({ length: 20 }, (_, index) => keys.createPublicFirstMeasureApiKey({
    orgId,
    name: `Live load key ${index}`,
    mode: "live"
  })));

  const app = await buildApp();
  await app.ready();
  t.after(async () => {
    await app.close();
    await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex();
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith("public-firstmeasure-api-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  });

  const auth = (key: string) => ({ authorization: `Bearer ${key}` });
  const order = (externalId: string) => ({
    external_id: externalId,
    address: "1600 Amphitheatre Parkway, Mountain View, CA 94043",
    project_type: "residential",
    report_mode: "full",
    lat: 37.422,
    lng: -122.084,
    process_async: false
  });

  await t.test("authentication, expiration, and scopes", async () => {
    const rootResponse = await app.inject({ method: "GET", url: "/v1/public/firstmeasure/" });
    assert.equal(rootResponse.statusCode, 200, rootResponse.body);

    const missing = await app.inject({ method: "GET", url: "/v1/public/firstmeasure/pricing" });
    assert.equal(missing.statusCode, 401, missing.body);
    assert.equal(missing.json().error, "missing_api_key");

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing",
      headers: auth("fmk_test_12345678_abcdefghijklmnopqrstuvwxyz")
    });
    assert.equal(invalid.statusCode, 401, invalid.body);

    const expired = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing",
      headers: auth(expiredKey.key)
    });
    assert.equal(expired.statusCode, 403, expired.body);
    assert.equal(expired.json().error, "api_key_expired");

    const missingScope = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(readOnlyKey.key)
    });
    assert.equal(missingScope.statusCode, 403, missingScope.body);
    assert.equal(missingScope.json().error, "scope_required");
  });

  let reportId = "";
  await t.test("test-mode order, idempotency, status, PDF, measurements, and files", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(testKey.key), "idempotency-key": "test-order-1" },
      payload: order("customer-test-order-1")
    });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().test_mode, true);
    assert.equal(created.json().billing.amount_charged, 0);
    reportId = String(created.json().report.id);
    assert.match(reportId, /^fmr_/);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(testKey.key), "idempotency-key": "test-order-1" },
      payload: order("customer-test-order-1")
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json().idempotent_replay, true);
    assert.equal(replay.json().report.id, reportId);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}`,
      headers: auth(testKey.key)
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().report.id, reportId);

    const crossOrg = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}`,
      headers: auth(otherKey.key)
    });
    assert.equal(crossOrg.statusCode, 404, crossOrg.body);

    const pdf = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}/pdf`,
      headers: auth(testKey.key)
    });
    assert.equal(pdf.statusCode, 200, pdf.body);
    assert.match(String(pdf.headers["content-type"]), /application\/pdf/);
    assert.equal(pdf.rawPayload.subarray(0, 4).toString(), "%PDF");

    const measurements = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}/measurements`,
      headers: auth(testKey.key)
    });
    assert.equal(measurements.statusCode, 200, measurements.body);
    assert.ok(measurements.json().measurements);

    const files = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}/files`,
      headers: auth(testKey.key)
    });
    assert.equal(files.statusCode, 200, files.body);
    assert.equal(files.json().files.length, 3);

    const file = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${reportId}/files/summary.json`,
      headers: auth(testKey.key)
    });
    assert.equal(file.statusCode, 200, file.body);
    assert.equal(JSON.parse(file.body).id, reportId);
  });

  await t.test("live-mode order uses isolated credits and creates a trackable report", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(liveKey.key)
    });
    assert.equal(before.statusCode, 200, before.body);

    const created = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(liveKey.key), "idempotency-key": "live-order-1" },
      payload: order("customer-live-order-1")
    });
    assert.equal(created.statusCode, 201, created.body);
    const liveReportId = String(created.json().report.id);
    assert.match(liveReportId, /^fmr_/);
    assert.ok(Number(created.json().billing.amount_charged) > 0);
    assert.equal(
      Number(created.json().billing.balance),
      Number(before.json().balance) - Number(created.json().billing.amount_charged)
    );

    const detail = await app.inject({
      method: "GET",
      url: `/v1/public/firstmeasure/reports/${liveReportId}`,
      headers: auth(liveKey.key)
    });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().report.id, liveReportId);
  });

  await t.test("validation and key revocation", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: auth(testKey.key),
      payload: { address: "" }
    });
    assert.equal(malformed.statusCode, 400, malformed.body);
    assert.equal(malformed.json().error, "validation_error");

    const revocable = await keys.createPublicFirstMeasureApiKey({ orgId, mode: "test", requireBilling: false });
    await keys.revokePublicFirstMeasureApiKey(revocable.record.key_id);
    const revoked = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing",
      headers: auth(revocable.key)
    });
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.equal(revoked.json().error, "api_key_revoked");
  });

  await t.test("failed auto top-up rolls back the debit and does not create a report", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(failedTopupKey.key)
    });
    assert.equal(before.statusCode, 200, before.body);
    const response = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(failedTopupKey.key), "idempotency-key": "failed-topup-order" },
      payload: order("failed-topup-order")
    });
    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, "auto_topup_failed");

    const after = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(failedTopupKey.key)
    });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().balance, before.json().balance);
    assert.equal(after.json().ledger_count, before.json().ledger_count + 2);

    const reports = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/reports",
      headers: auth(failedTopupKey.key)
    });
    assert.equal(reports.statusCode, 200, reports.body);
    assert.equal(reports.json().count, 0);
  });

  await t.test("parallel unique test orders remain readable", async () => {
    const startedAt = performance.now();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(loadTestKeys[index]!.key), "idempotency-key": `load-unique-${index}` },
      payload: order(`load-unique-${index}`)
    })));
    const elapsedMs = performance.now() - startedAt;
    assert.equal(responses.filter((response) => response.statusCode === 201).length, 100);
    const ids = new Set(responses.map((response) => String(response.json().report?.id || "")));
    assert.equal(ids.size, 100);
    t.diagnostic(`100 parallel test-mode orders completed in ${elapsedMs.toFixed(1)} ms`);

    const listed = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/reports?limit=200",
      headers: auth(testKey.key)
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.ok(Number(listed.json().count) >= 101);
  });

  await t.test("concurrent reuse of one idempotency key commissions only one test report", async () => {
    const responses = await Promise.all(Array.from({ length: 25 }, (_, index) => app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(loadTestKeys[index]!.key), "idempotency-key": "load-duplicate-key" },
      payload: order("load-duplicate-key")
    })));
    assert.ok(responses.every((response) => response.statusCode === 200 || response.statusCode === 201));
    const ids = new Set(responses.map((response) => String(response.json().report?.id || "")));
    assert.equal(ids.size, 1, `concurrent idempotency key created ${ids.size} reports`);
  });

  await t.test("one API key tolerates concurrent authenticated reads", async () => {
    const responses = await Promise.all(Array.from({ length: 50 }, () => app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing",
      headers: auth(testKey.key)
    })));
    const statusCounts = responses.reduce<Record<string, number>>((counts, response) => {
      const key = String(response.statusCode);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    t.diagnostic(`50 same-key reads returned ${JSON.stringify(statusCounts)}`);
    assert.ok(responses.every((response) => response.statusCode === 200));
  });

  await t.test("concurrent usage cannot reactivate a revoked key", async () => {
    const revocationRaceKey = await keys.createPublicFirstMeasureApiKey({ orgId, mode: "test", requireBilling: false });
    await Promise.all([
      ...Array.from({ length: 25 }, () => app.inject({
        method: "GET",
        url: "/v1/public/firstmeasure/pricing",
        headers: auth(revocationRaceKey.key)
      })),
      keys.revokePublicFirstMeasureApiKey(revocationRaceKey.record.key_id)
    ]);
    const after = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing",
      headers: auth(revocationRaceKey.key)
    });
    assert.equal(after.statusCode, 403, after.body);
    assert.equal(after.json().error, "api_key_revoked");
    assert.equal((await keys.readPublicFirstMeasureApiKey(revocationRaceKey.record.key_id)).status, "revoked");
  });

  await t.test("parallel live orders preserve every credit debit", async () => {
    const before = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(liveKey.key)
    });
    assert.equal(before.statusCode, 200, before.body);
    const responses = await Promise.all(loadLiveKeys.map((key, index) => app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/reports",
      headers: { ...auth(key.key), "idempotency-key": `live-load-${index}` },
      payload: order(`live-load-${index}`)
    })));
    assert.ok(responses.every((response) => response.statusCode === 201));
    const totalCharged = responses.reduce((sum, response) => sum + Number(response.json().billing.amount_charged), 0);
    const after = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/balance",
      headers: auth(liveKey.key)
    });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(Number(after.json().ledger_count), Number(before.json().ledger_count) + responses.length);
    assert.equal(Number(after.json().balance), Number(before.json().balance) - totalCharged);
  });
});
