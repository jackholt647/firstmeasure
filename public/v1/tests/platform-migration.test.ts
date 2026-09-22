import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runLegacyPlatformMigration } from "../platform/legacy_migration.js";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeLegacyFixture(root: string) {
  const source = path.join(root, "legacy");
  const target = path.join(root, "platform");
  const orgId = "0123456789abcdef01234567";
  const customerEmail = "owner@example.test";
  const employeeEmail = "tech@example.test";

  await writeJson(path.join(source, "organizations", orgId, "manifest.json"), {
    id: orgId,
    name: "Legacy Roofing",
    created_at: "2026-01-02T03:04:05+00:00",
    created_by_user_id: "abc123",
    created_by_email: customerEmail,
    users: ["abc123"],
    users_meta: {
      abc123: { email: customerEmail, name: "Owner User" }
    },
    credits_balance: 47,
    credits_ledger: [
      { ts: "2026-01-03T00:00:00+00:00", delta: 50, reason: "purchase" },
      { ts: "2026-01-04T00:00:00+00:00", delta: -3, reason: "order_submitted" }
    ],
    branding: { logo: "organizations/0123456789abcdef01234567/logo.png", colors: { primary: "#DB0000" } },
    billing: { auto_topup: { enabled: false } },
    report_settings: { general: { nfva_ratio: 300 }, customer: { page_3d: true } },
    contact: { email: "office@example.test", phone: "555", address: "1 Main" }
  });

  await writeJson(path.join(source, "users", "owner@example.test.json"), {
    id: "abc123",
    email: customerEmail,
    password_hash: "$2y$12$abcdefghijklmnopqrstuuAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    name: "Owner User",
    phone: "555-0001",
    company: "Legacy Roofing",
    organization_id: orgId,
    org_permissions: { level: "super_admin", items: {} },
    is_verified: true,
    role: "user",
    account_type: "customer",
    team_id: "default",
    projects: ["p1", "p2"],
    credits_balance: 5,
    credits_ledger: [{ ts: "2026-01-05T00:00:00+00:00", delta: 5 }]
  });

  await writeJson(path.join(source, "users", "tech@example.test.json"), {
    id: "tech123",
    email: employeeEmail,
    password_hash: "$2y$12$abcdefghijklmnopqrstuuBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    name: "Tech User",
    is_verified: true,
    role: "technician",
    account_type: "employee",
    permissions: { manage_queue: true },
    team_id: "production",
    queue_mode: "qa",
    shift_schedule: { recurring: {}, overrides: {} }
  });

  return { source, target, orgId, customerEmail, employeeEmail };
}

test("legacy migration dry-run is read-only and fresh rebuild writes validateable Platform storage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-migration-"));
  try {
    const { source, target, orgId, customerEmail, employeeEmail } = await makeLegacyFixture(root);
    const legacyUserBefore = await readFile(path.join(source, "users", "owner@example.test.json"), "utf8");

    const dryRun = await runLegacyPlatformMigration({ sourceRoot: source, targetRoot: target, mode: "dry-run" });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.counts.legacy_users_read, 2);
    assert.equal(dryRun.counts.platform_orgs_expected, 2);
    assert.equal(await readFile(path.join(source, "users", "owner@example.test.json"), "utf8"), legacyUserBefore);

    const fresh = await runLegacyPlatformMigration({ sourceRoot: source, targetRoot: target, mode: "fresh", confirmFresh: true });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.validation?.failed, 0);

    const org = JSON.parse(await readFile(path.join(target, "organizations", orgId, "manifest.json"), "utf8"));
    assert.equal(org.name, "Legacy Roofing");

    const global = JSON.parse(await readFile(path.join(target, "organizations", orgId, "global.json"), "utf8"));
    assert.equal(global.data.credits_balance, 47);
    assert.equal(global.data.credits_ledger.length, 2);

    const customer = JSON.parse(await readFile(path.join(target, "organizations", orgId, "users", "abc123.json"), "utf8"));
    assert.equal(customer.data.email, customerEmail);
    assert.equal(customer.data.role, "owner");
    assert.deepEqual(customer.data.permissions, { "*": true });
    assert.equal(customer.data.metadata.legacy_snapshot.password_hash, undefined);

    const employee = JSON.parse(await readFile(path.join(target, "organizations", "legacy_internal", "users", "tech123.json"), "utf8"));
    assert.equal(employee.data.email, employeeEmail);
    assert.equal(employee.data.role, "technician");
    assert.deepEqual(employee.data.permissions, { manage_queue: true });

    const validate = await runLegacyPlatformMigration({ sourceRoot: source, targetRoot: target, mode: "validate" });
    assert.equal(validate.ok, true);
    assert.equal(validate.validation?.failed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
