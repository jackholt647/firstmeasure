import assert from "node:assert/strict";
import test from "node:test";

import {
  enforceProjectLifecycleStatus,
  projectLifecycleEvidence
} from "../firstmeasure/project_lifecycle.js";
import { findTerminalStateRecoveryCandidates } from "../firstmeasure/terminal_state_recovery.js";

test("explicit customer cancellation evidence prevents an active status from being reindexed", () => {
  const manifest = {
    id: "cancelled-one",
    status: "queued",
    cancelled_by_customer: true,
    cancellation: {
      reason: "customer_cancelled_inside_grace_period",
      cancelled_at: "2026-08-12T10:00:00.000Z"
    },
    timestamps: { created_at: "2026-08-12T09:55:00.000Z" }
  };

  enforceProjectLifecycleStatus(manifest);

  assert.equal(manifest.status, "cancelled");
  assert.equal((manifest.timestamps as Record<string, unknown>).cancelled_at, "2026-08-12T10:00:00.000Z");
  assert.deepEqual(projectLifecycleEvidence(manifest).reasons.sort(), [
    "cancelled_at",
    "cancelled_by_customer",
    "customer_cancelled_inside_grace_period"
  ]);
});

test("age and a zero charge alone never mark a valid queued project terminal", () => {
  const manifest = {
    id: "legitimate-free-order",
    status: "queued",
    amount_charged: 0,
    timestamps: { created_at: "2025-01-01T00:00:00.000Z" }
  };

  enforceProjectLifecycleStatus(manifest);

  assert.equal(manifest.status, "queued");
  assert.equal(projectLifecycleEvidence(manifest).inferred_status, null);
});

test("a pre-rebuild terminal SQLite row precisely identifies a resurrected active row", () => {
  const now = Date.parse("2026-08-17T12:00:00.000Z");
  const baseline = [{
    id: "resurrected",
    status: "cancelled",
    manifest: {
      id: "resurrected",
      status: "cancelled",
      cancellation: { reason: "customer_cancelled_inside_grace_period" }
    }
  }];
  const current = [
    {
      id: "resurrected",
      status: "queued",
      manifest: { id: "resurrected", status: "queued", amount_charged: 0 },
      amount_charged: 0,
      created_at_ms: now - 72 * 3_600_000
    },
    {
      id: "old-but-valid",
      status: "queued",
      manifest: { id: "old-but-valid", status: "queued", amount_charged: 0 },
      amount_charged: 0,
      created_at_ms: now - 200 * 3_600_000
    }
  ];

  const candidates = findTerminalStateRecoveryCandidates(baseline, current, now);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "resurrected");
  assert.equal(candidates[0]?.target_status, "cancelled");
  assert.equal(candidates[0]?.source, "baseline_terminal");
  assert.equal(candidates[0]?.age_hours, 72);
});

test("embedded rejected_at evidence is recoverable when a baseline row is unavailable", () => {
  const candidates = findTerminalStateRecoveryCandidates([], [{
    id: "rejected-one",
    status: "ready",
    manifest: {
      id: "rejected-one",
      status: "ready",
      rejected_at: "2026-08-10T00:00:00.000Z",
      rejection_reason: "No coverage at this location"
    }
  }]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.target_status, "rejected_no_coverage");
  assert.equal(candidates[0]?.source, "embedded_terminal_evidence");
});

test("an existing terminal status is not rewritten from conflicting stale evidence", () => {
  const manifest = {
    id: "completed-one",
    status: "completed",
    cancelled_at: "2026-08-10T00:00:00.000Z"
  };

  enforceProjectLifecycleStatus(manifest);

  assert.equal(manifest.status, "completed");
});

test("a deliberate reorder performed after the baseline is not recovered as rejected", () => {
  const candidates = findTerminalStateRecoveryCandidates([{
    id: "reordered",
    status: "rejected_no_coverage",
    manifest: { id: "reordered", status: "rejected_no_coverage" }
  }], [{
    id: "reordered",
    status: "queued",
    manifest: {
      id: "reordered",
      status: "queued",
      reordered_from_rejection: true,
      reordered_at: "2026-08-17T07:00:00.000Z"
    }
  }]);

  assert.equal(candidates.length, 0);
});

test("an old requeue absent from the pre-rebuild index can be selected only with an explicit cutoff", () => {
  const now = Date.parse("2026-08-17T20:00:00.000Z");
  const cutoff = Date.parse("2026-08-15T07:36:55.000Z");
  const current = [{
    id: "reintroduced-requeue",
    status: "requeue",
    manifest: { id: "reintroduced-requeue", status: "requeue" },
    created_at_ms: Date.parse("2026-08-14T12:00:00.000Z"),
    amount_charged: 7
  }];

  assert.equal(findTerminalStateRecoveryCandidates([], current, now).length, 0);

  const candidates = findTerminalStateRecoveryCandidates([], current, now, {
    baselineAbsentRequeueBeforeMs: cutoff
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.id, "reintroduced-requeue");
  assert.equal(candidates[0]?.target_status, "cancelled");
  assert.equal(candidates[0]?.source, "baseline_absent_requeue_before_cutoff");
});

test("baseline-absent requeue recovery excludes new work and deliberate rejection reorders", () => {
  const now = Date.parse("2026-08-17T20:00:00.000Z");
  const cutoff = Date.parse("2026-08-15T07:36:55.000Z");
  const candidates = findTerminalStateRecoveryCandidates([], [
    {
      id: "new-requeue",
      status: "requeue",
      manifest: { id: "new-requeue", status: "requeue" },
      created_at_ms: Date.parse("2026-08-16T12:00:00.000Z")
    },
    {
      id: "legitimate-reorder",
      status: "requeue",
      manifest: {
        id: "legitimate-reorder",
        status: "requeue",
        reordered_from_rejection: true,
        reordered_at: "2026-08-14T13:00:00.000Z"
      },
      created_at_ms: Date.parse("2026-08-14T12:00:00.000Z")
    }
  ], now, { baselineAbsentRequeueBeforeMs: cutoff });

  assert.equal(candidates.length, 0);
});
