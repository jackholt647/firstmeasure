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
  const orgId = "cutoverfixtureorg00000001";

  await writeJson(path.join(source, "organizations", orgId, "manifest.json"), {
    id: orgId,
    name: "Cutover Fixture Roofing",
    created_at: "2026-05-01T00:00:00+00:00",
    credits_balance: 12,
    credits_ledger: [{ ts: "2026-05-01T00:00:00+00:00", delta: 12, reason: "fixture_seed" }],
    report_settings: { general: { nfva_ratio: 325 } },
    billing: { auto_topup: { enabled: false }, stripe: { has_payment_method: false } },
    contact: { email: "office-cutover@example.test", phone: "555-0199", address: "99 Cutover Lane" }
  });

  await writeJson(path.join(source, "users", "owner-cutover@example.test.json"), {
    id: "owner_cutover",
    email: "owner-cutover@example.test",
    password_hash: "$2y$12$abcdefghijklmnopqrstuuCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    name: "Owner Cutover",
    company: "Cutover Fixture Roofing",
    organization_id: orgId,
    org_permissions: { level: "super_admin", items: {} },
    is_verified: true,
    account_type: "customer",
    team_id: "default"
  });

  return { source, target, orgId };
}

test("cutover simulation fresh-migrates, validates storage, and runs API smoke checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-cutover-"));
  try {
    const { source, target, orgId } = await makeLegacyFixture(root);
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--experimental-sqlite",
        "--import",
        "tsx",
        "src/scripts/platform_cutover_simulation.ts",
        "--source",
        source,
        "--target",
        target,
        "--confirm-fresh",
        "--json"
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CRM_STORAGE_ROOT: path.join(root, "crm"),
          FIRSTMEASURE_STORAGE_ROOT: path.join(root, "firstmeasure"),
          FIRSTMEASURE_INDEX_DB_PATH: path.join(root, "firstmeasure", "projects_index.sqlite")
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024 * 4
      }
    );
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.migration.ok, true);
    assert.equal(report.migration.validation.failed, 0);
    assert.equal(report.storage.organizations, 1);
    assert.equal(report.storage.identities, 1);
    assert.equal(report.storage.org_users, 1);
    assert.equal(report.smoke.skipped, false);
    assert.ok(report.smoke.checks.length >= 8);
    assert.equal(report.smoke.checks.every((check: { ok: boolean }) => check.ok), true);

    const migratedOrg = JSON.parse(await readFile(path.join(target, "organizations", orgId, "manifest.json"), "utf8"));
    assert.equal(migratedOrg.name, "Cutover Fixture Roofing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
