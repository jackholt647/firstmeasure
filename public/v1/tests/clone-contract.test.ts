import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ArtifactSyncLedger } from "../src/migration/artifact_sync_ledger.js";
import {
  PRODUCTION_CLONE_CONFIRMATION,
  assertCloneTargetContract,
  developmentCloneExclusions
} from "../src/migration/clone_contract.js";

test("clone target contract isolates data environments and protects production", () => {
  assert.doesNotThrow(() => assertCloneTargetContract({
    targetEnvironment: "development",
    configuredEnvironment: "development",
    configuredEnvironmentExplicit: true,
    spacesPrefix: "development/projects"
  }));
  assert.throws(() => assertCloneTargetContract({
    targetEnvironment: "development",
    configuredEnvironment: "production",
    configuredEnvironmentExplicit: true,
    spacesPrefix: "development"
  }), /does not match/);
  assert.throws(() => assertCloneTargetContract({
    targetEnvironment: "development",
    configuredEnvironment: "development",
    configuredEnvironmentExplicit: true,
    spacesPrefix: "production"
  }), /SPACES_PREFIX/);
  assert.throws(() => assertCloneTargetContract({
    targetEnvironment: "production",
    configuredEnvironment: "production",
    configuredEnvironmentExplicit: true,
    spacesPrefix: "production"
  }), /Production clone writes require/);
  assert.doesNotThrow(() => assertCloneTargetContract({
    targetEnvironment: "production",
    configuredEnvironment: "production",
    configuredEnvironmentExplicit: true,
    spacesPrefix: "production",
    productionConfirmation: PRODUCTION_CLONE_CONFIRMATION
  }));
});

test("development clone policy excludes live credentials, sessions, and communications", () => {
  assert.deepEqual(developmentCloneExclusions(), {
    sessions: true,
    apiKeySecrets: true,
    apiKeyDeliveries: true,
    communications: true,
    appleProviderState: true
  });
});

test("artifact synchronization ledger persists verified fingerprints", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "firstmeasure-clone-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "ledger.sqlite");
  const ledger = new ArtifactSyncLedger(filePath, "development");
  ledger.startRun("run-1", "snapshot-1", "/snapshot/storage");
  ledger.save({
    object_key: "development/projects/project-1/report.pdf",
    source_size: 123,
    source_mtime_ms: 456,
    source_sha256: "a".repeat(64),
    remote_size: 123,
    remote_etag: "etag",
    status: "verified",
    last_seen_run: "run-1",
    verified_at: "2026-08-26T00:00:00.000Z"
  });
  ledger.finishRun("run-1", "complete", {
    discovered: 1,
    uploaded: 1,
    skipped: 0,
    verified: 1,
    failed: 0,
    orphaned: 0,
    sourceBytes: 123,
    uploadedBytes: 123
  });
  ledger.close();

  const reopened = new ArtifactSyncLedger(filePath, "development");
  assert.equal(reopened.get("development/projects/project-1/report.pdf")?.source_sha256, "a".repeat(64));
  assert.equal(reopened.get("development/projects/missing.pdf"), null);
  reopened.close();
});
