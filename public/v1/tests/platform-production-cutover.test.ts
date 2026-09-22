import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeLegacyFixture(root: string) {
  const source = path.join(root, "legacy");
  const target = path.join(root, "platform");
  const backupRoot = path.join(root, "backups");
  const orgId = "prodcutoverfixture0000001";

  await writeJson(path.join(source, "organizations", orgId, "manifest.json"), {
    id: orgId,
    name: "Production Cutover Fixture",
    credits_balance: 30,
    credits_ledger: [{ ts: "2026-05-30T00:00:00+00:00", delta: 30, reason: "seed" }]
  });
  await writeJson(path.join(source, "users", "owner-prod-cutover@example.test.json"), {
    id: "owner_prod_cutover",
    email: "owner-prod-cutover@example.test",
    password_hash: "$2y$12$abcdefghijklmnopqrstuuDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    name: "Owner Production Cutover",
    organization_id: orgId,
    org_permissions: { level: "super_admin", items: {} },
    account_type: "customer",
    is_verified: true
  });
  await writeJson(path.join(target, "sentinel.json"), { previous: true });
  return { source, target, backupRoot, orgId };
}

test("production cutover backs up existing target and fresh-migrates with validation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-prod-cutover-"));
  try {
    const { source, target, backupRoot, orgId } = await makeLegacyFixture(root);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--experimental-sqlite",
        "--import",
        "tsx",
        "src/scripts/platform_production_cutover.ts",
        "--source",
        source,
        "--target",
        target,
        "--backup-root",
        backupRoot,
        "--confirm-production",
        "--json"
      ],
      {
        cwd: process.cwd(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 4
      }
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.preflight.ok, true);
    assert.equal(report.migration.ok, true);
    assert.equal(report.migration.validation.failed, 0);
    assert.equal(typeof report.backupPath, "string");

    const backedUpSentinel = JSON.parse(await readFile(path.join(report.backupPath, "sentinel.json"), "utf8"));
    assert.equal(backedUpSentinel.previous, true);

    const migratedOrg = JSON.parse(await readFile(path.join(target, "organizations", orgId, "manifest.json"), "utf8"));
    assert.equal(migratedOrg.name, "Production Cutover Fixture");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
