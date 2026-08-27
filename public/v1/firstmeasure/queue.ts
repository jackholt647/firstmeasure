import type { SQLInputValue } from "node:sqlite";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { badRequest, conflict, notFound } from "./errors.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import {
  ensureFirstMeasureProjectIndexReady,
  getFirstMeasureProjectIndexDb,
  queryIndexedProjectManifests
} from "./project_index.js";
import {
  projectDir,
  readManifest,
  saveManifest,
  type ProjectManifest
} from "./storage.js";
import { buildReportExpediteOptions, isExpeditedReportExpediteKey, reportExpeditePriorityLevel } from "./expedite.js";
import { listInternalUsers, readInternalUser } from "../internal/storage.js";

type ActorRef = {
  id?: string;
  email?: string;
  name?: string;
  drafter_rank?: string;
  p1_eligible?: boolean;
  p2_eligible?: boolean;
  team_id?: string;
};

type QueueMode = "all" | "new_only" | "corrections_only" | "wait_for_feedback";

type QueueClaimInput = {
  actor: ActorRef;
  queue_mode?: QueueMode;
  allow_reserved?: boolean;
  allow_filler?: boolean;
  preferred_complexity?: Array<number | string>;
  team_id?: string;
};

type QueueStatusInput = {
  actor: ActorRef;
  queue_mode?: QueueMode;
};

type QueueReserveInput = {
  reserved_for: ActorRef;
  actor?: ActorRef;
  notes?: string | null;
};

type QueueReleaseInput = {
  actor?: ActorRef;
  notes?: string | null;
};

const NEW_QUEUE_STATUSES = new Set(["queued", "ready"]);
const CORRECTION_QUEUE_STATUSES = new Set(["correction_needed"]);
const ACTIVE_ASSIGNMENT_STATUSES = new Set(["processing", "in_progress", "correction_needed", "awaiting_review"]);
const WAIT_FOR_FEEDBACK_BLOCKING_STATUSES = new Set(["awaiting_review", "correction_needed", "awaiting_manager_review"]);
const QUEUE_OVERVIEW_DEFAULT_LIMIT = 500;
const QUEUE_OVERVIEW_MAX_LIMIT = 5000;
const QUEUE_OVERVIEW_ACTIVE_STATUSES = [
  "queued",
  "ready",
  "no_heightmap",
  "no_coverage_candidate",
  "coverage_failed",
  "needs_coverage_review",
  "coverage_review",
  "coverage_hold",
  "requeue",
  "correction_needed",
  "processing",
  "in_progress",
  "awaiting_review",
  "awaiting_manager_review",
  "pending_rejection"
];
const DEFAULT_QUEUE_PRIORITY_WINDOW_MINUTES = 15;
const TECHNICIAN_RECENT_ACTIVITY_WINDOW_MS = 2 * 60_000;
const ONLINE_TIMESTAMP_CLOCK_SKEW_MS = 60_000;
const DEFAULT_QUEUE_LEVEL_PRIORITY: Record<TechnicianRank, number[]> = {
  junior: [1, 2, 3, 4, 5],
  standard: [3, 4, 2, 1, 5],
  senior: [5, 4, 3, 2, 1]
};
const API_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_ROOT_CANDIDATES = [
  path.resolve(process.cwd(), "../measure/internal"),
  path.resolve(process.cwd(), "./measure/internal"),
  path.resolve(API_MODULE_DIR, "../../measure/internal"),
  path.resolve(API_MODULE_DIR, "../../../measure/internal")
];
const INTERNAL_ROOT_DIR = INTERNAL_ROOT_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? path.resolve(process.cwd(), "../measure/internal");
const SERVER_CONFIG_PATH = path.join(INTERNAL_ROOT_DIR, "storage", "config", "server_config.json");

type TechnicianRank = "junior" | "standard" | "senior";
type QueuePriorityLevel = 1 | 2 | 3;

type ProductionQueuePrioritySettings = {
  windowMinutes: number;
  priorities: Record<TechnicianRank, number[]>;
};

type QueueCandidateRow = {
  id?: string;
  complexity?: string;
  is_vip?: number;
  is_expedited?: number;
  created_at_ms?: number;
  queued_at_ms?: number;
  updated_at_ms?: number;
};

type QueueRankedCandidateRow = QueueCandidateRow & {
  manifest: ProjectManifest;
  _queuePriorityLevel: QueuePriorityLevel;
  _enteredAtMs: number;
  _level: number;
};

