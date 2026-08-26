import { withPostgresClient, withPostgresTransaction } from "../src/database/postgres.js";
import { conflict, notFound, badRequest } from "./errors.js";
import {
  ensurePostgresProjectIndexReady,
  mutatePostgresManifest,
  upsertPostgresProjectIndexWithClient
} from "./project_index_postgres.js";
import { projectDir, writeProjectManifestMirror, type ProjectManifest } from "./storage.js";
import {
  onlineSeniorTechnicianEmails,
  readProductionQueuePrioritySettings,
  resolveTechnicianPriorityEligibility
} from "./queue.js";

type ActorRef = { id?: string; email?: string; name?: string; drafter_rank?: string; p1_eligible?: boolean; p2_eligible?: boolean; team_id?: string };
type QueueMode = "all" | "new_only" | "corrections_only" | "wait_for_feedback";
type QueueClaimInput = {
  actor: ActorRef; queue_mode?: QueueMode; allow_reserved?: boolean; allow_filler?: boolean;
  preferred_complexity?: Array<number | string>; team_id?: string;
};
type QueueStatusInput = { actor: ActorRef; queue_mode?: QueueMode };
type QueueReserveInput = { reserved_for: ActorRef; actor?: ActorRef; notes?: string | null };
type QueueReleaseInput = { actor?: ActorRef; notes?: string | null };

const NEW_STATUSES = ["queued", "ready"];
const ACTIVE_STATUSES = ["processing", "in_progress", "correction_needed", "awaiting_review"];
const BLOCKING_STATUSES = ["awaiting_review", "correction_needed", "awaiting_manager_review"];

function actor(input: ActorRef) {
  const email = String(input.email ?? "").trim().toLowerCase();
  const id = String(input.id ?? "").trim();
  if (!email && !id) throw badRequest("missing_actor_identity", "actor.email or actor.id is required.");
  return { id: id || undefined, email: email || undefined, name: String(input.name ?? email ?? id).trim() || undefined,
    ...(input.drafter_rank ? { drafter_rank: input.drafter_rank } : {}), team_id: String(input.team_id ?? "").trim() || undefined };
}

