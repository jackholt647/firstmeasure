import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("FirstMeasure API keys support encrypted, expiring, one-time delivery links", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-key-delivery-"));
  process.env.FIRSTMATE_ENV = "test";
  process.env.FIRSTMEASURE_DATABASE_MODE = "sqlite";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(root, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure", "projects-index.sqlite");
  process.env.INTERNAL_STORAGE_ROOT = path.join(root, "internal");
  process.env.PLATFORM_STORAGE_ROOT = path.join(root, "platform");
  process.env.PUBLIC_FIRSTMEASURE_API_KEY_SECRET = "delivery-test-master-secret-with-sufficient-entropy";

  const [{ buildApp }, internalStorage, platformStorage, secretVault] = await Promise.all([
    import("../src/app.js"),
    import("../internal/storage.js"),
    import("../platform/storage.js"),
    import("../public-firstmeasure/key_secret_vault.js")
  ]);

  await internalStorage.saveInternalUser({
    email: "admin@example.test",
    name: "API Administrator",
    role: "admin",
    is_admin: true,
    permissions: {}
  });
  await platformStorage.createOrganization({ id: "org_delivery", name: "Delivery Roofing" });

  const app = await buildApp();
  await app.ready();
  const adminHeaders = {
    "x-internal-user-email": "admin@example.test",
    "x-internal-user-name": "API Administrator",
    "x-forwarded-host": "app.1m8.ai",
    "x-forwarded-proto": "https"
  };

  try {
    const createdResponse = await app.inject({
      method: "POST",
      url: "/v1/internal/admin/firstmeasure-api-keys",
      headers: adminHeaders,
      payload: {
        org_id: "org_delivery",
        name: "Customer integration",
        mode: "test",
        create_delivery_link: true,
        delivery_ttl_hours: 24
      }
    });
    assert.equal(createdResponse.statusCode, 201);
    assert.match(String(createdResponse.headers["cache-control"]), /no-store/);
    const created = createdResponse.json();
    assert.match(created.key, /^fmk_test_[a-f0-9]{16}_[A-Za-z0-9_-]{24,}$/);
    assert.equal(created.record.delivery_available, true);
    assert.equal(created.delivery.mode, "test");
    assert.match(created.delivery.url, /^https:\/\/app\.1m8\.ai\/api-key-delivery\/#fmd_[a-f0-9]{20}_[A-Za-z0-9_-]{32,}$/);
    const initialToken = created.delivery.url.split("#")[1];

    const vaultPath = path.join(
      root,
      "platform",
      "api_keys",
      "firstmeasure",
      ".secret-vault",
      `${created.record.key_id}.json`
    );
    const vaultSource = await readFile(vaultPath, "utf8");
    assert.equal(vaultSource.includes(created.key), false);
    assert.match(vaultSource, /"algorithm": "aes-256-gcm"/);

    const listedResponse = await app.inject({
      method: "GET",
      url: "/v1/internal/admin/firstmeasure-api-keys?org_id=org_delivery",
      headers: adminHeaders
    });
    assert.equal(listedResponse.statusCode, 200);
    const listedText = listedResponse.body;
    assert.equal(listedText.includes(created.key), false);
    assert.equal(listedText.includes(initialToken), false);
    assert.equal(listedResponse.json().keys[0].delivery_available, true);

    const revealResponse = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: initialToken }
    });
    assert.equal(revealResponse.statusCode, 200);
    assert.equal(revealResponse.json().delivery.key, created.key);
    assert.equal(revealResponse.json().delivery.key_name, "Customer integration");
    assert.match(String(revealResponse.headers["cache-control"]), /no-store/);
    assert.equal(revealResponse.headers["referrer-policy"], "no-referrer");

    const keyStillWorks = await app.inject({
      method: "GET",
      url: "/v1/public/firstmeasure/pricing?project_type=residential",
      headers: { authorization: `Bearer ${revealResponse.json().delivery.key}` }
    });
    assert.equal(keyStillWorks.statusCode, 200);
    assert.equal(keyStillWorks.json().test_mode, true);

    const secondReveal = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: initialToken }
    });
    assert.equal(secondReveal.statusCode, 410);
    assert.equal(secondReveal.json().error, "key_delivery_unavailable");

    const replacementResponse = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${created.record.key_id}/delivery-links`,
      headers: adminHeaders,
      payload: { delivery_ttl_hours: 72 }
    });
    assert.equal(replacementResponse.statusCode, 201);
    const replacementToken = replacementResponse.json().delivery.url.split("#")[1];
    assert.notEqual(replacementToken, initialToken);

    const supersededResponse = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${created.record.key_id}/delivery-links`,
      headers: adminHeaders,
      payload: { delivery_ttl_hours: 72 }
    });
    assert.equal(supersededResponse.statusCode, 201);
    const currentToken = supersededResponse.json().delivery.url.split("#")[1];

    const supersededReveal = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: replacementToken }
    });
    assert.equal(supersededReveal.statusCode, 410);

    const concurrent = await Promise.all(Array.from({ length: 12 }, () => app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: currentToken }
    })));
    assert.equal(concurrent.filter((response) => response.statusCode === 200).length, 1);
    assert.equal(concurrent.filter((response) => response.statusCode === 410).length, 11);
    assert.equal(concurrent.find((response) => response.statusCode === 200)?.json().delivery.key, created.key);

    const invalidReveal = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: "fmd_00000000000000000000_invalidinvalidinvalidinvalidinvalidinvalid" }
    });
    assert.equal(invalidReveal.statusCode, 404);
    assert.equal(invalidReveal.json().error, "key_delivery_unavailable");

    const beforeRevoke = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${created.record.key_id}/delivery-links`,
      headers: adminHeaders,
      payload: { delivery_ttl_hours: 1 }
    });
    const beforeRevokeToken = beforeRevoke.json().delivery.url.split("#")[1];
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${created.record.key_id}/revoke`,
      headers: adminHeaders,
      payload: {}
    });
    assert.equal(revoked.statusCode, 200);
    assert.equal(revoked.json().record.delivery_available, false);
    assert.equal(await secretVault.hasPublicFirstMeasureApiKeySecret(created.record.key_id), false);

    const revealRevoked = await app.inject({
      method: "POST",
      url: "/v1/public/firstmeasure/key-delivery/reveal",
      payload: { token: beforeRevokeToken }
    });
    assert.equal(revealRevoked.statusCode, 410);

    const rerolled = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${created.record.key_id}/reroll`,
      headers: adminHeaders,
      payload: {
        mode: "test",
        create_delivery_link: true,
        delivery_ttl_hours: 24
      }
    });
    assert.equal(rerolled.statusCode, 201);
    assert.equal(rerolled.json().record.delivery_available, true);
    assert.match(rerolled.json().delivery.url, /#fmd_/);
    assert.notEqual(rerolled.json().key, created.key);

    const historicalKeyId = rerolled.json().record.key_id;
    await secretVault.deletePublicFirstMeasureApiKeySecret(historicalKeyId);
    const historicalDelivery = await app.inject({
      method: "POST",
      url: `/v1/internal/admin/firstmeasure-api-keys/${historicalKeyId}/delivery-links`,
      headers: adminHeaders,
      payload: { delivery_ttl_hours: 24 }
    });
    assert.equal(historicalDelivery.statusCode, 409);
    assert.equal(historicalDelivery.json().error, "api_key_secret_unavailable");
  } finally {
    await app.close();
    // SQLite can retain its WAL briefly on Windows. Clean the stores this test
    // directly exercises; the OS temp root is disposable.
    for (const directory of ["internal", "platform"]) {
      await rm(path.join(root, directory), { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  }
});
