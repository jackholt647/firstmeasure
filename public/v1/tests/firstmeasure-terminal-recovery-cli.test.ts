import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function createIndex(dbPath: string, rows: Array<Record<string, unknown>>) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      address TEXT NOT NULL DEFAULT '',
      organization_id TEXT NOT NULL DEFAULT '',
      amount_charged REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT ''
    )
  `);
  const insert = db.prepare(`
    INSERT INTO projects (
      id, status, manifest_json, address, organization_id, amount_charged,
      created_at, created_at_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      String(row.id),
      String(row.status),
      JSON.stringify(row.manifest),
      String(row.address ?? ""),
      String(row.organization_id ?? ""),
      Number(row.amount_charged ?? 0),
      String(row.created_at ?? ""),
      Number(row.created_at_ms ?? 0),
      String(row.updated_at ?? "")
    );
  }
  db.close();
}

test("terminal recovery CLI produces an audit without mutating either index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-terminal-cli-"));
  const baselinePath = path.join(root, "baseline.sqlite");
  const currentPath = path.join(root, "current.sqlite");
  const outputPath = path.join(root, "audit.json");
  const createdMs = Date.now() - 72 * 3_600_000;
  try {
    createIndex(baselinePath, [{
      id: "cancelled-order",
      status: "cancelled",
      manifest: {
        id: "cancelled-order",
        status: "cancelled",
        cancelled_by_customer: true,
        cancellation: { reason: "customer_cancelled_inside_grace_period" }
      },
      amount_charged: 0,
      created_at_ms: createdMs
    }]);
    createIndex(currentPath, [
      {
        id: "cancelled-order",
        status: "queued",
        manifest: { id: "cancelled-order", status: "queued", amount_charged: 0 },
        amount_charged: 0,
        created_at_ms: createdMs
      },
      {
        id: "valid-old-free-order",
        status: "queued",
        manifest: { id: "valid-old-free-order", status: "queued", amount_charged: 0 },
        amount_charged: 0,
        created_at_ms: createdMs - 30 * 3_600_000
      }
    ]);

    const result = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--import", "tsx",
      "src/scripts/firstmeasure_terminal_state_recovery.ts",
      "--baseline-index", baselinePath,
      "--current-index", currentPath,
      "--output", outputPath
    ], { cwd: path.resolve(process.cwd()), encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /AUDIT ONLY/);
    const report = JSON.parse(await readFile(outputPath, "utf8"));
    assert.equal(report.candidate_count, 1);
    assert.equal(report.older_than_48_hours, 1);
    assert.equal(report.zero_charge_count, 1);
    assert.equal(report.candidates[0].id, "cancelled-order");

    const current = new DatabaseSync(currentPath, { readOnly: true });
    assert.equal(current.prepare("SELECT status FROM projects WHERE id = ?").get("cancelled-order")?.status, "queued");
    current.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  }
});

test("terminal recovery apply restores status, preserves files, and creates a manifest backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmeasure-terminal-apply-"));
  const storageRoot = path.join(root, "firstmeasure");
  const projectRoot = path.join(storageRoot, "projects", "cancelled-order");
  const currentPath = path.join(storageRoot, "projects_index.sqlite");
  const baselinePath = path.join(root, "baseline.sqlite");
  const outputPath = path.join(root, "audit.json");
  const timestamp = "2026-08-12T10:00:00.000Z";
  const childEnvironment = {
    ...process.env,
    FIRSTMATE_ENV: "test",
    FIRSTMEASURE_DATABASE_MODE: "sqlite",
    FIRSTMEASURE_STORAGE_ROOT: storageRoot,
    FIRSTMEASURE_INDEX_DB_PATH: currentPath,
    PLATFORM_STORAGE_ROOT: path.join(root, "platform")
  };
  try {
    const setup = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--import", "tsx",
      "--input-type=module",
      "-e", `const storage=await import('./firstmeasure/storage.ts'); await storage.saveManifest('cancelled-order',{id:'cancelled-order',schema_version:2,status:'queued',address:'1 Recovery Way',amount_charged:0,timestamps:{created_at:'${timestamp}',queued_at:'${timestamp}',updated_at:'${timestamp}'},workflow:{history:[],assigned_to:null,reserved_to:null},artifacts:{}});`
    ], { cwd: path.resolve(process.cwd()), encoding: "utf8", env: childEnvironment });
    assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);

    createIndex(baselinePath, [{
      id: "cancelled-order",
      status: "cancelled",
      manifest: {
        id: "cancelled-order",
        schema_version: 2,
        status: "cancelled",
        address: "1 Recovery Way",
        amount_charged: 0,
        cancelled_by_customer: true,
        cancelled_at: timestamp,
        cancellation: { reason: "customer_cancelled_inside_grace_period", cancelled_at: timestamp },
        timestamps: { created_at: timestamp, queued_at: timestamp, cancelled_at: timestamp, updated_at: timestamp }
      },
      address: "1 Recovery Way",
      amount_charged: 0,
      created_at: timestamp,
      created_at_ms: Date.parse(timestamp),
      updated_at: timestamp
    }]);
    const beforeApplyCurrent = new DatabaseSync(currentPath, { readOnly: true });
    assert.deepEqual(beforeApplyCurrent.prepare("SELECT id, status FROM projects").all().map((row) => ({ ...row })), [
      { id: "cancelled-order", status: "queued" }
    ], `${setup.stdout}\n${setup.stderr}`);
    beforeApplyCurrent.close();
    const beforeApplyBaseline = new DatabaseSync(baselinePath, { readOnly: true });
    assert.deepEqual(beforeApplyBaseline.prepare("SELECT id, status FROM projects").all().map((row) => ({ ...row })), [
      { id: "cancelled-order", status: "cancelled" }
    ]);
    beforeApplyBaseline.close();

    const apply = spawnSync(process.execPath, [
      "--experimental-sqlite",
      "--import", "tsx",
      "src/scripts/firstmeasure_terminal_state_recovery.ts",
      "--baseline-index", baselinePath,
      "--current-index", currentPath,
      "--output", outputPath,
      "--apply",
      "--confirm-count", "1",
      "--confirm-service-stopped",
      "--skip-platform-sync"
    ], { cwd: path.resolve(process.cwd()), encoding: "utf8", env: childEnvironment });
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    assert.match(apply.stdout, /"projects_recovered": 1/);

    const recovered = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
    assert.equal(recovered.status, "cancelled");
    assert.equal(recovered.cancelled_by_customer, true);
    assert.equal(recovered.migration_recovery.previous_status, "queued");
    assert.ok((await readdir(path.join(projectRoot, "manifest_backups"))).length >= 1);
    assert.ok((await readdir(projectRoot)).includes("manifest.json"));

    const current = new DatabaseSync(currentPath, { readOnly: true });
    assert.equal(current.prepare("SELECT status FROM projects WHERE id = ?").get("cancelled-order")?.status, "cancelled");
    current.close();
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch((error) => {
      if (String((error as NodeJS.ErrnoException)?.code ?? "") !== "EBUSY") throw error;
    });
  }
});
