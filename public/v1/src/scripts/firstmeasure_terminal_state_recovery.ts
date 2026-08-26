import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../config/env.js";
import {
  findTerminalStateRecoveryCandidates,
  type ProjectIndexLifecycleSnapshot,
  type TerminalStateRecoveryCandidate
} from "../../firstmeasure/terminal_state_recovery.js";
import { normalizeFirstMeasureStatus } from "../../firstmeasure/project_lifecycle.js";
import { patchManifest, readManifest, type JsonObject, type ProjectManifest } from "../../firstmeasure/storage.js";
import { listDocuments, upsertDocument } from "../../platform/storage.js";

type CliOptions = {
  baselineIndex: string;
  currentIndex: string;
  output: string;
  apply: boolean;
  confirmCount: number | null;
  confirmServiceStopped: boolean;
  syncPlatform: boolean;
  baselineAbsentRequeueBeforeMs: number | null;
};

function parseArguments(argv: string[]): CliOptions {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? String(argv[index + 1] ?? "") : "";
  };
  const output = value("--output") || path.resolve(
    process.cwd(),
    `firstmeasure-terminal-state-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  const confirmText = value("--confirm-count");
  const baselineAbsentRequeueBeforeText = value("--include-baseline-absent-requeue-before");
  const parsedBaselineAbsentRequeueBefore = Date.parse(baselineAbsentRequeueBeforeText);
  return {
    baselineIndex: value("--baseline-index"),
    currentIndex: value("--current-index") || path.resolve(process.cwd(), env.firstmeasureIndexDbPath),
    output,
    apply: argv.includes("--apply"),
    confirmCount: confirmText && Number.isInteger(Number(confirmText)) ? Number(confirmText) : null,
    confirmServiceStopped: argv.includes("--confirm-service-stopped"),
    syncPlatform: !argv.includes("--skip-platform-sync"),
    baselineAbsentRequeueBeforeMs: Number.isFinite(parsedBaselineAbsentRequeueBefore)
      ? parsedBaselineAbsentRequeueBefore
      : null
  };
}

async function resolveSqlitePath(input: string, label: string) {
  if (!input) throw new Error(`${label} is required.`);
  const resolved = path.resolve(input);
  const info = await stat(resolved).catch(() => null);
  if (!info) throw new Error(`${label} does not exist: ${resolved}`);
  if (info.isFile()) return resolved;
  if (!info.isDirectory()) throw new Error(`${label} is not a SQLite file or directory: ${resolved}`);
  const names = await readdir(resolved);
  const exact = names.find((name) => name === "projects_index.sqlite");
  const fallback = names.find((name) => name.endsWith(".sqlite") && !name.endsWith("-shm") && !name.endsWith("-wal"));
  const selected = exact ?? fallback;
  if (!selected) throw new Error(`${label} directory contains no SQLite database: ${resolved}`);
  return path.join(resolved, selected);
}

function parseManifest(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  const parsed = JSON.parse(String(value || "{}"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
}

function readSnapshots(dbPath: string, statuses?: string[]) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const where = statuses?.length
      ? `WHERE lower(status) IN (${statuses.map(() => "?").join(",")})`
      : "";
    const rows = db.prepare(`
      SELECT id, status, manifest_json, address, organization_id, amount_charged,
        created_at, created_at_ms, updated_at
      FROM projects
      ${where}
    `).all(...(statuses ?? [])) as Array<Record<string, unknown>>;
    return rows.map((row): ProjectIndexLifecycleSnapshot => ({
      id: String(row.id ?? ""),
      status: String(row.status ?? ""),
      manifest: parseManifest(row.manifest_json),
      address: String(row.address ?? ""),
      organization_id: String(row.organization_id ?? ""),
      amount_charged: Number(row.amount_charged ?? 0),
      created_at: String(row.created_at ?? ""),
      created_at_ms: Number(row.created_at_ms ?? 0),
      updated_at: String(row.updated_at ?? "")
    }));
  } finally {
    db.close();
  }
}

function publicCandidate(candidate: TerminalStateRecoveryCandidate) {
  const { baseline_manifest: _baseline, current_manifest: _current, ...safe } = candidate;
  return safe;
}

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function copyDefined(source: JsonObject, keys: string[]) {
  const output: JsonObject = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) output[key] = source[key];
  }
  return output;
}

function recoveryPatch(candidate: TerminalStateRecoveryCandidate, current: ProjectManifest) {
  const source = candidate.baseline_manifest ?? candidate.current_manifest;
  const sourceTimestamps = record(source.timestamps);
  const currentWorkflow = record(current.workflow);
  const history = Array.isArray(currentWorkflow.history) ? currentWorkflow.history : [];
  const now = new Date().toISOString();
  const terminalKey = candidate.target_status === "cancelled" ? "cancelled_at" : "rejected_at";
  const terminalAt = String(source[terminalKey] ?? sourceTimestamps[terminalKey] ?? now);
  const terminalFields = candidate.target_status === "cancelled"
    ? [
        "cancelled_at", "cancelled_by_customer", "cancelled_by_email", "cancelled_by_name",
        "cancellation_refund_decision", "cancellation_refunded", "cancellation_refund_amount",
        "cancellation_refund_at", "cancellation_refund_by_email", "cancellation_refund_by_name", "cancellation"
      ]
    : [
        "rejected_at", "rejection_reason", "rejected_by_email", "rejected_by_name", "rejection",
        "customer_rejection_title", "customer_rejection_message", "instant_rejection_reason",
        "refund_issued", "refund_amount", "refund_reason", "refund_pending", "refund_at"
      ];
  return {
    ...copyDefined(source, terminalFields),
    status: candidate.target_status,
    [terminalKey]: terminalAt,
    timestamps: { [terminalKey]: terminalAt },
    workflow: {
      ...currentWorkflow,
      assigned_to: null,
      assigned_at: null,
      reserved_to: null,
      reserved_at: null,
      correction_to: null,
      qa_claim: null,
      history: [
        ...history,
        {
          ts: now,
          event: "terminal_state_recovered_after_index_rebuild",
          from_status: candidate.current_status,
          to_status: candidate.target_status,
          recovery_source: candidate.source
        }
      ]
    },
    migration_recovery: {
      applied_at: now,
      reason: "terminal_state_resurrected_by_json_index_rebuild",
      baseline_status: candidate.baseline_status || null,
      previous_status: candidate.current_status,
      evidence: candidate.evidence
    }
  } satisfies JsonObject;
}

function projectMeasurementIds(dataInput: unknown, metadataInput: unknown) {
  const data = record(dataInput);
  const metadata = record(metadataInput);
  const measurement = record(data.measurement_project ?? data.measurement);
  const raw = record(measurement.raw);
  const rawManifest = record(raw.manifest);
  const metadataKeys = Array.isArray(metadata.measurement_keys) ? metadata.measurement_keys : [];
  return new Set([
    data.measurement_project_id,
    data.folder,
    measurement.id,
    measurement.project_id,
    measurement.folder,
    raw.id,
    raw.project_id,
    raw.folder,
    rawManifest.id,
    ...metadataKeys
  ].map((value) => String(value ?? "").trim()).filter(Boolean));
}

async function syncPlatformProject(candidate: TerminalStateRecoveryCandidate, manifest: ProjectManifest) {
  const organizationRef = record(manifest.organization_ref);
  const orgId = String(manifest.organization_id ?? organizationRef.id ?? candidate.organization_id ?? "").trim();
  if (!orgId) return 0;
  const documents = await listDocuments(orgId, "projects").catch(() => []);
  let updated = 0;
  for (const document of documents) {
    if (!projectMeasurementIds(document.data, document.metadata).has(candidate.id)) continue;
    const data = record(document.data);
    const measurement = record(data.measurement_project ?? data.measurement);
    const raw = record(measurement.raw);
    const nextMeasurement = {
      ...measurement,
      status: candidate.target_status,
      raw: {
        ...raw,
        status: candidate.target_status,
        manifest: { ...record(raw.manifest), status: candidate.target_status }
      }
    };
    await upsertDocument(orgId, "projects", {
      id: document.id,
      data: {
        ...data,
        status: candidate.target_status,
        workflow_state: candidate.target_status === "cancelled" ? "measurement_cancelled" : "measurement_rejected",
        measurement: nextMeasurement,
        measurement_project: nextMeasurement,
        updated_at: new Date().toISOString()
      },
      metadata: { ...record(document.metadata), source: "terminal_state_recovery" }
    }, { replace: true });
    updated += 1;
  }
  return updated;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const baselinePath = await resolveSqlitePath(options.baselineIndex, "--baseline-index");
  const currentPath = await resolveSqlitePath(options.currentIndex, "--current-index");
  const baseline = readSnapshots(
    baselinePath,
    options.baselineAbsentRequeueBeforeMs
      ? undefined
      : ["cancelled", "rejected", "rejected_no_coverage"]
  );
  const current = readSnapshots(currentPath, [
    "queued", "ready", "processing", "in_progress", "requeue", "correction_needed",
    "awaiting_review", "awaiting_manager_review", "pending_rejection", "submission_failed"
  ]);
  const candidates = findTerminalStateRecoveryCandidates(baseline, current, Date.now(), {
    baselineAbsentRequeueBeforeMs: options.baselineAbsentRequeueBeforeMs
  });
  const report = {
    generated_at: new Date().toISOString(),
    baseline_index: baselinePath,
    current_index: currentPath,
    selection_rule: options.baselineAbsentRequeueBeforeMs
      ? "terminal in pre-rebuild SQLite index OR explicit cancellation/rejection evidence OR baseline-absent requeue created before the explicit cutoff; currently active"
      : "terminal in pre-rebuild SQLite index OR explicit cancellation/rejection evidence; currently active",
    baseline_absent_requeue_before: options.baselineAbsentRequeueBeforeMs
      ? new Date(options.baselineAbsentRequeueBeforeMs).toISOString()
      : null,
    age_used_as_selection: Boolean(options.baselineAbsentRequeueBeforeMs),
    payment_used_as_selection: false,
    candidate_count: candidates.length,
    older_than_48_hours: candidates.filter((candidate) => (candidate.age_hours ?? 0) >= 48).length,
    zero_charge_count: candidates.filter((candidate) => candidate.amount_charged <= 0).length,
    candidates: candidates.map(publicCandidate)
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, candidates: undefined, output: options.output }, null, 2));

  if (!options.apply) {
    console.log("AUDIT ONLY: no project or portal data was changed.");
    return;
  }
  if (!options.confirmServiceStopped) {
    throw new Error("Apply refused: stop firstmate-v1 and pass --confirm-service-stopped.");
  }
  if (options.confirmCount !== candidates.length) {
    throw new Error(`Apply refused: --confirm-count must exactly equal ${candidates.length}.`);
  }

  const currentManifests = new Map<string, ProjectManifest>();
  for (const candidate of candidates) {
    const manifest = await readManifest(candidate.id);
    if (normalizeFirstMeasureStatus(manifest.status) !== candidate.current_status) {
      throw new Error(`Apply refused: project ${candidate.id} changed after audit (${manifest.status}).`);
    }
    currentManifests.set(candidate.id, manifest);
  }

  let platformDocumentsUpdated = 0;
  for (const candidate of candidates) {
    const updated = await patchManifest(candidate.id, recoveryPatch(candidate, currentManifests.get(candidate.id)!));
    if (options.syncPlatform) platformDocumentsUpdated += await syncPlatformProject(candidate, updated);
  }
  console.log(JSON.stringify({
    applied: true,
    projects_recovered: candidates.length,
    platform_project_documents_updated: platformDocumentsUpdated,
    filesystem_project_directories_deleted: 0,
    report: options.output
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
