import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runLegacyInternalMigration } from "../internal/migration.js";

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("internal migration clones users and state into a fresh Node storage root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-internal-migration-"));
  try {
    const source = path.join(root, "legacy-internal");
    const target = path.join(root, "internal");
    await writeJson(path.join(source, "users", "manager@example.test.json"), {
      id: "manager",
      email: "manager@example.test",
      name: "Manager",
      role: "manager",
      permissions: { manage_queue: true },
      shift_schedule: {
        recurring: {
          monday: [{ start: "13:00", end: "21:00", role: "technician" }]
        },
        overrides: []
      }
    });
    await writeJson(path.join(source, "users", "customer@example.test.json"), {
      email: "customer@example.test",
      name: "Customer",
      account_type: "customer"
    });
    await writeJson(path.join(source, "coupons", "SAVE10.json"), {
      id: "SAVE10",
      code: "SAVE10",
      percent: 10,
      status: "active"
    });
    await writeJson(path.join(source, "portal_status", "current.json"), {
      id: "current",
      mode: "open",
      message: "Ready"
    });
    const before = await readFile(path.join(source, "coupons", "SAVE10.json"), "utf8");

    const dryRun = await runLegacyInternalMigration({ sourceRoot: source, targetRoot: target, mode: "dry-run" });
    assert.equal(dryRun.counts.legacy_records_read, 3);
    assert.equal(dryRun.counts.internal_records_written, 0);
    assert.equal(await readFile(path.join(source, "coupons", "SAVE10.json"), "utf8"), before);

    const fresh = await runLegacyInternalMigration({ sourceRoot: source, targetRoot: target, mode: "fresh", confirmFresh: true });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.validation?.failed, 0);

    const user = JSON.parse(await readFile(path.join(target, "users", "manager.json"), "utf8"));
    assert.equal(user.email, "manager@example.test");
    assert.equal(user.shift_schedule.recurring.monday[0].start, "13:00");
    const coupon = JSON.parse(await readFile(path.join(target, "state", "coupons", "save10.json"), "utf8"));
    assert.equal(coupon.data.code, "SAVE10");

    const validate = await runLegacyInternalMigration({ sourceRoot: source, targetRoot: target, mode: "validate" });
    assert.equal(validate.ok, true);
    assert.equal(validate.validation?.failed, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal migration understands the legacy measure/internal/storage layout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "firstmate-internal-storage-migration-"));
  try {
    const source = path.join(root, "measure", "internal");
    const target = path.join(root, "internal");
    await writeJson(path.join(source, "storage", "users", "admin@example.test.json"), {
      email: "admin@example.test",
      name: "Admin",
      account_type: "employee",
      role: "admin",
      permissions: { manage_payroll: true }
    });
    await writeJson(path.join(source, "storage", "config", "server_config.json"), {
      settings: {
        qa_fix_only_mode: true,
        auto_filler_enabled: false
      }
    });
    await writeJson(path.join(source, "storage", "coupons", "HASHED.json"), {
      code_hash: "HASHED",
      credits_total: 10
    });

    const fresh = await runLegacyInternalMigration({ sourceRoot: source, targetRoot: target, mode: "fresh", confirmFresh: true });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.validation?.failed, 0);
    assert.equal(fresh.counts.internal_records_written, 5);

    const user = JSON.parse(await readFile(path.join(target, "users", "admin-example-test.json"), "utf8"));
    assert.equal(user.role, "admin");
    const config = JSON.parse(await readFile(path.join(target, "state", "server_config", "qa_fix_only_mode.json"), "utf8"));
    assert.equal(config.data.value, true);
    const coupon = JSON.parse(await readFile(path.join(target, "state", "coupons", "hashed.json"), "utf8"));
    assert.equal(coupon.data.credits_total, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