export async function getQueueStatus(input: QueueStatusInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).getPostgresQueueStatus(input);
  const actor = normalizeActor(input.actor);
  const mode = input.queue_mode ?? "all";
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const actorEmailValue = actor.email ?? "";
  const counts = {
    assigned: readQueueCount(db, `
      assigned_to_email = $actorEmail
      AND status IN (${sqlStringList(Array.from(ACTIVE_ASSIGNMENT_STATUSES))})
    `, { actorEmail: actorEmailValue }),
    corrections: readQueueCount(db, `
      status = 'correction_needed'
      AND assigned_to_email = ''
      AND (correction_to_email = '' OR correction_to_email = $actorEmail)
    `, { actorEmail: actorEmailValue }),
    reserved: readQueueCount(db, `
      status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
      AND assigned_to_email = ''
      AND reserved_to_email = $actorEmail
      AND thumbnail_artifact_name != ''
    `, { actorEmail: actorEmailValue }),
    available_new: readQueueCount(db, `
      status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
      AND assigned_to_email = ''
      AND (reserved_to_email = '' OR reserved_to_email = $actorEmail)
      AND thumbnail_artifact_name != ''
    `, { actorEmail: actorEmailValue })
  };

  const blockingAssignments = readQueueCount(db, `
    assigned_to_email = $actorEmail
    AND status IN (${sqlStringList(Array.from(WAIT_FOR_FEEDBACK_BLOCKING_STATUSES))})
  `, { actorEmail: actorEmailValue });

  const activeProjectRow = db.prepare(`
    SELECT id, status, address
    FROM projects
    WHERE assigned_to_email = $actorEmail
      AND status IN (${sqlStringList(Array.from(ACTIVE_ASSIGNMENT_STATUSES))})
    ORDER BY updated_at_ms DESC, id DESC
    LIMIT 1
  `).get({
    actorEmail: actorEmailValue
  }) as { id?: string; status?: string; address?: string } | undefined;

  const queueBlocked = mode === "wait_for_feedback" && blockingAssignments > 0;
  const queueBlockedReason = queueBlocked ? "active_assignment" : null;

  return {
    actor,
    queue_mode: mode,
    queue_blocked: queueBlocked,
    queue_blocked_reason: queueBlockedReason,
    queue_count: counts.reserved + counts.available_new,
    queue_breakdown: counts,
    active_project: activeProjectRow?.id
      ? {
          id: activeProjectRow.id,
          status: String(activeProjectRow.status ?? ""),
          address: String(activeProjectRow.address ?? "")
        }
      : null
  };
}

export async function getClaimableQueueStatus(input: QueueClaimInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).getPostgresClaimableQueueStatus(input);
  const actor = normalizeActor(input.actor);
  const status = await getQueueStatus({
    actor,
    queue_mode: input.queue_mode
  });
  if (status.queue_blocked) {
    return {
      ...status,
      claimable_count: 0,
      claimable_next_id: null,
      claimable_source: null
    };
  }

  const allowReserved = input.allow_reserved !== false;
  const allowFiller = input.allow_filler === true;
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const actorEmailValue = actor.email ?? "";
  const eligibility = await resolveTechnicianPriorityEligibility(actor);
  const rank = eligibility.rank;
  const seniorAvailable = rank === "standard" && eligibility.p1Eligible === undefined
    ? await hasAvailableSeniorTechnicianSqlite(db, input.team_id ?? actor.team_id)
    : false;
  const reservedRows = db.prepare(`
    SELECT id
    FROM projects
    WHERE status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
      AND assigned_to_email = ''
      AND reserved_to_email = $actorEmail
      AND thumbnail_artifact_name != ''
      ${allowFiller ? "" : "AND is_filler = 0"}
    ORDER BY CASE WHEN is_vip != 0 OR is_expedited != 0 THEN 1 ELSE 0 END DESC, created_at_ms ASC, id ASC
    LIMIT 50
  `).all({
    actorEmail: actorEmailValue
  }) as Array<{ id?: string }>;

  let source: "reserved" | "queue" = "reserved";
  let manifest = await firstClaimableManifestFromRows(reservedRows, actor, {
    allowFiller,
    allowReservedForOthers: false,
    requireReservedForActor: true,
    technicianRank: rank,
    seniorAvailable,
    p1Eligible: eligibility.p1Eligible,
    p2Eligible: eligibility.p2Eligible
  });

  if (!manifest) {
    const availableRows = db.prepare(`
      SELECT id, complexity, is_vip, is_expedited, created_at_ms, queued_at_ms, updated_at_ms
      FROM projects
      WHERE status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
        AND assigned_to_email = ''
        AND thumbnail_artifact_name != ''
        ${allowFiller ? "" : "AND is_filler = 0"}
        ${allowReserved ? "AND (reserved_to_email = '' OR reserved_to_email = $actorEmail)" : "AND reserved_to_email = ''"}
      ORDER BY CASE WHEN is_vip != 0 OR is_expedited != 0 THEN 1 ELSE 0 END DESC,
        queued_at_ms ASC, created_at_ms ASC, id ASC
    `).all({
      actorEmail: actorEmailValue
    }) as QueueCandidateRow[];

    const prioritySettings = await readProductionQueuePrioritySettings();
    const rankedRows = await rankProductionQueueRows(availableRows, {
      rank,
      settings: prioritySettings,
      preferredComplexities: input.preferred_complexity ?? [],
      p1Eligible: eligibility.p1Eligible
    });

    manifest = await firstClaimableManifestFromRows(rankedRows, actor, {
      allowFiller,
      allowReservedForOthers: allowReserved,
      requireReservedForActor: false,
      technicianRank: rank,
      seniorAvailable,
      p1Eligible: eligibility.p1Eligible,
      p2Eligible: eligibility.p2Eligible
    });
    source = "queue";
  }

  return {
    ...status,
    claimable_count: manifest ? 1 : 0,
    claimable_next_id: manifest?.id ?? null,
    claimable_source: manifest ? source : null
  };
}

