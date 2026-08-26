import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { FIRSTMEASURE_FILE_NAMES, PDF_FILE_NAMES } from "./constants.js";
import { reportExpeditePriorityLevel } from "./expedite.js";
import type { ProjectManifest } from "./storage.js";
import { enforceProjectLifecycleStatus } from "./project_lifecycle.js";

const PROJECT_INDEX_SCHEMA_VERSION = 3;
const INDEX_BACKFILL_META_KEY = "backfill_complete_v1";
const QUEUE_FIELDS_BACKFILL_META_KEY = "queue_fields_backfill_v1";
const QUEUE_FIELDS_BACKFILL_LEASE_MS = 10 * 60_000;
const PROJECT_SEARCH_TABLE_NAME = "project_search";
const LAST_REBUILD_STARTED_AT_META_KEY = "last_rebuild_started_at";
const LAST_REBUILD_FINISHED_AT_META_KEY = "last_rebuild_finished_at";
const LAST_REBUILD_COUNT_META_KEY = "last_rebuild_count";
const QUEUE_EVENT_RETENTION_ROWS = 100_000;

export const FIRSTMEASURE_QUEUE_GROUPS = [
  "rework_requested",
  "needs_structure_pins",
  "waiting",
  "queued",
  "requeue",
  "in_progress",
  "qa_waiting",
  "qa_claimed",
  "release_holding",
  "completed",
  "rejected",
  "cancelled"
] as const;

export type FirstMeasureQueueGroup = typeof FIRSTMEASURE_QUEUE_GROUPS[number];

type ProjectIndexRow = {
  manifest_json: string;
  thumbnail_artifact_name: string;
};

type ProjectIndexQueueSnapshot = {
  id: string;
  status: string;
  team_id: string;
  assigned_to_email: string;
  reserved_to_email: string;
  correction_to_email: string;
  qa_claimed_by_email: string;
};

type SqlParams = Record<string, SQLInputValue>;

export type ProjectActivityField =
  | "created"
  | "queued"
  | "started"
  | "uploaded"
  | "completed"
  | "rejected"
  | "cancelled"
  | "updated";

export type IndexedProjectDocument = SqlParams & {
  id: string;
  address: string;
  owner_name: string;
  owner_email: string;
  assigned_to_name: string;
  assigned_to_email: string;
  issuer_name: string;
  issuer_email: string;
  resident_name: string;
  resident_email: string;
  resident_phone: string;
  queue_group: string;
  queue_priority: number;
  queue_order_ms: number;
  delivery_hold_status: string;
  force_kick_email: string;
  force_kick_acknowledged: number;
};

export type ProjectIndexManifestQuery = {
  search?: string;
  statuses?: string[];
  limit?: number;
  owner_email?: string;
  organization_id?: string;
  team_id?: string;
  project_type?: string;
  has_report_pdf?: boolean;
  includeInstantOnly?: boolean;
  activityStartMs?: number | null;
  activityEndMs?: number | null;
  activityFields?: ProjectActivityField[];
};

export type QueueBucketQuery = {
  group: string;
  team_id?: string;
  limit?: number;
  offset?: number;
  includeInstantOnly?: boolean;
  activityStartMs?: number | null;
  activityEndMs?: number | null;
  activityFields?: ProjectActivityField[];
};

export type QueueCountsQuery = {
  team_id?: string;
  includeInstantOnly?: boolean;
  activityStartMs?: number | null;
  activityEndMs?: number | null;
  activityFields?: ProjectActivityField[];
};

export type QueueChangesQuery = {
  since?: number;
  limit?: number;
  team_id?: string;
};

export type LegacyListActor = {
  email?: string;
  team_id?: string;
  organization_id?: string;
  roles?: string[];
} | null;

export type LegacyListQuery = {
  filter: string;
  statusFilter: string;
  complexityFilter?: string;
  page: number;
  limit: number;
  search: string;
  actor: LegacyListActor;
  includeInstantOnly?: boolean;
  activityStartMs?: number | null;
  activityEndMs?: number | null;
  activityFields?: ProjectActivityField[];
};

export type LegacyListRow = {
  manifest: ProjectManifest;
  thumbnailArtifactName: string | null;
};

export type LegacyListResult = {
  totalCount: number;
  rows: LegacyListRow[];
};

export type RebuildProjectIndexResult = {
  dbPath: string;
  indexedProjects: number;
  startedAt: string;
  finishedAt: string;
};

export type ProjectIndexStatus = {
  dbPath: string;
  indexedProjects: number;
  ftsEnabled: boolean;
  schemaVersion: number;
  backfillComplete: boolean;
  lastRebuildStartedAt: string | null;
  lastRebuildFinishedAt: string | null;
  lastRebuildCount: number | null;
};

let dbInstance: DatabaseSync | null = null;
let indexReadyPromise: Promise<void> | null = null;
let projectSearchFtsEnabled = true;
let postgresModulePromise: Promise<typeof import("./project_index_postgres.js")> | null = null;

function postgresIndex() {
  postgresModulePromise ??= import("./project_index_postgres.js");
  return postgresModulePromise;
}

export function resolveFirstMeasureIndexDbPath(): string {
  return path.resolve(process.cwd(), env.firstmeasureIndexDbPath);
}

export async function ensureFirstMeasureProjectIndexReady() {
  if (isFirstMeasurePostgresEnabled()) {
    await (await postgresIndex()).ensurePostgresProjectIndexReady();
    return;
  }
  if (!indexReadyPromise) {
    indexReadyPromise = initializeProjectIndex();
  }
  await indexReadyPromise;
}

export async function closeFirstMeasureProjectIndex() {
  if (isFirstMeasurePostgresEnabled()) {
    const { closePostgresPools } = await import("../src/database/postgres.js");
    await closePostgresPools();
    return;
  }
  dbInstance?.close();
  dbInstance = null;
  indexReadyPromise = null;
}

export async function rebuildFirstMeasureProjectIndex(): Promise<RebuildProjectIndexResult> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).rebuildPostgresProjectIndex();
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const startedAt = new Date().toISOString();
  writeProjectIndexMeta(db, {
    [LAST_REBUILD_STARTED_AT_META_KEY]: startedAt
  });
  const indexedProjects = await backfillProjectIndexFromDisk(db);
  const finishedAt = new Date().toISOString();
  writeProjectIndexMeta(db, {
    [INDEX_BACKFILL_META_KEY]: "1",
    [LAST_REBUILD_STARTED_AT_META_KEY]: startedAt,
    [LAST_REBUILD_FINISHED_AT_META_KEY]: finishedAt,
    [LAST_REBUILD_COUNT_META_KEY]: String(indexedProjects)
  });
  return {
    dbPath: resolveFirstMeasureIndexDbPath(),
    indexedProjects,
    startedAt,
    finishedAt
  };
}

export async function getFirstMeasureProjectIndexStatus(): Promise<ProjectIndexStatus> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).getPostgresProjectIndexStatus();
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM projects
  `).get() as { count?: number } | undefined;
  const metaRows = db.prepare(`
    SELECT key, value
    FROM project_index_meta
  `).all() as Array<{ key?: string; value?: string }>;
  const meta = new Map<string, string>();
  for (const row of metaRows) {
    const key = String(row.key ?? "");
    if (!key) {
      continue;
    }
    meta.set(key, String(row.value ?? ""));
  }

  const schemaVersion = Number(meta.get("schema_version") ?? PROJECT_INDEX_SCHEMA_VERSION);
  const lastRebuildCountValue = meta.get(LAST_REBUILD_COUNT_META_KEY);

  return {
    dbPath: resolveFirstMeasureIndexDbPath(),
    indexedProjects: Number(countRow?.count ?? 0),
    ftsEnabled: projectSearchFtsEnabled,
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : PROJECT_INDEX_SCHEMA_VERSION,
    backfillComplete: meta.get(INDEX_BACKFILL_META_KEY) === "1",
    lastRebuildStartedAt: meta.get(LAST_REBUILD_STARTED_AT_META_KEY) || null,
    lastRebuildFinishedAt: meta.get(LAST_REBUILD_FINISHED_AT_META_KEY) || null,
    lastRebuildCount: lastRebuildCountValue && Number.isFinite(Number(lastRebuildCountValue))
      ? Number(lastRebuildCountValue)
      : null
  };
}

export function getFirstMeasureProjectIndexDb(): DatabaseSync {
  if (isFirstMeasurePostgresEnabled()) {
    throw new Error("Direct SQLite access is unavailable while PostgreSQL is enabled.");
  }
  if (!dbInstance) {
    throw new Error("FirstMeasure project index has not been initialized.");
  }
  return dbInstance;
}

export async function listIndexedProjectManifests(): Promise<ProjectManifest[]> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).listPostgresProjectManifests();
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const rows = db.prepare(`
    SELECT manifest_json
    FROM projects
    ORDER BY sort_ts DESC, updated_at_ms DESC, id DESC
  `).all() as Array<{ manifest_json: string }>;
  return rows.map((row) => JSON.parse(row.manifest_json) as ProjectManifest);
}

export async function findIndexedProjectByNormalizedAddress(address: string): Promise<ProjectManifest | null> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).findPostgresProjectByNormalizedAddress(address);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const row = db.prepare(`
    SELECT manifest_json
    FROM projects
    WHERE address_normalized = $address
    LIMIT 1
  `).get({
    address: normalizeProjectSearchText(address)
  }) as { manifest_json?: string } | undefined;

  if (!row?.manifest_json) {
    return null;
  }

  return JSON.parse(row.manifest_json) as ProjectManifest;
}

export async function findIndexedProjectsByNormalizedAddress(
  address: string,
  options: { limit?: number } = {}
): Promise<ProjectManifest[]> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).findPostgresProjectsByNormalizedAddress(address, options);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const limit = Math.max(1, Math.min(50, Math.floor(options.limit ?? 10)));
  const rows = db.prepare(`
    SELECT manifest_json
    FROM projects
    WHERE address_normalized = $address
    ORDER BY sort_ts DESC, updated_at_ms DESC, id DESC
    LIMIT $limit
  `).all({
    address: normalizeProjectSearchText(address),
    limit
  }) as Array<{ manifest_json?: string }>;

  return rows
    .map((row) => {
      try {
        return row.manifest_json ? JSON.parse(row.manifest_json) as ProjectManifest : null;
      } catch {
        return null;
      }
    })
    .filter((manifest): manifest is ProjectManifest => Boolean(manifest));
}

export async function queryIndexedProjectManifests(
  query: ProjectIndexManifestQuery
): Promise<{ count: number; projects: ProjectManifest[] }> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).queryPostgresProjectManifests(query);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const params: SqlParams = {};
  const joins: string[] = [];
  const where: string[] = ["1 = 1"];

  if (query.owner_email) {
    where.push("p.owner_email = $ownerEmail");
    params.ownerEmail = String(query.owner_email).trim().toLowerCase();
  }
  if (query.organization_id) {
    where.push("p.organization_id = $organizationId");
    params.organizationId = String(query.organization_id).trim();
  }
  if (query.team_id) {
    where.push("p.team_id = $teamId");
    params.teamId = String(query.team_id).trim();
  }
  if (query.project_type) {
    where.push("p.project_type = $projectType");
    params.projectType = String(query.project_type).trim();
  }
  if (typeof query.has_report_pdf === "boolean") {
    where.push("p.has_report_pdf = $hasReportPdf");
    params.hasReportPdf = query.has_report_pdf ? 1 : 0;
  }
  if (Array.isArray(query.statuses) && query.statuses.length > 0) {
    const placeholders: string[] = [];
    query.statuses.forEach((status, index) => {
      const key = `status${index}`;
      placeholders.push(`$${key}`);
      params[key] = status;
    });
    where.push(`p.status IN (${placeholders.join(", ")})`);
  }
  appendInstantVisibilityClause(where, params, query.includeInstantOnly);

  appendSearchClauses({
    joins,
    where,
    params,
    rawSearch: String(query.search ?? ""),
    alias: "p"
  });
  appendActivityWindowClause({
    where,
    params,
    activityStartMs: query.activityStartMs ?? null,
    activityEndMs: query.activityEndMs ?? null,
    activityFields: query.activityFields
  });

  const fromSql = `
    FROM projects p
    ${joins.join("\n")}
    WHERE ${where.join("\n      AND ")}
  `;

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    ${fromSql}
  `).get(params) as { count?: number } | undefined;

  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 20000);
  const rows = db.prepare(`
    SELECT p.manifest_json
    ${fromSql}
    ORDER BY p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC
    LIMIT $limit
  `).all({
    ...params,
    limit
  }) as Array<{ manifest_json: string }>;

  return {
    count: Number(countRow?.count ?? 0),
    projects: rows.map((row) => JSON.parse(row.manifest_json) as ProjectManifest)
  };
}

