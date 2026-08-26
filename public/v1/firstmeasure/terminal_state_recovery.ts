import {
  FIRSTMEASURE_ACTIVE_QUEUE_STATUSES,
  normalizeFirstMeasureStatus,
  projectLifecycleEvidence,
  type ProjectLifecycleRecord
} from "./project_lifecycle.js";

export type ProjectIndexLifecycleSnapshot = {
  id: string;
  status: string;
  manifest: ProjectLifecycleRecord;
  address?: string;
  organization_id?: string;
  amount_charged?: number;
  created_at?: string;
  created_at_ms?: number;
  updated_at?: string;
};

export type TerminalStateRecoveryCandidate = {
  id: string;
  target_status: "cancelled" | "rejected" | "rejected_no_coverage";
  baseline_status: string;
  current_status: string;
  source: "baseline_terminal" | "embedded_terminal_evidence" | "baseline_absent_requeue_before_cutoff";
  address: string;
  organization_id: string;
  amount_charged: number;
  created_at: string;
  updated_at: string;
  age_hours: number | null;
  evidence: string[];
  baseline_manifest: ProjectLifecycleRecord | null;
  current_manifest: ProjectLifecycleRecord;
};

export type TerminalStateRecoveryOptions = {
  baselineAbsentRequeueBeforeMs?: number | null;
};

const RECOVERABLE_TERMINAL_STATUSES = new Set(["cancelled", "rejected", "rejected_no_coverage"]);

function recoveryTargetStatus(value: unknown): TerminalStateRecoveryCandidate["target_status"] | null {
  const status = normalizeFirstMeasureStatus(value);
  return RECOVERABLE_TERMINAL_STATUSES.has(status)
    ? status as TerminalStateRecoveryCandidate["target_status"]
    : null;
}

function snapshotDateMs(snapshot: ProjectIndexLifecycleSnapshot) {
  const numeric = Number(snapshot.created_at_ms ?? 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(snapshot.created_at ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasExplicitReorderAfterRejection(manifest: ProjectLifecycleRecord) {
  if (manifest.reordered_from_rejection === true || String(manifest.reordered_at ?? "").trim()) return true;
  const workflow = manifest.workflow && typeof manifest.workflow === "object" && !Array.isArray(manifest.workflow)
    ? manifest.workflow as ProjectLifecycleRecord
    : {};
  const histories = [manifest.work_history, workflow.history];
  return histories.some((history) => Array.isArray(history) && history.some((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return normalizeFirstMeasureStatus((entry as ProjectLifecycleRecord).event) === "reordered_rejected_project";
  }));
}

/**
 * Finds only active queue rows with a previous terminal state or explicit
 * terminal evidence. Old age and zero-dollar charges are report fields, not
 * selection criteria.
 */
export function findTerminalStateRecoveryCandidates(
  baselineRows: ProjectIndexLifecycleSnapshot[],
  currentRows: ProjectIndexLifecycleSnapshot[],
  nowMs = Date.now(),
  options: TerminalStateRecoveryOptions = {}
) {
  const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
  const candidates: TerminalStateRecoveryCandidate[] = [];

  for (const current of currentRows) {
    const currentStatus = normalizeFirstMeasureStatus(current.status);
    if (!FIRSTMEASURE_ACTIVE_QUEUE_STATUSES.has(currentStatus)) continue;

    const baseline = baselineById.get(current.id);
    const baselineTarget = recoveryTargetStatus(baseline?.status);
    const embedded = projectLifecycleEvidence(current.manifest);
    const embeddedTarget = recoveryTargetStatus(embedded.inferred_status);
    const createdMs = snapshotDateMs(current);
    const baselineAbsentRequeueCutoff = Number(options.baselineAbsentRequeueBeforeMs ?? 0);
    const baselineAbsentRequeue = !baseline
      && currentStatus === "requeue"
      && baselineAbsentRequeueCutoff > 0
      && createdMs > 0
      && createdMs < baselineAbsentRequeueCutoff
      && !hasExplicitReorderAfterRejection(current.manifest);
    const target = baselineTarget ?? embeddedTarget ?? (baselineAbsentRequeue ? "cancelled" : null);
    if (!target) continue;
    // A rejected project can be intentionally reordered into the same project
    // id. The reorder path leaves an explicit durable marker, so a baseline
    // terminal row must not undo a valid reorder performed after the backup.
    if (target !== "cancelled" && hasExplicitReorderAfterRejection(current.manifest)) continue;

    candidates.push({
      id: current.id,
      target_status: target,
      baseline_status: normalizeFirstMeasureStatus(baseline?.status),
      current_status: currentStatus,
      source: baselineTarget
        ? "baseline_terminal"
        : embeddedTarget
          ? "embedded_terminal_evidence"
          : "baseline_absent_requeue_before_cutoff",
      address: String(current.address ?? current.manifest.address ?? ""),
      organization_id: String(
        current.organization_id
        ?? current.manifest.organization_id
        ?? (current.manifest.organization_ref as ProjectLifecycleRecord | undefined)?.id
        ?? ""
      ),
      amount_charged: Number(current.amount_charged ?? current.manifest.amount_charged ?? 0) || 0,
      created_at: String(current.created_at ?? ""),
      updated_at: String(current.updated_at ?? ""),
      age_hours: createdMs > 0 ? Math.round(((nowMs - createdMs) / 3_600_000) * 10) / 10 : null,
      evidence: baselineTarget
        ? [`baseline_status:${baselineTarget}`, ...projectLifecycleEvidence(baseline?.manifest).reasons]
        : embeddedTarget
          ? embedded.reasons
          : [
              "absent_from_pre_rebuild_index",
              "current_status:requeue",
              `created_before:${new Date(baselineAbsentRequeueCutoff).toISOString()}`
            ],
      baseline_manifest: baseline?.manifest ?? null,
      current_manifest: current.manifest
    });
  }

  return candidates.sort((a, b) => (
    (b.age_hours ?? -1) - (a.age_hours ?? -1)
    || a.id.localeCompare(b.id)
  ));
}