export async function claimNextInQueue(input: QueueClaimInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).claimNextPostgresQueue(input);
  const actor = normalizeActor(input.actor);
  const status = await getQueueStatus({
    actor,
    queue_mode: input.queue_mode
  });

  if (status.queue_blocked) {
    throw conflict("queue_blocked", `Queue is blocked: ${status.queue_blocked_reason ?? "unknown"}`);
  }

  const allowReserved = input.allow_reserved !== false;
  const allowFiller = input.allow_filler === true;
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const actorEmailValue = actor.email ?? "";
  const eligibility = await resolveTechnicianPriorityEligibility(actor);
  const rank = eligibility.rank;
  const seniorAvailable = rank === "standard" && eligibility.p1Eligible === undefined
    ? await hasAvailableSeniorTechnicianSqlite(db, input.team_id ?? actor.team_id)
    : false;
  const reservedRows = db.prepare(`
    SELECT id
    FROM projects
    WHERE status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
      AND assigned_to_email = ''
      AND reserved_to_email = $actorEmail
      AND thumbnail_artifact_name != ''
      ${allowFiller ? "" : "AND is_filler = 0"}
    ORDER BY CASE WHEN is_vip != 0 OR is_expedited != 0 THEN 1 ELSE 0 END DESC, created_at_ms ASC, id ASC
    LIMIT 50
  `).all({
    actorEmail: actorEmailValue
  }) as Array<{ id?: string }>;

  let source: "reserved" | "queue" = "reserved";
  let manifest = await firstClaimableManifestFromRows(reservedRows, actor, {
    allowFiller,
    allowReservedForOthers: false,
    requireReservedForActor: true,
    technicianRank: rank,
    seniorAvailable,
    p1Eligible: eligibility.p1Eligible,
    p2Eligible: eligibility.p2Eligible
  });

  if (!manifest) {
    const availableRows = db.prepare(`
      SELECT id, complexity, is_vip, is_expedited, created_at_ms, queued_at_ms, updated_at_ms
      FROM projects
      WHERE status IN (${sqlStringList(Array.from(NEW_QUEUE_STATUSES))})
        AND assigned_to_email = ''
        AND thumbnail_artifact_name != ''
        ${allowFiller ? "" : "AND is_filler = 0"}
        ${allowReserved ? "AND (reserved_to_email = '' OR reserved_to_email = $actorEmail)" : "AND reserved_to_email = ''"}
      ORDER BY CASE WHEN is_vip != 0 OR is_expedited != 0 THEN 1 ELSE 0 END DESC,
        queued_at_ms ASC, created_at_ms ASC, id ASC
    `).all({
      actorEmail: actorEmailValue
    }) as QueueCandidateRow[];

    const prioritySettings = await readProductionQueuePrioritySettings();
    const rankedRows = await rankProductionQueueRows(availableRows, {
      rank,
      settings: prioritySettings,
      preferredComplexities: input.preferred_complexity ?? [],
      p1Eligible: eligibility.p1Eligible
    });

    manifest = await firstClaimableManifestFromRows(rankedRows, actor, {
      allowFiller,
      allowReservedForOthers: allowReserved,
      requireReservedForActor: false,
      technicianRank: rank,
      seniorAvailable,
      p1Eligible: eligibility.p1Eligible,
      p2Eligible: eligibility.p2Eligible
    });
    source = "queue";
  }

  if (!manifest) {
    throw notFound("queue_empty", "No eligible project was found in the queue.");
  }

  const workflow = workflowRecord(manifest);
  if (actorEmail(workflow.assigned_to)) {
    throw conflict("project_already_assigned", "Selected project is already assigned.");
  }

  const now = new Date().toISOString();
  workflow.assigned_to = actor;
  workflow.assigned_at = now;

  if (actorEmail(workflow.reserved_to) === actor.email) {
    workflow.reserved_to = null;
    workflow.reserved_at = null;
  }

  const history = Array.isArray(workflow.history) ? workflow.history : [];
  history.push({
    ts: now,
    event: "claimed_new",
    actor
  });
  workflow.history = history;

  manifest.workflow = workflow;
  manifest.status = "in_progress";
  await saveManifest(manifest.id, manifest);

  return {
    project: manifest,
    source
  };
}

export async function reserveProject(projectId: string, input: QueueReserveInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).reservePostgresProject(projectId, input);
  const manifest = await readManifest(projectId);
  const workflow = workflowRecord(manifest);
  const reservedFor = normalizeActor(input.reserved_for);
  if (hasPendingForceKickForActor(manifest, reservedFor)) {
    throw conflict("pending_force_kick", "This project still has a pending force-kick for that user.");
  }
  const assignedTo = actorEmail(workflow.assigned_to);
  if (assignedTo) {
    throw conflict("project_already_assigned", "Assigned projects cannot be reserved.");
  }

  workflow.reserved_to = reservedFor;
  workflow.reserved_at = new Date().toISOString();
  const now = workflow.reserved_at;
  workflow.history = [
    ...(Array.isArray(workflow.history) ? workflow.history : []),
    {
      ts: workflow.reserved_at,
      event: "reserved_for_user",
      actor: normalizeOptionalActor(input.actor),
      reserved_to: reservedFor,
      notes: input.notes ?? null
    }
  ];
  manifest.workflow = workflow;
  if (["requeue", "correction_needed"].includes(String(manifest.status))) {
    manifest.status = "queued";
    manifest.timestamps = {
      ...asRecord(manifest.timestamps),
      queued_at: now,
      updated_at: now
    };
  }
  await saveManifest(projectId, manifest);

  return manifest;
}