export async function queryIndexedQaCandidateManifests(options: {
  team_id?: string;
  limit?: number;
} = {}): Promise<ProjectManifest[]> {
  if (isFirstMeasurePostgresEnabled()) {
    const result = await (await postgresIndex()).queryPostgresProjectManifests({
      statuses: ["awaiting_review", "submission_failed"],
      team_id: options.team_id,
      limit: options.limit ?? 20_000
    });
    return result.projects;
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const limit = Math.min(Math.max(Number(options.limit ?? 20_000), 1), 20_000);
  const params: SqlParams = { limit };
  const teamWhere = options.team_id ? "AND team_id = $teamId" : "";
  if (options.team_id) params.teamId = String(options.team_id).trim();
  const rows = db.prepare(`
    SELECT manifest_json
    FROM projects
    WHERE instant_only = 0
      AND status IN ('awaiting_review', 'submission_failed')
      ${teamWhere}
    ORDER BY sort_ts DESC, updated_at_ms DESC, id DESC
    LIMIT $limit
  `).all(params) as Array<{ manifest_json: string }>;
  return rows.map((row) => JSON.parse(row.manifest_json) as ProjectManifest);
}

export async function getIndexedQueueCounts(
  query: QueueCountsQuery = {}
): Promise<{
  groups: Record<FirstMeasureQueueGroup, number>;
  total: number;
  version: number;
}> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).getPostgresQueueCounts(query);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const params: SqlParams = {};
  const where = ["1 = 1"];
  if (query.team_id) {
    where.push("p.team_id = $teamId");
    params.teamId = String(query.team_id).trim();
  }
  appendInstantVisibilityClause(where, params, query.includeInstantOnly);
  appendActivityWindowClause({
    where,
    params,
    activityStartMs: query.activityStartMs ?? null,
    activityEndMs: query.activityEndMs ?? null,
    activityFields: query.activityFields
  });

  const materialized = db.prepare(`
    SELECT queue_group AS group_id, COUNT(*) AS count
    FROM projects p
    WHERE queue_group <> ''
      AND ${where.join("\n      AND ")}
    GROUP BY queue_group
  `).all(params) as Array<{ group_id?: string; count?: number }>;
  const legacy = db.prepare(`
    SELECT ${queueGroupCaseSql("p")} AS group_id, COUNT(*) AS count
    FROM projects p
    WHERE queue_group = ''
      AND ${where.join("\n      AND ")}
    GROUP BY group_id
  `).all(params) as Array<{ group_id?: string; count?: number }>;
  const rows = [...materialized, ...legacy];

  const groups = emptyQueueCounts();
  for (const row of rows) {
    const group = normalizeQueueGroup(row.group_id);
    if (!group) continue;
    groups[group] += Number(row.count ?? 0);
  }

  return {
    groups,
    total: Object.values(groups).reduce((sum, count) => sum + count, 0),
    version: readQueueVersion(db)
  };
}

export async function queryIndexedQueueBucket(
  query: QueueBucketQuery
): Promise<{
  group: FirstMeasureQueueGroup;
  count: number;
  rows: Array<{ manifest: ProjectManifest; thumbnailArtifactName: string | null }>;
  pagination: {
    limit: number;
    offset: number;
    next_offset: number | null;
    has_more: boolean;
  };
  version: number;
}> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).queryPostgresQueueBucket(query);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const group = normalizeQueueGroup(query.group) ?? "queued";
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 500);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const params: SqlParams = {};
  const where = [`(p.queue_group = $queueGroup OR (p.queue_group = '' AND ${queueGroupWhereSql("p", group)}))`];
  params.queueGroup = group;

  if (query.team_id) {
    where.push("p.team_id = $teamId");
    params.teamId = String(query.team_id).trim();
  }
  appendInstantVisibilityClause(where, params, query.includeInstantOnly);
  appendActivityWindowClause({
    where,
    params,
    activityStartMs: query.activityStartMs ?? null,
    activityEndMs: query.activityEndMs ?? null,
    activityFields: query.activityFields
  });

  const fromSql = `
    FROM projects p
    WHERE ${where.join("\n      AND ")}
  `;
  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    ${fromSql}
  `).get(params) as { count?: number } | undefined;
  const count = Number(countRow?.count ?? 0);
  const priorityOrdered = isPriorityOrderedQueueGroup(group);
  const rows = priorityOrdered
    ? db.prepare(`
        SELECT p.manifest_json, p.thumbnail_artifact_name
        ${fromSql}
        ${queueGroupOrderSql("p", group)}
      `).all(params) as ProjectIndexRow[]
    : db.prepare(`
        SELECT p.manifest_json, p.thumbnail_artifact_name
        ${fromSql}
        ${queueGroupOrderSql("p", group)}
        LIMIT $limit OFFSET $offset
      `).all({
        ...params,
        limit,
        offset
      }) as ProjectIndexRow[];

  const parsedRows = rows.map((row) => ({
    manifest: JSON.parse(row.manifest_json) as ProjectManifest,
    thumbnailArtifactName: row.thumbnail_artifact_name ? row.thumbnail_artifact_name : null
  }));
  if (priorityOrdered) {
    parsedRows.sort((a, b) => compareQueueBucketRows(a.manifest, b.manifest, group));
  }
  const pagedRows = priorityOrdered ? parsedRows.slice(offset, offset + limit) : parsedRows;

  const nextOffset = offset + pagedRows.length;
  return {
    group,
    count,
    rows: pagedRows,
    pagination: {
      limit,
      offset,
      next_offset: nextOffset < count ? nextOffset : null,
      has_more: nextOffset < count
    },
    version: readQueueVersion(db)
  };
}

export async function readIndexedQueueChanges(query: QueueChangesQuery = {}) {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).readPostgresQueueChanges(query);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const since = Math.max(0, Math.floor(Number(query.since ?? 0)));
  const limit = Math.min(Math.max(Math.floor(Number(query.limit ?? 250)), 1), 1000);
  const params: SqlParams = { since, limit };
  const where = ["version > $since"];
  if (query.team_id) {
    where.push("team_id = $teamId");
    params.teamId = String(query.team_id).trim();
  }
  const rows = db.prepare(`
    SELECT version, project_id, event_type, status, previous_status, queue_group, previous_queue_group,
      team_id, actor_email, created_at, payload_json
    FROM project_queue_events
    WHERE ${where.join("\n      AND ")}
    ORDER BY version ASC
    LIMIT $limit
  `).all(params) as Array<Record<string, unknown>>;
  const currentVersion = readQueueVersion(db);
  return {
    since,
    version: currentVersion,
    has_more: rows.length === limit && Number(rows[rows.length - 1]?.version ?? 0) < currentVersion,
    changes: rows.map((row) => ({
      version: Number(row.version ?? 0),
      project_id: String(row.project_id ?? ""),
      event_type: String(row.event_type ?? ""),
      status: String(row.status ?? ""),
      previous_status: String(row.previous_status ?? "") || null,
      queue_group: String(row.queue_group ?? ""),
      previous_queue_group: String(row.previous_queue_group ?? "") || null,
      team_id: String(row.team_id ?? ""),
      actor_email: String(row.actor_email ?? "") || null,
      created_at: String(row.created_at ?? ""),
      payload: parseJsonObject(row.payload_json)
    }))
  };
}

export async function isFirstDeliveredReportForIssuer(manifest: ProjectManifest): Promise<boolean> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).isFirstPostgresDeliveredReportForIssuer(manifest);
  }
  await ensureFirstMeasureProjectIndexReady();
  const issuerEmail = normalizeEmail(asRecord(manifest.issuer).email);
  const projectId = readString(manifest.id);
  if (!issuerEmail || !projectId) {
    return false;
  }

  const db = getFirstMeasureProjectIndexDb();
  const rows = db.prepare(`
    SELECT manifest_json
    FROM projects
    WHERE issuer_email = $issuerEmail
      AND status = 'completed'
      AND has_report_pdf = 1
      AND is_filler = 0
    ORDER BY completed_at_ms ASC, updated_at_ms ASC, id ASC
  `).all({
    issuerEmail
  }) as Array<{ manifest_json?: string }>;

  let earliestDeliveredProjectId = "";
  let earliestDeliveredAtMs = Number.MAX_SAFE_INTEGER;
  let currentDeliveredAtMs = 0;

  for (const row of rows) {
    if (!row.manifest_json) {
      continue;
    }

    let candidate: ProjectManifest;
    try {
      candidate = JSON.parse(row.manifest_json) as ProjectManifest;
    } catch {
      continue;
    }

    const candidateId = readString(candidate.id);
    const deliveredAtMs = readSuccessfulReportDeliveryTimestamp(candidate);
    if (!candidateId || !deliveredAtMs) {
      continue;
    }

    if (
      deliveredAtMs < earliestDeliveredAtMs
      || (deliveredAtMs === earliestDeliveredAtMs && (!earliestDeliveredProjectId || candidateId < earliestDeliveredProjectId))
    ) {
      earliestDeliveredAtMs = deliveredAtMs;
      earliestDeliveredProjectId = candidateId;
    }

    if (candidateId === projectId) {
      currentDeliveredAtMs = deliveredAtMs;
    }
  }

  if (!currentDeliveredAtMs) {
    return !earliestDeliveredProjectId;
  }

  return earliestDeliveredProjectId === projectId;
}

export async function searchIndexedProjectsForLegacyList(query: LegacyListQuery): Promise<LegacyListResult> {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).searchPostgresProjectsForLegacyList(query);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const joins: string[] = [];
  const where: string[] = ["1 = 1"];
  const params: SqlParams = {};
  const searchText = normalizeProjectSearchText(query.search);
  const searchTokens = tokenizeProjectSearch(query.search);

  appendInstantVisibilityClause(where, params, query.includeInstantOnly);
  appendLegacyVisibilityClause(where, params, query.filter, query.actor);
  appendLegacyStatusClause(where, params, query.statusFilter);
  appendLegacyComplexityClause(where, params, query.complexityFilter);
  appendSearchClauses({
    joins,
    where,
    params,
    rawSearch: query.search,
    alias: "p"
  });
  appendActivityWindowClause({
    where,
    params,
    activityStartMs: query.activityStartMs ?? null,
    activityEndMs: query.activityEndMs ?? null,
    activityFields: query.activityFields
  });

  const fromSql = `
    FROM projects p
    ${joins.join("\n")}
    WHERE ${where.join("\n      AND ")}
  `;

  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    ${fromSql}
  `).get(params) as { count?: number } | undefined;

  const tokenBonus = Math.max(0, 20 - (searchTokens.length * 2));
  const ftsRankSql = projectSearchFtsEnabled ? `bm25(${PROJECT_SEARCH_TABLE_NAME})` : "CASE WHEN 1 = 1 THEN 0 END";
  const orderSql = searchTokens.length > 0
    ? `
      ORDER BY
        (
          CASE
            WHEN p.id_normalized = $searchText THEN 220
            WHEN p.id_normalized LIKE $searchPrefix THEN 140
            WHEN p.id_normalized LIKE $searchContains THEN 80
            ELSE 0
          END
          + CASE
            WHEN p.address_normalized = $searchText THEN 180
            WHEN p.address_normalized LIKE $searchPrefix THEN 130
            WHEN p.address_normalized LIKE $searchContains THEN 90
            ELSE 0
          END
          + CASE
            WHEN p.resident_name_normalized = $searchText THEN 170
            WHEN p.resident_name_normalized LIKE $searchPrefix THEN 120
            WHEN p.resident_name_normalized LIKE $searchContains THEN 95
            ELSE 0
          END
          + CASE
            WHEN p.issuer_name_normalized = $searchText THEN 120
            WHEN p.issuer_name_normalized LIKE $searchPrefix THEN 80
            WHEN p.issuer_name_normalized LIKE $searchContains THEN 55
            ELSE 0
          END
          + CASE
            WHEN p.owner_name_normalized = $searchText THEN 90
            WHEN p.owner_name_normalized LIKE $searchPrefix THEN 60
            WHEN p.owner_name_normalized LIKE $searchContains THEN 40
            ELSE 0
          END
          + $tokenBonus
        ) DESC,
        ${ftsRankSql} ASC,
        p.sort_ts DESC,
        p.updated_at_ms DESC,
        p.id DESC
    `
    : `
      ORDER BY p.sort_ts DESC, p.updated_at_ms DESC, p.id DESC
    `;

  const rows = db.prepare(`
    SELECT p.manifest_json, p.thumbnail_artifact_name
    ${fromSql}
    ${orderSql}
    LIMIT $limit OFFSET $offset
  `).all({
    ...params,
    ...(searchTokens.length > 0 ? {
      searchText,
      searchPrefix: `${searchText}%`,
      searchContains: `%${searchText}%`,
      tokenBonus
    } : {}),
    limit: query.limit,
    offset: (query.page - 1) * query.limit
  }) as ProjectIndexRow[];

  return {
    totalCount: Number(countRow?.count ?? 0),
    rows: rows.map((row) => ({
      manifest: JSON.parse(row.manifest_json) as ProjectManifest,
      thumbnailArtifactName: row.thumbnail_artifact_name ? row.thumbnail_artifact_name : null
    }))
  };
}