function optionalActor(input?: ActorRef | null) {
  if (!input) return null;
  try { return actor(input); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function email(value: unknown) { return String(record(value).email ?? "").trim().toLowerCase(); }

function manifestValue(value: unknown) {
  return (typeof value === "string" ? JSON.parse(value) : value) as ProjectManifest;
}

async function statusWithClient(client: import("pg").PoolClient, input: QueueStatusInput) {
  const normalized = actor(input.actor);
  const actorEmail = normalized.email ?? "";
  const counts = await client.query<{
    assigned: string; corrections: string; reserved: string; available_new: string; blocking: string;
    active_id: string | null; active_status: string | null; active_address: string | null;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM projects WHERE assigned_to_email = $1 AND status = ANY($2::text[]))::text AS assigned,
      (SELECT COUNT(*) FROM projects WHERE status = 'correction_needed' AND assigned_to_email = ''
        AND (correction_to_email = '' OR correction_to_email = $1))::text AS corrections,
      COALESCE((SELECT SUM(project_count) FROM project_queue_counters
        WHERE scope = 'claim_reserved' AND team_id = $1 AND queue_group = 'queued'), 0)::text AS reserved,
      (COALESCE((SELECT SUM(project_count) FROM project_queue_counters
          WHERE scope = 'claim_unreserved' AND team_id = '' AND queue_group = 'queued'), 0)
        + COALESCE((SELECT SUM(project_count) FROM project_queue_counters
          WHERE scope = 'claim_reserved' AND team_id = $1 AND queue_group = 'queued'), 0))::text AS available_new,
      (SELECT COUNT(*) FROM projects WHERE assigned_to_email = $1 AND status = ANY($3::text[]))::text AS blocking,
      active.id AS active_id, active.status AS active_status, active.address AS active_address
    FROM (SELECT 1) seed
    LEFT JOIN LATERAL (
      SELECT id, status, address FROM projects
      WHERE assigned_to_email = $1 AND status = ANY($2::text[])
      ORDER BY updated_at_ms DESC, id DESC LIMIT 1
    ) active ON true
  `, [actorEmail, ACTIVE_STATUSES, BLOCKING_STATUSES]);
  const row = counts.rows[0];
  const queueBreakdown = {
    assigned: Number(row?.assigned ?? 0), corrections: Number(row?.corrections ?? 0),
    reserved: Number(row?.reserved ?? 0), available_new: Number(row?.available_new ?? 0)
  };
  const blocked = input.queue_mode === "wait_for_feedback" && Number(row?.blocking ?? 0) > 0;
  return {
    actor: normalized, queue_mode: input.queue_mode ?? "all", queue_blocked: blocked,
    queue_blocked_reason: blocked ? "active_assignment" : null,
    queue_count: queueBreakdown.reserved + queueBreakdown.available_new, queue_breakdown: queueBreakdown,
    active_project: row?.active_id
      ? { id: row.active_id, status: row.active_status ?? "", address: row.active_address ?? "" }
      : null
  };
}

export async function getPostgresQueueStatus(input: QueueStatusInput) {
  await ensurePostgresProjectIndexReady();
  return withPostgresClient((client) => statusWithClient(client, input));
}

function candidateSql(
  input: QueueClaimInput,
  lock: boolean,
  rank: "junior" | "standard" | "senior",
  rankPreferences: number[],
  source: "reserved" | "queue",
  seniorAvailable: boolean,
  p1Eligible?: boolean,
  p2Eligible?: boolean
) {
  const allowFiller = input.allow_filler === true;
  const normalized = actor(input.actor);
  const preferred = (input.preferred_complexity?.length ? input.preferred_complexity : rankPreferences)
    .map(String).filter((value) => /^[1-5]$/.test(value));
  const values: unknown[] = [normalized.email ?? "", NEW_STATUSES];
  const where = ["queue_group = 'queued'", "status = ANY($2::text[])", "assigned_to_email = ''", "thumbnail_artifact_name <> ''"];
  if (!allowFiller) where.push("is_filler = 0");
  if (source === "reserved") where.push("reserved_to_email = $1");
  else where.push("reserved_to_email = ''");
  if (input.team_id) { values.push(String(input.team_id).trim()); where.push(`team_id = $${values.length}`); }
  const kickEmail = "$1";
  where.push(`(force_kick_email = '' OR force_kick_email <> ${kickEmail} OR force_kick_acknowledged <> 0)`);
  const canClaimP1 = p1Eligible ?? (rank === "senior" || (rank === "standard" && !seniorAvailable));
  if (!canClaimP1) where.push("queue_priority <> 1");
  if (p2Eligible === false) where.push("queue_priority <> 2");
  values.push(preferred);
  const preferredParam = `$${values.length}`;
  return {
    values,
    sql: `SELECT manifest_json, thumbnail_artifact_name FROM projects WHERE ${where.join(" AND ")}
      ORDER BY queue_priority,
        CASE WHEN complexity = ANY(${preferredParam}::text[]) THEN 0 ELSE 1 END,
        created_at_ms ASC, queued_at_ms ASC, id ASC LIMIT 1 ${lock ? "FOR UPDATE SKIP LOCKED" : ""}`
  };
}

async function selectCandidate(
  client: import("pg").PoolClient,
  input: QueueClaimInput,
  lock: boolean,
  rank: "junior" | "standard" | "senior",
  rankPreferences: number[],
  seniorAvailable: boolean,
  p1Eligible?: boolean,
  p2Eligible?: boolean
) {
  if (input.allow_reserved !== false && String(input.actor.email ?? "").trim()) {
    const reserved = candidateSql(input, lock, rank, rankPreferences, "reserved", seniorAvailable, p1Eligible, p2Eligible);
    const reservedResult = await client.query<{ manifest_json: unknown; thumbnail_artifact_name: string }>(reserved.sql, reserved.values);
    if (reservedResult.rows[0]) return { row: reservedResult.rows[0], source: "reserved" as const };
  }
  const available = candidateSql(input, lock, rank, rankPreferences, "queue", seniorAvailable, p1Eligible, p2Eligible);
  const availableResult = await client.query<{ manifest_json: unknown; thumbnail_artifact_name: string }>(available.sql, available.values);
  return { row: availableResult.rows[0] ?? null, source: "queue" as const };
}

async function hasAvailableSeniorTechnicianPostgres(
  client: import("pg").PoolClient,
  teamId?: string
) {
  const onlineSeniorEmails = await onlineSeniorTechnicianEmails(teamId);
  if (!onlineSeniorEmails.length) return false;
  const busy = await client.query<{ email: string }>(`
    SELECT DISTINCT lower(assigned_to_email) AS email
    FROM projects
    WHERE lower(assigned_to_email) = ANY($1::text[])
      AND status = ANY($2::text[])
  `, [onlineSeniorEmails, ACTIVE_STATUSES]);
  const busyEmails = new Set(busy.rows.map((row) => String(row.email ?? "").trim().toLowerCase()));
  return onlineSeniorEmails.some((email) => !busyEmails.has(email));
}

export async function getPostgresClaimableQueueStatus(input: QueueClaimInput) {
  await ensurePostgresProjectIndexReady();
  const eligibility = await resolveTechnicianPriorityEligibility(input.actor);
  const rank = eligibility.rank;
  const settings = await readProductionQueuePrioritySettings();
  return withPostgresTransaction(async (client) => {
    const status = await statusWithClient(client, input);
    if (status.queue_blocked) return { ...status, claimable_count: 0, claimable_next_id: null, claimable_source: null };
    const seniorAvailable = rank === "standard" && eligibility.p1Eligible === undefined
      ? await hasAvailableSeniorTechnicianPostgres(client, input.team_id ?? input.actor.team_id)
      : false;
    const candidate = await selectCandidate(client, input, false, rank, settings.priorities[rank], seniorAvailable, eligibility.p1Eligible, eligibility.p2Eligible);
    const manifest = candidate.row ? manifestValue(candidate.row.manifest_json) : null;
    return {
      ...status,
      claimable_count: manifest ? 1 : 0,
      claimable_next_id: manifest?.id ?? null,
      claimable_source: manifest ? candidate.source : null
    };
  });
}

export async function claimNextPostgresQueue(input: QueueClaimInput) {
  await ensurePostgresProjectIndexReady();
  const normalized = actor(input.actor);
  const eligibility = await resolveTechnicianPriorityEligibility(input.actor);
  const rank = eligibility.rank;
  const settings = await readProductionQueuePrioritySettings();
  const claimed = await withPostgresTransaction(async (client) => {
    const status = await statusWithClient(client, input);
    if (status.queue_blocked) throw conflict("queue_blocked", `Queue is blocked: ${status.queue_blocked_reason ?? "unknown"}`);
    const seniorAvailable = rank === "standard" && eligibility.p1Eligible === undefined
      ? await hasAvailableSeniorTechnicianPostgres(client, input.team_id ?? input.actor.team_id)
      : false;
    const candidate = await selectCandidate(client, input, true, rank, settings.priorities[rank], seniorAvailable, eligibility.p1Eligible, eligibility.p2Eligible);
    if (!candidate.row) throw notFound("queue_empty", "No eligible project was found in the queue.");
    const manifest = manifestValue(candidate.row.manifest_json);
    const workflow = record(manifest.workflow);
    if (email(workflow.assigned_to)) throw conflict("project_already_assigned", "Selected project is already assigned.");
    const now = new Date().toISOString();
    workflow.assigned_to = normalized;
    workflow.assigned_at = now;
    const source = candidate.source;
    if (source === "reserved") { workflow.reserved_to = null; workflow.reserved_at = null; }
    workflow.history = [...(Array.isArray(workflow.history) ? workflow.history : []), { ts: now, event: "claimed_new", actor: normalized }];
    manifest.workflow = workflow;
    manifest.status = "in_progress";
    manifest.timestamps = { ...record(manifest.timestamps), started_at: record(manifest.timestamps).started_at || now, updated_at: now };
    await upsertPostgresProjectIndexWithClient(client, manifest, {
      storagePath: projectDir(manifest.id), currentThumbnailArtifactName: candidate.row.thumbnail_artifact_name
    });
    return { project: manifest, source };
  });
  await writeProjectManifestMirror(claimed.project.id, claimed.project).catch((error) => {
    console.error(`Queue claim committed for '${claimed.project.id}', but its JSON mirror failed.`, error);
  });
  return claimed;
}

export async function reservePostgresProject(projectId: string, input: QueueReserveInput) {
  const reservedFor = actor(input.reserved_for);
  const updated = await mutatePostgresManifest(projectId, (manifest) => {
    const workflow = record(manifest.workflow);
    if (email(workflow.assigned_to)) throw conflict("project_already_assigned", "Assigned projects cannot be reserved.");
    const forceKick = record((manifest as Record<string, unknown>).force_kick);
    if (!forceKick.acknowledged && String(forceKick.email ?? "").toLowerCase() === reservedFor.email) {
      throw conflict("pending_force_kick", "This project still has a pending force-kick for that user.");
    }
    const now = new Date().toISOString();
    workflow.reserved_to = reservedFor; workflow.reserved_at = now;
    workflow.history = [...(Array.isArray(workflow.history) ? workflow.history : []), {
      ts: now, event: "reserved_for_user", actor: optionalActor(input.actor), reserved_to: reservedFor, notes: input.notes ?? null
    }];
    manifest.workflow = workflow;
    if (["requeue", "correction_needed"].includes(String(manifest.status))) {
      manifest.status = "queued"; manifest.timestamps = { ...record(manifest.timestamps), queued_at: now, updated_at: now };
    }
    return manifest;
  }, { storagePath: projectDir(projectId) });
  if (!updated) throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
  await writeProjectManifestMirror(projectId, updated).catch(() => undefined);
  return updated;
}

export async function releasePostgresReservation(projectId: string, input: QueueReleaseInput) {
  const updated = await mutatePostgresManifest(projectId, (manifest) => {
    const workflow = record(manifest.workflow);
    if (!workflow.reserved_to) return manifest;
    const now = new Date().toISOString(); const previous = workflow.reserved_to;
    workflow.reserved_to = null; workflow.reserved_at = null;
    workflow.history = [...(Array.isArray(workflow.history) ? workflow.history : []), {
      ts: now, event: "reservation_released", actor: optionalActor(input.actor), previous_reserved_to: previous, notes: input.notes ?? null
    }];
    manifest.workflow = workflow; return manifest;
  }, { storagePath: projectDir(projectId) });
  if (!updated) throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
  await writeProjectManifestMirror(projectId, updated).catch(() => undefined);
  return updated;
}

export async function releasePostgresAssignment(projectId: string, input: QueueReleaseInput) {
  const updated = await mutatePostgresManifest(projectId, (manifest) => {
    const workflow = record(manifest.workflow);
    if (!workflow.assigned_to) return manifest;
    const now = new Date().toISOString(); const previous = workflow.assigned_to;
    workflow.assigned_to = null; workflow.assigned_at = null;
    workflow.history = [...(Array.isArray(workflow.history) ? workflow.history : []), {
      ts: now, event: "assignment_released", actor: optionalActor(input.actor), previous_assigned_to: previous, notes: input.notes ?? null
    }];
    manifest.workflow = workflow;
    if (["in_progress", "processing", "correction_needed"].includes(String(manifest.status))) {
      manifest.status = "requeue"; manifest.timestamps = { ...record(manifest.timestamps), updated_at: now };
    }
    return manifest;
  }, { storagePath: projectDir(projectId) });
  if (!updated) throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
  await writeProjectManifestMirror(projectId, updated).catch(() => undefined);
  return updated;
}
