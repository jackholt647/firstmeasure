import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveDeploymentProviderKeysPath, runProductionPreflight } from "../scripts/production_preflight.mjs";

test("production preflight validates a deployable release without changing storage", async (t) => {
  const root = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(tmpdir(), "firstmeasure-preflight-")));
  const v1Root = path.join(root, "public", "v1");
  const firstmeasure = path.join(v1Root, "storage", "firstmeasure", "projects", "project-one");
  const identities = path.join(v1Root, "storage", "platform", "identities");
  const privateRoot = path.join(root, "private");
  await Promise.all([mkdir(firstmeasure, { recursive: true }), mkdir(identities, { recursive: true }), mkdir(privateRoot, { recursive: true })]);
  await Promise.all([
    writeFile(path.join(v1Root, "package.json"), "{}\n"),
    writeFile(path.join(firstmeasure, "manifest.json"), JSON.stringify({ id: "project-one", status: "queued" })),
    writeFile(path.join(identities, "identity-one.json"), JSON.stringify({ id: "identity-one", phone: "(303) 555-1212" })),
    writeFile(path.join(privateRoot, "provider-keys.json"), JSON.stringify({
      google: { shared_api_key: "test-google" },
      application: { internal_api_secret: "test-internal" }
    })),
    writeFile(path.join(privateRoot, "do-ca.crt"), "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n")
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const environment = {
    FIRSTMATE_DATABASE_MODE: "postgres",
    V1_PORT: "3101",
    DATABASE_URL: "postgresql://firstmeasure_app:secret@database.invalid:25060/firstmeasure?sslmode=require",
    DATABASE_ADMIN_URL: "postgresql://doadmin:secret@database.invalid:25060/firstmeasure?sslmode=require",
    DATABASE_CA_CERT_PATH: "../../private/do-ca.crt",
    FIRSTMEASURE_STORAGE_ROOT: "./storage/firstmeasure",
    PLATFORM_STORAGE_ROOT: "./storage/platform",
    GOOGLE_AUTH_CLIENT_ID: "test.apps.googleusercontent.com",
    TELNYX_API_KEY: "test-telnyx",
    TELNYX_VERIFY_PROFILE_ID: "test-profile",
    STRIPE_LIVE_SECRET_KEY: "test-stripe",
    STRIPE_LIVE_WEBHOOK_SECRET: "test-webhook"
  };
  assert.equal(resolveDeploymentProviderKeysPath(v1Root, environment), path.join(privateRoot, "provider-keys.json"));
  const before = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(firstmeasure, "manifest.json"), "utf8"));
  const report = await runProductionPreflight({ v1Root, envOverrides: environment, checkDatabase: false, checkPhpRuntime: false });
  const after = await import("node:fs/promises").then(({ readFile }) => readFile(path.join(firstmeasure, "manifest.json"), "utf8"));
  assert.equal(report.ok, true, JSON.stringify(report.checks));
  assert.equal(report.stats.projects.manifests, 1);
  assert.equal(report.stats.phones.with_phone, 1);
  assert.equal(report.checks.find((entry) => entry.name === "provider_keys_php_access")?.ok, true);
  assert.equal(after, before, "preflight must be read-only");
});

test("compiled provider-key resolution stays at project-root private storage", async () => {
  const provider = await import("../dist/src/config/provider_keys.js");
  const expected = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../private/provider-keys.json");
  assert.equal(path.normalize(provider.PROVIDER_KEYS_PATH).toLowerCase(), path.normalize(expected).toLowerCase());
});

test("compiled PostgreSQL config removes URL SSL overrides when a CA is pinned", async () => {
  const original = process.env.DATABASE_CA_CERT_PATH;
  process.env.DATABASE_CA_CERT_PATH = "private/do-ca.crt";
  try {
    const database = await import(`../dist/src/database/postgres.js?tls-test=${Date.now()}`);
    const sanitized = new URL(database.connectionStringWithExternalTlsConfig(
      "postgresql://app:secret@example.test:25060/firstmeasure?sslmode=require&application_name=test"
    ));
    assert.equal(sanitized.searchParams.has("sslmode"), false);
    assert.equal(sanitized.searchParams.get("application_name"), "test");
  } finally {
    if (original == null) delete process.env.DATABASE_CA_CERT_PATH;
    else process.env.DATABASE_CA_CERT_PATH = original;
  }
});