export async function readIndexedProjectArtifactState(projectId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    return (await postgresIndex()).readPostgresProjectArtifactState(projectId);
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const row = db.prepare(`
    SELECT
      has_insights,
      has_pdf_state,
      has_report_pdf,
      has_summary_pdf,
      has_model_data,
      has_google_image,
      has_mask_tif,
      has_dsm_tif
    FROM projects
    WHERE id = $id
    LIMIT 1
  `).get({
    id: projectId
  }) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  return {
    has_insights: Boolean(row.has_insights),
    has_pdf_state: Boolean(row.has_pdf_state),
    has_report_pdf: Boolean(row.has_report_pdf),
    has_main_pdf: Boolean(row.has_report_pdf),
    has_summary_pdf: Boolean(row.has_summary_pdf),
    has_model_data: Boolean(row.has_model_data),
    has_google_image: Boolean(row.has_google_image),
    has_mask_tif: Boolean(row.has_mask_tif),
    has_dsm_tif: Boolean(row.has_dsm_tif)
  };
}

export async function upsertProjectIndex(
  manifest: ProjectManifest,
  options?: {
    storagePath?: string;
    fileNames?: string[];
    artifactFileName?: string | null;
  }
) {
  if (isFirstMeasurePostgresEnabled()) {
    await (await postgresIndex()).upsertPostgresProjectIndex(manifest, options);
    return;
  }
  await ensureFirstMeasureProjectIndexReady();
  const db = getFirstMeasureProjectIndexDb();
  const current = db.prepare(`
    SELECT
      thumbnail_artifact_name,
      id,
      status,
      team_id,
      assigned_to_email,
      reserved_to_email,
      correction_to_email,
      qa_claimed_by_email,
      address,
      owner_name,
      owner_email,
      assigned_to_name,
      issuer_name,
      issuer_email,
      resident_name,
      resident_email,
      resident_phone
    FROM projects
    WHERE id = $id
    LIMIT 1
  `).get({
    id: manifest.id
  }) as ({ thumbnail_artifact_name?: string } & Partial<ProjectIndexQueueSnapshot> & Record<string, unknown>) | undefined;

  const indexed = buildIndexedProjectDocument(manifest, {
    currentThumbnailArtifactName: current?.thumbnail_artifact_name ?? "",
    storagePath: options?.storagePath,
    fileNames: options?.fileNames,
    artifactFileName: options?.artifactFileName ?? ""
  });
  const sqliteIndexed = { ...indexed } as Record<string, SQLInputValue>;
  for (const postgresOnlyColumn of [
    "force_kick_email", "force_kick_acknowledged"
  ]) {
    delete sqliteIndexed[postgresOnlyColumn];
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO projects (
        id, manifest_json, storage_path, schema_version, status, project_type, address, address_normalized,
        id_normalized, owner_name, owner_name_normalized, owner_email, issuer_name, issuer_name_normalized,
        issuer_email, resident_name, resident_name_normalized, resident_email, resident_phone, organization_id,
        team_id, assigned_to_name, assigned_to_email, reserved_to_name, reserved_to_email, correction_to_name,
        correction_to_email, qa_claimed_by_name, qa_claimed_by_email, complexity, amount_charged, is_filler,
        is_vip, is_expedited, instant_enabled, instant_only, include_gutter_measurements, has_insights, has_pdf_state, has_report_pdf, has_summary_pdf,
        has_model_data, has_google_image, has_mask_tif, has_dsm_tif, thumbnail_artifact_name, created_at,
        queued_at, processed_at, started_at, uploaded_at, completed_at, rejected_at, cancelled_at, updated_at,
        created_at_ms, queued_at_ms, processed_at_ms, started_at_ms, uploaded_at_ms, completed_at_ms,
        rejected_at_ms, cancelled_at_ms, updated_at_ms, sort_ts, search_text,
        queue_group, queue_priority, queue_order_ms, delivery_hold_status
      ) VALUES (
        $id, $manifest_json, $storage_path, $schema_version, $status, $project_type, $address, $address_normalized,
        $id_normalized, $owner_name, $owner_name_normalized, $owner_email, $issuer_name, $issuer_name_normalized,
        $issuer_email, $resident_name, $resident_name_normalized, $resident_email, $resident_phone, $organization_id,
        $team_id, $assigned_to_name, $assigned_to_email, $reserved_to_name, $reserved_to_email, $correction_to_name,
        $correction_to_email, $qa_claimed_by_name, $qa_claimed_by_email, $complexity, $amount_charged, $is_filler,
        $is_vip, $is_expedited, $instant_enabled, $instant_only, $include_gutter_measurements, $has_insights, $has_pdf_state, $has_report_pdf, $has_summary_pdf,
        $has_model_data, $has_google_image, $has_mask_tif, $has_dsm_tif, $thumbnail_artifact_name, $created_at,
        $queued_at, $processed_at, $started_at, $uploaded_at, $completed_at, $rejected_at, $cancelled_at, $updated_at,
        $created_at_ms, $queued_at_ms, $processed_at_ms, $started_at_ms, $uploaded_at_ms, $completed_at_ms,
        $rejected_at_ms, $cancelled_at_ms, $updated_at_ms, $sort_ts, $search_text,
        $queue_group, $queue_priority, $queue_order_ms, $delivery_hold_status
      )
      ON CONFLICT(id) DO UPDATE SET
        manifest_json = excluded.manifest_json,
        storage_path = excluded.storage_path,
        schema_version = excluded.schema_version,
        status = excluded.status,
        project_type = excluded.project_type,
        address = excluded.address,
        address_normalized = excluded.address_normalized,
        id_normalized = excluded.id_normalized,
        owner_name = excluded.owner_name,
        owner_name_normalized = excluded.owner_name_normalized,
        owner_email = excluded.owner_email,
        issuer_name = excluded.issuer_name,
        issuer_name_normalized = excluded.issuer_name_normalized,
        issuer_email = excluded.issuer_email,
        resident_name = excluded.resident_name,
        resident_name_normalized = excluded.resident_name_normalized,
        resident_email = excluded.resident_email,
        resident_phone = excluded.resident_phone,
        organization_id = excluded.organization_id,
        team_id = excluded.team_id,
        assigned_to_name = excluded.assigned_to_name,
        assigned_to_email = excluded.assigned_to_email,
        reserved_to_name = excluded.reserved_to_name,
        reserved_to_email = excluded.reserved_to_email,
        correction_to_name = excluded.correction_to_name,
        correction_to_email = excluded.correction_to_email,
        qa_claimed_by_name = excluded.qa_claimed_by_name,
        qa_claimed_by_email = excluded.qa_claimed_by_email,
        complexity = excluded.complexity,
        amount_charged = excluded.amount_charged,
        is_filler = excluded.is_filler,
        is_vip = excluded.is_vip,
        is_expedited = excluded.is_expedited,
        instant_enabled = excluded.instant_enabled,
        instant_only = excluded.instant_only,
        include_gutter_measurements = excluded.include_gutter_measurements,
        has_insights = excluded.has_insights,
        has_pdf_state = excluded.has_pdf_state,
        has_report_pdf = excluded.has_report_pdf,
        has_summary_pdf = excluded.has_summary_pdf,
        has_model_data = excluded.has_model_data,
        has_google_image = excluded.has_google_image,
        has_mask_tif = excluded.has_mask_tif,
        has_dsm_tif = excluded.has_dsm_tif,
        thumbnail_artifact_name = excluded.thumbnail_artifact_name,
        created_at = excluded.created_at,
        queued_at = excluded.queued_at,
        processed_at = excluded.processed_at,
        started_at = excluded.started_at,
        uploaded_at = excluded.uploaded_at,
        completed_at = excluded.completed_at,
        rejected_at = excluded.rejected_at,
        cancelled_at = excluded.cancelled_at,
        updated_at = excluded.updated_at,
        created_at_ms = excluded.created_at_ms,
        queued_at_ms = excluded.queued_at_ms,
        processed_at_ms = excluded.processed_at_ms,
        started_at_ms = excluded.started_at_ms,
        uploaded_at_ms = excluded.uploaded_at_ms,
        completed_at_ms = excluded.completed_at_ms,
        rejected_at_ms = excluded.rejected_at_ms,
        cancelled_at_ms = excluded.cancelled_at_ms,
        updated_at_ms = excluded.updated_at_ms,
        sort_ts = excluded.sort_ts,
        search_text = excluded.search_text,
        queue_group = excluded.queue_group,
        queue_priority = excluded.queue_priority,
        queue_order_ms = excluded.queue_order_ms,
        delivery_hold_status = excluded.delivery_hold_status
    `).run(sqliteIndexed);

    if (projectSearchFtsEnabled && projectSearchFieldsChanged(current, indexed)) {
      db.prepare(`
        DELETE FROM ${PROJECT_SEARCH_TABLE_NAME}
        WHERE project_id = $project_id
      `).run({
        project_id: indexed.id
      });

      db.prepare(`
        INSERT INTO ${PROJECT_SEARCH_TABLE_NAME} (
          project_id, id, address, owner_name, owner_email, assigned_to_name, assigned_to_email,
          issuer_name, issuer_email, resident_name, resident_email, resident_phone
        ) VALUES (
          $project_id, $id, $address, $owner_name, $owner_email, $assigned_to_name, $assigned_to_email,
          $issuer_name, $issuer_email, $resident_name, $resident_email, $resident_phone
        )
      `).run({
        project_id: indexed.id,
        id: indexed.id,
        address: indexed.address,
        owner_name: indexed.owner_name,
        owner_email: indexed.owner_email,
        assigned_to_name: indexed.assigned_to_name,
        assigned_to_email: indexed.assigned_to_email,
        issuer_name: indexed.issuer_name,
        issuer_email: indexed.issuer_email,
        resident_name: indexed.resident_name,
        resident_email: indexed.resident_email,
        resident_phone: indexed.resident_phone
      });
    }

    const eventVersion = recordProjectQueueEvent(db, current ?? null, indexed);
    if (eventVersion !== null && eventVersion % 500 === 0) {
      pruneProjectQueueEvents(db);
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function initializeProjectIndex() {
  const dbPath = resolveFirstMeasureIndexDbPath();
  await mkdir(path.dirname(dbPath), { recursive: true });

  if (!dbInstance) {
    dbInstance = new DatabaseSync(dbPath);
    const configuredBusyTimeoutMs = Number(process.env.FIRSTMEASURE_SQLITE_BUSY_TIMEOUT_MS ?? 15_000);
    const busyTimeoutMs = Number.isFinite(configuredBusyTimeoutMs)
      ? Math.max(0, Math.floor(configuredBusyTimeoutMs))
      : 15_000;
    dbInstance.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    dbInstance.exec("PRAGMA journal_mode = WAL");
    dbInstance.exec("PRAGMA synchronous = NORMAL");
    dbInstance.exec("PRAGMA temp_store = MEMORY");
    initializeProjectIndexSchema(dbInstance);
    backfillMaterializedQueueFields(dbInstance);
  }

  const db = getFirstMeasureProjectIndexDb();
  const backfillState = db.prepare(`
    SELECT value
    FROM project_index_meta
    WHERE key = $key
    LIMIT 1
  `).get({
    key: INDEX_BACKFILL_META_KEY
  }) as { value?: string } | undefined;

  if (backfillState?.value === "1") {
    return;
  }

  const startedAt = new Date().toISOString();
  const indexedProjects = await backfillProjectIndexFromDisk(db);
  writeProjectIndexMeta(db, {
    [INDEX_BACKFILL_META_KEY]: "1",
    [LAST_REBUILD_STARTED_AT_META_KEY]: startedAt,
    [LAST_REBUILD_FINISHED_AT_META_KEY]: new Date().toISOString(),
    [LAST_REBUILD_COUNT_META_KEY]: String(indexedProjects)
  });
}

function initializeProjectIndexSchema(db: DatabaseSync) {
  if (isCurrentProjectIndexSchema(db)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isCurrentProjectIndexSchema(db)) {
      initializeProjectIndexSchemaUnderLock(db);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function isCurrentProjectIndexSchema(db: DatabaseSync) {
  try {
    const state = db.prepare(`
      SELECT value FROM project_index_meta WHERE key = 'schema_version' LIMIT 1
    `).get() as { value?: string } | undefined;
    if (state?.value !== String(PROJECT_INDEX_SCHEMA_VERSION)) return false;
    const fts = db.prepare(`
      SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = $name LIMIT 1
    `).get({ name: PROJECT_SEARCH_TABLE_NAME }) as { found?: number } | undefined;
    projectSearchFtsEnabled = Boolean(fts?.found);
    return true;
  } catch {
    return false;
  }
}

function initializeProjectIndexSchemaUnderLock(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_queue_events (
      version INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      previous_status TEXT NOT NULL DEFAULT '',
      queue_group TEXT NOT NULL,
      previous_queue_group TEXT NOT NULL DEFAULT '',
      team_id TEXT NOT NULL DEFAULT '',
      actor_email TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      manifest_json TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      project_type TEXT NOT NULL,
      address TEXT NOT NULL,
      address_normalized TEXT NOT NULL,
      id_normalized TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      owner_name_normalized TEXT NOT NULL,
      owner_email TEXT NOT NULL,
      issuer_name TEXT NOT NULL,
      issuer_name_normalized TEXT NOT NULL,
      issuer_email TEXT NOT NULL,
      resident_name TEXT NOT NULL,
      resident_name_normalized TEXT NOT NULL,
      resident_email TEXT NOT NULL,
      resident_phone TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      team_id TEXT NOT NULL,
      assigned_to_name TEXT NOT NULL,
      assigned_to_email TEXT NOT NULL,
      reserved_to_name TEXT NOT NULL,
      reserved_to_email TEXT NOT NULL,
      correction_to_name TEXT NOT NULL,
      correction_to_email TEXT NOT NULL,
      qa_claimed_by_name TEXT NOT NULL,
      qa_claimed_by_email TEXT NOT NULL,
      complexity TEXT NOT NULL,
      amount_charged REAL NOT NULL DEFAULT 0,
      is_filler INTEGER NOT NULL DEFAULT 0,
      is_vip INTEGER NOT NULL DEFAULT 0,
      is_expedited INTEGER NOT NULL DEFAULT 0,
      instant_enabled INTEGER NOT NULL DEFAULT 0,
      instant_only INTEGER NOT NULL DEFAULT 0,
      include_gutter_measurements INTEGER NOT NULL DEFAULT 0,
      has_insights INTEGER NOT NULL DEFAULT 0,
      has_pdf_state INTEGER NOT NULL DEFAULT 0,
      has_report_pdf INTEGER NOT NULL DEFAULT 0,
      has_summary_pdf INTEGER NOT NULL DEFAULT 0,
      has_model_data INTEGER NOT NULL DEFAULT 0,
      has_google_image INTEGER NOT NULL DEFAULT 0,
      has_mask_tif INTEGER NOT NULL DEFAULT 0,
      has_dsm_tif INTEGER NOT NULL DEFAULT 0,
      thumbnail_artifact_name TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      queued_at TEXT NOT NULL DEFAULT '',
      processed_at TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      rejected_at TEXT NOT NULL DEFAULT '',
      cancelled_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL DEFAULT 0,
      queued_at_ms INTEGER NOT NULL DEFAULT 0,
      processed_at_ms INTEGER NOT NULL DEFAULT 0,
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      uploaded_at_ms INTEGER NOT NULL DEFAULT 0,
      completed_at_ms INTEGER NOT NULL DEFAULT 0,
      rejected_at_ms INTEGER NOT NULL DEFAULT 0,
      cancelled_at_ms INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL DEFAULT 0,
      sort_ts INTEGER NOT NULL DEFAULT 0,
      search_text TEXT NOT NULL DEFAULT '',
      queue_group TEXT NOT NULL DEFAULT '',
      queue_priority INTEGER NOT NULL DEFAULT 3,
      queue_order_ms INTEGER NOT NULL DEFAULT 0,
      delivery_hold_status TEXT NOT NULL DEFAULT ''
    );

  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${PROJECT_SEARCH_TABLE_NAME}
      USING fts5(
        project_id UNINDEXED,
        id,
        address,
        owner_name,
        owner_email,
        assigned_to_name,
        assigned_to_email,
        issuer_name,
        issuer_email,
        resident_name,
        resident_email,
        resident_phone,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    projectSearchFtsEnabled = true;
  } catch {
    projectSearchFtsEnabled = false;
  }

  ensureProjectIndexColumn(db, "instant_enabled", "ALTER TABLE projects ADD COLUMN instant_enabled INTEGER NOT NULL DEFAULT 0");
  ensureProjectIndexColumn(db, "instant_only", "ALTER TABLE projects ADD COLUMN instant_only INTEGER NOT NULL DEFAULT 0");
  ensureProjectIndexColumn(db, "is_expedited", "ALTER TABLE projects ADD COLUMN is_expedited INTEGER NOT NULL DEFAULT 0");
  ensureProjectIndexColumn(db, "queue_group", "ALTER TABLE projects ADD COLUMN queue_group TEXT NOT NULL DEFAULT ''");
  ensureProjectIndexColumn(db, "queue_priority", "ALTER TABLE projects ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 3");
  ensureProjectIndexColumn(db, "queue_order_ms", "ALTER TABLE projects ADD COLUMN queue_order_ms INTEGER NOT NULL DEFAULT 0");
  ensureProjectIndexColumn(db, "delivery_hold_status", "ALTER TABLE projects ADD COLUMN delivery_hold_status TEXT NOT NULL DEFAULT ''");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_projects_status_sort
      ON projects (status, sort_ts DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_org_status_sort
      ON projects (organization_id, status, sort_ts DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_team_status_sort
      ON projects (team_id, status, sort_ts DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_owner_email_sort
      ON projects (owner_email, sort_ts DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_instant_only_sort
      ON projects (instant_only, sort_ts DESC, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_qa_candidates
      ON projects (instant_only, status, sort_ts DESC, updated_at_ms DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_team_qa_candidates
      ON projects (team_id, instant_only, status, sort_ts DESC, updated_at_ms DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_queue_group
      ON projects (queue_group, instant_only, team_id, queue_priority, queue_order_ms, id);
    CREATE INDEX IF NOT EXISTS idx_projects_queue_counts
      ON projects (instant_only, team_id, queue_group);
    CREATE INDEX IF NOT EXISTS idx_projects_assigned_status
      ON projects (assigned_to_email, status, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_reserved_status
      ON projects (reserved_to_email, status, updated_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_address_normalized
      ON projects (address_normalized);
    CREATE INDEX IF NOT EXISTS idx_projects_started_at_ms
      ON projects (started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_uploaded_at_ms
      ON projects (uploaded_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_completed_at_ms
      ON projects (completed_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_rejected_at_ms
      ON projects (rejected_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_projects_cancelled_at_ms
      ON projects (cancelled_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_project_queue_events_project
      ON project_queue_events (project_id, version DESC);
    CREATE INDEX IF NOT EXISTS idx_project_queue_events_team_version
      ON project_queue_events (team_id, version ASC);
  `);

  writeProjectIndexMeta(db, {
    schema_version: String(PROJECT_INDEX_SCHEMA_VERSION)
  });
}

