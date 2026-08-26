export type ProjectLifecycleRecord = Record<string, unknown>;

export const FIRSTMEASURE_TERMINAL_STATUSES = new Set([
  "completed",
  "rejected",
  "rejected_no_coverage",
  "cancelled"
]);

export const FIRSTMEASURE_ACTIVE_QUEUE_STATUSES = new Set([
  "queued",
  "ready",
  "processing",
  "in_progress",
  "requeue",
  "correction_needed",
  "awaiting_review",
  "awaiting_manager_review",
  "pending_rejection",
  "submission_failed"
]);

function asRecord(value: unknown): ProjectLifecycleRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ProjectLifecycleRecord
    : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeFirstMeasureStatus(value: unknown) {
  return cleanText(value).toLowerCase().replace(/-/g, "_");
}

function lifecycleEvents(manifest: ProjectLifecycleRecord) {
  const workflow = asRecord(manifest.workflow);
  const values = [
    manifest.work_history,
    manifest.history,
    workflow.history,
    workflow.work_history
  ];
  return values.flatMap((value) => Array.isArray(value) ? value : [])
    .map((value) => asRecord(value));
}

function firstTimestamp(...values: unknown[]) {
  return values.map(cleanText).find(Boolean) ?? "";
}

function rejectionLooksLikeNoCoverage(manifest: ProjectLifecycleRecord) {
  const values = [
    manifest.instant_rejection_reason,
    manifest.rejection_reason,
    manifest.customer_rejection_title,
    manifest.customer_rejection_message,
    asRecord(manifest.rejection).reason
  ].map((value) => cleanText(value).toLowerCase()).filter(Boolean);
  return values.some((value) => (
    value.includes("no coverage")
    || value.includes("no_coverage")
    || value.includes("coverage unavailable")
  ));
}

export type ProjectLifecycleEvidence = {
  inferred_status: "cancelled" | "rejected" | "rejected_no_coverage" | null;
  terminal_at: string;
  reasons: string[];
};

/**
 * Recovers terminal lifecycle state only from durable, explicit evidence.
 * Age, price, and missing payment are intentionally not evidence because they
 * also describe valid queued projects and test orders.
 */
export function projectLifecycleEvidence(manifestInput: unknown): ProjectLifecycleEvidence {
  const manifest = asRecord(manifestInput);
  const timestamps = asRecord(manifest.timestamps);
  const cancellation = asRecord(manifest.cancellation);
  const events = lifecycleEvents(manifest);
  const eventNames = new Set(events.map((event) => normalizeFirstMeasureStatus(event.event ?? event.type)));

  const cancelledAt = firstTimestamp(
    manifest.cancelled_at,
    timestamps.cancelled_at,
    cancellation.cancelled_at,
    cancellation.refund_at,
    manifest.cancellation_refund_at
  );
  const cancellationReasons: string[] = [];
  if (manifest.cancelled_by_customer === true || cancellation.cancelled_by_customer === true) {
    cancellationReasons.push("cancelled_by_customer");
  }
  if (cancelledAt) cancellationReasons.push("cancelled_at");
  if (cleanText(cancellation.reason) === "customer_cancelled_inside_grace_period") {
    cancellationReasons.push("customer_cancelled_inside_grace_period");
  }
  if (cleanText(manifest.cancellation_refund_decision)) cancellationReasons.push("cancellation_refund_decision");
  if (eventNames.has("customer_cancelled_order")) cancellationReasons.push("customer_cancelled_order_event");
  if (eventNames.has("cancelled_project")) cancellationReasons.push("cancelled_project_event");
  if (cancellationReasons.length) {
    return { inferred_status: "cancelled", terminal_at: cancelledAt, reasons: cancellationReasons };
  }

  const rejectedAt = firstTimestamp(manifest.rejected_at, timestamps.rejected_at, asRecord(manifest.rejection).rejected_at);
  const rejectionReasons: string[] = [];
  if (rejectedAt) rejectionReasons.push("rejected_at");
  if (eventNames.has("rejected_project")) rejectionReasons.push("rejected_project_event");
  if (eventNames.has("rejected_no_coverage")) rejectionReasons.push("rejected_no_coverage_event");
  if (rejectionReasons.length) {
    const noCoverage = rejectionLooksLikeNoCoverage(manifest) || eventNames.has("rejected_no_coverage");
    return {
      inferred_status: noCoverage ? "rejected_no_coverage" : "rejected",
      terminal_at: rejectedAt,
      reasons: rejectionReasons
    };
  }

  return { inferred_status: null, terminal_at: "", reasons: [] };
}

/**
 * Makes explicit cancellation/rejection evidence win over an active status.
 * Existing terminal statuses are never changed.
 */
export function enforceProjectLifecycleStatus(manifest: ProjectLifecycleRecord) {
  const status = normalizeFirstMeasureStatus(manifest.status);
  if (FIRSTMEASURE_TERMINAL_STATUSES.has(status) || !FIRSTMEASURE_ACTIVE_QUEUE_STATUSES.has(status)) return manifest;
  const evidence = projectLifecycleEvidence(manifest);
  if (!evidence.inferred_status) return manifest;

  manifest["status"] = evidence.inferred_status;
  const timestamps = { ...asRecord(manifest.timestamps) };
  const terminalKey = evidence.inferred_status === "cancelled" ? "cancelled_at" : "rejected_at";
  if (!cleanText(timestamps[terminalKey]) && evidence.terminal_at) timestamps[terminalKey] = evidence.terminal_at;
  manifest["timestamps"] = timestamps;
  return manifest;
}