export async function releaseReservation(projectId: string, input: QueueReleaseInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).releasePostgresReservation(projectId, input);
  const manifest = await readManifest(projectId);
  const workflow = workflowRecord(manifest);
  if (!workflow.reserved_to) {
    return manifest;
  }

  const now = new Date().toISOString();
  const previous = workflow.reserved_to;
  workflow.reserved_to = null;
  workflow.reserved_at = null;
  workflow.history = [
    ...(Array.isArray(workflow.history) ? workflow.history : []),
    {
      ts: now,
      event: "reservation_released",
      actor: normalizeOptionalActor(input.actor),
      previous_reserved_to: previous,
      notes: input.notes ?? null
    }
  ];
  manifest.workflow = workflow;
  await saveManifest(projectId, manifest);

  return manifest;
}

export async function releaseAssignment(projectId: string, input: QueueReleaseInput) {
  if (isFirstMeasurePostgresEnabled()) return (await import("./queue_postgres.js")).releasePostgresAssignment(projectId, input);
  const manifest = await readManifest(projectId);
  const workflow = workflowRecord(manifest);
  if (!workflow.assigned_to) {
    return manifest;
  }

  const now = new Date().toISOString();
  const previous = workflow.assigned_to;
  workflow.assigned_to = null;
  workflow.assigned_at = null;
  workflow.history = [
    ...(Array.isArray(workflow.history) ? workflow.history : []),
    {
      ts: now,
      event: "assignment_released",
      actor: normalizeOptionalActor(input.actor),
      previous_assigned_to: previous,
      notes: input.notes ?? null
    }
  ];
  manifest.workflow = workflow;
  if (["in_progress", "processing", "correction_needed"].includes(String(manifest.status))) {
    manifest.status = "requeue";
    manifest.timestamps = {
      ...asRecord(manifest.timestamps),
      updated_at: now
    };
  }
  await saveManifest(projectId, manifest);

  return manifest;
}

export async function getQueueOverview(input: {
  statuses?: string[];
  team_id?: string;
  include_completed?: boolean;
  limit?: number;
  legacy_full?: boolean;
}) {
  const statuses = input.statuses && input.statuses.length > 0
    ? input.statuses
    : (input.include_completed ? undefined : QUEUE_OVERVIEW_ACTIVE_STATUSES);
  const limit = resolveQueueOverviewLimit(input);
  const result = await queryIndexedProjectManifests({
    statuses,
    team_id: input.team_id,
    includeInstantOnly: true,
    limit
  });

  const projects = result.projects
    .sort(compareQueuePriority)
    .map((manifest) => {
      const priorityLevel = queuePriorityLevelFromManifest(manifest);
      return {
      id: manifest.id,
      address: manifest.address,
      status: manifest.status,
      project_type: manifest.project_type,
      is_filler: manifest.is_filler,
      is_vip: manifest.is_vip,
      is_expedited: manifest.is_expedited,
      qa_priority: (manifest as Record<string, unknown>).qa_priority ?? false,
      report_expedite_option: (manifest as Record<string, unknown>).report_expedite_option ?? null,
      report_due_window_start: (manifest as Record<string, unknown>).report_due_window_start ?? null,
      report_due_window_end: (manifest as Record<string, unknown>).report_due_window_end ?? null,
      report_due_window_label: (manifest as Record<string, unknown>).report_due_window_label ?? null,
      report_production_deadline_at: (manifest as Record<string, unknown>).report_production_deadline_at ?? null,
      priority_level: priorityLevel,
      priority_label: queuePriorityLabel(priorityLevel),
      deadline_at: hasExpeditedDeliveryDeadline(manifest) ? reportProductionDeadlineAt(manifest) : null,
      include_gutter_measurements: manifest.include_gutter_measurements,
      assigned_to: workflowRecord(manifest).assigned_to ?? null,
      reserved_to: workflowRecord(manifest).reserved_to ?? null,
      correction_to: workflowRecord(manifest).correction_to ?? null,
      created_at: asRecord(manifest.timestamps).created_at ?? null,
      updated_at: asRecord(manifest.timestamps).updated_at ?? null
      };
    });

  const counts: Record<string, number> = {};
  for (const project of projects) {
    counts[project.status] = (counts[project.status] ?? 0) + 1;
  }

  return {
    count: projects.length,
    total_count: result.count,
    returned_count: projects.length,
    truncated: result.count > projects.length,
    limit,
    counts,
    projects
  };
}

function resolveQueueOverviewLimit(input: { limit?: number; legacy_full?: boolean }) {
  const requested = Number(input.limit ?? 0);
  if (Number.isFinite(requested) && requested > 0) {
    return Math.min(Math.floor(requested), QUEUE_OVERVIEW_MAX_LIMIT);
  }
  return input.legacy_full ? QUEUE_OVERVIEW_MAX_LIMIT : QUEUE_OVERVIEW_DEFAULT_LIMIT;
}