function ensureProjectIndexColumn(db: DatabaseSync, columnName: string, sql: string) {
  const columns = db.prepare("PRAGMA table_info(projects)").all() as Array<{ name?: string }>;
  if (columns.some((column) => String(column.name ?? "") === columnName)) {
    return;
  }
  db.exec(sql);
}

function backfillMaterializedQueueFields(db: DatabaseSync) {
  const initialState = db.prepare(`
    SELECT value FROM project_index_meta WHERE key = $key LIMIT 1
  `).get({ key: QUEUE_FIELDS_BACKFILL_META_KEY }) as { value?: string } | undefined;
  if (initialState?.value === "1") return;
  const initialRunningSince = String(initialState?.value ?? "").startsWith("running:")
    ? Number(String(initialState?.value).slice("running:".length))
    : 0;
  if (Number.isFinite(initialRunningSince) && initialRunningSince > Date.now() - QUEUE_FIELDS_BACKFILL_LEASE_MS) {
    return;
  }

  let ownsBackfill = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const state = db.prepare(`
      SELECT value FROM project_index_meta WHERE key = $key LIMIT 1
    `).get({ key: QUEUE_FIELDS_BACKFILL_META_KEY }) as { value?: string } | undefined;
    if (state?.value === "1") {
      db.exec("COMMIT");
      return;
    }
    const runningSince = String(state?.value ?? "").startsWith("running:")
      ? Number(String(state?.value).slice("running:".length))
      : 0;
    if (Number.isFinite(runningSince) && runningSince > Date.now() - QUEUE_FIELDS_BACKFILL_LEASE_MS) {
      db.exec("COMMIT");
      return;
    }
    writeProjectIndexMeta(db, {
      [QUEUE_FIELDS_BACKFILL_META_KEY]: `running:${Date.now()}`
    });
    ownsBackfill = true;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (!ownsBackfill) return;

  let updatedRows = 0;
  let failedRows = 0;
  console.info("FirstMeasure SQLite queue-field backfill started.");

  const selectBatch = db.prepare(`
    SELECT manifest_json, storage_path, thumbnail_artifact_name
    FROM projects
    WHERE queue_group = ''
    ORDER BY id
    LIMIT 250
  `);
  const update = db.prepare(`
    UPDATE projects
    SET queue_group = $queue_group,
      queue_priority = $queue_priority,
      queue_order_ms = $queue_order_ms,
      delivery_hold_status = $delivery_hold_status
    WHERE id = $id
  `);

  while (true) {
    const rows = selectBatch.all() as Array<{
      manifest_json?: string;
      storage_path?: string;
      thumbnail_artifact_name?: string;
    }>;
    if (!rows.length) break;
    let batchUpdatedRows = 0;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        try {
          const manifest = JSON.parse(String(row.manifest_json ?? "")) as ProjectManifest;
          const indexed = buildIndexedProjectDocument(manifest, {
            currentThumbnailArtifactName: String(row.thumbnail_artifact_name ?? ""),
            storagePath: String(row.storage_path ?? ""),
            artifactFileName: ""
          });
          update.run({
            id: indexed.id,
            queue_group: String(indexed.queue_group || "__none"),
            queue_priority: indexed.queue_priority,
            queue_order_ms: indexed.queue_order_ms,
            delivery_hold_status: indexed.delivery_hold_status
          });
          batchUpdatedRows += 1;
        } catch {
          // A malformed legacy row remains on the compatibility query path.
          failedRows += 1;
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    updatedRows += batchUpdatedRows;
    if (updatedRows > 0 && updatedRows % 2_500 === 0) {
      console.info(`FirstMeasure SQLite queue-field backfill updated ${updatedRows} rows.`);
    }
    if (batchUpdatedRows === 0) {
      console.error(`FirstMeasure SQLite queue-field backfill stopped after a batch made no progress (${failedRows} failed rows).`);
      break;
    }
    if (rows.length < 250) break;
  }

  const remaining = db.prepare(`SELECT COUNT(*) AS count FROM projects WHERE queue_group = ''`).get() as { count?: number };
  if (Number(remaining.count ?? 0) === 0) {
    writeProjectIndexMeta(db, { [QUEUE_FIELDS_BACKFILL_META_KEY]: "1" });
  }
  console.info(`FirstMeasure SQLite queue-field backfill finished: ${updatedRows} updated, ${failedRows} failed, ${Number(remaining.count ?? 0)} remaining.`);
}

async function backfillProjectIndexFromDisk(db: DatabaseSync) {
  const projectsRoot = resolveFirstMeasureProjectsRoot();
  await mkdir(projectsRoot, { recursive: true });
  let indexedProjects = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`DELETE FROM projects`).run();
    if (projectSearchFtsEnabled) {
      db.prepare(`DELETE FROM ${PROJECT_SEARCH_TABLE_NAME}`).run();
    }

    const stack: string[] = [projectsRoot];
    while (stack.length > 0) {
      const currentDir = stack.pop();
      if (!currentDir) {
        continue;
      }

      const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
      const fileNames = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
      if (fileNames.includes(FIRSTMEASURE_FILE_NAMES.manifest)) {
        const manifestPath = path.join(currentDir, FIRSTMEASURE_FILE_NAMES.manifest);
        const raw = await readFile(manifestPath, "utf8").catch(() => null);
        if (!raw) {
          continue;
        }

        try {
          const manifest = JSON.parse(raw) as ProjectManifest;
          const indexed = buildIndexedProjectDocument(manifest, {
            currentThumbnailArtifactName: "",
            storagePath: currentDir,
            fileNames,
            artifactFileName: ""
          });
          db.prepare(`
            INSERT INTO projects (
              id, manifest_json, storage_path, schema_version, status, project_type, address, address_normalized,
              id_normalized, owner_name, owner_name_normalized, owner_email, issuer_name, issuer_name_normalized,
              issuer_email, resident_name, resident_name_normalized, resident_email, resident_phone, organization_id,
              team_id, assigned_to_name, assigned_to_email, reserved_to_name, reserved_to_email, correction_to_name,
              correction_to_email, qa_claimed_by_name, qa_claimed_by_email, complexity, amount_charged, is_filler,
              is_vip, is_expedited, instant_enabled, instant_only, include_gutter_measurements, has_insights, has_pdf_state, has_report_pdf, has_summary_pdf,
              has_model_data, has_google_image, has_mask_tif, has_dsm_tif, thumbnail_artifact_name, created_at,
              queued_at, processed_at, started_at, uploaded_at, completed_at, rejected_at, cancelled_at, updated_at,
              created_at_ms, queued_at_ms, processed_at_ms, started_at_ms, uploaded_at_ms, completed_at_ms,
              rejected_at_ms, cancelled_at_ms, updated_at_ms, sort_ts, search_text,
              queue_group, queue_priority, queue_order_ms, delivery_hold_status
            ) VALUES (
              $id, $manifest_json, $storage_path, $schema_version, $status, $project_type, $address, $address_normalized,
              $id_normalized, $owner_name, $owner_name_normalized, $owner_email, $issuer_name, $issuer_name_normalized,
              $issuer_email, $resident_name, $resident_name_normalized, $resident_email, $resident_phone, $organization_id,
              $team_id, $assigned_to_name, $assigned_to_email, $reserved_to_name, $reserved_to_email, $correction_to_name,
              $correction_to_email, $qa_claimed_by_name, $qa_claimed_by_email, $complexity, $amount_charged, $is_filler,
              $is_vip, $is_expedited, $instant_enabled, $instant_only, $include_gutter_measurements, $has_insights, $has_pdf_state, $has_report_pdf, $has_summary_pdf,
              $has_model_data, $has_google_image, $has_mask_tif, $has_dsm_tif, $thumbnail_artifact_name, $created_at,
              $queued_at, $processed_at, $started_at, $uploaded_at, $completed_at, $rejected_at, $cancelled_at, $updated_at,
              $created_at_ms, $queued_at_ms, $processed_at_ms, $started_at_ms, $uploaded_at_ms, $completed_at_ms,
              $rejected_at_ms, $cancelled_at_ms, $updated_at_ms, $sort_ts, $search_text,
              $queue_group, $queue_priority, $queue_order_ms, $delivery_hold_status
            )
          `).run(indexed);

          if (projectSearchFtsEnabled) {
            db.prepare(`
              INSERT INTO ${PROJECT_SEARCH_TABLE_NAME} (
                project_id, id, address, owner_name, owner_email, assigned_to_name, assigned_to_email,
                issuer_name, issuer_email, resident_name, resident_email, resident_phone
              ) VALUES (
                $project_id, $id, $address, $owner_name, $owner_email, $assigned_to_name, $assigned_to_email,
                $issuer_name, $issuer_email, $resident_name, $resident_email, $resident_phone
              )
            `).run({
              project_id: indexed.id,
              id: indexed.id,
              address: indexed.address,
              owner_name: indexed.owner_name,
              owner_email: indexed.owner_email,
              assigned_to_name: indexed.assigned_to_name,
              assigned_to_email: indexed.assigned_to_email,
              issuer_name: indexed.issuer_name,
              issuer_email: indexed.issuer_email,
              resident_name: indexed.resident_name,
              resident_email: indexed.resident_email,
              resident_phone: indexed.resident_phone
            });
          }

          indexedProjects += 1;
        } catch {
          continue;
        }

        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (entry.name === "manifest_backups") {
          continue;
        }
        stack.push(path.join(currentDir, entry.name));
      }
    }

    db.exec("COMMIT");
    return indexedProjects;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function resolveFirstMeasureProjectsRoot() {
  return path.resolve(process.cwd(), env.firstmeasureStorageRoot, "projects");
}

export function buildIndexedProjectDocument(
  manifest: ProjectManifest,
  options: {
    currentThumbnailArtifactName: string;
    storagePath?: string;
    fileNames?: string[];
    artifactFileName: string;
  }
): IndexedProjectDocument {
  // Rebuilds and PostgreSQL cutovers must not resurrect a project whose JSON
  // still carries explicit cancellation/rejection evidence with a stale active
  // status. This is deliberately narrower than age/payment heuristics.
  enforceProjectLifecycleStatus(manifest);
  const workflow = asRecord(manifest.workflow);
  const timestamps = asRecord(manifest.timestamps);
  const ownerRef = asRecord(manifest.owner_ref);
  const organizationRef = asRecord(manifest.organization_ref);
  const teamRef = asRecord(manifest.team_ref);
  const assigned = asRecord(workflow.assigned_to);
  const reserved = asRecord(workflow.reserved_to);
  const correction = asRecord(workflow.correction_to);
  const qaClaim = asRecord(workflow.qa_claim);
  const resident = asRecord(manifest.resident);
  const issuer = asRecord(manifest.issuer);
  const artifactState = buildArtifactState(
    asRecord(manifest.artifacts),
    options.fileNames,
    options.currentThumbnailArtifactName,
    options.artifactFileName
  );
  const manifestForIndex: ProjectManifest = {
    ...manifest,
    artifacts: artifactState.artifacts
  };
  const ownerName = readString((manifest as Record<string, unknown>).owner_name) || readString(ownerRef.name);
  const ownerEmail = normalizeEmail((manifest as Record<string, unknown>).owner_email ?? ownerRef.email);
  const issuerName = readString(issuer.name);
  const issuerEmail = normalizeEmail(issuer.email);
  const residentName = readString(resident.name);
  const residentEmail = normalizeEmail(resident.email);
  const residentPhone = normalizeProjectSearchText(resident.phone);
  const assignedName = readString((manifest as Record<string, unknown>).assigned_to_name) || readString(assigned.name);
  const assignedEmail = normalizeEmail((manifest as Record<string, unknown>).assigned_to_email ?? assigned.email);
  const reservedName = readString((manifest as Record<string, unknown>).reserved_to_name) || readString(reserved.name);
  const reservedEmail = normalizeEmail((manifest as Record<string, unknown>).reserved_to_email ?? reserved.email);
  const correctionName = readString((manifest as Record<string, unknown>).correction_to_name) || readString(correction.name);
  const correctionEmail = normalizeEmail((manifest as Record<string, unknown>).correction_to_email ?? correction.email);
  const qaClaimedName = readString((manifest as Record<string, unknown>).qa_claimed_by_name) || readString(qaClaim.name);
  const qaClaimedEmail = normalizeEmail((manifest as Record<string, unknown>).qa_claimed_by_email ?? qaClaim.email);
  const createdAt = readString((manifest as Record<string, unknown>).created_at) || readString(timestamps.created_at);
  const queuedAt = readString((manifest as Record<string, unknown>).queued_at) || readString(timestamps.queued_at);
  const processedAt = readString((manifest as Record<string, unknown>).processed_at) || readString(timestamps.processed_at);
  const startedAt = readString((manifest as Record<string, unknown>).started_at) || readString(timestamps.started_at);
  const uploadedAt = readString((manifest as Record<string, unknown>).uploaded_at) || readString(timestamps.uploaded_at);
  const completedAt = readString((manifest as Record<string, unknown>).completed_at) || readString(timestamps.completed_at);
  const rejectedAt = readString((manifest as Record<string, unknown>).rejected_at) || readString(timestamps.rejected_at);
  const cancelledAt = readString((manifest as Record<string, unknown>).cancelled_at) || readString(timestamps.cancelled_at);
  const updatedAt = readString((manifest as Record<string, unknown>).updated_at) || readString(timestamps.updated_at);
  const sortSource = completedAt || uploadedAt || createdAt;
  const queuePriority = indexedQueuePriority(manifest);
  const queueGroup = indexedQueueGroup(manifest, {
    status: String(manifest.status ?? ""),
    assignedToEmail: assignedEmail,
    qaClaimedByEmail: qaClaimedEmail,
    queuePriority
  });
  const forceKick = asRecord((manifest as Record<string, unknown>).force_kick);
  const delivery = asRecord((manifest as Record<string, unknown>).delivery);
  const releaseHold = asRecord(delivery.release_hold);
  const deliveryHoldStatus = readString(
    (manifest as Record<string, unknown>).delivery_hold_status ?? releaseHold.status
  ).toLowerCase();

  return {
    id: String(manifest.id ?? "").trim(),
    manifest_json: JSON.stringify(manifestForIndex),
    storage_path: options.storagePath ?? "",
    schema_version: Number(manifest.schema_version ?? PROJECT_INDEX_SCHEMA_VERSION),
    status: String(manifest.status ?? ""),
    project_type: String(manifest.project_type ?? ""),
    address: String(manifest.address ?? ""),
    address_normalized: normalizeProjectSearchText(manifest.address),
    id_normalized: normalizeProjectSearchText(manifest.id),
    owner_name: ownerName,
    owner_name_normalized: normalizeProjectSearchText(ownerName),
    owner_email: ownerEmail,
    issuer_name: issuerName,
    issuer_name_normalized: normalizeProjectSearchText(issuerName),
    issuer_email: issuerEmail,
    resident_name: residentName,
    resident_name_normalized: normalizeProjectSearchText(residentName),
    resident_email: residentEmail,
    resident_phone: residentPhone,
    organization_id: readString((manifest as Record<string, unknown>).organization_id) || readString(organizationRef.id),
    team_id: readString((manifest as Record<string, unknown>).team_id) || readString(teamRef.id),
    assigned_to_name: assignedName,
    assigned_to_email: assignedEmail,
    reserved_to_name: reservedName,
    reserved_to_email: reservedEmail,
    correction_to_name: correctionName,
    correction_to_email: correctionEmail,
    qa_claimed_by_name: qaClaimedName,
    qa_claimed_by_email: qaClaimedEmail,
    queue_group: queueGroup,
    queue_priority: queuePriority,
    queue_order_ms: indexedQueueOrderMs(queueGroup, {
      createdAt, queuedAt, startedAt, uploadedAt, updatedAt
    }),
    delivery_hold_status: deliveryHoldStatus,
    force_kick_email: normalizeEmail(forceKick.email),
    force_kick_acknowledged: truthyFlag(forceKick.acknowledged) ? 1 : 0,
    complexity: String(manifest.complexity ?? ""),
    amount_charged: typeof manifest.amount_charged === "number" ? manifest.amount_charged : Number(manifest.amount_charged ?? 0) || 0,
    is_filler: manifest.is_filler ? 1 : 0,
    is_vip: manifest.is_vip ? 1 : 0,
    is_expedited: manifest.is_expedited ? 1 : 0,
    instant_enabled: manifest.instant_enabled ? 1 : 0,
    instant_only: manifest.instant_only ? 1 : 0,
    include_gutter_measurements: manifest.include_gutter_measurements ? 1 : 0,
    has_insights: artifactState.artifacts.has_insights ? 1 : 0,
    has_pdf_state: artifactState.artifacts.has_pdf_state ? 1 : 0,
    has_report_pdf: artifactState.artifacts.has_report_pdf ? 1 : 0,
    has_summary_pdf: artifactState.artifacts.has_summary_pdf ? 1 : 0,
    has_model_data: artifactState.artifacts.has_model_data ? 1 : 0,
    has_google_image: artifactState.artifacts.has_google_image ? 1 : 0,
    has_mask_tif: artifactState.artifacts.has_mask_tif ? 1 : 0,
    has_dsm_tif: artifactState.artifacts.has_dsm_tif ? 1 : 0,
    thumbnail_artifact_name: artifactState.thumbnailArtifactName,
    created_at: createdAt,
    queued_at: queuedAt,
    processed_at: processedAt,
    started_at: startedAt,
    uploaded_at: uploadedAt,
    completed_at: completedAt,
    rejected_at: rejectedAt,
    cancelled_at: cancelledAt,
    updated_at: updatedAt,
    created_at_ms: parseTimestamp(createdAt),
    queued_at_ms: parseTimestamp(queuedAt),
    processed_at_ms: parseTimestamp(processedAt),
    started_at_ms: parseTimestamp(startedAt),
    uploaded_at_ms: parseTimestamp(uploadedAt),
    completed_at_ms: parseTimestamp(completedAt),
    rejected_at_ms: parseTimestamp(rejectedAt),
    cancelled_at_ms: parseTimestamp(cancelledAt),
    updated_at_ms: parseTimestamp(updatedAt),
    sort_ts: parseTimestamp(sortSource),
    search_text: normalizeProjectSearchText([
      manifest.id,
      manifest.address,
      manifest.status,
      ownerName,
      ownerEmail,
      assignedName,
      assignedEmail,
      issuerName,
      issuerEmail,
      residentName,
      residentEmail,
      resident.phone
    ].join(" "))
  };
}

export function indexedQueuePriority(manifest: ProjectManifest) {
  const raw = manifest as Record<string, unknown>;
  if (truthyFlag(raw.qa_priority) || truthyFlag(raw.manual_priority) || truthyFlag(raw.prioritized)) return 1;
  const explicit = Number.parseInt(String(raw.priority_level ?? raw.queue_priority_level ?? ""), 10);
  if (explicit === 1) return 1;
  let level = reportExpeditePriorityLevel(
    String(raw.report_expedite_option ?? "").trim().toLowerCase(),
    truthyFlag(raw.is_expedited)
  );
  if (truthyFlag(raw.is_vip)) level = Math.min(level, 2);
  return Math.max(1, Math.min(9, Number.isFinite(level) ? Math.floor(level) : 3));
}

export function indexedQueueGroup(
  manifest: ProjectManifest,
  indexed: { status: string; assignedToEmail: string; qaClaimedByEmail: string; queuePriority?: number }
): FirstMeasureQueueGroup | "" {
  const status = indexed.status;
  if (["rework_requested", "reworking", "customer_rework_requested"].includes(status)) return "rework_requested";
  if (["needs_structure_pins", "structure_pins_required"].includes(status)) return "needs_structure_pins";
  if (["no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"].includes(status)) return "waiting";
  if (["queued", "ready"].includes(status)) return indexed.assignedToEmail ? "in_progress" : "queued";
  if (["requeue", "correction_needed"].includes(status)) return "requeue";
  if (["processing", "in_progress"].includes(status)) return "in_progress";
  if (["awaiting_review", "awaiting_manager_review", "submission_failed"].includes(status)) {
    return indexed.qaClaimedByEmail ? "qa_claimed" : "qa_waiting";
  }
  if (status === "completed") {
    const raw = manifest as Record<string, unknown>;
    const delivery = asRecord(raw.delivery);
    const releaseHold = asRecord(delivery.release_hold);
    const hold = readString(raw.delivery_hold_status ?? releaseHold.status).toLowerCase();
    return hold === "holding" && (indexed.queuePriority ?? indexedQueuePriority(manifest)) !== 1
      ? "release_holding"
      : "completed";
  }
  if (["pending_rejection", "rejected", "rejected_no_coverage"].includes(status)) return "rejected";
  return status === "cancelled" ? "cancelled" : "";
}

function indexedQueueOrderMs(
  group: FirstMeasureQueueGroup | "",
  timestamps: { createdAt: string; queuedAt: string; startedAt: string; uploadedAt: string; updatedAt: string }
) {
  // Active queue buckets keep their priority grouping, but chronological order
  // is based on the immutable customer-order time whenever it is available.
  const candidates = group === "queued"
    ? [timestamps.createdAt, timestamps.queuedAt, timestamps.updatedAt]
    : group === "in_progress"
      ? [timestamps.createdAt, timestamps.startedAt, timestamps.updatedAt, timestamps.queuedAt]
      : [timestamps.createdAt, timestamps.updatedAt, timestamps.uploadedAt, timestamps.queuedAt];
  for (const value of candidates) {
    const parsed = parseTimestamp(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function buildArtifactState(
  artifacts: Record<string, unknown>,
  fileNames: string[] | undefined,
  currentThumbnailArtifactName: string,
  artifactFileName: string
) {
  const fileSet = fileNames ? new Set(fileNames.map((name) => name.toLowerCase())) : null;
  const lowerArtifactFileName = artifactFileName.trim().toLowerCase();
  const hasFile = (fileName: string, fallbackKey: string) => {
    if (fileSet) {
      return fileSet.has(fileName.toLowerCase());
    }
    if (lowerArtifactFileName === fileName.toLowerCase()) {
      return true;
    }
    return Boolean(artifacts[fallbackKey]);
  };

  const scoreThumbnailArtifactName = (fileName: string) => {
    const lower = fileName.trim().toLowerCase();
    if (!lower) return Number.NEGATIVE_INFINITY;
    if (!/\.(png|jpe?g|webp|tiff?)$/.test(lower)) return Number.NEGATIVE_INFINITY;

    let score = 0;
    if (/(^|[/_-])solar([/_. -]|$)/.test(lower)) score += 300;
    if (/top[ _-]?down|topdown/.test(lower)) score += 280;
    if (/(^|[/_-])overview([/_. -]|$)|aerial/.test(lower)) score += 120;
    if (/browser_thumbnail|cover_thumbnail/.test(lower)) score += 160;
    if (lower === "google.png") score += 200;
    if (lower === "azure.png") score += 190;
    if (lower === "apple.png") score += 180;
    if (/rgb_preview|rgb_png|rgb_jpg|rgb\.png|rgb\.jpg|rgb\.jpeg/.test(lower)) score += 170;
    if (/rgb\.tif|rgb\.tiff/.test(lower)) score += 110;
    if (/source_/.test(lower)) score -= 20;
    if (/quad|quad_crop|north|south|east|west|street|elev/.test(lower)) score -= 320;
    if (/qa-|qa_|qa_note_thread|thread|annotation|markup|gutter/.test(lower)) score -= 260;
    return score;
  };

  const pickBestThumbnailArtifactName = (names: string[]) => {
    let bestName = "";
    let bestScore = Number.NEGATIVE_INFINITY;
    names.forEach((name) => {
      const score = scoreThumbnailArtifactName(name);
      if (score > bestScore) {
        bestName = name;
        bestScore = score;
      }
    });
    return bestScore > Number.NEGATIVE_INFINITY ? bestName : "";
  };

  let thumbnailArtifactName = currentThumbnailArtifactName.trim();
  if (fileSet) {
    thumbnailArtifactName = pickBestThumbnailArtifactName(Array.from(fileSet.values()));
  } else if (lowerArtifactFileName) {
    thumbnailArtifactName = pickBestThumbnailArtifactName([
      currentThumbnailArtifactName.trim(),
      lowerArtifactFileName
    ]);
  }

  return {
    thumbnailArtifactName,
    artifacts: {
      ...artifacts,
      has_insights: hasFile("insights.json", "has_insights"),
      has_pdf_state: hasFile(FIRSTMEASURE_FILE_NAMES.pdfState, "has_pdf_state"),
      has_report_pdf: hasFile(PDF_FILE_NAMES.main, "has_report_pdf"),
      has_main_pdf: hasFile(PDF_FILE_NAMES.main, "has_main_pdf"),
      has_summary_pdf: hasFile(PDF_FILE_NAMES.summary, "has_summary_pdf"),
      has_model_data: hasFile(FIRSTMEASURE_FILE_NAMES.xmlStored, "has_model_data"),
      has_google_image: hasFile("google.png", "has_google_image"),
      has_mask_tif: hasFile("mask.tif", "has_mask_tif"),
      has_dsm_tif: hasFile("dsm.tif", "has_dsm_tif")
    }
  };
}

function writeProjectIndexMeta(db: DatabaseSync, entries: Record<string, string>) {
  const statement = db.prepare(`
    INSERT INTO project_index_meta (key, value)
    VALUES ($key, $value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  for (const [key, value] of Object.entries(entries)) {
    statement.run({ key, value });
  }
}

function emptyQueueCounts(): Record<FirstMeasureQueueGroup, number> {
  return {
    rework_requested: 0,
    needs_structure_pins: 0,
    waiting: 0,
    queued: 0,
    requeue: 0,
    in_progress: 0,
    qa_waiting: 0,
    qa_claimed: 0,
    release_holding: 0,
    completed: 0,
    rejected: 0,
    cancelled: 0
  };
}

function normalizeQueueGroup(value: unknown): FirstMeasureQueueGroup | null {
  const raw = String(value ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (raw === "rework" || raw === "reworking" || raw === "change_requests" || raw === "rework_requests") return "rework_requested";
  if (raw === "structure_pins" || raw === "needs_pins" || raw === "needs_structure_pin") return "needs_structure_pins";
  if (raw === "queue" || raw === "queued_projects" || raw === "ready") return "queued";
  if (raw === "re_queue" || raw === "corrections") return "requeue";
  if (raw === "progress" || raw === "projects_in_progress") return "in_progress";
  if (raw === "with_qa" || raw === "projects_with_qa") return "qa_claimed";
  if (raw === "qa" || raw === "waiting_for_qa" || raw === "projects_waiting_for_qa") return "qa_waiting";
  if (raw === "release_hold" || raw === "release_holds" || raw === "holding_for_release" || raw === "waiting_for_release") return "release_holding";
  if (raw === "complete") return "completed";
  if (FIRSTMEASURE_QUEUE_GROUPS.includes(raw as FirstMeasureQueueGroup)) {
    return raw as FirstMeasureQueueGroup;
  }
  return null;
}

function sqlIn(values: string[]) {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function priorityOneSql(alias: string) {
  const p = alias;
  const json = `lower(${p}.manifest_json)`;
  return `(
    instr(${json}, '"qa_priority":true') > 0
    OR instr(${json}, '"manual_priority":true') > 0
    OR instr(${json}, '"prioritized":true') > 0
    OR instr(${json}, '"priority_level":1') > 0
    OR instr(${json}, '"priority_level":"1"') > 0
    OR instr(${json}, '"queue_priority_level":1') > 0
    OR instr(${json}, '"queue_priority_level":"1"') > 0
    OR instr(${json}, '"report_expedite_option":"rush_under_1"') > 0
    OR instr(${json}, '"report_expedite_option":"rush_1_2"') > 0
    OR instr(${json}, '"report_expedite_option":"rush_1_1_5"') > 0
    OR (${p}.is_vip != 0 AND instr(${json}, '"report_expedite_option":"rush_1_3"') > 0)
    OR (${p}.is_vip != 0 AND instr(${json}, '"report_expedite_option":"rush_2_3"') > 0)
  )`;
}

function releaseHoldingSql(alias: string) {
  const p = alias;
  return `${p}.status = 'completed' AND instr(${p}.manifest_json, '"delivery_hold_status":"holding"') > 0 AND NOT ${priorityOneSql(p)}`;
}

function queueGroupCaseSql(alias: string) {
  const p = alias;
  return `
    CASE
      WHEN ${p}.status IN (${sqlIn(["rework_requested", "reworking", "customer_rework_requested"])}) THEN 'rework_requested'
      WHEN ${p}.status IN (${sqlIn(["needs_structure_pins", "structure_pins_required"])}) THEN 'needs_structure_pins'
      WHEN ${p}.status IN (${sqlIn(["no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"])}) THEN 'waiting'
      WHEN ${p}.status IN (${sqlIn(["queued", "ready"])}) AND ${p}.assigned_to_email <> '' THEN 'in_progress'
      WHEN ${p}.status IN (${sqlIn(["queued", "ready"])}) THEN 'queued'
      WHEN ${p}.status IN (${sqlIn(["requeue", "correction_needed"])}) THEN 'requeue'
      WHEN ${p}.status IN (${sqlIn(["processing", "in_progress"])}) THEN 'in_progress'
      WHEN ${p}.status IN (${sqlIn(["awaiting_review", "awaiting_manager_review", "submission_failed"])}) AND ${p}.qa_claimed_by_email <> '' THEN 'qa_claimed'
      WHEN ${p}.status IN (${sqlIn(["awaiting_review", "awaiting_manager_review", "submission_failed"])}) THEN 'qa_waiting'
      WHEN ${releaseHoldingSql(p)} THEN 'release_holding'
      WHEN ${p}.status = 'completed' THEN 'completed'
      WHEN ${p}.status IN (${sqlIn(["pending_rejection", "rejected", "rejected_no_coverage"])}) THEN 'rejected'
      WHEN ${p}.status = 'cancelled' THEN 'cancelled'
      ELSE ''
    END
  `;
}

function queueGroupWhereSql(alias: string, group: FirstMeasureQueueGroup) {
  const p = alias;
  if (group === "rework_requested") {
    return `${p}.status IN (${sqlIn(["rework_requested", "reworking", "customer_rework_requested"])})`;
  }
  if (group === "needs_structure_pins") {
    return `${p}.status IN (${sqlIn(["needs_structure_pins", "structure_pins_required"])})`;
  }
  if (group === "waiting") {
    return `${p}.status IN (${sqlIn(["no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"])})`;
  }
  if (group === "queued") {
    return `${p}.status IN (${sqlIn(["queued", "ready"])}) AND ${p}.assigned_to_email = ''`;
  }
  if (group === "requeue") {
    return `${p}.status IN (${sqlIn(["requeue", "correction_needed"])})`;
  }
  if (group === "in_progress") {
    return `(${p}.status IN (${sqlIn(["processing", "in_progress"])}) OR (${p}.status IN (${sqlIn(["queued", "ready"])}) AND ${p}.assigned_to_email <> ''))`;
  }
  if (group === "qa_claimed") {
    return `${p}.status IN (${sqlIn(["awaiting_review", "awaiting_manager_review", "submission_failed"])}) AND ${p}.qa_claimed_by_email <> ''`;
  }
  if (group === "qa_waiting") {
    return `${p}.status IN (${sqlIn(["awaiting_review", "awaiting_manager_review", "submission_failed"])}) AND ${p}.qa_claimed_by_email = ''`;
  }
  if (group === "release_holding") {
    return releaseHoldingSql(p);
  }
  if (group === "completed") {
    return `${p}.status = 'completed' AND (instr(${p}.manifest_json, '"delivery_hold_status":"holding"') = 0 OR ${priorityOneSql(p)})`;
  }
  if (group === "rejected") {
    return `${p}.status IN (${sqlIn(["pending_rejection", "rejected", "rejected_no_coverage"])})`;
  }
  return `${p}.status = 'cancelled'`;
}

function queueGroupOrderSql(alias: string, group: FirstMeasureQueueGroup) {
  const p = alias;
  if (group === "queued") {
    return `
      ORDER BY CASE WHEN ${p}.is_vip != 0 OR ${p}.is_expedited != 0 THEN 1 ELSE 0 END DESC,
        ${p}.queued_at_ms ASC, ${p}.created_at_ms ASC, ${p}.id ASC
    `;
  }
  if (group === "rework_requested" || group === "requeue" || group === "waiting" || group === "needs_structure_pins") {
    return `ORDER BY ${p}.updated_at_ms ASC, ${p}.queued_at_ms ASC, ${p}.id ASC`;
  }
  if (group === "release_holding") {
    return `ORDER BY ${p}.completed_at_ms ASC, ${p}.updated_at_ms ASC, ${p}.id ASC`;
  }
  if (group === "completed") {
    return `ORDER BY ${p}.completed_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  }
  if (group === "rejected") {
    return `ORDER BY ${p}.rejected_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  }
  if (group === "cancelled") {
    return `ORDER BY ${p}.cancelled_at_ms DESC, ${p}.updated_at_ms DESC, ${p}.id DESC`;
  }
  return `ORDER BY ${p}.updated_at_ms DESC, ${p}.id DESC`;
}

function isPriorityOrderedQueueGroup(group: FirstMeasureQueueGroup) {
  return group !== "completed" && group !== "release_holding" && group !== "rejected" && group !== "cancelled";
}

function compareQueueBucketRows(a: ProjectManifest, b: ProjectManifest, group: FirstMeasureQueueGroup) {
  const priorityA = queuePriorityLevelFromManifest(a);
  const priorityB = queuePriorityLevelFromManifest(b);
  if (priorityA !== priorityB) return priorityA - priorityB;

  const timeA = queueBucketSortTimeMs(a, group);
  const timeB = queueBucketSortTimeMs(b, group);
  if (timeA !== timeB) return timeA - timeB;
  return String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

function queuePriorityLevelFromManifest(manifest: ProjectManifest) {
  const raw = manifest as Record<string, unknown>;
  if (truthyFlag(raw.qa_priority) || truthyFlag(raw.manual_priority) || truthyFlag(raw.prioritized)) {
    return 1;
  }

  const option = String(raw.report_expedite_option ?? "").trim().toLowerCase();
  let level = reportExpeditePriorityLevel(option, truthyFlag(raw.is_expedited));

  if (truthyFlag(raw.is_vip)) {
    level = Math.min(level, 2);
  }
  return level;
}

function queueBucketSortTimeMs(manifest: ProjectManifest, group: FirstMeasureQueueGroup) {
  if (group === "queued") return firstManifestTimeMs(manifest, ["created_at", "queued_at", "processed_at", "updated_at"]);
  if (group === "in_progress") return firstManifestTimeMs(manifest, ["created_at", "started_at", "updated_at", "queued_at"]);
  if (group === "qa_waiting" || group === "qa_claimed") return firstManifestTimeMs(manifest, ["created_at", "uploaded_at", "updated_at"]);
  return firstManifestTimeMs(manifest, ["created_at", "updated_at", "queued_at"]);
}

function firstManifestTimeMs(manifest: ProjectManifest, keys: string[]) {
  const raw = manifest as Record<string, unknown>;
  const timestamps = asRecord(raw.timestamps);
  for (const key of keys) {
    const value = readString(raw[key]) || readString(timestamps[key]);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function truthyFlag(value: unknown) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function readQueueVersion(db: DatabaseSync) {
  const row = db.prepare(`
    SELECT MAX(version) AS version
    FROM project_queue_events
  `).get() as { version?: number } | undefined;
  return Number(row?.version ?? 0);
}

function recordProjectQueueEvent(
  db: DatabaseSync,
  current: (Partial<ProjectIndexQueueSnapshot> & { thumbnail_artifact_name?: string }) | null,
  indexed: IndexedProjectDocument
) {
  const next = projectQueueSnapshotFromIndexed(indexed);
  const previous = current ? projectQueueSnapshotFromIndexed(current) : null;
  if (previous && !queueSnapshotChanged(previous, next)) {
    return null;
  }

  const previousGroup = previous ? queueGroupFromSnapshot(previous) : "";
  const nextGroup = queueGroupFromSnapshot(next);
  const eventType = !previous
    ? "project_indexed"
    : (previous.status !== next.status ? "status_changed" : "queue_fields_changed");
  const payload = {
    previous: previous
      ? {
          status: previous.status,
          queue_group: previousGroup,
          assigned_to_email: previous.assigned_to_email,
          reserved_to_email: previous.reserved_to_email,
          correction_to_email: previous.correction_to_email,
          qa_claimed_by_email: previous.qa_claimed_by_email
        }
      : null,
    current: {
      status: next.status,
      queue_group: nextGroup,
      assigned_to_email: next.assigned_to_email,
      reserved_to_email: next.reserved_to_email,
      correction_to_email: next.correction_to_email,
      qa_claimed_by_email: next.qa_claimed_by_email
    }
  };

  const result = db.prepare(`
    INSERT INTO project_queue_events (
      event_id, project_id, event_type, status, previous_status, queue_group, previous_queue_group,
      team_id, actor_email, created_at, payload_json
    ) VALUES (
      $event_id, $project_id, $event_type, $status, $previous_status, $queue_group, $previous_queue_group,
      $team_id, $actor_email, $created_at, $payload_json
    )
  `).run({
    event_id: `${Date.now()}-${randomBytes(6).toString("hex")}`,
    project_id: next.id,
    event_type: eventType,
    status: next.status,
    previous_status: previous?.status ?? "",
    queue_group: nextGroup,
    previous_queue_group: previousGroup,
    team_id: next.team_id,
    actor_email: "",
    created_at: new Date().toISOString(),
    payload_json: JSON.stringify(payload)
  });
  return Number(result.lastInsertRowid);
}

function projectSearchFieldsChanged(
  current: Record<string, unknown> | undefined,
  indexed: IndexedProjectDocument
) {
  if (!current) return true;
  const fields = [
    "id", "address", "owner_name", "owner_email", "assigned_to_name", "assigned_to_email",
    "issuer_name", "issuer_email", "resident_name", "resident_email", "resident_phone"
  ];
  return fields.some((field) => String(current[field] ?? "") !== String(indexed[field] ?? ""));
}

function pruneProjectQueueEvents(db: DatabaseSync) {
  db.prepare(`
    DELETE FROM project_queue_events
    WHERE version IN (
      SELECT version
      FROM project_queue_events
      ORDER BY version DESC
      LIMIT -1 OFFSET $retention
    )
  `).run({
    retention: QUEUE_EVENT_RETENTION_ROWS
  });
}

function projectQueueSnapshotFromIndexed(value: Partial<ProjectIndexQueueSnapshot>): ProjectIndexQueueSnapshot {
  return {
    id: String(value.id ?? ""),
    status: String(value.status ?? ""),
    team_id: String(value.team_id ?? ""),
    assigned_to_email: String(value.assigned_to_email ?? ""),
    reserved_to_email: String(value.reserved_to_email ?? ""),
    correction_to_email: String(value.correction_to_email ?? ""),
    qa_claimed_by_email: String(value.qa_claimed_by_email ?? "")
  };
}

function queueSnapshotChanged(previous: ProjectIndexQueueSnapshot, next: ProjectIndexQueueSnapshot) {
  return previous.status !== next.status
    || previous.team_id !== next.team_id
    || previous.assigned_to_email !== next.assigned_to_email
    || previous.reserved_to_email !== next.reserved_to_email
    || previous.correction_to_email !== next.correction_to_email
    || previous.qa_claimed_by_email !== next.qa_claimed_by_email;
}

function queueGroupFromSnapshot(snapshot: ProjectIndexQueueSnapshot) {
  const status = snapshot.status;
  if (["rework_requested", "reworking", "customer_rework_requested"].includes(status)) return "rework_requested";
  if (["no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"].includes(status)) return "waiting";
  if (["queued", "ready"].includes(status)) return "queued";
  if (["requeue", "correction_needed"].includes(status)) return "requeue";
  if (["processing", "in_progress"].includes(status)) return "in_progress";
  if (["awaiting_review", "awaiting_manager_review", "submission_failed"].includes(status)) {
    return snapshot.qa_claimed_by_email ? "qa_claimed" : "qa_waiting";
  }
  if (status === "completed") return "completed";
  if (["pending_rejection", "rejected", "rejected_no_coverage"].includes(status)) return "rejected";
  if (status === "cancelled") return "cancelled";
  return "";
}

function parseJsonObject(value: unknown) {
  try {
    const parsed = JSON.parse(String(value ?? "{}"));
    return asRecord(parsed);
  } catch {
    return {};
  }
}

function appendSearchClauses(input: {
  joins: string[];
  where: string[];
  params: SqlParams;
  rawSearch: string;
  alias: string;
}) {
  const tokens = tokenizeProjectSearch(input.rawSearch);
  if (tokens.length === 0) {
    return;
  }

  if (projectSearchFtsEnabled) {
    input.joins.push(`JOIN ${PROJECT_SEARCH_TABLE_NAME} ON ${PROJECT_SEARCH_TABLE_NAME}.project_id = ${input.alias}.id`);
    input.where.push(`${PROJECT_SEARCH_TABLE_NAME} MATCH $ftsQuery`);
    input.params.ftsQuery = buildFtsQuery(tokens);
    return;
  }

  tokens.forEach((token, index) => {
    const key = `searchLike${index}`;
    input.where.push(`${input.alias}.search_text LIKE $${key}`);
    input.params[key] = `%${token}%`;
  });
}

function appendLegacyVisibilityClause(
  where: string[],
  params: SqlParams,
  filter: string,
  actor: LegacyListActor
) {
  if (!actor) {
    return;
  }

  const actorEmail = normalizeEmail(actor.email);
  const actorTeamId = readString(actor.team_id);
  const actorOrgId = readString(actor.organization_id);
  const roles = Array.isArray(actor.roles) ? actor.roles.map((role) => String(role).toLowerCase()) : [];
  const isQueueAdmin = roles.includes("admin") || roles.includes("queue_admin") || roles.includes("manager");

  if (!actorEmail && !actorTeamId && !actorOrgId) {
    return;
  }

  if (filter === "all") {
    if (isQueueAdmin) {
      return;
    }
    where.push("(p.owner_email = $actorEmail OR p.issuer_email = $actorEmail OR p.assigned_to_email = $actorEmail)");
    params.actorEmail = actorEmail;
    return;
  }

  if (filter === "team" && actorTeamId) {
    where.push("((p.team_id = $actorTeamId AND p.team_id <> '') OR p.assigned_to_email = $actorEmail)");
    params.actorTeamId = actorTeamId;
    params.actorEmail = actorEmail;
    return;
  }

  if (filter === "org" && actorOrgId) {
    where.push("((p.organization_id = $actorOrgId AND p.organization_id <> '') OR p.owner_email = $actorEmail OR p.issuer_email = $actorEmail OR p.assigned_to_email = $actorEmail)");
    params.actorOrgId = actorOrgId;
    params.actorEmail = actorEmail;
    return;
  }

  where.push("(p.owner_email = $actorEmail OR p.issuer_email = $actorEmail OR p.assigned_to_email = $actorEmail)");
  params.actorEmail = actorEmail;
}

function appendInstantVisibilityClause(
  where: string[],
  _params: SqlParams,
  includeInstantOnly: boolean | undefined
) {
  if (includeInstantOnly) {
    return;
  }
  where.push("p.instant_only = 0");
}

function appendLegacyStatusClause(where: string[], _params: SqlParams, statusFilter: string) {
  if (!statusFilter || statusFilter === "all") {
    return;
  }
  if (statusFilter === "rejected") {
    where.push("p.status IN ('rejected_no_coverage', 'rejected')");
    return;
  }
  if (statusFilter === "cancelled") {
    where.push("p.status = 'cancelled'");
    return;
  }
  if (statusFilter === "ready") {
    where.push("p.status = 'completed' AND p.has_report_pdf = 1");
    return;
  }
  if (statusFilter === "completed") {
    where.push("p.status = 'completed'");
    return;
  }
  if (statusFilter === "processing") {
    where.push("NOT (p.status = 'completed' AND p.has_report_pdf = 1)");
    where.push("p.status NOT IN ('rejected_no_coverage', 'rejected', 'cancelled')");
    return;
  }
}

function appendLegacyComplexityClause(where: string[], params: SqlParams, complexityFilter: string | undefined) {
  const value = String(complexityFilter ?? "").trim().toLowerCase();
  if (!value || value === "all") return;
  if (!/^[1-5]$/.test(value)) return;
  where.push("p.complexity = $complexityFilter");
  params.complexityFilter = value;
}

function appendActivityWindowClause(input: {
  where: string[];
  params: SqlParams;
  activityStartMs: number | null;
  activityEndMs: number | null;
  activityFields?: ProjectActivityField[];
}) {
  const { activityStartMs, activityEndMs } = input;
  if (activityStartMs == null && activityEndMs == null) {
    return;
  }

  const fields = Array.isArray(input.activityFields) && input.activityFields.length > 0
    ? input.activityFields
    : ["started", "uploaded", "completed"] as ProjectActivityField[];
  const lowerBound = activityStartMs ?? 0;
  const upperBound = activityEndMs ?? 8_640_000_000_000_000;
  const unionParts: string[] = [];

  for (const field of fields) {
    if (field === "created") {
      unionParts.push("SELECT id FROM projects WHERE created_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "queued") {
      unionParts.push("SELECT id FROM projects WHERE queued_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "started") {
      unionParts.push("SELECT id FROM projects WHERE started_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "uploaded") {
      unionParts.push("SELECT id FROM projects WHERE uploaded_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "completed") {
      unionParts.push("SELECT id FROM projects WHERE completed_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "rejected") {
      unionParts.push("SELECT id FROM projects WHERE rejected_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "cancelled") {
      unionParts.push("SELECT id FROM projects WHERE cancelled_at_ms BETWEEN $activityStartMs AND $activityEndMs");
      continue;
    }
    if (field === "updated") {
      unionParts.push("SELECT id FROM projects WHERE updated_at_ms BETWEEN $activityStartMs AND $activityEndMs");
    }
  }

  if (unionParts.length === 0) {
    return;
  }

  input.params.activityStartMs = lowerBound;
  input.params.activityEndMs = upperBound;
  input.where.push(`
    p.id IN (
      ${unionParts.join("\n      UNION\n      ")}
    )
  `);
}

function buildFtsQuery(tokens: string[]) {
  return tokens.map((token) => `${token}*`).join(" AND ");
}

function parseTimestamp(value: string) {
  if (!value) {
    return 0;
  }
  const raw = String(value).trim();
  const isoCandidate = raw.includes("T") ? raw : raw.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoCandidate);
  const parseTarget = hasTimezone ? isoCandidate : `${isoCandidate}Z`;
  const parsed = Date.parse(parseTarget);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readSuccessfulReportDeliveryTimestamp(manifest: ProjectManifest) {
  const manifestRecord = asRecord(manifest);
  const delivery = asRecord(manifestRecord.delivery);
  const emailState = asRecord(manifestRecord.email_state);
  const deliveryEmailState = asRecord(delivery.email_state);
  const reportEmailState = asRecord(emailState.report_email);
  const deliveryReportEmailState = asRecord(deliveryEmailState.report_email);
  const sentOk = Boolean(reportEmailState.sent_ok) || Boolean(deliveryReportEmailState.sent_ok);
  const timestamp =
    readString(manifestRecord.report_sent_at)
    || readString(delivery.report_sent_at)
    || readString(reportEmailState.sent_at_utc)
    || readString(deliveryReportEmailState.sent_at_utc);

  if (sentOk && timestamp) {
    return parseTimestamp(timestamp);
  }
  if (sentOk) {
    return parseTimestamp(
      readString(manifestRecord.completed_at)
      || readString(asRecord(manifestRecord.timestamps).completed_at)
    );
  }
  if (timestamp) {
    return parseTimestamp(timestamp);
  }
  return 0;
}

function tokenizeProjectSearch(value: string) {
  const normalized = normalizeProjectSearchText(value);
  if (normalized.length < 2) {
    return [];
  }
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeProjectSearchText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function readString(value: unknown) {
  return String(value ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
