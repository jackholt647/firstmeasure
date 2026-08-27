import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import pg from "pg";

const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runMigration(environment: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/scripts/cluster_state_migrate.ts", "--apply", "--verify", "--concurrency", "2"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("cluster migration imports and verifies every shared state family", { skip: !databaseUrl }, async (t) => {
  const reset = new pg.Client({ connectionString: databaseUrl });
  await reset.connect();
  await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
  await reset.query("CREATE SCHEMA public");

  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "firstmeasure-cluster-migration-"));
  t.after(async () => {
    await reset.end();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  const objects = new Map<string, Buffer>();
  const objectServer = createServer((request, response) => {
    const key = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace(/^\/firstmeasure-test\/?/, ""));
    if (request.method === "PUT") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        objects.set(key, Buffer.concat(chunks));
        response.writeHead(200, { ETag: '"test-etag"' });
        response.end();
      });
      return;
    }
    if (request.method === "GET" && objects.has(key)) {
      const content = objects.get(key)!;
      response.writeHead(200, { "Content-Length": String(content.length), "Content-Type": "application/octet-stream" });
      response.end(content);
      return;
    }
    response.writeHead(404, { "Content-Type": "application/xml" });
    response.end("<Error><Code>NoSuchKey</Code></Error>");
  });
  await new Promise<void>((resolve) => objectServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => objectServer.close(() => resolve())));
  const address = objectServer.address();
  assert.ok(address && typeof address === "object");

  const roots = {
    platform: path.join(fixtureRoot, "platform"),
    internal: path.join(fixtureRoot, "internal"),
    firstmeasure: path.join(fixtureRoot, "firstmeasure"),
    weather: path.join(fixtureRoot, "weather"),
    codeReports: path.join(fixtureRoot, "code-reports"),
    crm: path.join(fixtureRoot, "crm"),
    canvassing: path.join(fixtureRoot, "canvassing"),
    pricebook: path.join(fixtureRoot, "pricebook"),
    communications: path.join(fixtureRoot, "communications")
  };
  const organizationId = "org-migration";
  const identity = { id: "identity-migration", email: "migration@example.test", email_normalized: "migration@example.test" };
  await writeJson(path.join(roots.platform, "identities", "identity.json"), identity);
  await writeJson(path.join(roots.platform, "sessions", "session.json"), {
    id_hash: "session-hash", identity_id: identity.id, expires_at: "2099-01-01T00:00:00.000Z"
  });
  const organizationRoot = path.join(roots.platform, "organizations", organizationId);
  await writeJson(path.join(organizationRoot, "manifest.json"), { id: organizationId, name: "Migration Test" });
  await writeJson(path.join(organizationRoot, "global.json"), { id: "global", data: { migrated: true } });
  await writeJson(path.join(organizationRoot, "users", "user.json"), { id: "user", data: { migrated: true } });
  await writeJson(path.join(organizationRoot, "branch_data", "branch-1", "module.json"), { id: "module", data: { migrated: true } });
  await writeJson(path.join(organizationRoot, "media", "media-1", "metadata.json"), { id: "media-1", name: "roof.jpg" });
  await writeJson(path.join(organizationRoot, "media", "media-1", "markup", "markup.json"), { id: "markup", shapes: [] });
  await mkdir(path.join(organizationRoot, "media", "media-1", "original"), { recursive: true });
  await writeFile(path.join(organizationRoot, "media", "media-1", "original", "roof.jpg"), Buffer.from("original-media"));

  await writeJson(path.join(roots.internal, "users", "worker.json"), { id: "worker", email: "worker@example.test", name: "Worker" });
  await writeJson(path.join(roots.internal, "state", "settings", "queue.json"), { id: "queue", data: { enabled: true } });
  await writeJson(path.join(roots.weather, "reports", "weather-1.json"), { id: "weather-1", status: "complete" });
  await writeJson(path.join(roots.codeReports, "reports", "cr_migration01.json"), { id: "cr_migration01", status: "complete" });
  await writeJson(path.join(roots.crm, "global", "settings", "crm.json"), { id: "crm", data: { migrated: true } });
  await writeJson(path.join(roots.canvassing, "organizations", organizationId, "branches", "branch-1", "pins", "pin.json"), { id: "pin", lat: 1, lng: 2 });
  await writeJson(path.join(roots.pricebook, "pricebooks", "pricebook-1", "manifest.json"), { id: "pricebook-1", name: "Test", revision: 1 });
  await writeJson(path.join(roots.pricebook, "pricebooks", "pricebook-1", "catalog.json"), { items: [] });
  await mkdir(path.join(roots.pricebook, "pricebooks", "pricebook-1", "assets"), { recursive: true });
  await writeFile(path.join(roots.pricebook, "pricebooks", "pricebook-1", "assets", "item.png"), Buffer.from("pricebook-asset"));
  await writeJson(path.join(roots.platform, "public_firstmeasure", "reports", "fmr_migration01.json"), { report_id: "fmr_migration01", org_id: organizationId });
  await writeJson(path.join(roots.platform, "api_keys", "firstmeasure", "key-migration.json"), { key_id: "key-migration", org_id: organizationId });
  await writeJson(path.join(roots.platform, "api_keys", "firstmeasure", ".secret-vault", "key-migration.json"), { key_id: "key-migration", ciphertext: "test" });
  await writeJson(path.join(roots.platform, "api_keys", "firstmeasure", ".deliveries", "delivery.json"), { delivery_id: "delivery", key_id: "key-migration" });
  await writeJson(path.join(roots.communications, "gmail_mailboxes", "mailbox@example.test", "mailbox.json"), { mailbox_email: "mailbox@example.test" });
  await writeJson(path.join(roots.communications, "gmail_mailboxes", "mailbox@example.test", "messages", "message.json"), { gmail_message_id: "message" });
  await writeJson(path.join(roots.communications, "gmail_mailboxes", "mailbox@example.test", "unmatched", "unmatched.json"), { gmail_message_id: "unmatched" });
  await writeJson(path.join(roots.communications, "gmail_mailboxes", "mailbox@example.test", "sync_runs", "run.json"), { id: "run" });
  await writeJson(path.join(roots.firstmeasure, "rush_modes.json"), { global: { enabled: false } });
  await writeJson(path.join(roots.firstmeasure, "apple_key.json"), { key: "migration-apple-key", updated_at_utc: "2026-01-01T00:00:00.000Z", tile_version: 10401 });
  await mkdir(path.join(roots.firstmeasure, "logs"), { recursive: true });
  await writeFile(path.join(roots.firstmeasure, "logs", "apple_key_ingest.ndjson"), `${JSON.stringify({ ts_utc: "2026-01-01T00:00:00.000Z", key_changed: true })}\n`);

  const result = await runMigration({
    ...process.env,
    FIRSTMATE_ENV: "test",
    FIRSTMEASURE_DATABASE_MODE: "postgres",
    DATABASE_URL: databaseUrl,
    DATABASE_ADMIN_URL: databaseUrl,
    POSTGRES_AUTO_MIGRATE: "false",
    FIRSTMEASURE_ARTIFACT_STORAGE: "spaces",
    SPACES_ENDPOINT: `http://127.0.0.1:${address.port}`,
    SPACES_REGION: "us-east-1",
    SPACES_BUCKET: "firstmeasure-test",
    SPACES_ACCESS_KEY_ID: "test-access-key",
    SPACES_SECRET_ACCESS_KEY: "test-secret-key",
    SPACES_FORCE_PATH_STYLE: "true",
    SPACES_PREFIX: "migration-test",
    PLATFORM_STORAGE_ROOT: roots.platform,
    INTERNAL_STORAGE_ROOT: roots.internal,
    FIRSTMEASURE_STORAGE_ROOT: roots.firstmeasure,
    WEATHER_STORAGE_ROOT: roots.weather,
    CODE_REPORT_STORAGE_ROOT: roots.codeReports,
    CRM_STORAGE_ROOT: roots.crm,
    CANVASSING_STORAGE_ROOT: roots.canvassing,
    PRICEBOOK_STORAGE_ROOT: roots.pricebook,
    COMMUNICATIONS_STORAGE_ROOT: roots.communications
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"failures": \[\]/);
  assert.equal((await reset.query("SELECT COUNT(*)::int count FROM platform_identities")).rows[0].count, 1);
  assert.equal((await reset.query("SELECT COUNT(*)::int count FROM internal_users_index")).rows[0].count, 1);
  assert.equal((await reset.query("SELECT COUNT(*)::int count FROM app_shared_documents WHERE namespace='communications'")).rows[0].count, 4);
  assert.equal(objects.get("migration-test/platform/organizations/org-migration/media/media-1/original/roof.jpg")?.toString(), "original-media");
  assert.equal(objects.get("migration-test/pricebooks/pricebook-1/assets/item.png")?.toString(), "pricebook-asset");
});
