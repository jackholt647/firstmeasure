import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  buildIndexedProjectDocument,
  indexedQueueGroup,
  indexedQueuePriority
} from "../firstmeasure/project_index.js";
import { queueEnteredAtMs } from "../firstmeasure/queue.js";
import { qaQueueEnteredAtMs } from "../firstmeasure/api.js";
import type { ProjectManifest } from "../firstmeasure/storage.js";

function document(overrides: Record<string, unknown> = {}) {
  const manifest = {
    id: "indexed-queue-test",
    schema_version: 2,
    status: "queued",
    address: "1 Fast Queue Way",
    workflow: {},
    timestamps: {
      created_at: "2026-08-17T00:00:00.000Z",
      queued_at: "2026-08-17T00:01:00.000Z",
      updated_at: "2026-08-17T00:02:00.000Z"
    },
    ...overrides
  } as unknown as ProjectManifest;
  return buildIndexedProjectDocument(manifest, {
    currentThumbnailArtifactName: "",
    fileNames: ["manifest.json", "azure.png"],
    artifactFileName: ""
  });
}

test("queue routing and priority are materialized during project indexing", () => {
  const queued = document({ report_expedite_option: "rush_under_1" });
  assert.equal(queued.queue_group, "queued");
  assert.equal(queued.queue_priority, 1);
  assert.equal(queued.queue_order_ms, Date.parse("2026-08-17T00:00:00.000Z"));

  const requeued = document({
    timestamps: {
      created_at: "2026-08-01T00:00:00.000Z",
      queued_at: "2026-08-17T00:01:00.000Z",
      updated_at: "2026-08-17T00:02:00.000Z"
    }
  });
  assert.equal(requeued.queue_order_ms, Date.parse("2026-08-01T00:00:00.000Z"));

  const resubmittedToQa = document({
    status: "awaiting_review",
    timestamps: {
      created_at: "2026-08-02T00:00:00.000Z",
      queued_at: "2026-08-02T00:01:00.000Z",
      uploaded_at: "2026-08-17T00:03:00.000Z",
      updated_at: "2026-08-17T00:03:00.000Z"
    }
  });
  assert.equal(resubmittedToQa.queue_group, "qa_waiting");
  assert.equal(resubmittedToQa.queue_order_ms, Date.parse("2026-08-02T00:00:00.000Z"));

  const assigned = document({
    workflow: { assigned_to: { email: "tech@example.test" } }
  });
  assert.equal(assigned.queue_group, "in_progress");

  const holding = document({ status: "completed", delivery_hold_status: "holding" });
  assert.equal(holding.queue_group, "release_holding");

  const priorityHolding = document({
    status: "completed",
    delivery_hold_status: "holding",
    qa_priority: true
  });
  assert.equal(priorityHolding.queue_group, "completed");

  const kicked = document({ force_kick: { email: "Tech@Example.Test", acknowledged: false } });
  assert.equal(kicked.force_kick_email, "tech@example.test");
  assert.equal(kicked.force_kick_acknowledged, 0);
});

test("queue helper aliases remain consistent with indexed documents", () => {
  const manifest = {
    id: "helper-test",
    status: "awaiting_review",
    workflow: { qa_claim: { email: "qa@example.test" } },
    report_expedite_option: "rush_1_3"
  } as unknown as ProjectManifest;
  assert.equal(indexedQueuePriority(manifest), 2);
  assert.equal(indexedQueueGroup(manifest, {
    status: "awaiting_review",
    assignedToEmail: "",
    qaClaimedByEmail: "qa@example.test"
  }), "qa_claimed");
});

test("chronological queue ranking keeps the original customer order time", () => {
  const createdAt = Date.parse("2026-01-01T00:00:00.000Z");
  const requeuedAt = Date.parse("2026-08-17T00:00:00.000Z");

  assert.equal(queueEnteredAtMs({
    created_at_ms: createdAt,
    queued_at_ms: requeuedAt,
    updated_at_ms: requeuedAt
  }), createdAt);

  assert.equal(qaQueueEnteredAtMs({
    created_at: "2026-01-01T00:00:00.000Z",
    queued_at: "2026-08-16T00:00:00.000Z",
    uploaded_at: "2026-08-17T00:00:00.000Z"
  }), createdAt);
});

test("PostgreSQL hot queue paths do not search JSON documents", async () => {
  const indexSource = await readFile(path.resolve("firstmeasure/project_index_postgres.ts"), "utf8");
  const queueSource = await readFile(path.resolve("firstmeasure/queue_postgres.ts"), "utf8");
  const serverSource = await readFile(path.resolve("src/server.ts"), "utf8");
  const clusterWorkerSlotsSource = await readFile(path.resolve("src/cluster_worker_slots.ts"), "utf8");

  assert.doesNotMatch(indexSource, /manifest_json::text/);
  assert.doesNotMatch(indexSource, /position\([^\n]+manifest_json/);
  assert.doesNotMatch(queueSource, /manifest_json\s*(?:#>>|->>)/);
  assert.match(indexSource, /project_queue_counters/);
  assert.match(indexSource, /p\.queue_group = \$1/);
  assert.match(queueSource, /queue_priority/);
  assert.match(queueSource, /FOR UPDATE SKIP LOCKED/);
  assert.doesNotMatch(queueSource, /COUNT\(\*\)\s+FILTER/);
  assert.match(indexSource, /idx_projects_reserved_claim_queue/);
  assert.match(indexSource, /idx_projects_unreserved_claim_queue/);
  assert.match(indexSource, /projectImportSourceCheckpoint/);
  assert.match(indexSource, /pg_try_advisory_lock/);
  assert.match(indexSource, /const canLeadMigration = !clusterWorkerId \|\| clusterWorkerId === "1"/);
  assert.match(indexSource, /canLeadMigration && await initializePostgresAsLeader\(\)/);
  assert.match(indexSource, /Existing databases created by an older build must derive/);
  assert.match(indexSource, /indexed_schema_version: SCHEMA_VERSION/);
  assert.match(indexSource, /migrateDerivedQueueColumns\(client, importedWithCurrentSchema\)/);
  assert.match(queueSource, /input\.allow_reserved !== false/);
  assert.match(queueSource, /else where\.push\("reserved_to_email = ''"\)/);
  assert.match(serverSource, /takeClusterWorkerSlot\(workerSlots, worker\.id\)/);
  assert.match(clusterWorkerSlotsSource, /workerSlots\.get\(workerId\)/);
  assert.match(serverSource, /forkSlot\(slot\)/);
});