function readQueueCount(
  db: ReturnType<typeof getFirstMeasureProjectIndexDb>,
  whereSql: string,
  params: Record<string, SQLInputValue>
) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM projects
    WHERE ${whereSql}
  `).get(params) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

function sqlStringList(values: string[]) {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

async function firstClaimableManifestFromRows(
  rows: Array<{ id?: string }>,
  actor: ActorRef,
  options: {
    allowFiller: boolean;
    allowReservedForOthers: boolean;
    requireReservedForActor: boolean;
    technicianRank?: TechnicianRank;
    seniorAvailable?: boolean;
    p1Eligible?: boolean;
    p2Eligible?: boolean;
  }
) {
  const actorEmailValue = actor.email ?? "";
  for (const row of rows) {
    const projectId = String(row.id ?? "").trim();
    if (!projectId) continue;

    const manifest = await readManifest(projectId);
    const workflow = workflowRecord(manifest);
    const reservedTo = actorEmail(workflow.reserved_to);
    if (!isClaimableNew(manifest, options.allowFiller)) continue;
    if (hasPendingForceKickForActor(manifest, actor)) continue;
    if (options.technicianRank && !technicianCanClaimPriorityLevel(
      options.technicianRank,
      queuePriorityLevelFromManifest(manifest),
      options.seniorAvailable === true,
      options.p1Eligible,
      options.p2Eligible
    )) continue;
    if (options.requireReservedForActor && reservedTo !== actorEmailValue) continue;
    if (!options.allowReservedForOthers && reservedTo && reservedTo !== actorEmailValue) continue;
    if (options.allowReservedForOthers && reservedTo && reservedTo !== actorEmailValue) continue;
    return manifest;
  }
  return null;
}

function hasPendingForceKickForActor(manifest: ProjectManifest, actor: ActorRef) {
  const actorEmailValue = String(actor.email ?? "").trim().toLowerCase();
  if (!actorEmailValue) return false;

  const forceKick = asRecord((manifest as Record<string, unknown>).force_kick);
  if (Boolean(forceKick.acknowledged)) return false;

  const kickEmail = String(forceKick.email ?? "").trim().toLowerCase();
  return kickEmail !== "" && kickEmail === actorEmailValue;
}

function isClaimableNew(manifest: ProjectManifest, allowFiller: boolean) {
  return NEW_QUEUE_STATUSES.has(String(manifest.status))
    && !actorEmail(workflowRecord(manifest).assigned_to)
    && hasRenderableProjectAsset(manifest)
    && (allowFiller || !manifest.is_filler);
}

function hasRenderableProjectAsset(manifest: ProjectManifest) {
  const artifacts = asRecord(manifest.artifacts);
  if (artifacts.has_renderable_image || artifacts.has_google_image) return true;
  return ["rgb.tif", "google.png", "azure.png", "apple.png"].some((fileName) => (
    existsSync(path.join(projectDir(manifest.id), fileName))
  ));
}

function isClaimableCorrection(manifest: ProjectManifest, actor: ActorRef, allowFiller: boolean) {
  if (!CORRECTION_QUEUE_STATUSES.has(String(manifest.status))) return false;
  if (actorEmail(workflowRecord(manifest).assigned_to)) return false;
  if (!allowFiller && manifest.is_filler) return false;
  const correctionTo = actorEmail(workflowRecord(manifest).correction_to);
  return !correctionTo || correctionTo === actor.email;
}

function isReservedForActor(manifest: ProjectManifest, actor: ActorRef) {
  return actorEmail(workflowRecord(manifest).reserved_to) === actor.email;
}

function compareQueuePriority(a: ProjectManifest, b: ProjectManifest) {
  const priorityA = queuePriorityLevelFromManifest(a);
  const priorityB = queuePriorityLevelFromManifest(b);
  if (priorityA !== priorityB) return priorityA - priorityB;
  const createdA = Date.parse(String(asRecord(a.timestamps).created_at ?? "")) || 0;
  const createdB = Date.parse(String(asRecord(b.timestamps).created_at ?? "")) || 0;
  return createdA - createdB;
}

function queuePriorityLevelFromManifest(manifest: ProjectManifest, row?: QueueCandidateRow): QueuePriorityLevel {
  const raw = manifest as Record<string, unknown>;
  if (truthyFlag(raw.qa_priority) || truthyFlag(raw.manual_priority) || truthyFlag(raw.prioritized)) {
    return 1;
  }

  const option = normalizeExpediteOption(raw.report_expedite_option);
  let level = reportExpeditePriorityLevel(option, truthyFlag(raw.is_expedited ?? row?.is_expedited)) as QueuePriorityLevel;

  if (truthyFlag(raw.is_vip ?? row?.is_vip)) {
    level = Math.min(level, 2) as QueuePriorityLevel;
  }
  return level;
}

function queuePriorityLabel(level: QueuePriorityLevel) {
  if (level === 1) return "Under 1 hour expedited";
  if (level === 2) return "1-3 hour expedited";
  return "Normal";
}

function hasExpeditedDeliveryDeadline(manifest: ProjectManifest) {
  const raw = manifest as Record<string, unknown>;
  const option = normalizeExpediteOption(raw.report_expedite_option);
  return isExpeditedReportExpediteKey(option) || truthyFlag(raw.is_expedited);
}

function reportProductionDeadlineAt(manifest: ProjectManifest) {
  const raw = manifest as Record<string, unknown>;
  const explicit = String(raw.report_production_deadline_at ?? "").trim();
  if (explicit) return explicit;
  const option = normalizeExpediteOption(raw.report_expedite_option);
  const submittedMs = firstTimestampMs(raw, asRecord(manifest.timestamps), ["queued_at", "created_at", "processed_at", "updated_at"]);
  if (submittedMs) {
    const quote = buildReportExpediteOptions({
      projectType: raw.project_type,
      structureCount: Math.max(1, countManifestPins(manifest) || 1),
      now: new Date(submittedMs)
    });
    const quoted = quote.options.find((entry) => entry.key === option);
    if (quoted?.production_deadline_at) return quoted.production_deadline_at;
  }
  return String(raw.report_due_window_start ?? "").trim() || null;
}

function countManifestPins(manifest: ProjectManifest) {
  if (!Array.isArray(manifest.pins)) return 0;
  return manifest.pins.reduce((count, pin) => {
    const lat = typeof pin?.lat === "number" ? pin.lat : Number(pin?.lat);
    const lng = typeof pin?.lng === "number" ? pin.lng : Number(pin?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? count + 1 : count;
  }, 0);
}

function firstTimestampMs(raw: Record<string, unknown>, timestamps: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const direct = parseTimestampMs(raw[key]);
    if (direct) return direct;
    const nested = parseTimestampMs(timestamps[key]);
    if (nested) return nested;
  }
  return 0;
}

function parseTimestampMs(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return 0;
  const isoCandidate = text.includes("T") ? text : text.replace(" ", "T");
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(isoCandidate);
  const parsed = Date.parse(hasTimezone ? isoCandidate : `${isoCandidate}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeExpediteOption(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function truthyFlag(value: unknown) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

export function technicianCanClaimPriorityLevel(
  rank: TechnicianRank,
  level: QueuePriorityLevel,
  seniorAvailable = false,
  p1Eligible?: boolean,
  p2Eligible?: boolean
) {
  if (level === 2 && p2Eligible !== undefined) return p2Eligible;
  if (level !== 1) return true;
  if (p1Eligible !== undefined) return p1Eligible;
  if (rank === "senior") return true;
  return rank === "standard" && !seniorAvailable;
}

export function isRecentlyOnlineTechnician(user: Record<string, unknown>, nowMs = Date.now()) {
  if (truthyFlag(user.disabled) || truthyFlag(user.is_offline)) return false;
  if (String(user.status ?? "").trim().toLowerCase() === "disabled") return false;
  if (String(user.availability_status ?? "").trim().toLowerCase() === "offline") return false;
  const timestamp = Date.parse(String(user.last_activity_at ?? user.last_login_at ?? user.last_login ?? ""));
  const age = nowMs - timestamp;
  return Number.isFinite(timestamp)
    && age >= -ONLINE_TIMESTAMP_CLOCK_SKEW_MS
    && age <= TECHNICIAN_RECENT_ACTIVITY_WINDOW_MS;
}

export async function onlineSeniorTechnicianEmails(teamId?: string) {
  const normalizedTeamId = String(teamId ?? "").trim().toLowerCase();
  const constrainTeam = normalizedTeamId !== "" && normalizedTeamId !== "default" && normalizedTeamId !== "all";
  const users = await listInternalUsers();
  return users
    .filter((user) => typeof user.p1_eligible === "boolean"
      ? user.p1_eligible
      : normalizeTechnicianRank(user.drafter_rank).rank === "senior")
    .filter((user) => !constrainTeam || String(user.team_id ?? "").trim().toLowerCase() === normalizedTeamId)
    .filter((user) => isRecentlyOnlineTechnician(user))
    .map((user) => String(user.email ?? "").trim().toLowerCase())
    .filter(Boolean);
}

async function hasAvailableSeniorTechnicianSqlite(
  db: ReturnType<typeof getFirstMeasureProjectIndexDb>,
  teamId?: string
) {
  const onlineSeniorEmails = await onlineSeniorTechnicianEmails(teamId);
  if (!onlineSeniorEmails.length) return false;
  const placeholders = onlineSeniorEmails.map(() => "?").join(", ");
  const busyRows = db.prepare(`
    SELECT DISTINCT lower(assigned_to_email) AS email
    FROM projects
    WHERE lower(assigned_to_email) IN (${placeholders})
      AND status IN (${sqlStringList(Array.from(ACTIVE_ASSIGNMENT_STATUSES))})
  `).all(...onlineSeniorEmails) as Array<{ email?: string }>;
  const busyEmails = new Set(busyRows.map((row) => String(row.email ?? "").trim().toLowerCase()));
  return onlineSeniorEmails.some((email) => !busyEmails.has(email));
}

function workflowRecord(manifest: ProjectManifest) {
  const workflow = asRecord(manifest.workflow);
  if (!("history" in workflow)) workflow.history = [];
  return workflow;
}

function normalizeActor(actor: ActorRef) {
  const email = String(actor.email ?? "").trim().toLowerCase();
  const id = String(actor.id ?? "").trim();
  if (!email && !id) {
    throw badRequest("missing_actor_identity", "actor.email or actor.id is required.");
  }
  return {
    id: id || undefined,
    email: email || undefined,
    name: String(actor.name ?? email ?? id).trim() || undefined,
    ...((actor as Record<string, unknown>).drafter_rank
      ? { drafter_rank: normalizeTechnicianRank((actor as Record<string, unknown>).drafter_rank).rank }
      : {}),
    ...(typeof (actor as Record<string, unknown>).p1_eligible === "boolean"
      ? { p1_eligible: (actor as Record<string, unknown>).p1_eligible as boolean }
      : {}),
    ...(typeof (actor as Record<string, unknown>).p2_eligible === "boolean"
      ? { p2_eligible: (actor as Record<string, unknown>).p2_eligible as boolean }
      : {}),
    team_id: String(actor.team_id ?? "").trim() || undefined
  };
}

function normalizeOptionalActor(actor?: ActorRef | null) {
  if (!actor) return null;
  try {
    return normalizeActor(actor);
  } catch {
    return null;
  }
}

function actorEmail(value: unknown) {
  return String(asRecord(value).email ?? "").trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function rankProductionQueueRows(
  rows: QueueCandidateRow[],
  input: {
    rank: TechnicianRank;
    settings: ProductionQueuePrioritySettings;
    preferredComplexities?: Array<number | string>;
    p1Eligible?: boolean;
  }
) {
  const rowsWithTime = await hydrateQueueCandidateRows(rows);

  if (!rowsWithTime.length) return [];

  if (input.rank === "junior") {
    return rankJuniorQueueRows(rowsWithTime, input.p1Eligible === true);
  }

  const sortedByQueue = rowsWithTime.slice().sort(compareQueueCandidatePosition);
  const selectedPriority = sortedByQueue[0]?._queuePriorityLevel ?? 3;
  const grouped = sortedByQueue.filter((row) => row._queuePriorityLevel === selectedPriority);

  if (selectedPriority === 1 && grouped.length > 1) {
    const levelOrder = input.rank === "senior" ? [5, 4, 3, 2, 1] : [1, 2, 3, 4, 5];
    return [
      ...sortByComplexityPreference(grouped, levelOrder),
      ...sortedByQueue.filter((row) => row._queuePriorityLevel !== selectedPriority)
    ];
  }

  if (selectedPriority !== 3) {
    return sortedByQueue;
  }

  const intervalMs = Math.max(1, input.settings.windowMinutes) * 60_000;
  const oldestEnteredAtMs = Math.min(...grouped.map((row) => row._enteredAtMs));
  const bucketRows = grouped.filter((row) => {
    const enteredAtMs = row._enteredAtMs;
    return enteredAtMs >= oldestEnteredAtMs && enteredAtMs < oldestEnteredAtMs + intervalMs;
  });
  const fallbackRows = rowsWithTime.filter((row) => !bucketRows.some((bucketRow) => bucketRow.id === row.id));
  const levelOrder = normalizeLevelOrder(
    input.preferredComplexities && input.preferredComplexities.length
      ? input.preferredComplexities
      : input.settings.priorities[input.rank]
  );
  const levelIndex = new Map(levelOrder.map((level, index) => [level, index]));

  const compare = (a: typeof rowsWithTime[number], b: typeof rowsWithTime[number]) => {
    const levelA = levelIndex.get(a._level) ?? 999;
    const levelB = levelIndex.get(b._level) ?? 999;
    if (levelA !== levelB) return levelA - levelB;
    if (a._enteredAtMs !== b._enteredAtMs) return a._enteredAtMs - b._enteredAtMs;
    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  };

  bucketRows.sort(compare);
  fallbackRows.sort((a, b) => {
    if (a._queuePriorityLevel !== b._queuePriorityLevel) return a._queuePriorityLevel - b._queuePriorityLevel;
    const bucketA = queuePriorityWindowOffset(a._enteredAtMs, oldestEnteredAtMs, intervalMs);
    const bucketB = queuePriorityWindowOffset(b._enteredAtMs, oldestEnteredAtMs, intervalMs);
    if (bucketA !== bucketB) return bucketA - bucketB;
    return compare(a, b);
  });

  return [...bucketRows, ...fallbackRows];
}

async function hydrateQueueCandidateRows(rows: QueueCandidateRow[]): Promise<QueueRankedCandidateRow[]> {
  const hydrated: QueueRankedCandidateRow[] = [];
  for (const row of rows) {
    const projectId = String(row.id ?? "").trim();
    if (!projectId) continue;
    try {
      const manifest = await readManifest(projectId);
      hydrated.push({
        ...row,
        manifest,
        _queuePriorityLevel: queuePriorityLevelFromManifest(manifest, row),
        _enteredAtMs: queueEnteredAtMs(row),
        _level: queueProjectLevel(row)
      });
    } catch {
      continue;
    }
  }
  return hydrated;
}

function compareQueueCandidatePosition(a: QueueRankedCandidateRow, b: QueueRankedCandidateRow) {
  if (a._queuePriorityLevel !== b._queuePriorityLevel) return a._queuePriorityLevel - b._queuePriorityLevel;
  if (a._enteredAtMs !== b._enteredAtMs) return a._enteredAtMs - b._enteredAtMs;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function rankJuniorQueueRows(rows: QueueRankedCandidateRow[], allowPriorityOne = false) {
  const eligible = rows
    .filter((row) => allowPriorityOne || row._queuePriorityLevel !== 1)
    .sort(compareQueueCandidatePosition);
  const candidateWindow = eligible.slice(0, 5);
  const rest = eligible.slice(5);
  if (!candidateWindow.length) return [];

  candidateWindow.sort((a, b) => {
    if (a._level !== b._level) return a._level - b._level;
    return compareQueueCandidatePosition(a, b);
  });

  const selected = candidateWindow[0];
  if (!selected) return [];
  const remainingWindow = candidateWindow.slice(1).sort(compareQueueCandidatePosition);
  return [selected, ...remainingWindow, ...rest];
}

function sortByComplexityPreference(rows: QueueRankedCandidateRow[], levelOrder: number[]) {
  const levelIndex = new Map(levelOrder.map((level, index) => [level, index]));
  return rows.slice().sort((a, b) => {
    const levelA = levelIndex.get(a._level) ?? 999;
    const levelB = levelIndex.get(b._level) ?? 999;
    if (levelA !== levelB) return levelA - levelB;
    return compareQueueCandidatePosition(a, b);
  });
}

export function queueEnteredAtMs(row: QueueCandidateRow) {
  // FIFO age follows the customer order, not the latest trip through production.
  const created = Number(row.created_at_ms ?? 0);
  if (Number.isFinite(created) && created > 0) return created;
  const queued = Number(row.queued_at_ms ?? 0);
  if (Number.isFinite(queued) && queued > 0) return queued;
  const updated = Number(row.updated_at_ms ?? 0);
  if (Number.isFinite(updated) && updated > 0) return updated;
  return 0;
}

function queuePriorityWindowOffset(valueMs: number, oldestMs: number, intervalMs: number) {
  if (!Number.isFinite(valueMs) || !Number.isFinite(oldestMs) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Math.floor((valueMs - oldestMs) / intervalMs));
}

function queueProjectLevel(row: QueueCandidateRow) {
  const value = Number.parseInt(String(row.complexity ?? "").replace(/[^0-9.-]/g, ""), 10);
  if (Number.isFinite(value) && value >= 1 && value <= 5) return value;
  if (Number.isFinite(value) && value > 5) return 5;
  return 3;
}

function normalizeLevelOrder(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const levels: number[] = [];
  for (const item of raw) {
    const level = Number.parseInt(String(item).replace(/[^0-9.-]/g, ""), 10);
    if (!Number.isFinite(level) || level < 1 || level > 5 || levels.includes(level)) continue;
    levels.push(level);
  }
  for (const level of [1, 2, 3, 4, 5]) {
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
}

function normalizeTechnicianRank(value: unknown): { rank: TechnicianRank } {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "senior") return { rank: "senior" };
  if (raw === "standard") return { rank: "standard" };
  return { rank: "junior" };
}

export async function resolveTechnicianRank(actor: ActorRef): Promise<TechnicianRank> {
  const actorRank = normalizeTechnicianRank((actor as Record<string, unknown>).drafter_rank).rank;
  if ((actor as Record<string, unknown>).drafter_rank) return actorRank;
  const email = String(actor.email ?? "").trim().toLowerCase();
  if (!email) return "junior";
  const user = await readInternalUserByEmail(email);
  return normalizeTechnicianRank(user?.drafter_rank).rank;
}

export async function resolveTechnicianPriorityEligibility(actor: ActorRef) {
  const email = String(actor.email ?? "").trim().toLowerCase();
  const user = email ? await readInternalUserByEmail(email) : null;
  const actorRecord = actor as Record<string, unknown>;
  const rank = actorRecord.drafter_rank
    ? normalizeTechnicianRank(actorRecord.drafter_rank).rank
    : normalizeTechnicianRank(user?.drafter_rank).rank;
  return {
    rank,
    p1Eligible: typeof actorRecord.p1_eligible === "boolean"
      ? actorRecord.p1_eligible
      : (typeof user?.p1_eligible === "boolean" ? user.p1_eligible : undefined),
    p2Eligible: typeof actorRecord.p2_eligible === "boolean"
      ? actorRecord.p2_eligible
      : (typeof user?.p2_eligible === "boolean" ? user.p2_eligible : undefined)
  };
}

async function readInternalUserByEmail(email: string): Promise<Record<string, unknown> | null> {
  return await readInternalUser(email).catch(() => null);
}

export async function readProductionQueuePrioritySettings(): Promise<ProductionQueuePrioritySettings> {
  const defaults: ProductionQueuePrioritySettings = {
    windowMinutes: DEFAULT_QUEUE_PRIORITY_WINDOW_MINUTES,
    priorities: {
      junior: [...DEFAULT_QUEUE_LEVEL_PRIORITY.junior],
      standard: [...DEFAULT_QUEUE_LEVEL_PRIORITY.standard],
      senior: [...DEFAULT_QUEUE_LEVEL_PRIORITY.senior]
    }
  };

  try {
    const parsed = asRecord(JSON.parse(await readFile(SERVER_CONFIG_PATH, "utf8")));
    const settings = asRecord(parsed.settings);
    const windowMinutes = Number(settings.production_queue_priority_window_minutes);
    if (Number.isFinite(windowMinutes) && windowMinutes >= 1 && windowMinutes <= 240) {
      defaults.windowMinutes = Math.round(windowMinutes);
    }
    defaults.priorities.junior = normalizeLevelOrder(settings.production_queue_priority_junior ?? defaults.priorities.junior);
    defaults.priorities.standard = normalizeLevelOrder(settings.production_queue_priority_standard ?? defaults.priorities.standard);
    defaults.priorities.senior = normalizeLevelOrder(settings.production_queue_priority_senior ?? defaults.priorities.senior);
  } catch {
    // Defaults are intentionally usable without a config file.
  }

  return defaults;
}
