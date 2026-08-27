import path from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";

import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { env } from "../src/config/env.js";
import {
  deleteProjectArtifact,
  getProjectArtifact,
  isSpacesArtifactStorageEnabled,
  putProjectArtifact
} from "../src/storage/project_artifacts.js";
import { requirePlatformAuth } from "../platform/auth.js";

import { getAppleKeyInfo, setAppleKey } from "./apple.js";
import { FIRSTMEASURE_FILE_NAMES, PDF_FILE_NAMES, firstMeasurePointValueForComplexity, type PdfSlot } from "./constants.js";
import { MANAGEMENT_TIME_ZONE, managementDateKey, managementDayBounds } from "./reporting_time.js";
import {
  buildQaShiftLeaderboard,
  normalizeQaShiftDateKey,
  qaShiftDateKey,
  qaShiftQueryWindow,
  type QaShiftPointEvent
} from "./qa_shifts.js";
import { FirstMeasureError, badRequest, conflict } from "./errors.js";
import { buildReportExpediteOptions, isExpeditedReportExpediteKey, normalizeReportExpediteKey, reportExpeditePriorityLevel, REPORT_EXPEDITE_1_3_KEY, REPORT_EXPEDITE_STANDARD_KEY, REPORT_EXPEDITE_UNDER_1_KEY } from "./expedite.js";
import {
  buildProjectGoogle3dManifestRoute,
  ensureProjectGoogle3dCapture,
  projectGoogle3dCaptureExists,
  readProjectGoogle3dManifest,
  readProjectGoogle3dTile
} from "./google3d.js";
import { renderProjectPdf } from "./pdf.js";
import { processProjectImagery, processProjectInsights, processProjectMask } from "./processing.js";
import {
  ensureFirstMeasureProjectIndexReady,
  findIndexedProjectByNormalizedAddress,
  findIndexedProjectsByNormalizedAddress,
  FIRSTMEASURE_QUEUE_GROUPS,
  getFirstMeasureProjectIndexDb,
  getFirstMeasureProjectIndexStatus,
  getIndexedQueueCounts,
  queryIndexedQueueBucket,
  queryIndexedQaCandidateManifests,
  queryIndexedProjectManifests,
  readIndexedQueueChanges,
  rebuildFirstMeasureProjectIndex,
  searchIndexedProjectsForLegacyList,
  upsertProjectIndex,
  type FirstMeasureQueueGroup
} from "./project_index.js";
import {
  enqueueFirstMeasureJob,
  getFirstMeasureJobRetryDelayMs,
  getFirstMeasureJob,
  getFirstMeasureJobStats,
  getFirstMeasureWorkerHealth,
  listFirstMeasureJobs
} from "./job_queue.js";
import {
  getFirstMeasureJobRuntimeStatus,
  registerFirstMeasureJobHandler,
  startFirstMeasureJobRuntime
} from "./job_runtime.js";
import { shouldRunFirstMeasureBackgroundProcessor } from "./background_role.js";
import { acquireFirstMeasureLock } from "./locks.js";
import { patchInternalUser, readInternalUser } from "../internal/storage.js";
import {
  claimNextInQueue,
  getClaimableQueueStatus,
  getQueueOverview,
  getQueueStatus,
  releaseAssignment,
  releaseReservation,
  reserveProject
} from "./queue.js";
import {
  appleKeySetSchema,
  artifactJsonUploadSchema,
  createProjectSchema,
  instantPdfRenderSchema,
  jsonDocumentSchema,
  orderInstantSchema,
  patchProjectSchema,
  pdfBatchSchema,
  projectsQuerySchema,
  queueClaimNextSchema,
  queueOverviewSchema,
  queueReleaseSchema,
  queueReserveSchema,
  queueStatusSchema,
  renderReportSchema,
  statusUpdateSchema,
  xmlAssembleSchema
} from "./schemas.js";
import {
  buildPendingProjectInstantPayload,
  buildProjectInstantPayload,
  INSTANT_STRUCTURE_INSIGHTS_FILE_NAME,
  projectHasInstantArtifacts
} from "./instant.js";
import {
  INSTANT_PDF_FILE_NAME,
  generateProjectInstantPdf,
  triggerInstantPdfArtifact
} from "./instant_pdf.js";
import {
  RUSH_BONUS_PERCENT,
  createRushMode,
  evaluateAutomaticRushMode,
  getCurrentRushMode,
  getRushAutomationSettings,
  listRushModes,
  updateRushAutomationSettings
} from "./rush.js";
import { buildInstantRenderData } from "./instant_render.js";
import {
  getSharedPdfRuntimeAsset,
  renderSharedProjectPdfs,
  type SharedPdfClientAssetName,
  type SharedPdfOutputSpec
} from "./pdf_runtime.js";
import {
  createProject,
  getProjectDetail,
  listProjectFiles,
  listProjectManifests,
  patchManifest,
  projectDir,
  readAppMetadata,
  readArtifact,
  readBrandingDefaults,
  readManifest,
  readPdfState,
  readStoredPdf,
  readStoredXml,
  refreshArtifactFlags,
  saveAppMetadata,
  saveArtifact,
  saveBrandingDefaults,
  saveManifest,
  savePdfState,
  sanitizeFileName,
  saveStoredPdf,
  updateStatus,
  type ProjectManifest
} from "./storage.js";
import { buildXmlExportPayload, resolveXmlExportFormat } from "./xml.js";
import {
  chargePublicFirstMeasureOrder,
  firstMeasurePublicReportAmount,
  refundPublicFirstMeasureOrder
} from "../public-firstmeasure/billing.js";
import { readBranchModule, readDocument, readGlobal, readOrganization, saveGlobal } from "../platform/storage.js";
import {
  findPublicFirstMeasureReportByProjectId,
  updatePublicFirstMeasureReportRecord
} from "../public-firstmeasure/reports.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { buildWeatherReport } from "../weather/reports.js";
import { generateWeatherReportPdf } from "../weather/pdf.js";

type RenderReportInput = {
  page_config?: Record<string, unknown>;
  branding?: unknown;
  prepared_for?: Record<string, unknown>;
  pages?: Array<Record<string, unknown>>;
  page?: Record<string, unknown>;
  output_slot?: PdfSlot;
  persist_files?: boolean;
  update_status?: boolean;
  actor?: Record<string, unknown>;
};

type ProjectActivityField =
  | "created"
  | "queued"
  | "started"
  | "uploaded"
  | "completed"
  | "rejected"
  | "cancelled"
  | "updated";

const DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS = 90;
const DEFAULT_PROJECT_ACTIVITY_FIELDS: ProjectActivityField[] = ["started", "uploaded", "completed"];
const APP_ORDER_REPORT_URL = "https://app.1m8.ai/portal";
const STRUCTURE_REORDER_PROJECT_TYPES = new Set(["commercial", "multifamily"]);

type ProjectPriorityFlag = "none" | "vip" | "expedited";

function defaultQueueBucketActivityFields(group: string, activityFields?: ProjectActivityField[]) {
  if (activityFields && activityFields.length > 0) return activityFields;
  const normalized = group.trim().toLowerCase();
  if (normalized === "cancelled" || normalized === "canceled") return ["cancelled"] as ProjectActivityField[];
  if (normalized === "rejected") return ["rejected"] as ProjectActivityField[];
  if (normalized === "completed") return ["completed"] as ProjectActivityField[];
  return activityFields;
}

type FirstMeasureDebugEvent = {
  at: string;
  step: string;
  detail?: unknown;
};

type FirstMeasureDebugContext = {
  enabled: true;
  traceId: string;
  source: string | null;
  startedAt: string;
  startedAtMs: number;
  events: FirstMeasureDebugEvent[];
};

type FirstMeasureRuntimeStatus = {
  process_started_at: string;
  process_uptime_ms: number;
  pid: number;
  node_version: string;
  package_version: string | null;
  api_module_path: string;
  api_module_updated_at: string | null;
};

type StructureTypeReorderPayload = {
  correctProjectType: "commercial" | "multifamily";
  correctProjectTypeLabel: string;
  url: string;
  prefill: Record<string, unknown>;
};

type DebuggableRequest = FastifyRequest & {
  __firstMeasureDebug?: FirstMeasureDebugContext;
};

type LegacyProjectSearchDoc = {
  manifest: ProjectManifest;
  legacy: Record<string, unknown>;
  searchText: string;
  idText: string;
  addressText: string;
  residentNameText: string;
  issuerNameText: string;
  ownerNameText: string;
  organizationId: string;
  teamId: string;
  ownerEmail: string;
  issuerEmail: string;
  assignedEmail: string;
  relatedActorEmails: string[];
  sortTs: number;
};

type LegacyProjectSearchCache = {
  expiresAt: number;
  docs: LegacyProjectSearchDoc[];
  docsByOrg: Map<string, LegacyProjectSearchDoc[]>;
  docsByTeam: Map<string, LegacyProjectSearchDoc[]>;
  docsByActorEmail: Map<string, LegacyProjectSearchDoc[]>;
};

type ProjectListView = "full" | "card" | "stats";

type QueueOverviewCacheEntry = {
  expiresAt: number;
  value: Record<string, unknown>;
};

type QaQueueCacheEntry = {
  expiresAt: number;
  version: number;
  ranked: QaRankedProject[];
};

const LEGACY_PROJECT_SEARCH_CACHE_TTL_MS = 5000;
const QUEUE_OVERVIEW_COMPAT_CACHE_TTL_MS = 1500;
const QUEUE_OVERVIEW_COMPAT_DEFAULT_BUCKET_LIMIT = 500;
const QUEUE_OVERVIEW_COMPAT_MAX_BUCKET_LIMIT = 5000;
const QA_TECH_QUEUE_CACHE_TTL_MS = 60_000;
const QA_STALE_CLAIM_SWEEP_MS = 60_000;
const QA_SESSION_IDLE_RELEASE_MS = 15 * 60_000;
// Corrected work returns to the QA reviewer who requested it. The reservation
// is bounded so an unattended correction eventually becomes shared work.
const QA_CORRECTION_RETURN_HOLD_MS = 15 * 60_000;
const QA_BATCH_INTERVAL_MS = 30 * 60_000;
const INVALID_PORTAL_ACTOR_EMAILS = new Set(["", "unknown@example.com", "unknown@unknown.local"]);
const PROJECT_THUMBNAIL_CACHE_MAX_AGE_SECONDS = 3600;
const PROJECT_THUMBNAIL_DEFAULT_WIDTH = 320;
const PROJECT_THUMBNAIL_MAX_WIDTH = 1200;
const PROJECT_THUMBNAIL_FILE_NAME = "browser_thumbnail";
const PDF_JSON_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const PDF_SYNC_UPLOAD_CHUNK_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const PDF_SYNC_UPLOAD_MAX_CHUNK_BYTES = 5 * 1024 * 1024;
const PDF_SYNC_UPLOAD_MAX_CHUNKS = 128;
const PDF_SYNC_UPLOAD_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const PDF_RENDER_RECIPE_VERSION = "2026-08-16.1";
const REPORT_RELEASE_HOLD_POLL_MS = 60_000;
const REPORT_RELEASE_HOLD_BATCH_LIMIT = 100;
const EXPEDITE_MISSED_PROMISE_POLL_MS = 60_000;
const EXPEDITE_MISSED_PROMISE_BATCH_LIMIT = 250;
const EXPEDITE_MISSED_PROMISE_AUTOMATIC_REFUNDS_ENABLED = false;
const WEATHER_REPORT_ADDON_AMOUNT = 5;
const weatherReportGenerationQueue = new Set<string>();
let legacyProjectSearchCache: LegacyProjectSearchCache | null = null;
const queueOverviewCompatCache = new Map<string, QueueOverviewCacheEntry>();
const qaTechQueueCache = new Map<string, QaQueueCacheEntry>();
const qaShiftLeaderboardCache = new Map<string, { expiresAt: number; value: ReturnType<typeof buildQaShiftLeaderboard> }>();
const qaTechQueueBuilds = new Map<string, Promise<QaRankedProject[]>>();
const qaProjectClaimLocks = new Map<string, Promise<void>>();
let reportReleaseHoldTimer: ReturnType<typeof setInterval> | null = null;
let expediteMissedPromiseTimer: ReturnType<typeof setInterval> | null = null;

type PdfSyncUploadManifest = {
  project_id: string;
  upload_id: string;
  chunk_count: number;
  payload_bytes: number;
  payload_sha256: string;
  created_at: string;
};

function normalizePdfSyncUploadId(value: unknown) {
  const uploadId = String(value ?? "").trim();
  if (!/^[a-zA-Z0-9_-]{12,100}$/.test(uploadId)) {
    throw badRequest("invalid_pdf_sync_upload_id", "PDF sync upload id is invalid.");
  }
  return uploadId;
}

function normalizePdfSyncUploadInteger(value: unknown, field: string, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw badRequest("invalid_pdf_sync_upload", `${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

function pdfSyncUploadDirectory(projectId: string, uploadId: string) {
  return path.join(projectDir(projectId), ".pdf-sync-uploads", normalizePdfSyncUploadId(uploadId));
}

function pdfSyncUploadChunkPath(directory: string, chunkIndex: number) {
  return path.join(directory, `${String(chunkIndex).padStart(6, "0")}.part`);
}

function pdfSyncUploadArtifactPath(uploadId: string, fileName: string) {
  return `.pdf-sync-uploads/${normalizePdfSyncUploadId(uploadId)}/${fileName}`;
}

async function readPdfSyncUploadManifest(projectId: string, uploadId: string) {
  const directory = pdfSyncUploadDirectory(projectId, uploadId);
  const manifestPath = path.join(directory, "upload.json");
  let parsed: unknown;
  try {
    if (isSpacesArtifactStorageEnabled()) {
      const content = await getProjectArtifact(projectId, pdfSyncUploadArtifactPath(uploadId, "upload.json"));
      if (!content) throw new Error("missing");
      parsed = JSON.parse(content.toString("utf8"));
    } else {
      if (!existsSync(manifestPath)) throw new Error("missing");
      parsed = JSON.parse(await readFile(manifestPath, "utf8"));
    }
  } catch {
    throw badRequest("pdf_sync_upload_not_found", "The PDF sync upload was not found, is invalid, or has expired.");
  }
  const record = asRecord(parsed);
  const manifest: PdfSyncUploadManifest = {
    project_id: String(record.project_id ?? ""),
    upload_id: normalizePdfSyncUploadId(record.upload_id),
    chunk_count: normalizePdfSyncUploadInteger(record.chunk_count, "chunk_count", 1, PDF_SYNC_UPLOAD_MAX_CHUNKS),
    payload_bytes: normalizePdfSyncUploadInteger(record.payload_bytes, "payload_bytes", 1, PDF_SYNC_UPLOAD_MAX_PAYLOAD_BYTES),
    payload_sha256: String(record.payload_sha256 ?? "").trim().toLowerCase(),
    created_at: String(record.created_at ?? "")
  };
  if (manifest.project_id !== projectId || manifest.upload_id !== uploadId || !/^[a-f0-9]{64}$/.test(manifest.payload_sha256)) {
    throw badRequest("invalid_pdf_sync_upload", "The PDF sync upload metadata does not match this project.");
  }
  return { directory, manifest };
}
let qaStaleClaimSweepTimer: ReturnType<typeof setInterval> | null = null;
let qaStaleClaimSweepInFlight = false;

const FIRSTMEASURE_PROCESS_STARTED_AT_MS = Date.now();
const FIRSTMEASURE_PROCESS_STARTED_AT = new Date(FIRSTMEASURE_PROCESS_STARTED_AT_MS).toISOString();
const FIRSTMEASURE_API_MODULE_PATH = fileURLToPath(import.meta.url);
const FIRSTMEASURE_PACKAGE_JSON_PATH = path.resolve(process.cwd(), "package.json");

function clearProjectListCaches() {
  legacyProjectSearchCache = null;
  queueOverviewCompatCache.clear();
}

function clearQaClaimCaches() {
  clearProjectListCaches();
  qaTechQueueCache.clear();
}

async function getFirstMeasureRuntimeStatus(): Promise<FirstMeasureRuntimeStatus> {
  let packageVersion: string | null = null;
  let apiModuleUpdatedAt: string | null = null;

  try {
    const raw = await readFile(FIRSTMEASURE_PACKAGE_JSON_PATH, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    const version = String(parsed?.version ?? "").trim();
    packageVersion = version || null;
  } catch {
    packageVersion = null;
  }

  try {
    const stats = await stat(FIRSTMEASURE_API_MODULE_PATH);
    apiModuleUpdatedAt = stats.mtime.toISOString();
  } catch {
    apiModuleUpdatedAt = null;
  }

  return {
    process_started_at: FIRSTMEASURE_PROCESS_STARTED_AT,
    process_uptime_ms: Math.max(0, Date.now() - FIRSTMEASURE_PROCESS_STARTED_AT_MS),
    pid: process.pid,
    node_version: process.version,
    package_version: packageVersion,
    api_module_path: FIRSTMEASURE_API_MODULE_PATH,
    api_module_updated_at: apiModuleUpdatedAt
  };
}

function isFirstMeasureDebugEnabled(request: FastifyRequest) {
  const query = asRecord(request.query);
  const header = request.headers["x-firstmeasure-debug"];
  return toBooleanish(query.debug) || toBooleanish(header);
}

function getFirstMeasureDebugSource(request: FastifyRequest) {
  const query = asRecord(request.query);
  return toOptionalString(query.debug_source) ?? toOptionalString(request.headers["x-firstmeasure-debug-source"]) ?? null;
}

function getFirstMeasureDebug(request: FastifyRequest) {
  return (request as DebuggableRequest).__firstMeasureDebug ?? null;
}

function ensureFirstMeasureDebug(request: FastifyRequest) {
  const cast = request as DebuggableRequest;
  if (cast.__firstMeasureDebug) {
    return cast.__firstMeasureDebug;
  }
  if (!isFirstMeasureDebugEnabled(request)) {
    return null;
  }
  const now = Date.now();
  const ctx: FirstMeasureDebugContext = {
    enabled: true,
    traceId: `${request.id}-${now.toString(36)}`,
    source: getFirstMeasureDebugSource(request),
    startedAt: new Date(now).toISOString(),
    startedAtMs: now,
    events: []
  };
  cast.__firstMeasureDebug = ctx;
  return ctx;
}

function summarizeDebugValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 157)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sample: value.slice(0, 5).map((item) => summarizeDebugValue(item))
    };
  }
  if (typeof value === "object") {
    const record = asRecord(value);
    const entries = Object.entries(record).slice(0, 12);
    return {
      type: "object",
      keys: Object.keys(record).slice(0, 12),
      key_count: Object.keys(record).length,
      sample: Object.fromEntries(entries.map(([key, entryValue]) => [key, summarizeDebugValue(entryValue)]))
    };
  }
  return String(value);
}

function recordFirstMeasureDebug(request: FastifyRequest, step: string, detail?: unknown) {
  const ctx = getFirstMeasureDebug(request);
  if (!ctx) return;
  ctx.events.push({
    at: new Date().toISOString(),
    step,
    ...(detail === undefined ? {} : { detail: summarizeDebugValue(detail) })
  });
  if (ctx.events.length > 12) {
    ctx.events = ctx.events.slice(ctx.events.length - 12);
  }
}

function buildFirstMeasureDebugPayload(request: FastifyRequest, statusCode: number) {
  const ctx = getFirstMeasureDebug(request);
  if (!ctx) return null;
  return {
    trace_id: ctx.traceId,
    source: ctx.source,
    method: request.method,
    route: request.routeOptions.url,
    url: request.url,
    status_code: statusCode,
    started_at: ctx.startedAt,
    duration_ms: Math.max(0, Date.now() - ctx.startedAtMs),
    query_keys: Object.keys(asRecord(request.query)),
    events: ctx.events,
    server: {
      pid: process.pid
    }
  };
}

export const registerFirstMeasureApi: FastifyPluginAsync = async (app) => {
  await ensureFirstMeasureProjectIndexReady();
  registerFirstMeasureJobHandler("pdf.sync", runBackgroundPdfSyncJob);
  registerFirstMeasureJobHandler("report.delivery", runBackgroundReportDeliveryJob);
  registerFirstMeasureJobHandler("report.release", runBackgroundReportReleaseJob);
  startFirstMeasureJobRuntime(app.log);
  startReportReleaseHoldProcessor(app);
  startExpediteMissedPromiseProcessor(app);
  startQaStaleClaimProcessor(app);

  app.addHook("onRequest", async (request) => {
    const debug = ensureFirstMeasureDebug(request);
    if (!debug) return;
    recordFirstMeasureDebug(request, "request_received", {
      query: request.query,
      source: debug.source
    });
  });

  app.addHook("preHandler", async (request) => {
    if (!getFirstMeasureDebug(request)) return;
    recordFirstMeasureDebug(request, "handler_enter", {
      route: request.routeOptions.url,
      body: request.body
    });
  });

  const providerBackedRoutes = new Set([
    "/projects/queue",
    "/instants",
    "/projects/:id/instant/ensure",
    "/projects/:id/process/imagery",
    "/projects/:id/process/insights",
    "/projects/:id/mask/ensure",
    "/projects/:id/google-3d/capture",
    "/ai/gemini-image"
  ]);
  const providerRequestWindows = new Map<string, { startedAt: number; count: number }>();
  app.addHook("preHandler", async (request) => {
    const providerRoute = String(request.routeOptions.url ?? "").replace(/^\/v1\/firstmeasure/, "");
    if (request.method !== "POST" || !providerBackedRoutes.has(providerRoute)) return;
    const suppliedInternalSecret = String(request.headers["x-firstmeasure-internal"] ?? "");
    const isInternal = Boolean(env.firstMeasureInternalApiSecret)
      && suppliedInternalSecret === env.firstMeasureInternalApiSecret;
    let rateKey = `internal:${request.ip}`;
    if (!isInternal) {
      const auth = await requirePlatformAuth(request);
      rateKey = String(auth.identity.email ?? auth.userId ?? auth.sessionId).toLowerCase();
    }
    const now = Date.now();
    const window = providerRequestWindows.get(rateKey);
    if (!window || now - window.startedAt >= 60_000) {
      providerRequestWindows.set(rateKey, { startedAt: now, count: 1 });
      return;
    }
    window.count += 1;
    if (window.count > 60) throw new FirstMeasureError("provider_rate_limited", 429, "Too many provider-backed requests. Try again shortly.");
  });

  app.addHook("preSerialization", async (request, reply, payload) => {
    if (!getFirstMeasureDebug(request)) return payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || Buffer.isBuffer(payload)) {
      return payload;
    }
    if (Object.prototype.hasOwnProperty.call(payload, "_debug")) {
      return payload;
    }
    recordFirstMeasureDebug(request, "json_response_ready", {
      status_code: reply.statusCode
    });
    return {
      ...(payload as Record<string, unknown>),
      _debug: buildFirstMeasureDebugPayload(request, reply.statusCode)
    };
  });

  const geminiImageWindows = new Map<string, { startedAt: number; count: number }>();
  app.post("/ai/gemini-image", { bodyLimit: 20 * 1024 * 1024 }, async (request) => {
    const auth = await requirePlatformAuth(request);
    const rateKey = String(auth.identity.email ?? auth.userId ?? auth.sessionId).toLowerCase();
    const now = Date.now();
    const window = geminiImageWindows.get(rateKey);
    if (!window || now - window.startedAt >= 60_000) {
      geminiImageWindows.set(rateKey, { startedAt: now, count: 1 });
    } else {
      window.count += 1;
      if (window.count > 10) throw new FirstMeasureError("gemini_rate_limited", 429, "Too many Gemini image requests. Try again shortly.");
    }

    const body = asRecord(request.body);
    const prompt = String(body.prompt ?? "").trim();
    const imageBase64 = String(body.image_base64 ?? "").trim();
    const requestedModel = String(body.model ?? "gemini-3-pro-image-preview").trim();
    const model = /^gemini-[a-z0-9._-]{1,80}$/i.test(requestedModel) ? requestedModel : "gemini-3-pro-image-preview";
    if (!prompt || prompt.length > 20_000) throw badRequest("invalid_gemini_prompt", "A prompt of at most 20,000 characters is required.");
    if (!imageBase64 || imageBase64.length > 18_000_000 || !/^[a-z0-9+/=\r\n]+$/i.test(imageBase64)) {
      throw badRequest("invalid_gemini_image", "A valid PNG image payload is required.");
    }
    if (!env.geminiApiKey) throw new FirstMeasureError("gemini_not_configured", 503, "The server Gemini credential is not configured.");

    const providerResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.geminiApiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: imageBase64 } }] }]
      })
    });
    const providerBody = await providerResponse.json().catch(() => ({})) as Record<string, unknown>;
    if (!providerResponse.ok) {
      app.log.warn({ statusCode: providerResponse.status, actor: rateKey }, "Gemini image request failed");
      throw new FirstMeasureError("gemini_request_failed", 502, "Gemini could not process the image.");
    }
    const candidates = Array.isArray(providerBody.candidates) ? providerBody.candidates : [];
    const first = asRecord(candidates[0]);
    const content = asRecord(first.content);
    const parts = Array.isArray(content.parts) ? content.parts : [];
    for (const rawPart of parts) {
      const part = asRecord(rawPart);
      const inline = asRecord(part.inlineData ?? part.inline_data);
      const data = String(inline.data ?? "").trim();
      if (data) return { ok: true, success: true, image_base64: data };
    }
    return { ok: false, success: false, error: "gemini_image_missing" };
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const debug = getFirstMeasureDebug(request);
    if (!debug) return payload;
    const durationMs = Math.max(0, Date.now() - debug.startedAtMs);
    reply.header("X-FirstMeasure-Debug-Trace", debug.traceId);
    reply.header("X-FirstMeasure-Debug-Ms", String(durationMs));
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const payload = buildFirstMeasureDebugPayload(request, reply.statusCode);
    if (!payload) return;
    app.log.info(payload, "FirstMeasure debug request");
  });

  app.setErrorHandler((error, request, reply) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    const errorMessage = error instanceof Error ? error.message : String(error);
    recordFirstMeasureDebug(request, "error", {
      name: errorName,
      message: errorMessage
    });
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({
        ok: false,
        error: "validation_error",
        issues: error.issues
      });
    }

    if (error instanceof FirstMeasureError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }

    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      const statusCode = Number((error as { statusCode: number }).statusCode);
      reply.code(statusCode);
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }

    const sqliteCode = String((error as { code?: unknown }).code ?? "");
    if (sqliteCode === "SQLITE_BUSY" || /database is locked|SQLITE_BUSY/i.test(errorMessage)) {
      app.log.warn({ err: error, requestId: request.id }, "SQLite write contention");
      reply.code(503);
      return reply.send({
        ok: false,
        error: "storage_busy",
        message: "The project queue is briefly busy. Please try again.",
        request_id: request.id,
        retryable: true
      });
    }

    app.log.error(error);
    reply.code(500);
    return reply.send({
      ok: false,
      error: "internal_error",
      message: "An unexpected error occurred.",
      request_id: request.id,
      ...(getFirstMeasureDebug(request)
        ? {
            debug_error: {
              name: errorName,
              message: errorMessage
            }
          }
        : {})
    });
  });

  app.get("/", async () => ({
    ok: true,
    api: "firstmeasure",
    message: "firstmeasure API is mounted",
    runtime: await getFirstMeasureRuntimeStatus(),
    endpoints: {
      projects: "/projects",
      storedReport: "/projects/:id/pdf",
      assembleReport: "/projects/:id/pdf/assemble",
      renderReport: "/projects/:id/render/report",
      summaryReport: "/projects/:id/pdf?slot=summary",
      instant: "/projects/:id/instant",
      instants: "/instants",
      queueStatus: "/queue/status",
      queueClaimNext: "/queue/claim-next",
      reportExpediteOptions: "/report-expedite-options",
      appleKey: "/apple-key",
      renderPages: "/projects/:id/render/pages",
      storedXml: "/projects/:id/xml",
      google3dCapture: "/projects/:id/google-3d/capture"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "firstmeasure",
    route: "/ping",
    method: request.method,
    query: request.query,
    receivedAt: new Date().toISOString(),
    runtime: await getFirstMeasureRuntimeStatus()
  }));

  app.get("/health/background", async (_request, reply) => {
    const background = await getFirstMeasureWorkerHealth();
    if (!background.healthy) reply.code(503);
    return {
      ok: background.healthy,
      background,
      checked_at: new Date().toISOString()
    };
  });

  app.post("/echo", async (request) => ({
    ok: true,
    api: "firstmeasure",
    route: "/echo",
    method: request.method,
    url: request.url,
    query: request.query,
    body: request.body ?? null,
    receivedAt: new Date().toISOString()
  }));

  app.get("/report-expedite-options", async (request) => {
    const query = asRecord(request.query);
    return buildReportExpediteOptions({ projectType: query.project_type, structureCount: query.structure_count ?? query.structures ?? query.pin_count });
  });

  app.post("/report-expedite-options", async (request) => {
    const body = asRecord(request.body);
    return buildReportExpediteOptions({ projectType: body.project_type, structureCount: body.structure_count ?? body.structures ?? body.pin_count });
  });

  app.post("/admin/index-status", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        error: "forbidden",
        message: "FirstMeasure debug tools require admin or explicit debugging access."
      };
    }

    return {
      ok: true,
      firstmeasure: await getFirstMeasureProjectIndexStatus(),
      runtime: await getFirstMeasureRuntimeStatus()
    };
  });

  app.post("/admin/reindex", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        error: "forbidden",
        message: "FirstMeasure debug tools require admin or explicit debugging access."
      };
    }

    const result = await rebuildFirstMeasureProjectIndex();
    return {
      ok: true,
      result,
      firstmeasure: await getFirstMeasureProjectIndexStatus(),
      runtime: await getFirstMeasureRuntimeStatus()
    };
  });

  app.post("/admin/jobs/status", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        error: "forbidden",
        message: "FirstMeasure debug tools require admin or explicit debugging access."
      };
    }
    const ids = Array.isArray(input.ids) ? input.ids.map((value) => String(value)).filter(Boolean) : [];
    return {
      ok: true,
      runtime: getFirstMeasureJobRuntimeStatus(),
      stats: await getFirstMeasureJobStats(),
      jobs: ids.length ? await listFirstMeasureJobs(ids) : []
    };
  });

  app.post("/admin/jobs/enqueue-stress", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        error: "forbidden",
        message: "FirstMeasure debug tools require admin or explicit debugging access."
      };
    }
    const count = Math.max(1, Math.min(5000, Math.floor(Number(input.count ?? 100))));
    const iterations = Math.max(1, Math.min(250_000_000, Math.floor(Number(input.iterations ?? 8_000_000))));
    const durationMs = Math.max(0, Math.min(120_000, Math.floor(Number(input.duration_ms ?? 0))));
    const priority = Math.floor(Number(input.priority ?? 0));
    const maxAttempts = Math.max(1, Math.min(5, Math.floor(Number(input.max_attempts ?? 1))));
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(await enqueueFirstMeasureJob("stress.cpu", {
        iterations,
        duration_ms: durationMs,
        batch_index: index
      }, {
        priority,
        maxAttempts
      }));
    }
    return {
      ok: true,
      success: true,
      enqueued: ids.length,
      ids,
      runtime: getFirstMeasureJobRuntimeStatus(),
      stats: await getFirstMeasureJobStats()
    };
  });

  app.post("/admin/jobs/:id", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        error: "forbidden",
        message: "FirstMeasure debug tools require admin or explicit debugging access."
      };
    }
    const id = getProjectId(request.params);
    return {
      ok: true,
      job: await getFirstMeasureJob(id)
    };
  });

  app.get("/rush/current", async () => getCurrentRushMode());

  app.post("/admin/rush-modes/list", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        success: false,
        error: "forbidden",
        message: "Rush mode history requires admin or explicit debugging access."
      };
    }

    return {
      ok: true,
      success: true,
      rush_modes: await listRushModes()
    };
  });

  app.post("/admin/rush-modes", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        success: false,
        error: "forbidden",
        message: "Rush mode controls require admin or explicit debugging access."
      };
    }

    const rushMode = await createRushMode({
      start_at: input.start_at,
      duration_minutes: input.duration_minutes,
      duration_seconds: input.duration_seconds,
      actor: normalizeOptionalPortalActor(input.actor) ?? null
    });
    return {
      ok: true,
      success: true,
      rush_mode: rushMode,
      current: await getCurrentRushMode()
    };
  });

  app.post("/admin/rush-modes/automation", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        success: false,
        error: "forbidden",
        message: "Rush mode automation settings require admin or explicit debugging access."
      };
    }

    return getRushAutomationSettings();
  });

  app.post("/admin/rush-modes/automation/update", async (request, reply) => {
    const input = asRecord(request.body);
    if (!canAccessFirstMeasureDebugTools(normalizeOptionalPortalActor(input.actor))) {
      reply.code(403);
      return {
        ok: false,
        success: false,
        error: "forbidden",
        message: "Rush mode automation settings require admin or explicit debugging access."
      };
    }

    return updateRushAutomationSettings(asRecord(input.settings));
  });

  app.post("/projects/queue", async (request, reply) => {
    const rawBody = asRecord(request.body);
    const body = createProjectSchema.parse(rawBody);
    const previousReportCandidate = await findPreviousReportImportCandidate(body.address);
    const projectInput = withDerivedProjectRefs(body);
    const reorderProjectId = String(rawBody.reorder_project_id ?? rawBody.source_project_id ?? "").trim();
    const reordered = reorderProjectId
      ? await reopenRejectedProjectForReorder(reorderProjectId, projectInput, rawBody)
      : null;
    const created = reordered ? { manifest: reordered } : await createProject(projectInput);
    await maybeEvaluateAutomaticRushMode(app, created.manifest.id);
    const projectId = created.manifest.id;
    if (previousReportCandidate) {
      await patchManifest(projectId, { previous_report_candidate: previousReportCandidate });
    }
    const shouldProcessAsync = rawBody.process_async === true;
    const processInput = {
      address: body.address,
      lat: typeof body.lat === "number" ? body.lat : null,
      lng: typeof body.lng === "number" ? body.lng : null,
      radius_meters: typeof body.radius_meters === "number" ? body.radius_meters : null
    };

    if (shouldProcessAsync) {
      void processProjectImagery(projectId, processInput).catch((error) => {
        app.log.error({ err: error, projectId }, "Failed background imagery processing for queued project");
      });
    } else {
      await processProjectImagery(projectId, processInput);
    }

    const refreshed = await getProjectDetail(projectId);
    reply.code(201);
    return {
      ok: true,
      success: true,
      folder: projectId,
      project: refreshed,
      manifest: refreshed.manifest
    };
  });

  app.get("/projects", async (request) => {
    const input = asRecord(request.query);
    const query = parseProjectsQueryInput(input, {
      defaultLimit: 200,
      defaultActivityWindowDays: DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS
    });
    const result = await queryIndexedProjectManifests(query);
    const view = getProjectListView(input);
    return {
      ok: true,
      count: result.count,
      projects: view === "full"
        ? result.projects
        : result.projects.map((manifest) => buildProjectListViewRow(manifest, request, view))
    };
  });

  app.post("/projects", async (request, reply) => {
    const body = createProjectSchema.parse(request.body ?? {});
    const previousReportCandidate = await findPreviousReportImportCandidate(body.address);
    const created = await createProject(withDerivedProjectRefs(body));
    await maybeEvaluateAutomaticRushMode(app, created.manifest.id);
    if (previousReportCandidate) {
      await patchManifest(created.manifest.id, { previous_report_candidate: previousReportCandidate });
      const refreshed = await getProjectDetail(created.manifest.id);
      reply.code(201);
      return { ok: true, project: refreshed };
    }
    reply.code(201);
    return { ok: true, project: created };
  });

  app.post("/instants", async (request, reply) => {
    const body = orderInstantSchema.parse(request.body ?? {});
    const created = await createProject(withDerivedProjectRefs({
      ...body,
      instant_enabled: true,
      instant_only: true
    }));
    await maybeEvaluateAutomaticRushMode(app, created.manifest.id);
    const projectId = created.manifest.id;
    const shouldProcessAsync = body.process_async === true;
    const processInput = {
      address: body.address,
      lat: typeof body.lat === "number" ? body.lat : null,
      lng: typeof body.lng === "number" ? body.lng : null,
      radius_meters: typeof body.radius_meters === "number" ? body.radius_meters : null
    };

    if (shouldProcessAsync) {
      void processProjectImagery(projectId, processInput).catch((error) => {
        app.log.error({ err: error, projectId }, "Failed background instant imagery processing");
      });
      reply.code(202);
      return {
        ok: true,
        accepted: true,
        project: await getProjectDetail(projectId),
        instant_url: buildAbsoluteApiUrl(request, `/instants/${encodeURIComponent(projectId)}`)
      };
    }

    await processProjectImagery(projectId, processInput);
    const project = await getProjectDetail(projectId);
    reply.code(201);
    return {
      ok: true,
      project,
      instant_url: buildAbsoluteApiUrl(request, `/instants/${encodeURIComponent(projectId)}`),
      instant: await buildInstantResponse(projectId, request)
    };
  });

  app.post("/projects/list", async (request) => {
    const input = asRecord(request.body);
    return buildProjectsListResponse(input, request);
  });

  app.post("/projects/find-by-address", async (request) => {
    const input = asRecord(request.body);
    const match = await findIndexedProjectByNormalizedAddress(String(input.address ?? ""));
    const legacy = match ? buildLegacyManifest(match) : null;
    return {
      ok: true,
      success: true,
      exists: Boolean(match),
      folder: legacy?.id ?? null,
      manifest: legacy
    };
  });

  app.post("/projects/query", async (request) => {
    const rawQuery = projectsQuerySchema.parse(request.body ?? {});
    const input = asRecord(rawQuery);
    const query = parseProjectsQueryInput(input, {
      defaultLimit: 100,
      defaultActivityWindowDays: DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS
    });
    const result = await queryIndexedProjectManifests(query);
    const view = getProjectListView(input);
    return {
      ok: true,
      count: result.count,
      projects: view === "full"
        ? result.projects
        : result.projects.map((manifest) => buildProjectListViewRow(manifest, request, view))
    };
  });

  app.get("/projects/:id", async (request) => {
    const projectId = getProjectId(request.params);
    const project = await getProjectDetail(projectId);
    const manifest = buildLegacyManifest(project.manifest);
    if (projectIncludesWeatherReport(manifest) && projectWeatherReportMayGenerate(manifest)) {
      const status = String(manifest.weather_report_status ?? "").trim().toLowerCase();
      const reportId = firstNonBlankString(manifest.weather_report_id, asRecord(manifest.weather_report).id);
      if (status !== "ready" || !reportId) {
        queueProjectWeatherReportGeneration(projectId, manifest);
      }
    }
    return {
      ok: true,
      project
    };
  });

  app.get("/projects/:id/instant", async (request) => ({
    ok: true,
    instant: await buildInstantResponse(getProjectId(request.params), request)
  }));

  app.get("/instants/:id", async (request) => ({
    ok: true,
    instant: await buildInstantResponse(getProjectId(request.params), request)
  }));

  app.post("/projects/:id/instant/ensure", async (request) => ({
    ok: true,
    ...(await ensureProjectInstantResponse(getProjectId(request.params), request))
  }));

  app.post("/projects/:id/weather/order", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const orgId = firstNonBlankString(legacy.organization_id, asRecord(legacy.organization_ref).id);
    if (!orgId) throw badRequest("missing_organization", "This project is missing an organization reference.");
    const enabled = await isAppFlagEnabled(orgId, "firstmeasure", "weather_reports").catch(() => false);
    if (!enabled) throw badRequest("weather_reports_disabled", "Historical weather reports are not enabled for this organization.");
    if (projectIncludesWeatherReport(legacy)) {
      const reportId = firstNonBlankString(legacy.weather_report_id, asRecord(legacy.weather_report).id);
      const currentStatus = String(legacy.weather_report_status ?? "").trim().toLowerCase();
      const ready = Boolean(reportId && currentStatus === "ready");
      const pdfUrl = ready ? firstNonBlankString(legacy.weather_report_pdf_url, projectWeatherPdfUrl(reportId)) : "";
      if (!reportId && currentStatus !== "processing") {
        await patchManifest(projectId, {
          weather_report_tier: "history",
          weather_report_status: "processing"
        });
      }
      if (!ready && projectWeatherReportMayGenerate(legacy)) {
        queueProjectWeatherReportGeneration(projectId, { ...legacy, include_weather_report: true });
      }
      return {
        ok: true,
        success: true,
        already_ordered: true,
        charged_amount: 0,
        weather_report_id: reportId,
        weather_report_pdf_url: pdfUrl,
        weather_report_status: ready ? "ready" : "processing",
        manifest: buildLegacyManifest(await readManifest(projectId))
      };
    }
    const actor = normalizeOptionalPortalActor(body.actor) || normalizeOptionalPortalActor(legacy.issuer) || { email: "", name: "" };
    const actorEmail = firstNonBlankString(actor.email, asRecord(legacy.issuer).email, "weather-report@firstmeasure.internal");
    const manifestStructureCount = Math.max(1, countManifestPins(manifest) || 1);
    const requestedStructureCount = Math.max(0, Math.round(Number(body.structure_count)) || 0);
    const structureCount = Math.max(manifestStructureCount, requestedStructureCount, 1);
    const chargeAmount = moneyAmount(WEATHER_REPORT_ADDON_AMOUNT * structureCount);
    const chargeToken = `weather_${projectId}_${Date.now()}`;
    const charge = await chargePublicFirstMeasureOrder({
      orgId,
      amount: chargeAmount,
      actorEmail,
      meta: {
        charge_token: chargeToken,
        project_id: projectId,
        structure_count: structureCount,
        unit_price: WEATHER_REPORT_ADDON_AMOUNT,
        address: legacy.address ?? null,
        source: "firstmeasure_weather_report_order"
      }
    });
    try {
      const currentAmount = moneyAmount(legacy.amount_charged);
      const patch = {
        include_weather_report: true,
        weather_report_tier: "history",
        weather_report_status: "processing",
        amount_charged: moneyAmount(currentAmount + chargeAmount),
        weather_report_charge_amount: chargeAmount,
        weather_report_structure_count: structureCount,
        weather_report_unit_price: WEATHER_REPORT_ADDON_AMOUNT,
        weather_report_charge_token: chargeToken,
        weather_report_ordered_at: new Date().toISOString()
      };
      await patchManifest(projectId, patch);
      const updated = buildLegacyManifest(await readManifest(projectId));
      if (projectWeatherReportMayGenerate(updated)) {
        queueProjectWeatherReportGeneration(projectId, updated, {
          orgId,
          actorEmail,
          chargeToken,
          amount: chargeAmount
        });
      }
      return {
        ok: true,
        success: true,
        charged_amount: chargeAmount,
        charge,
        weather_report_status: "processing",
        manifest: updated
      };
    } catch (error) {
      await refundPublicFirstMeasureOrder({
        orgId,
        amount: chargeAmount,
        actorEmail,
        reason: "api_firstmeasure_weather_report_refund",
        meta: {
          charge_token: chargeToken,
          project_id: projectId,
          structure_count: structureCount,
          unit_price: WEATHER_REPORT_ADDON_AMOUNT,
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => null);
      throw error;
    }
  });

  app.post("/instants/:id/ensure", async (request) => ({
    ok: true,
    ...(await ensureProjectInstantResponse(getProjectId(request.params), request))
  }));

  app.post("/projects/:id/instant/pdf", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = instantPdfRenderSchema.parse(request.body ?? {});
    const manifest = await readManifest(projectId);
    const result = await generateProjectInstantPdf({
      projectId,
      manifest,
      brandingDefaults: input.branding,
      preparedFor: input.prepared_for,
      showPreparedFor: input.show_prepared_for !== false,
      fileName: typeof input.file_name === "string" && input.file_name.trim() ? input.file_name.trim() : INSTANT_PDF_FILE_NAME
    });
    reply.type("application/pdf");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/instants/:id/pdf", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = instantPdfRenderSchema.parse(request.body ?? {});
    const manifest = await readManifest(projectId);
    const result = await generateProjectInstantPdf({
      projectId,
      manifest,
      brandingDefaults: input.branding,
      preparedFor: input.prepared_for,
      showPreparedFor: input.show_prepared_for !== false,
      fileName: typeof input.file_name === "string" && input.file_name.trim() ? input.file_name.trim() : INSTANT_PDF_FILE_NAME
    });
    reply.type("application/pdf");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/projects/:id/instant/refund", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const manifest = await patchManifest(projectId, {
      refund_issued: Boolean(body.refund_issued ?? true),
      refund_amount: typeof body.refund_amount === "number" ? body.refund_amount : Number(body.refund_amount ?? 0),
      refund_reason: body.refund_reason == null ? "instant_no_coverage" : String(body.refund_reason),
      refund_pending: Boolean(body.refund_pending ?? false)
    });
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(manifest)
    };
  });

  app.get("/projects/:id/editor", async (request) => ({
    ok: true,
    success: true,
    ...(await buildEditorBundle(getProjectId(request.params), request))
  }));

  app.get("/projects/:id/previous-report-candidate", async (request) => {
    const projectId = getProjectId(request.params);
    const manifest = await readManifest(projectId);
    const existing = asRecord((manifest as Record<string, unknown>).previous_report_candidate);
    if (String(existing.status ?? "") === "pending" && toOptionalString(existing.source_project_id)) {
      return { ok: true, success: true, candidate: existing };
    }

    const candidate = await findPreviousReportImportCandidate(manifest.address, { excludeProjectId: projectId });
    return { ok: true, success: true, candidate };
  });

  app.get("/projects/:id/editor/pdf-state", async (request, reply) => {
    const value = await readPdfState(getProjectId(request.params));
    reply.type("application/json; charset=utf-8");
    return reply.send(value ?? null);
  });

  app.post("/projects/:id/editor/save", async (request) => {
    const projectId = getProjectId(request.params);
    const contentType = String(request.headers["content-type"] ?? "");

    let metadata: unknown = undefined;
    let pdfState: unknown = undefined;

    if (contentType.includes("multipart/form-data")) {
      const parts = (request as {
        parts: () => AsyncIterable<{
          type: "file" | "field";
          fieldname: string;
          value?: unknown;
          filename?: string;
          mimetype?: string;
          toBuffer?: () => Promise<Buffer>;
        }>;
      }).parts();

      for await (const part of parts) {
        if (part.type === "file") {
          const buffer = await part.toBuffer?.();
          if (!buffer) continue;
          if (part.fieldname === "pdf_state") {
            pdfState = tryParseJsonBuffer(buffer);
            continue;
          }
          const fileName = sanitizeUploadFileName(part.fieldname, part.filename);
          await saveArtifact(projectId, fileName, buffer);
          continue;
        }

        if (part.fieldname === "metadata") {
          metadata = tryParseJsonString(part.value, undefined);
          continue;
        }
        if (part.fieldname === "pdf_state") {
          pdfState = tryParseJsonString(part.value, null);
        }
      }
    } else {
      const body = asRecord(request.body);
      metadata = Object.prototype.hasOwnProperty.call(body, "metadata") ? body.metadata : undefined;
      pdfState = body.pdf_state;
    }

    if (metadata !== undefined) {
      await saveAppMetadata(projectId, metadata);
    }
    if (pdfState !== undefined) {
      await savePdfState(projectId, pdfState);
    }

    if (metadata !== undefined) {
      const radius = extractRadiusFromMetadata(metadata);
      if (radius !== null) {
        await patchManifest(projectId, { radius_meters: radius });
      }
    }

    return {
      ok: true,
      success: true,
      folder: projectId
    };
  });

  app.post("/projects/:id/editor/presence", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email && !actor?.id) {
      throw badRequest("missing_actor", "A project editor actor is required.");
    }
    if (actor?.email) {
      await touchPortalUserActivity(actor.email);
    }
    const nowIso = new Date().toISOString();
    const manifest = await patchManifest(projectId, {
      editor_presence: {
        ...(actor?.id ? { id: actor.id } : {}),
        ...(actor?.email ? { email: actor.email } : {}),
        ...(actor?.name ? { name: actor.name } : {}),
        ...(actor?.team_id ? { team_id: actor.team_id } : {}),
        at: nowIso
      }
    });
    return {
      ok: true,
      success: true,
      editor_presence: asRecord((manifest as Record<string, unknown>).editor_presence)
    };
  });

  app.patch("/projects/:id", async (request) => {
    const projectId = getProjectId(request.params);
    const patch = patchProjectSchema.parse(request.body ?? {});
    const current = await readManifest(projectId);
    const timedPatch = withRecalculatedReportExpediteTiming(current, patch);
    const manifest = await patchManifest(projectId, timedPatch);
    return {
      ok: true,
      project: {
        manifest,
        files: await listProjectFiles(projectId)
      }
    };
  });

  app.post("/projects/:id/status", async (request) => {
    const projectId = getProjectId(request.params);
    const body = statusUpdateSchema.parse(request.body ?? {});
    const reviewSubmission = isReviewSubmissionStatus(body.status);
    const pdfSync = reviewSubmission
      ? await resolveProjectPdfSyncReference(projectId, body.pdf_sync_job_id, body.pdf_sync_revision)
      : null;
    const project = reviewSubmission
      ? await updateStatusForSubmission(projectId, body.status)
      : await updateStatus(projectId, body.status);
    const persistedStatus = String(project.status ?? "").trim().toLowerCase();
    const accepted = !reviewSubmission || REVIEW_SUBMISSION_STATUSES.has(persistedStatus);
    return {
      ok: true,
      accepted,
      pdf_sync_job_id: pdfSync?.jobId ?? null,
      pdf_sync_revision: pdfSync?.revision ?? null,
      project
    };
  });

  app.get("/projects/:id/app-metadata", async (request) => ({
    ok: true,
    value: await readAppMetadata(getProjectId(request.params))
  }));

  app.put("/projects/:id/app-metadata", async (request) => {
    const body = jsonDocumentSchema.parse(request.body ?? null);
    return { ok: true, value: await saveAppMetadata(getProjectId(request.params), body) };
  });

  app.get("/projects/:id/google-3d/manifest.json", async (request, reply) => {
    reply.type("application/json; charset=utf-8");
    return reply.send(await readProjectGoogle3dManifest(getProjectId(request.params)));
  });

  app.get("/projects/:id/google-3d/tiles/:name", async (request, reply) => {
    const artifact = await readProjectGoogle3dTile(getProjectId(request.params), getFileName(request.params));
    reply.type(getMimeType(artifact.name));
    reply.header("Content-Disposition", `inline; filename="${artifact.name}"`);
    return reply.send(artifact.content);
  });

  app.post("/projects/:id/google-3d/capture", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const manifest = await readManifest(projectId);
    const lat = toFiniteNumber(body.lat) ?? manifest.lat;
    const lng = toFiniteNumber(body.lng) ?? manifest.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw badRequest("missing_project_coordinates", "Project coordinates are required to capture Google 3D tiles.");
    }
    const captureLat = Number(lat);
    const captureLng = Number(lng);

    const address = toOptionalString(body.address) ?? String(manifest.address ?? "").trim();
    const radiusMeters = resolveGoogle3dCaptureRadius(body, manifest);
    const capture = await ensureProjectGoogle3dCapture({
      projectId,
      address: address || String(manifest.address ?? ""),
      lat: captureLat,
      lon: captureLng,
      radiusMeters,
      force: Boolean(body.force)
    });

    const manifestRoute = buildProjectGoogle3dManifestRoute(projectId);
    const manifestApiPath = buildApiPath(manifestRoute);
    const existingMetadata = asRecord(await readAppMetadata(projectId));
    await saveAppMetadata(projectId, {
      ...existingMetadata,
      google3dTiles: {
        ...asRecord(existingMetadata.google3dTiles),
        manifestUrl: manifestApiPath,
        generatedAt: capture.generatedAt,
        anchor: capture.anchor,
        capture: capture.capture,
        source: capture.source
      }
    });

    return {
      ok: true,
      success: true,
      manifest_url: manifestApiPath,
      capture
    };
  });

  app.get("/projects/:id/pdf-state", async (request) => ({
    ok: true,
    value: await readPdfState(getProjectId(request.params))
  }));

  app.put("/projects/:id/pdf-state", { bodyLimit: PDF_JSON_BODY_LIMIT_BYTES }, async (request) => {
    const body = jsonDocumentSchema.parse(request.body ?? null);
    return { ok: true, value: await savePdfState(getProjectId(request.params), body) };
  });

  app.get("/projects/:id/branding-defaults", async (request) => ({
    ok: true,
    value: await readBrandingDefaults(getProjectId(request.params))
  }));

  app.put("/projects/:id/branding-defaults", async (request) => {
    const body = jsonDocumentSchema.parse(request.body ?? null);
    return { ok: true, value: await saveBrandingDefaults(getProjectId(request.params), body) };
  });

  app.get("/projects/:id/artifacts", async (request) => ({
    ok: true,
    files: await listProjectFiles(getProjectId(request.params))
  }));

  app.get("/projects/:id/thumbnail", async (request, reply) => {
    return sendProjectThumbnail(getProjectId(request.params), asRecord(request.query), reply);
  });

  app.post("/projects/:id/artifacts", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const contentType = request.headers["content-type"] ?? "";

    if (contentType.includes("multipart/form-data")) {
      const file = await (request as { file: () => Promise<{ filename: string; toBuffer: () => Promise<Buffer> } | undefined> }).file();
      if (!file) {
        reply.code(400);
        return { ok: false, error: "missing_file" };
      }
      const saved = await saveArtifact(projectId, file.filename, await file.toBuffer());
      return { ok: true, artifact: saved };
    }

    const body = artifactJsonUploadSchema.parse(request.body ?? {});
    const content = body.content_base64
      ? Buffer.from(body.content_base64, "base64")
      : body.content_text ?? "";
    return { ok: true, artifact: await saveArtifact(projectId, body.file_name, content) };
  });

  app.get("/projects/:id/artifacts/:name", async (request, reply) => {
    const artifact = await readArtifact(getProjectId(request.params), getFileName(request.params));
    return sendArtifactContent(artifact, reply);
  });

  app.post("/projects/:id/mask/ensure", async (request) => {
    const projectId = getProjectId(request.params);
    const files = await listProjectFiles(projectId);
    const existingMask = files.find((file) => file.name === "mask.tif");
    if (existingMask) {
      return {
        ok: true,
        success: true,
        already: true,
        url: buildProjectArtifactUrl(request, projectId, "mask.tif", stableFileVersion(existingMask))
      };
    }

    const manifest = await readManifest(projectId);
    await processProjectMask(projectId, {
      address: manifest.address,
      lat: manifest.lat,
      lng: manifest.lng,
      radius_meters: manifest.radius_meters
    });

    const refreshedFiles = await listProjectFiles(projectId).catch(() => []);
    const generatedMask = refreshedFiles.find((file) => file.name === "mask.tif");
    return {
      ok: true,
      success: true,
      already: false,
      url: buildProjectArtifactUrl(request, projectId, "mask.tif", stableFileVersion(generatedMask ?? {}))
    };
  });

  app.post("/queue/status", async (request) => {
    const input = queueStatusSchema.parse(request.body ?? {});
    await touchPortalUserActivity(input.actor.email);
    return {
      ok: true,
      ...(await getQueueStatus({
        ...input,
        queue_mode: input.queue_mode === "disabled" ? "all" : input.queue_mode
      }))
    };
  });

  app.post("/queue/status/compat", async (request) => {
    const input = asRecord(request.body);
    const actor = normalizePortalActor(input);
    await touchPortalUserActivity(actor.email);
    const queueModeValue = await resolveQueueModeValue(actor.email, input.queue_mode);
    const status = await getClaimableQueueStatus({ actor, queue_mode: queueModeValue.internal });
    const activeProjects = input.include_active_projects
      ? await readActorActiveProjectRows(actor.email, request)
      : null;
    return {
      ok: true,
      success: true,
      has_next: !status.queue_blocked && status.claimable_count > 0,
      queue_count: status.queue_count,
      claimable_count: status.claimable_count,
      claimable_next_id: status.claimable_next_id,
      claimable_source: status.claimable_source,
      queue_blocked: status.queue_blocked,
      queue_blocked_reason: status.queue_blocked_reason,
      active_project: status.active_project,
      queue_breakdown: status.queue_breakdown,
      queue_mode: queueModeValue.selected,
      on_break: false,
      break_started_at: null,
      ...(activeProjects ? {
        active_projects: activeProjects,
        active_project_count: activeProjects.length
      } : {})
    };
  });

  app.post("/queue/claim-next", async (request) => {
    const input = queueClaimNextSchema.parse(request.body ?? {});
    await touchPortalUserActivity(input.actor.email);
    return {
      ok: true,
      ...(await claimNextInQueue({
        ...input,
        queue_mode: input.queue_mode === "disabled" ? "all" : input.queue_mode
      }))
    };
  });

  app.post("/queue/claim-next/compat", async (request) => {
    const input = asRecord(request.body);
    const actor = normalizePortalActor(input);
    await touchPortalUserActivity(actor.email);
    const queueModeValue = await resolveQueueModeValue(actor.email, input.queue_mode);
    const claimed = await claimNextInQueue({
      actor,
      queue_mode: queueModeValue.internal,
      preferred_complexity: Array.isArray(input.preferred_complexity)
        ? input.preferred_complexity as Array<number | string>
        : undefined,
      team_id: toOptionalString(input.team_id)
    });
    const manifest = buildLegacyManifest(claimed.project);
    return {
      ok: true,
      success: true,
      found: true,
      folder: manifest.id ?? "",
      address: manifest.address ?? "",
      source: claimed.source
    };
  });

  app.post("/queue/admin/overview", async (request) => {
    const input = queueOverviewSchema.parse(request.body ?? {});
    return { ok: true, ...(await getQueueOverview(input)) };
  });

  app.post("/queue/admin/overview/compat", async (request) => {
    const input = asRecord(request.body);
    return buildQueueOverviewCompat(input, request);
  });

  app.post("/queue/counts", async (request) => {
    const input = asRecord(request.body);
    const parsedQuery = parseProjectsQueryInput(input, {
      defaultLimit: 50,
      defaultActivityWindowDays: DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS
    });
    const counts = await getIndexedQueueCounts({
      team_id: toOptionalString(input.team_id ?? input.team),
      includeInstantOnly: parsedQuery.includeInstantOnly,
      activityStartMs: parsedQuery.activityStartMs ?? null,
      activityEndMs: parsedQuery.activityEndMs ?? null,
      activityFields: parsedQuery.activityFields
    });
    return {
      ok: true,
      success: true,
      groups: FIRSTMEASURE_QUEUE_GROUPS,
      counts: counts.groups,
      total: counts.total,
      total_count: counts.total,
      version: counts.version
    };
  });

  app.post("/queue/bucket", async (request) => {
    const input = asRecord(request.body);
    const parsedQuery = parseProjectsQueryInput(input, {
      defaultLimit: 50,
      defaultActivityWindowDays: DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS
    });
    const view = getProjectListView(input);
    const group = String(input.group ?? input.status_group ?? "queued");
    const result = await queryIndexedQueueBucket({
      group,
      team_id: toOptionalString(input.team_id ?? input.team),
      limit: clampQueueBucketLimit(input.limit, 50, 500),
      offset: Math.max(Number.parseInt(String(input.offset ?? "0"), 10) || 0, 0),
      includeInstantOnly: parsedQuery.includeInstantOnly,
      activityStartMs: parsedQuery.activityStartMs ?? null,
      activityEndMs: parsedQuery.activityEndMs ?? null,
      activityFields: defaultQueueBucketActivityFields(group, parsedQuery.activityFields)
    });
    const projects = view === "full"
      ? await Promise.all(result.rows.map((row) => buildLegacyProjectRow(row.manifest, request, row.thumbnailArtifactName)))
      : result.rows.map((row) => buildProjectListViewRow(row.manifest, request, view, row.thumbnailArtifactName));
    return {
      ok: true,
      success: true,
      group: result.group,
      count: result.count,
      projects,
      pagination: {
        ...result.pagination,
        count: projects.length,
        total_count: result.count
      },
      version: result.version
    };
  });

  app.get("/queue/changes", async (request) => {
    const input = asRecord(request.query);
    return {
      ok: true,
      success: true,
      ...(await readIndexedQueueChanges({
        since: Number.parseInt(String(input.since ?? input.after ?? "0"), 10) || 0,
        limit: clampQueueBucketLimit(input.limit, 250, 1000),
        team_id: toOptionalString(input.team_id ?? input.team)
      }))
    };
  });

  app.post("/queue/changes", async (request) => {
    const input = asRecord(request.body);
    return {
      ok: true,
      success: true,
      ...(await readIndexedQueueChanges({
        since: Number.parseInt(String(input.since ?? input.after ?? "0"), 10) || 0,
        limit: clampQueueBucketLimit(input.limit, 250, 1000),
        team_id: toOptionalString(input.team_id ?? input.team)
      }))
    };
  });

  app.post("/status/snapshot", async (request) => {
    const input = asRecord(request.body);
    return buildPortalStatusSnapshot(input, request);
  });

  app.post("/projects/:id/queue/reserve", async (request) => {
    const input = queueReserveSchema.parse(request.body ?? {});
    const project = await reserveProject(getProjectId(request.params), input);
    const reservedFor = asRecord(asRecord(project.workflow).reserved_to);
    return {
      ok: true,
      success: true,
      project,
      reserved_to_email: String(reservedFor.email ?? ""),
      reserved_to_name: String(reservedFor.name ?? "")
    };
  });

  app.post("/projects/:id/queue/claim", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
    if (!actorEmail) {
      throw badRequest("missing_actor", "A queue claim actor email is required.");
    }

    const manifest = await readManifest(projectId);
    const workflow = asRecord(manifest.workflow);
    const legacy = buildLegacyManifest(manifest);
    const status = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
    const assignedEmail = String(legacy.assigned_to_email ?? "").trim().toLowerCase();
    const reservedEmail = String(legacy.reserved_to_email ?? "").trim().toLowerCase();
    const claimableStatuses = new Set(["queued", "ready", "processing", "in_progress", "correction_needed", "requeue"]);

    if (assignedEmail) {
      if (assignedEmail === actorEmail) {
        if (status === "queued" || status === "ready") {
          const now = new Date().toISOString();
          const nowSql = toSqlDateString(new Date());
          const timestamps = asRecord(manifest.timestamps);
          const nextManifest = {
            ...manifest,
            status: "in_progress",
            timestamps: {
              ...timestamps,
              started_at: timestamps.started_at ?? nowSql,
              updated_at: nowSql
            },
            workflow: {
              ...workflow,
              assigned_to: asRecord(workflow.assigned_to).email ? workflow.assigned_to : actor,
              assigned_at: workflow.assigned_at ?? now,
              reserved_to: null,
              reserved_at: null
            }
          } as ProjectManifest;
          await saveManifest(projectId, nextManifest);
          return {
            ok: true,
            success: true,
            folder: projectId,
            project: nextManifest,
            manifest: buildLegacyManifest(nextManifest),
            resumed: true,
            repaired_status: true
          };
        }
        return {
          ok: true,
          success: true,
          folder: projectId,
          project: manifest,
          manifest: buildLegacyManifest(manifest),
          resumed: true
        };
      }
      throw conflict("project_already_assigned", "Selected project is already assigned.", {
        assigned_to_email: assignedEmail
      });
    }

    if (reservedEmail && reservedEmail !== actorEmail) {
      throw conflict("project_reserved_for_other_user", "Selected project is reserved for another user.", {
        reserved_to_email: reservedEmail
      });
    }

    if (!claimableStatuses.has(status)) {
      throw conflict("project_not_claimable", "Selected project is not in a claimable status.", {
        status
      });
    }

    const now = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const timestamps = asRecord(manifest.timestamps);
    const event = ["correction_needed", "requeue"].includes(status) ? "claimed_correction" : "claimed_new";
    const nextManifest = {
      ...manifest,
      status: "in_progress",
      timestamps: {
        ...timestamps,
        started_at: timestamps.started_at ?? nowSql,
        updated_at: nowSql
      },
      workflow: {
        ...workflow,
        assigned_to: actor,
        assigned_at: now,
        reserved_to: null,
        reserved_at: null,
        history: [
          ...(Array.isArray(workflow.history) ? workflow.history : []),
          {
            ts: now,
            event,
            actor
          }
        ]
      }
    } as ProjectManifest;
    await saveManifest(projectId, nextManifest);

    return {
      ok: true,
      success: true,
      folder: projectId,
      source: "project_claim",
      project: nextManifest,
      manifest: buildLegacyManifest(nextManifest),
      resumed: false
    };
  });

  app.post("/projects/:id/queue/release-reservation", async (request) => {
    const input = queueReleaseSchema.parse(request.body ?? {});
    const project = await releaseReservation(getProjectId(request.params), input);
    return {
      ok: true,
      success: true,
      project,
      reserved_to_email: "",
      reserved_to_name: ""
    };
  });

  app.post("/projects/:id/queue/release-assignment", async (request) => {
    const input = queueReleaseSchema.parse(request.body ?? {});
    return {
      ok: true,
      project: await releaseAssignment(getProjectId(request.params), input)
    };
  });

  app.post("/projects/:id/vip", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const manifest = await patchManifest(projectId, {
      is_vip: Boolean(body.is_vip)
    });
    clearProjectListCaches();
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(manifest)
    };
  });

  app.post("/projects/:id/expedited", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const isExpedited = Boolean(body.is_expedited);
    const patch = isExpedited
      ? { is_expedited: true }
      : { is_expedited: false };
    const manifest = await patchManifest(projectId, patch);
    clearProjectListCaches();
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(manifest)
    };
  });

  app.post("/projects/:id/priority-flag", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const rawFlag = String(body.priority_flag ?? body.flag ?? "").trim().toLowerCase();
    let priorityFlag: ProjectPriorityFlag;
    if (rawFlag === "vip" || rawFlag === "expedited" || rawFlag === "none") {
      priorityFlag = rawFlag;
    } else if (Boolean(body.is_vip)) {
      priorityFlag = "vip";
    } else if (Boolean(body.is_expedited)) {
      priorityFlag = "expedited";
    } else {
      priorityFlag = "none";
    }

    const priorityPatch: Record<string, unknown> = priorityFlag === "none"
      ? { is_vip: false, is_expedited: false }
      : (priorityFlag === "vip" ? { is_vip: true } : { is_expedited: true });
    const manifest = await patchManifest(projectId, priorityPatch);
    clearProjectListCaches();
    return {
      ok: true,
      success: true,
      priority_flag: priorityFlag,
      manifest: buildLegacyManifest(manifest)
    };
  });

  app.post("/projects/:id/qa/priority", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const prioritized = Boolean(body.prioritized ?? body.priority);
    const actor = normalizeOptionalPortalActor(body.actor);
    const nowIso = new Date().toISOString();
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    workHistory.push({
      ts: nowIso,
      event: prioritized ? "qa_priority_enabled" : "qa_priority_cleared",
      actor_email: actor?.email ?? null,
      actor_name: actor?.name ?? actor?.email ?? null
    });

    const updated = await patchManifest(projectId, {
      qa_priority: prioritized,
      qa_priority_at: prioritized ? nowIso : null,
      qa_priority_by_email: prioritized ? (actor?.email ?? null) : null,
      qa_priority_by_name: prioritized ? (actor?.name ?? actor?.email ?? null) : null,
      work_history: workHistory
    });
    clearProjectListCaches();

    return {
      ok: true,
      success: true,
      prioritized,
      manifest: buildLegacyManifest(updated)
    };
  });

  app.post("/projects/:id/coverage/reject", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const note = String(body.note ?? "").trim();
    const rejectionReason = await resolveRejectionReasonId(body.rejection_reason);
    const existingManifest = await readManifest(projectId);
    const existingLegacy = buildLegacyManifest(existingManifest);
    let structureReorder: StructureTypeReorderPayload | null = null;
    if (rejectionReason === "incorrect_structure_type") {
      const correctProjectType = normalizeStructureReorderProjectType(
        body.correct_project_type
        ?? body.reorder_project_type
        ?? body.target_project_type
      );
      if (!STRUCTURE_REORDER_PROJECT_TYPES.has(correctProjectType)) {
        throw badRequest(
          "missing_correct_project_type",
          "Incorrect structure type rejections require the correct project type: commercial or multifamily."
        );
      }
      structureReorder = buildStructureTypeReorderPayload(
        projectId,
        existingLegacy,
        correctProjectType as "commercial" | "multifamily"
      );
    }
    const submittedRejectionReasonDetails = Array.isArray(body.rejection_reasons)
      ? Array.from(new Set(
          await Promise.all(body.rejection_reasons.map((value) => resolveRejectionReasonId(value)))
        )).filter(Boolean)
      : [rejectionReason];
    const rejectionReasonDetails = Array.from(new Set([
      rejectionReason,
      ...submittedRejectionReasonDetails
    ]));
    const actor = normalizeOptionalPortalActor(body.actor);
    const nowSql = toSqlDateString(new Date());
    const organizationRef = asRecord(existingLegacy.organization_ref);
    const ownerRef = asRecord(existingLegacy.owner_ref);
    const issuer = asRecord(existingLegacy.issuer);
    const ownerEmail = String(
      existingLegacy.owner_email
      ?? ownerRef.email
      ?? issuer.email
      ?? ""
    ).trim().toLowerCase();
    const organizationId = String(
      existingLegacy.organization_id
      ?? organizationRef.id
      ?? ""
    ).trim().toLowerCase();
    const amountCharged = Math.max(0, moneyAmount(existingLegacy.amount_charged));
    const existingRefundIssued = Boolean(existingLegacy.refund_issued);
    const callerPreRefunded = Boolean(body.refund_issued);
    let autoRefund:
      | {
        amount: number;
        at: string;
        scope: "org";
        targetEmail: string | null;
        targetOrganizationId: string;
      }
      | null = null;

    if (!existingRefundIssued && !callerPreRefunded && amountCharged > 0) {
      if (!organizationId) {
        throw badRequest(
          "missing_refund_organization",
          "This project does not have an associated organization available for refund."
        );
      }
      const refundAt = new Date().toISOString();
      await refundPublicFirstMeasureOrder({
        orgId: organizationId,
        amount: amountCharged,
        actorEmail: actor?.email ?? ownerEmail ?? "",
        reason: "rejection_refund",
        meta: {
          project_id: projectId,
          address: existingLegacy.address ?? "",
          project_type: existingLegacy.project_type ?? "residential",
          pin_count: Math.max(1, Array.isArray(existingLegacy.pins) ? existingLegacy.pins.length : 1),
          source: "firstmeasure_coverage_reject",
          rejected_by_email: actor?.email ?? null,
          rejected_by_name: actor?.name ?? actor?.email ?? null,
          organization_id: organizationId,
          refund: amountCharged
        }
      });
      autoRefund = {
        amount: amountCharged,
        at: refundAt,
        scope: "org",
        targetEmail: ownerEmail || null,
        targetOrganizationId: organizationId
      };
    }

    const rejectionPatch: Record<string, unknown> = {
      rejection_reason: rejectionReason,
      rejection_note: note,
      rejection_notes: note,
      rejection_reason_details: rejectionReasonDetails,
      rejected_no_coverage_by: actor?.email ?? null,
      timestamps: {
        rejected_at: nowSql,
        updated_at: nowSql
      }
    };
    if ("refund_issued" in body) rejectionPatch.refund_issued = Boolean(body.refund_issued);
    if ("refund_pending" in body) rejectionPatch.refund_pending = Boolean(body.refund_pending);
    if ("refund_amount" in body) rejectionPatch.refund_amount = Number(body.refund_amount ?? 0);
    if ("refund_reason" in body) rejectionPatch.refund_reason = String(body.refund_reason ?? "");
    if (autoRefund) {
      const workflow = asRecord(existingLegacy.workflow);
      const workHistory = Array.isArray(existingLegacy.work_history)
        ? [...existingLegacy.work_history]
        : (Array.isArray(workflow.history) ? [...workflow.history] : []);
      workHistory.push({
        event: "credit_refunded",
        ts: autoRefund.at,
        by_email: actor?.email ?? null,
        by_name: actor?.name ?? actor?.email ?? null,
        refund_amount: autoRefund.amount,
        refund_reason: "rejection_refund",
        project_id: projectId,
        refund_scope: autoRefund.scope,
        refund_to_email: autoRefund.targetEmail,
        refund_to_organization_id: autoRefund.targetOrganizationId,
        note: "Refunded as part of project rejection"
      });
      rejectionPatch.refund_issued = true;
      rejectionPatch.refund_pending = false;
      rejectionPatch.refund_amount = autoRefund.amount;
      rejectionPatch.refund_reason = "rejection_refund";
      rejectionPatch.refund_at = autoRefund.at;
      rejectionPatch.refund_by = actor?.email ?? null;
      rejectionPatch.refund_by_name = actor?.name ?? actor?.email ?? null;
      rejectionPatch.refund_scope = autoRefund.scope;
      rejectionPatch.refund_to_email = autoRefund.targetEmail;
      rejectionPatch.refund_to_organization_id = autoRefund.targetOrganizationId;
      rejectionPatch.work_history = workHistory;
      rejectionPatch.workflow = {
        ...workflow,
        history: workHistory,
        work_history: workHistory
      };
    }
    if (structureReorder) {
      rejectionPatch.correct_project_type = structureReorder.correctProjectType;
      rejectionPatch.rejection_correct_project_type = structureReorder.correctProjectType;
      rejectionPatch.reorder_project_type = structureReorder.correctProjectType;
      rejectionPatch.reorder_url = structureReorder.url;
      rejectionPatch.rejection_reorder = {
        source_project_id: projectId,
        project_type: structureReorder.correctProjectType,
        project_type_label: structureReorder.correctProjectTypeLabel,
        url: structureReorder.url,
        prefill: structureReorder.prefill
      };
      rejectionPatch.customer_rejection_title = "Incorrect structure type";
      rejectionPatch.customer_rejection_message =
        `This was ordered as ${projectTypeLabelForCustomer(existingLegacy.project_type)}, but it appears to require a ${structureReorder.correctProjectTypeLabel} report. We have reimbursed the original report.`;
    }
    if (!String(rejectionPatch.customer_rejection_title ?? "").trim()) {
      rejectionPatch.customer_rejection_title = "Project rejected";
    }
    if (!String(rejectionPatch.customer_rejection_message ?? "").trim()) {
      rejectionPatch.customer_rejection_message = buildRejectionMessageParagraphs({
        ...existingLegacy,
        ...rejectionPatch
      }).join(" ");
    }

    const manifest = await patchManifest(projectId, rejectionPatch);
    const updated = await updateStatus(projectId, "rejected_no_coverage");
    const emailResult = await sendProjectRejectionEmail(projectId, false).catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(updated ?? manifest),
      email_result: emailResult
    };
  });

  app.post("/projects/:id/coverage/push-forward", async (request) => {
    const projectId = getProjectId(request.params);
    const manifest = await patchManifest(projectId, {
      coverage_reviewed_at: new Date().toISOString()
    });
    return { ok: true, success: true, manifest: buildLegacyManifest(manifest) };
  });

  app.post("/projects/:id/requeue/send-to-queue", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const nowIso = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const workflow = asRecord(manifest.workflow);
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    workHistory.push({
      ts: nowIso,
      event: "requeued_manually",
      actor_email: actor?.email ?? null,
      actor_name: actor?.name ?? actor?.email ?? null
    });
    await patchManifest(projectId, {
      work_history: workHistory,
      assigned_to_email: null,
      assigned_to_name: null,
      reserved_to_email: null,
      reserved_to_name: null,
      correction_to_email: null,
      correction_to_name: null,
      qa_claimed_by_email: null,
      qa_claimed_by_name: null,
      editor_presence: null,
      force_kick: null,
      timestamps: {
        ...asRecord(manifest.timestamps),
        queued_at: nowSql,
        started_at: null,
        updated_at: nowSql
      },
      workflow: {
        ...workflow,
        assigned_to: null,
        assigned_at: null,
        reserved_to: null,
        reserved_at: null,
        correction_to: null,
        qa_claim: null
      }
    });
    const updated = await updateStatus(projectId, "queued");
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(updated)
    };
  });

  app.post("/projects/:id/requeue/force", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const now = new Date();
    const nowIso = now.toISOString();
    const nowSql = toSqlDateString(now);
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const workflow = asRecord(manifest.workflow);
    const assignedTo = asRecord(workflow.assigned_to);
    const qaClaim = asRecord(workflow.qa_claim);
    const reservedTo = asRecord(workflow.reserved_to);
    const editorPresence = asRecord((manifest as Record<string, unknown>).editor_presence);
    const status = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();

    if (["completed", "rejected", "rejected_no_coverage", "cancelled"].includes(status)) {
      return {
        ok: true,
        success: false,
        error: "status_not_requeueable",
        message: "Completed, rejected, and cancelled projects cannot be force re-queued.",
        status
      };
    }

    const assignedEmail = String(legacy.assigned_to_email ?? assignedTo.email ?? "").trim().toLowerCase();
    const assignedName = String(legacy.assigned_to_name ?? assignedTo.name ?? "").trim();
    const qaEmail = String(legacy.qa_claimed_by_email ?? qaClaim.email ?? "").trim().toLowerCase();
    const qaName = String(legacy.qa_claimed_by_name ?? qaClaim.name ?? "").trim();
    const reservedEmail = String(legacy.reserved_to_email ?? reservedTo.email ?? "").trim();
    const reservedName = String(legacy.reserved_to_name ?? reservedTo.name ?? "").trim();
    const presenceEmail = String(editorPresence.email ?? "").trim().toLowerCase();
    const presenceName = String(editorPresence.name ?? "").trim();
    const presenceAt = Date.parse(String(editorPresence.at ?? ""));
    const presenceIsFresh = Number.isFinite(presenceAt) && (Date.now() - presenceAt) <= 60_000;
    const kickEmail = (presenceIsFresh ? presenceEmail : "") || assignedEmail;
    const kickName = (presenceIsFresh ? presenceName : "") || assignedName;
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    const forceKick = kickEmail
      ? {
          email: kickEmail,
          name: kickName || kickEmail,
          by: actor?.email ?? null,
          by_name: actor?.name ?? actor?.email ?? null,
          at: nowIso,
          reason: String(body.reason ?? "force_requeue"),
          acknowledged: false
        }
      : null;

    workHistory.push({
      ts: nowIso,
      event: "force_requeued",
      actor_email: actor?.email ?? null,
      actor_name: actor?.name ?? actor?.email ?? null,
      previous_status: status || null,
      kicked_worker_email: kickEmail || null,
      kicked_worker_name: kickName || null,
      cleared_qa_email: qaEmail || null,
      cleared_qa_name: qaName || null,
      cleared_reservation_email: reservedEmail || null,
      cleared_reservation_name: reservedName || null,
      used_editor_presence: presenceIsFresh
    });

    await patchManifest(projectId, {
      assigned_to_email: null,
      assigned_to_name: null,
      qa_claimed_by_email: null,
      qa_claimed_by_name: null,
      reserved_to_email: null,
      reserved_to_name: null,
      correction_to_email: null,
      correction_to_name: null,
      force_kick: forceKick,
      editor_presence: presenceIsFresh ? editorPresence : null,
      work_history: workHistory,
      workflow: {
        ...workflow,
        assigned_to: null,
        assigned_at: null,
        qa_claim: null,
        reserved_to: null,
        reserved_at: null,
        correction_to: null
      },
      timestamps: {
        ...asRecord(manifest.timestamps),
        started_at: null,
        updated_at: nowSql
      }
    });
    const updated = await updateStatus(projectId, "requeue");
    return {
      ok: true,
      success: true,
      message: kickEmail
        ? `Project moved to re-queue. ${kickName || kickEmail} will be removed from the editor.`
        : "Project moved to re-queue.",
      manifest: buildLegacyManifest(updated)
    };
  });

  app.post("/projects/:id/force-kick/status", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
    const manifest = await readManifest(projectId);
    const forceKick = asRecord((manifest as Record<string, unknown>).force_kick);
    const kickEmail = String(forceKick.email ?? "").trim().toLowerCase();
    const acknowledged = Boolean(forceKick.acknowledged);

    if (!kickEmail || acknowledged || !actorEmail || kickEmail !== actorEmail) {
      return {
        ok: true,
        success: true,
        kicked: false
      };
    }

    return {
      ok: true,
      success: true,
      kicked: true,
      kicked_by: String(forceKick.by_name ?? forceKick.by ?? "An administrator"),
      reason: String(forceKick.reason ?? "")
    };
  });

  app.post("/projects/:id/force-kick/acknowledge", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
    const nowIso = new Date().toISOString();
    const manifest = await readManifest(projectId);
    const forceKick = asRecord((manifest as Record<string, unknown>).force_kick);
    const kickEmail = String(forceKick.email ?? "").trim().toLowerCase();

    if (!kickEmail) {
      return {
        ok: true,
        success: true,
        acknowledged: false,
        note: "no_pending_force_kick"
      };
    }

    if (actorEmail && kickEmail !== actorEmail) {
      return {
        ok: true,
        success: false,
        error: "kick_owned_by_other_user"
      };
    }

    const legacy = buildLegacyManifest(manifest);
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    workHistory.push({
      ts: nowIso,
      event: "force_kick_acknowledged",
      worker_email: kickEmail,
      worker_name: String(forceKick.name ?? kickEmail),
      by: actorEmail || null
    });

    await patchManifest(projectId, {
      force_kick: {
        ...forceKick,
        acknowledged: true,
        acknowledged_at: nowIso
      },
      editor_presence: actorEmail && kickEmail === actorEmail ? null : asRecord((manifest as Record<string, unknown>).editor_presence),
      work_history: workHistory
    });

    return {
      ok: true,
      success: true,
      acknowledged: true
    };
  });

  app.post("/projects/:id/afk-kick", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const actorName = actor?.name ?? actorEmail;
    const idleSeconds = Math.max(0, Number.parseInt(String(body.idle_seconds ?? 300), 10) || 300);
    const nowIso = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const status = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
    if (!["in_progress", "processing", "correction_needed"].includes(status)) {
      return {
        ok: true,
        success: true,
        kicked: false,
        note: "status_not_afk_kickable",
        status
      };
    }

    const workflow = asRecord(manifest.workflow);
    const assignedTo = asRecord(workflow.assigned_to);
    const assignedEmail = String(legacy.assigned_to_email ?? assignedTo.email ?? "").trim().toLowerCase();

    if (assignedEmail && actorEmail && assignedEmail !== actorEmail.toLowerCase()) {
      return {
        ok: true,
        success: true,
        note: "not_assigned"
      };
    }

    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    workHistory.push({
      ts: nowIso,
      event: "afk_kicked",
      worker_email: actorEmail || null,
      worker_name: actorName || null,
      idle_seconds: idleSeconds,
      idle_minutes: Math.round((idleSeconds / 60) * 10) / 10
    });

    await patchManifest(projectId, {
      afk_kick: {
        email: actorEmail || null,
        name: actorName || null,
        at: nowSql,
        idle_seconds: idleSeconds
      },
      assigned_to_email: null,
      assigned_to_name: null,
      work_history: workHistory,
      workflow: {
        ...workflow,
        assigned_to: null,
        assigned_at: null
      },
      timestamps: {
        ...asRecord(manifest.timestamps),
        started_at: null,
        updated_at: nowSql
      }
    });
    const updated = await updateStatus(projectId, "requeue");
    return {
      ok: true,
      success: true,
      manifest: buildLegacyManifest(updated)
    };
  });

  app.post("/portal/heartbeat", async () => ({
    ok: true,
    success: true,
    received_at: new Date().toISOString()
  }));

  app.post("/qa/session/heartbeat", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA heartbeat actor email is required.");
    }

    const active = body.active === undefined ? true : Boolean(body.active);
    let renewedClaim = false;
    if (active) {
      const currentFolder = String(body.current_folder ?? "").trim();
      await touchPortalUserActivity(actor.email, {
        qaActive: true,
        qaHeartbeat: true,
        currentFolder
      });
      if (currentFolder) renewedClaim = await renewQaClaimForActor(currentFolder, actor);
    } else {
      await releaseQaClaimsForActor(actor.email, actor, "idle_timeout");
    }
    return {
      ok: true,
      success: true,
      active,
      renewed_claim: renewedClaim,
      received_at: new Date().toISOString()
    };
  });

  app.post("/qa/session/release", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA actor email is required.");
    }
    const projectIds = Array.isArray(body.project_ids)
      ? body.project_ids.map((value) => String(value ?? "").trim()).filter(Boolean)
      : null;
    const released = await releaseQaClaimsForActor(
      actor.email,
      actor,
      String(body.reason ?? "manual"),
      projectIds
    );
    return {
      ok: true,
      success: true,
      released
    };
  });

  app.post("/qa/me/status", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA actor email is required.");
    }
    await touchPortalUserActivity(actor.email, { qaActive: true });
    // A QA actor's staff team is roster/reporting metadata, not an implicit
    // project-queue partition. Only an explicit request field scopes QA work.
    const teamId = normalizeQaTeamFilter(body.team_id ?? body.team);
    const status = await buildQaTechnicianStatus(actor, teamId, request);
    return {
      ok: true,
      success: true,
      ...status
    };
  });

  app.post("/qa/bootstrap", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA actor email is required.");
    }

    // The browser has always requested this cleanup, but the flag was
    // previously ignored. Sweep before touching this actor's QA activity so a
    // reload cannot revive claims left behind by an earlier, expired session.
    if (toBooleanish(body.release_stale)) {
      await releaseStaleQaClaims("qa_bootstrap");
    }
    await touchPortalUserActivity(actor.email, { qaActive: true });
    const roles = Array.isArray(actor.roles) ? actor.roles.map((role) => String(role).trim().toLowerCase()) : [];
    const canManageQueue = Boolean(body.can_manage_queue) || roles.includes("admin") || roles.includes("manager") || roles.includes("queue_admin");
    const canManagerReview = Boolean(body.can_manager_review) || roles.includes("admin") || roles.includes("manager");
    const canDoQa = Boolean(body.can_do_qa) || canManageQueue || canManagerReview || roles.includes("qa");
    const teamId = normalizeQaTeamFilter(body.team_id ?? body.team);

    if (!canManageQueue && !canManagerReview) {
      const status = canDoQa
        ? await buildQaTechnicianStatus(actor, teamId, request)
        : {
            can_manage_queue: false,
            can_do_qa: false,
            can_manager_review: false,
            pending: [],
            claimed_projects: [],
            history: [],
            manager: [],
            manager_history: [],
            stats: {
              claimed_count: 0,
              reviewed_today_count: 0,
              qa_rates_today: [],
              qa_leaderboard_today: { success: true, leaderboard: [], cached: true },
              next_candidate_id: null,
              next_candidate_address: null,
              has_available_next: false
            },
            manual_top_ids: [],
            team: teamId || "all",
            source: "qa_bootstrap_denied"
          };
      return {
        ok: true,
        success: true,
        ...status,
        rejection_reasons: await getRejectionReasons(),
        source: status.source || "qa_bootstrap_technician"
      };
    }

    const limit = Math.max(1, Math.min(500, Number(body.limit ?? 500) || 500));
    const requestedPendingLimit = Number(body.pending_limit ?? body.pending_page_size ?? 200) || 200;
    const pendingLimit = [25, 50, 100, 200].includes(requestedPendingLimit) ? requestedPendingLimit : 200;
    const requestedPendingPage = Math.max(1, Math.floor(Number(body.pending_page ?? 1) || 1));
    const requestedHistoryLimit = Number(body.history_limit ?? body.history_page_size ?? 25) || 25;
    const historyLimit = [10, 25, 50, 100].includes(requestedHistoryLimit) ? requestedHistoryLimit : 25;
    const requestedHistoryPage = Math.max(1, Math.floor(Number(body.history_page ?? 1) || 1));
    const requestedHistoryOffset = Math.max(0, Math.floor(Number(body.history_offset ?? ((requestedHistoryPage - 1) * historyLimit)) || 0));
    const overview = await buildQueueOverviewCompat({
      team: teamId || "all",
      view: "card",
      limit,
      include: ["qa", "pending_rejection"]
    }, request);

    const qaItems = Array.isArray(overview.qa) ? overview.qa.map(asRecord) : [];
    const pendingRejections = Array.isArray(overview.rejected)
      ? overview.rejected.map(asRecord).filter((item) => String(item.status ?? "").trim().toLowerCase() === "pending_rejection")
      : [];
    const pendingById = new Map<string, Record<string, unknown>>();
    for (const item of [...qaItems, ...pendingRejections]) {
      const status = String(item.status ?? "").trim().toLowerCase();
      if (!["awaiting_review", "submission_failed", "pending_rejection"].includes(status)) continue;
      const id = String(item.id ?? item.folder ?? item.project_id ?? "").trim();
      if (id) pendingById.set(id, item);
    }

    const drafterRanks = normalizeDrafterRankMap(body.drafter_ranks);
    const ranked = await getRankedQaQueueManifests({ teamId, live: true, drafterRanks });
    const rankedRows = await Promise.all(ranked.slice(0, limit).map((entry) => (
      buildQaRankedProjectRow(entry, request, "card")
    )));

    const pending: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    rankedRows.forEach((rankedItem, index) => {
      const rankedRecord = asRecord(rankedItem);
      const id = String(rankedRecord.id ?? rankedRecord.folder ?? rankedRecord.project_id ?? "").trim();
      if (!id || !pendingById.has(id)) return;
      pending.push({
        ...pendingById.get(id),
        ...rankedRecord,
        qa_priority: Boolean(rankedRecord.qa_priority),
        qa_priority_rank: index + 1
      });
      seen.add(id);
    });
    for (const item of pendingById.values()) {
      const id = String(item.id ?? item.folder ?? item.project_id ?? "").trim();
      if (id && seen.has(id)) continue;
      pending.push(item);
    }
    pending.forEach((item, index) => {
      if (!item.qa_priority_rank) item.qa_priority_rank = index + 1;
    });

    const actorEmail = String(actor.email ?? "").trim().toLowerCase();
    const claimedByMe = pending.filter((item) => qaClaimEmailFromLegacyRow(item) === actorEmail);
    const nextCandidate = claimedByMe[0] ?? pending.find((item) => qaClaimAvailableForActor(item, actorEmail)) ?? null;
    const pendingTotalCount = pending.length;
    const pendingTotalPages = Math.max(1, Math.ceil(pendingTotalCount / pendingLimit));
    const pendingPage = Math.min(requestedPendingPage, pendingTotalPages);
    const pendingOffset = (pendingPage - 1) * pendingLimit;
    const pendingPageItems = pending.slice(pendingOffset, pendingOffset + pendingLimit);
    const todayBounds = managementDayBounds();
    const historyEndMs = Date.now();
    const completedStatsBucket = await queryIndexedQueueBucket({
      group: "completed",
      team_id: teamId || undefined,
      limit: 500,
      offset: 0,
      activityStartMs: todayBounds.startMs,
      activityEndMs: historyEndMs,
      activityFields: ["completed"]
    });
    const completedStatsRows = completedStatsBucket.rows.map((row) => buildLegacyManifest(row.manifest));
    const historyTotalCount = completedStatsBucket.count;
    const historyTotalPages = Math.max(1, Math.ceil(historyTotalCount / historyLimit));
    const historyPage = Math.min(requestedHistoryPage, historyTotalPages);
    const historyOffset = body.history_offset === undefined
      ? (historyPage - 1) * historyLimit
      : Math.min(requestedHistoryOffset, Math.max(0, historyTotalCount - 1));
    const completedPageRows = historyOffset + historyLimit <= completedStatsBucket.rows.length
      ? completedStatsBucket.rows.slice(historyOffset, historyOffset + historyLimit)
      : (await queryIndexedQueueBucket({
          group: "completed",
          team_id: teamId || undefined,
          limit: historyLimit,
          offset: historyOffset,
          activityStartMs: todayBounds.startMs,
          activityEndMs: historyEndMs,
          activityFields: ["completed"]
        })).rows;
    const completedAny = completedPageRows.map((row) => asRecord(
      buildProjectListViewRow(row.manifest, request, "card", row.thumbnailArtifactName)
    ));
    const leaderboardToday = await loadQaShiftLeaderboard(qaShiftDateKey(), teamId);
    const mineToday = leaderboardToday.leaderboard.find((row) => row.email === actorEmail)?.approved_count ?? 0;
    const manager = canManagerReview
      ? qaItems.filter((item) => String(item.status ?? "").trim().toLowerCase() === "awaiting_manager_review")
      : [];
    const managerHistory = canManagerReview
      ? completedAny.filter((item) => Boolean(item.manager_approved_by) || Boolean(item.manager_approved_by_name))
      : [];

    return {
      ok: true,
      success: true,
      can_manage_queue: canManageQueue,
      can_do_qa: canDoQa,
      can_manager_review: canManagerReview,
      pending: pendingPageItems,
      pending_pagination: {
        page: pendingPage,
        per_page: pendingLimit,
        total_count: pendingTotalCount,
        total_pages: pendingTotalPages,
        offset: pendingOffset,
        has_more: pendingOffset + pendingPageItems.length < pendingTotalCount
      },
      history: completedAny,
      history_pagination: {
        page: historyPage,
        per_page: historyLimit,
        total_count: historyTotalCount,
        total_pages: historyTotalPages,
        offset: historyOffset,
        has_more: historyOffset + completedAny.length < historyTotalCount
      },
      manager,
      manager_history: managerHistory,
      stats: {
        claimed_count: claimedByMe.length,
        reviewed_today_count: mineToday,
        qa_rates_today: canManagerReview ? leaderboardToday.leaderboard : [],
        qa_leaderboard_today: leaderboardToday,
        preferred_project_id: "",
        preferred_project_address: "",
        preferred_project_available: false,
        next_candidate_id: String(nextCandidate?.id ?? nextCandidate?.folder ?? "") || null,
        next_candidate_address: String(nextCandidate?.address ?? "") || null,
        queue_meta: overview.queue_meta ?? null
      },
      manual_top_ids: pending.filter((item) => Boolean(item.qa_priority)).map((item) => String(item.id ?? "")).filter(Boolean),
      team: teamId || "all",
      rejection_reasons: await getRejectionReasons(),
      source: "qa_bootstrap"
    };
  });

  app.post("/qa/leaderboard", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA leaderboard actor email is required.");
    }
    const date = normalizeQaShiftDateKey(body.date);
    const teamId = normalizeQaTeamFilter(body.team_id ?? body.team);
    const leaderboard = await loadQaShiftLeaderboard(date, teamId, Boolean(body.force));
    return {
      ok: true,
      ...leaderboard
    };
  });

  app.post("/qa/queue/peek", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (actor?.email) await touchPortalUserActivity(actor.email, { qaActive: true });
    const teamId = normalizeQaTeamFilter(body.team_id ?? body.team);
    const ranked = await getRankedQaQueueManifests({
      teamId,
      live: body.live !== false,
      drafterRanks: normalizeDrafterRankMap(body.drafter_ranks)
    });
    const limit = Math.max(1, Math.min(100, Number(body.limit ?? 50) || 50));
    const projects = await Promise.all(
      ranked.slice(0, limit).map((entry) => buildQaRankedProjectRow(entry, request, "card"))
    );
    return {
      ok: true,
      success: true,
      projects
    };
  });

  app.post("/qa/queue/pull", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "A QA actor email is required.");
    }

    await touchPortalUserActivity(actor.email, { qaActive: true });
    const count = Math.max(1, Math.min(4, Number(body.count ?? 2) || 2));
    const teamId = normalizeQaTeamFilter(body.team_id ?? body.team);
    const result = await reserveNextQaProjects({
      actor,
      teamId,
      count,
      drafterRanks: normalizeDrafterRankMap(body.drafter_ranks)
    });
    const projects = await Promise.all(
      result.reserved.map((entry) => buildQaRankedProjectRow(entry, request, "card"))
    );

    return {
      ok: true,
      success: true,
      projects,
      reserved_count: projects.length,
      source: result.source,
      queue_cache_age_ms: result.queueCacheAgeMs
    };
  });

  app.post("/qa/bulk-approve", async (request) => {
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    if (!actor?.email) {
      throw badRequest("missing_actor", "An admin actor email is required for bulk QA approval.");
    }
    await requireQaBulkApprovalAdmin(actor.email);
    const actorEmail = actor.email.toLowerCase();

    const criteria = asRecord(body.criteria);
    const ids = Array.isArray(body.project_ids)
      ? body.project_ids.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!ids.length) {
      throw badRequest("missing_projects", "At least one project id is required.");
    }

    const drafterRanks = normalizeDrafterRankMap(body.drafter_ranks);
    const includeClaimed = Boolean(criteria.include_claimed);
    const results = await mapWithConcurrency(ids.slice(0, 250), 8, async (id) => {
      const manifest = await readManifest(id).catch(() => null);
      if (!manifest) {
        return { type: "skipped", id, reason: "not_found" };
      }
      const legacy = buildLegacyManifest(manifest);
      const status = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
      if (status !== "awaiting_review") {
        return { type: "skipped", id, reason: "not_awaiting_review", status };
      }
      const claimedBy = qaClaimEmail(manifest);
      if (claimedBy && claimedBy !== actorEmail && !includeClaimed) {
        return { type: "skipped", id, reason: "claimed", claimed_by: claimedBy };
      }
      const rank = await buildQaRankMeta(manifest, drafterRanks);
      if (!qaBulkApprovalMatches(manifest, rank, criteria)) {
        return { type: "skipped", id, reason: "criteria_mismatch", score: rank.error_score };
      }
      const result = await approveQaProjectFromBulk(manifest, actor, criteria);
      if (result.success) return { type: "approved", id, score: rank.error_score, email_result: result.email_result ?? null };
      return { type: "skipped", id, reason: result.error ?? "approval_failed" };
    });

    const approved = results.filter((row) => row.type === "approved").map(({ type, ...row }) => row);
    const skipped = results.filter((row) => row.type === "skipped").map(({ type, ...row }) => row);

    if (approved.length) qaTechQueueCache.clear();
    return {
      ok: true,
      success: true,
      approved_count: approved.length,
      skipped_count: skipped.length,
      approved,
      skipped
    };
  });

  app.post("/projects/:id/qa/claim", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const actorName = actor?.name ?? actorEmail;
    if (!actorEmail) {
      throw badRequest("missing_actor", "A QA actor email is required to claim this item.");
    }

    const result = await withQaProjectClaimLock(projectId, async () => {
      const manifest = await readManifest(projectId);
      const legacy = buildLegacyManifest(manifest);
      const status = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
      if (!["awaiting_review", "submission_failed"].includes(status)) {
        return {
          ok: true,
          success: false,
          error: "project_not_in_qa_queue",
          status
        };
      }

      const workflow = asRecord(manifest.workflow);
      const qaClaim = asRecord(workflow.qa_claim);
      const claimedByEmail = String(legacy.qa_claimed_by_email ?? qaClaim.email ?? "").trim().toLowerCase();
      const claimedByName = String(legacy.qa_claimed_by_name ?? qaClaim.name ?? "").trim();

      if (claimedByEmail && claimedByEmail !== actorEmail.toLowerCase() && !(await isQaClaimStale(claimedByEmail, legacy.qa_claimed_at ?? qaClaim.claimed_at, manifest))) {
        // The manifest is authoritative, while the queue and dashboard are
        // served from the project index. Repair a split-brain claim before
        // reporting the conflict so the UI immediately shows the real owner.
        await reconcileQaClaimIndex(manifest);
        return {
          ok: true,
          success: false,
          error: "item_claimed_by_other_user",
          claimed_by: claimedByEmail,
          claimed_by_name: claimedByName || claimedByEmail
        };
      }
      if (claimedByEmail && claimedByEmail !== actorEmail.toLowerCase()) {
        await releaseQaClaimOnManifest(manifest, actor, "claimed_stale_takeover");
      }

      await claimQaProjectForActor(manifest, actor);
      return null;
    });
    if (result) return result;

    return {
      ok: true,
      success: true,
      folder: projectId,
      claimed_by: actorEmail,
      claimed_by_name: actorName || actorEmail,
      was_released: false
    };
  });

  app.post("/projects/:id/qa/release-claim", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const force = toBooleanish(body.force);
    const actorRoles = Array.isArray(actor?.roles)
      ? actor.roles.map((role) => String(role).trim().toLowerCase())
      : [];
    const canForceRelease = actorRoles.includes("admin") || actorRoles.includes("manager");
    if (force && (!actorEmail || !canForceRelease)) {
      return {
        ok: true,
        success: false,
        error: "manager_role_required",
        message: "Only managers can force release another QA reviewer's claim."
      };
    }
    const result = await withQaProjectClaimLock(projectId, async () => {
      const manifest = await readManifest(projectId);
      const legacy = buildLegacyManifest(manifest);
      const workflow = asRecord(manifest.workflow);
      const claimedByEmail = String(legacy.qa_claimed_by_email ?? "").trim().toLowerCase();

      if (claimedByEmail && actorEmail && claimedByEmail !== actorEmail.toLowerCase() && !force) {
        return {
          ok: true,
          success: false,
          error: "claim_owned_by_other_user",
          claimed_by: claimedByEmail
        };
      }

      const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
      if (claimedByEmail) {
        workHistory.push({
          ts: new Date().toISOString(),
          event: "qa_claim_released",
          previous_claimer: claimedByEmail,
          released_by: actorEmail || null,
          reason: force ? "manager_force_release" : String(body.reason ?? "manual")
        });
      }

      await patchManifest(projectId, {
        qa_claimed_by_email: null,
        qa_claimed_by_name: null,
        qa_claimed_at: null,
        qa_available: true,
        qa_availability_reason: null,
        hidden_from_queue: false,
        work_history: workHistory,
        workflow: {
          ...workflow,
          qa_claim: null
        }
      }, { backup: false });
      clearQaClaimCaches();
      return null;
    });
    if (result) return result;

    return {
      ok: true,
      success: true,
      folder: projectId
    };
  });

  app.post("/projects/:id/qa/decision", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const decision = String(body.status ?? "").trim().toLowerCase();
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const actorName = actor?.name ?? actorEmail;
    const nowIso = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const workflow = asRecord(manifest.workflow);
    const currentStatus = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
    if (!["awaiting_review", "submission_failed"].includes(currentStatus)) {
      throw conflict("project_not_awaiting_review", "Project is no longer awaiting QA review.", {
        status: currentStatus || null
      });
    }

    if (!actorEmail) {
      throw badRequest("missing_actor", "A QA actor email is required to submit a QA decision.");
    }

    const qaClaim = asRecord(workflow.qa_claim);
    const claimedByEmail = String(legacy.qa_claimed_by_email ?? qaClaim.email ?? "").trim().toLowerCase();
    if (!claimedByEmail || claimedByEmail !== actorEmail.toLowerCase()) {
      throw conflict("qa_claim_required", "This project is no longer claimed by this QA user.", {
        claimed_by: claimedByEmail || null,
        actor: actorEmail
      });
    }

    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    const qaHistory = Array.isArray(legacy.qa_history) ? [...legacy.qa_history] : [];
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const requestedDecisionType = String(body.qa_decision_type ?? body.decision_type ?? "").trim().toLowerCase();
    const correctedByQa = decision === "approved" && (
      Boolean(body.corrected_by_qa ?? body.qa_corrected_by_qa)
      || requestedDecisionType === "qa_corrected_and_approved"
    );
    const qaDecisionType = decision === "rejected"
      ? "technician_correction_requested"
      : (correctedByQa ? "qa_corrected_and_approved" : "approved_without_changes");
    const qaDecisionTracking = {
      qa_decision_type: qaDecisionType,
      qa_correction_needed: qaDecisionType !== "approved_without_changes",
      qa_corrected_by_qa: qaDecisionType === "qa_corrected_and_approved",
      qa_correction_requested_from_technician: qaDecisionType === "technician_correction_requested",
      qa_approved_without_changes: qaDecisionType === "approved_without_changes",
      qa_correction_source: qaDecisionType === "qa_corrected_and_approved"
        ? "qa"
        : (qaDecisionType === "technician_correction_requested" ? "technician" : "none")
    };

    if (decision === "approved") {
      const pdfSync = await resolveProjectPdfSyncReference(
        projectId,
        body.pdf_sync_job_id,
        body.pdf_sync_revision
      );
      if (currentStatus === "submission_failed") {
        workHistory.push({
          ts: nowIso,
          event: "submission_delivery_retried_by_qa",
          qa_email: actorEmail,
          qa_name: actorName
        });
        await patchManifest(projectId, {
          __allow_terminal_status_transition: true,
          status: "completed",
          submission_status: "submitting",
          submission_failure: null,
          qa_claimed_by_email: null,
          qa_claimed_by_name: null,
          qa_claimed_at: null,
          work_history: workHistory,
          workflow: { ...workflow, qa_claim: null }
        });
        const delivery = await enqueueProjectReportDelivery(projectId, pdfSync?.jobId, pdfSync?.revision);
        qaTechQueueCache.clear();
        return {
          ok: true,
          success: true,
          accepted: true,
          submission_retry: true,
          delivery_job_id: delivery.jobId,
          pdf_sync_job_id: delivery.pdfSyncJobId || null,
          pdf_sync_revision: delivery.pdfSyncRevision || null
        };
      }
      const isVip = Boolean(legacy.is_vip ?? manifest.is_vip);
      const qaUser = await readPortalUserByEmail(actorEmail);
      const isQaTrainee = Boolean(qaUser?.is_qa_trainee);
      const requiresManagerReview = isVip || isQaTrainee;
      const managerReviewReasons = [
        ...(isVip ? ["vip"] : []),
        ...(isQaTrainee ? ["qa_trainee"] : [])
      ];
      qaHistory.push({
        ts: nowIso,
        qa_email: actorEmail || null,
        qa_name: actorName || null,
        decision: "approved",
        decision_type: qaDecisionType,
        correction_needed: qaDecisionTracking.qa_correction_needed,
        corrected_by_qa: qaDecisionTracking.qa_corrected_by_qa,
        approved_without_changes: qaDecisionTracking.qa_approved_without_changes
      });
      workHistory.push({
        ts: nowIso,
        event: requiresManagerReview ? "qa_approved_pending_manager" : "qa_approved",
        qa_email: actorEmail || null,
        qa_name: actorName || null,
        decision_type: qaDecisionType,
        correction_needed: qaDecisionTracking.qa_correction_needed,
        corrected_by_qa: qaDecisionTracking.qa_corrected_by_qa,
        approved_without_changes: qaDecisionTracking.qa_approved_without_changes
      });

      await patchManifest(projectId, {
        ...qaDecisionTracking,
        ...(qaDecisionTracking.qa_corrected_by_qa ? rushBonusRemovalPatch("qa_corrected", nowSql) : {}),
        ...(requiresManagerReview ? {} : buildCustomerReworkCompletionPatch(legacy, nowIso, actorEmail, actorName)),
        manager_review_required: requiresManagerReview,
        manager_review_reasons: managerReviewReasons,
        qa_reviewer_was_trainee: isQaTrainee,
        qa_threads: threads,
        qa_history: qaHistory,
        qa_approved_by: actorEmail || null,
        qa_approved_by_name: actorName || null,
        qa_reviewed_by: actorEmail || null,
        qa_reviewed_by_name: actorName || null,
        qa_reviewed_at: nowSql,
        qa_approved_at: nowSql,
        qa_completed_at: requiresManagerReview ? null : nowSql,
        qa_paid_to_email: String(legacy.assigned_to_email ?? "") || null,
        qa_paid_to_name: String(legacy.assigned_to_name ?? "") || null,
        qa_fix_required: false,
        qa_fix_by_email: null,
        qa_fix_by_name: null,
        qa_fix_required_at: null,
        correction_to_email: null,
        correction_to_name: null,
        correction_requested_at: null,
        qa_claimed_by_email: null,
        qa_claimed_by_name: null,
        qa_claimed_at: null,
        work_history: workHistory,
        workflow: {
          ...workflow,
          correction_to: null,
          qa_claim: null
        }
      });

      if (requiresManagerReview) {
        const updated = await updateStatus(projectId, "awaiting_manager_review");
        const updatedLegacy = buildLegacyManifest(updated);
        const updatedStatus = String(updatedLegacy.status ?? updated.status ?? "").trim().toLowerCase();
        if (updatedStatus !== "awaiting_manager_review") {
          throw conflict("qa_manager_review_transition_failed", "QA approval did not persist the expected manager review status.", {
            status: updatedStatus || null
          });
        }
        return {
          ok: true,
          success: true,
          accepted: true,
          delivery_job_id: null,
          pdf_sync_job_id: pdfSync?.jobId ?? null,
          pdf_sync_revision: pdfSync?.revision ?? null,
          manifest: updatedLegacy,
          email_result: null
        };
      }

      const updated = await updateStatus(projectId, "completed");
      const updatedLegacy = buildLegacyManifest(updated);
      const updatedStatus = String(updatedLegacy.status ?? updated.status ?? "").trim().toLowerCase();
      if (updatedStatus !== "completed") {
        throw conflict("qa_completion_failed", "QA approval did not persist the expected completed status.", {
          status: updatedStatus || null
        });
      }
      const delivery = await enqueueProjectReportDelivery(projectId, pdfSync?.jobId, pdfSync?.revision);

      return {
        ok: true,
        success: true,
        accepted: true,
        manifest: updatedLegacy,
        email_result: { ok: true, accepted: true, job_id: delivery.jobId },
        delivery_job_id: delivery.jobId,
        pdf_sync_job_id: delivery.pdfSyncJobId || null,
        pdf_sync_revision: delivery.pdfSyncRevision || null
      };
    }

    if (decision === "rejected") {
      if (Boolean(legacy.customer_rework_in_qa) || getActiveCustomerReworkRequest(legacy)) {
        throw badRequest(
          "customer_rework_cannot_request_tech_correction",
          "Customer rework QA jobs must be approved without changes or corrected and approved."
        );
      }
      const failures = Array.isArray(body.failures) ? body.failures : [];
      const rejectCount = Number(legacy.qa_reject_count ?? 0) + 1;
      const targetTech = resolveOriginalTechnician(legacy, workflow);
      const techOnline = await isTechnicianOnlineForReturn(manifest, targetTech.email);
      qaHistory.push({
        ts: nowIso,
        qa_email: actorEmail || null,
        qa_name: actorName || null,
        decision: "rejected",
        decision_type: qaDecisionType,
        correction_needed: qaDecisionTracking.qa_correction_needed,
        correction_requested_from_technician: qaDecisionTracking.qa_correction_requested_from_technician,
        failures,
        target_tech_email: targetTech.email || null,
        target_tech_name: targetTech.name || null,
        delivery_mode: techOnline ? "reserved_queue" : "unreserved_queue"
      });
      workHistory.push({
        ts: nowIso,
        event: "qa_sent_back_to_tech",
        qa_email: actorEmail || null,
        qa_name: actorName || null,
        decision_type: qaDecisionType,
        correction_needed: qaDecisionTracking.qa_correction_needed,
        correction_requested_from_technician: qaDecisionTracking.qa_correction_requested_from_technician,
        rejection_count: rejectCount,
        target_tech_email: targetTech.email || null,
        target_tech_name: targetTech.name || null,
        delivery_mode: techOnline ? "reserved_queue" : "unreserved_queue"
      });

      const patch: Record<string, unknown> = {
        ...qaDecisionTracking,
        ...rushBonusRemovalPatch("qa_sent_back_to_tech", nowSql),
        qa_reject_count: rejectCount,
        qa_history: qaHistory,
        qa_threads: threads,
        work_history: workHistory,
        assigned_to_email: null,
        assigned_to_name: null,
        reserved_to_email: null,
        reserved_to_name: null,
        qa_claimed_by_email: null,
        qa_claimed_by_name: null,
        qa_claimed_at: null,
        correction_to_email: null,
        correction_to_name: null,
        correction_requested_at: nowSql,
        correction_requested_by: actorEmail || null,
        qa_return_to_email: actorEmail || null,
        qa_return_to_name: actorName || null,
        qa_return_requested_at: nowIso,
        qa_return_submitted_at: null,
        qa_return_hold_expires_at: null,
        qa_fix_required: false,
        qa_fix_by_email: null,
        qa_fix_by_name: null,
        qa_fix_required_at: null,
        workflow: {
          ...workflow,
          assigned_to: null,
          assigned_at: null,
          reserved_to: null,
          reserved_at: null,
          correction_to: null,
          qa_claim: null
        }
      };
      const routed = await routeProjectBackToTechnician({
        projectId,
        manifest,
        actor,
        patch,
        targetTech,
        source: "qa"
      });
      return {
        ok: true,
        success: true,
        manifest: buildLegacyManifest(routed.manifest),
        message: routed.message,
        delivery_mode: routed.deliveryMode,
        worker_online: routed.techOnline,
        target_tech_email: routed.targetTech.email || null,
        target_tech_name: routed.targetTech.name || null
      };
    }

    throw badRequest("invalid_qa_decision", "QA status must be approved or rejected.");
  });

  app.post("/projects/:id/manager/decision", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const decision = String(body.status ?? "").trim().toLowerCase();
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const actorName = actor?.name ?? actorEmail;
    const nowIso = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);

    if (String(legacy.status ?? manifest.status ?? "").trim().toLowerCase() !== "awaiting_manager_review") {
      throw badRequest("project_not_awaiting_manager_review", "Project is not awaiting manager review.");
    }

    const workflow = asRecord(manifest.workflow);
    const threads = Array.isArray(body.threads) ? body.threads : [];
    const notes = String(body.notes ?? "").trim();
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];

    if (decision === "approved") {
      const pdfSync = await resolveProjectPdfSyncReference(
        projectId,
        body.pdf_sync_job_id,
        body.pdf_sync_revision
      );
      workHistory.push({
        ts: nowIso,
        event: "manager_approved",
        manager_email: actorEmail || null,
        manager_name: actorName || null,
        notes: notes || null
      });

      await patchManifest(projectId, {
        ...buildCustomerReworkCompletionPatch(legacy, nowIso, actorEmail, actorName),
        manager_threads: threads,
        manager_approved_by: actorEmail || null,
        manager_approved_by_name: actorName || null,
        manager_approved_at: nowSql,
        completed_at: nowSql,
        work_history: workHistory,
        workflow
      });

      const updated = await updateStatus(projectId, "completed");
      const delivery = await enqueueProjectReportDelivery(projectId, pdfSync?.jobId, pdfSync?.revision);

      return {
        ok: true,
        success: true,
        manifest: buildLegacyManifest(updated),
        accepted: true,
        email_result: { ok: true, accepted: true, job_id: delivery.jobId },
        delivery_job_id: delivery.jobId,
        pdf_sync_job_id: delivery.pdfSyncJobId || null,
        pdf_sync_revision: delivery.pdfSyncRevision || null
      };
    }

    if (decision === "rejected") {
      if (Boolean(legacy.customer_rework_in_qa) || getActiveCustomerReworkRequest(legacy)) {
        throw badRequest(
          "customer_rework_cannot_request_tech_correction",
          "Customer rework manager review jobs must be finalized instead of sent back to the technician."
        );
      }
      const activeIssues = threads.filter((thread) => {
        const status = String(asRecord(thread).status ?? "open").trim().toLowerCase();
        return status !== "closed" && status !== "resolved";
      }).length;
      const targetTech = resolveOriginalTechnician(legacy, workflow);
      const techOnline = await isTechnicianOnlineForReturn(manifest, targetTech.email);

      workHistory.push({
        ts: nowIso,
        event: "manager_sent_back_to_tech",
        manager_email: actorEmail || null,
        manager_name: actorName || null,
        notes: notes || null,
        active_issues: activeIssues,
        worker_email: targetTech.email || null,
        worker_name: targetTech.name || null,
        delivery_mode: techOnline ? "reserved_queue" : "unreserved_queue"
      });

      const routed = await routeProjectBackToTechnician({
        projectId,
        manifest,
        actor,
        patch: {
        ...rushBonusRemovalPatch("manager_sent_back_to_tech", nowSql),
        manager_threads: threads,
        manager_reject_count: Number(legacy.manager_reject_count ?? 0) + 1,
        assigned_to_email: null,
        assigned_to_name: null,
        reserved_to_email: null,
        reserved_to_name: null,
        qa_claimed_by_email: null,
        qa_claimed_by_name: null,
        correction_to_email: null,
        correction_to_name: null,
        correction_requested_at: nowSql,
        correction_requested_by: actorEmail || null,
        work_history: workHistory,
        workflow: {
          ...workflow,
          assigned_to: null,
          assigned_at: null,
          reserved_to: null,
          reserved_at: null,
          correction_to: null,
          qa_claim: null
        }
      },
        targetTech,
        source: "manager"
      });
      return {
        ok: true,
        success: true,
        manifest: buildLegacyManifest(routed.manifest),
        message: routed.message,
        delivery_mode: routed.deliveryMode,
        worker_online: routed.techOnline,
        target_tech_email: routed.targetTech.email || null,
        target_tech_name: routed.targetTech.name || null
      };
    }

    throw badRequest("invalid_manager_decision", "Manager status must be approved or rejected.");
  });

  app.post("/projects/:id/drafter/qa-response", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const pdfSync = await resolveProjectPdfSyncReference(
      projectId,
      body.pdf_sync_job_id,
      body.pdf_sync_revision
    );
    const actor = normalizeOptionalPortalActor(body.actor);
    const actorEmail = actor?.email ?? "";
    const actorName = actor?.name ?? actorEmail;
    const nowIso = new Date().toISOString();
    const nowSql = toSqlDateString(new Date());
    const manifest = await readManifest(projectId);
    const legacy = buildLegacyManifest(manifest);
    const workflow = asRecord(manifest.workflow);
    const incomingThreads = Array.isArray(body.threads) ? body.threads : [];
    const requestedScope = String(body.thread_scope ?? "").trim().toLowerCase();
    const statusNow = String(legacy.status ?? manifest.status ?? "").trim().toLowerCase();
    const isManagerCorrection = requestedScope === "manager"
      || (
        Boolean(legacy.is_vip ?? manifest.is_vip)
        && Boolean(legacy.qa_reviewed_at ?? manifest.qa_reviewed_at)
        && (
        statusNow === "correction_needed"
        || statusNow === "requeue"
          || (Array.isArray(legacy.manager_threads) && legacy.manager_threads.length > 0)
        )
      );
    const normalizedThreads = Array.isArray(incomingThreads) ? incomingThreads : [];
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];

    let fixedCount = 0;
    let disputedCount = 0;
    for (const thread of normalizedThreads) {
      const threadStatus = String(asRecord(thread).status ?? "open").trim().toLowerCase();
      if (threadStatus === "fixed") fixedCount += 1;
      else if (threadStatus === "disputed") disputedCount += 1;
    }

    const patch: Record<string, unknown> = {
      uploaded_at: nowSql,
      last_correction_stats: {
        submitted_at: nowSql,
        fixed_count: fixedCount,
        disputed_count: disputedCount,
        total_threads: normalizedThreads.length
      },
      work_history: [
        ...workHistory,
        {
          ts: nowIso,
          event: "correction_submitted",
          worker_email: actorEmail || null,
          worker_name: actorName || null,
          thread_count: normalizedThreads.length,
          thread_scope: isManagerCorrection ? "manager" : "qa"
        }
      ]
    };

    if (isManagerCorrection) {
      patch.manager_threads = normalizedThreads;
      patch.workflow = {
        ...workflow,
        correction_to: null
      };
      await patchManifest(projectId, patch);
      const updated = await updateStatusForSubmission(projectId, "awaiting_manager_review");
      return {
        ok: true,
        success: true,
        accepted: true,
        pdf_sync_job_id: pdfSync?.jobId ?? null,
        pdf_sync_revision: pdfSync?.revision ?? null,
        manifest: buildLegacyManifest(updated),
        thread_scope: "manager",
        next_status: "awaiting_manager_review"
      };
    }

    patch.qa_threads = normalizedThreads;
    const returnQa = resolveCorrectionReturnQa(legacy);
    const returnHoldExpiresAt = returnQa.email
      ? new Date(Date.now() + QA_CORRECTION_RETURN_HOLD_MS).toISOString()
      : null;
    if (returnQa.email) {
      patch.qa_claimed_by_email = returnQa.email;
      patch.qa_claimed_by_name = returnQa.name || returnQa.email;
      patch.qa_claimed_at = nowIso;
      patch.qa_available = false;
      patch.qa_availability_reason = "claimed";
      patch.hidden_from_queue = true;
      patch.qa_return_to_email = returnQa.email;
      patch.qa_return_to_name = returnQa.name || returnQa.email;
      patch.qa_return_submitted_at = nowIso;
      patch.qa_return_hold_expires_at = returnHoldExpiresAt;
      const correctionWorkHistory = Array.isArray(patch.work_history) ? [...patch.work_history] : [];
      const correctionEventIndex = correctionWorkHistory.length - 1;
      correctionWorkHistory[correctionEventIndex] = {
        ...asRecord(correctionWorkHistory[correctionEventIndex]),
        return_qa_email: returnQa.email,
        return_qa_name: returnQa.name || returnQa.email,
        return_hold_expires_at: returnHoldExpiresAt
      };
      patch.work_history = correctionWorkHistory;
    }
    patch.workflow = {
      ...workflow,
      correction_to: null,
      ...(returnQa.email ? {
        qa_claim: {
          email: returnQa.email,
          name: returnQa.name || returnQa.email,
          claimed_at: nowIso,
          claim_reason: "correction_return",
          hold_expires_at: returnHoldExpiresAt
        }
      } : {})
    };
    await patchManifest(projectId, patch);
    const updated = await updateStatusForSubmission(projectId, "awaiting_review");
    return {
      ok: true,
      success: true,
      accepted: true,
      pdf_sync_job_id: pdfSync?.jobId ?? null,
      pdf_sync_revision: pdfSync?.revision ?? null,
      manifest: buildLegacyManifest(updated),
      thread_scope: "qa",
      next_status: "awaiting_review"
    };
  });

  app.get("/projects/:id/email/status", async (request) => {
    const manifest = await readManifest(getProjectId(request.params));
    return {
      ok: true,
      success: true,
      email_summary: getProjectEmailSummary(manifest)
    };
  });

  app.post("/projects/:id/email/send-report", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const result = await sendProjectEmail(projectId, Boolean(body.force));
    return {
      ok: true,
      success: Boolean(result.ok),
      result
    };
  });

  app.post("/projects/:id/release/force", async (request) => {
    const projectId = getProjectId(request.params);
    const result = await releaseProjectReport(projectId, "forced");
    return {
      ok: true,
      success: Boolean(result.ok),
      result
    };
  });

  app.post("/projects/:id/email/send-rejection", async (request) => {
    const projectId = getProjectId(request.params);
    const body = asRecord(request.body);
    const result = await sendProjectRejectionEmail(projectId, Boolean(body.force));
    return {
      ok: true,
      success: Boolean(result.ok),
      result
    };
  });

  app.get("/apple-key", async () => ({
    ok: true,
    value: await getAppleKeyInfo()
  }));

  app.post("/apple-key", async (request) => {
    const input = appleKeySetSchema.parse(request.body ?? {});
    try {
      return { ok: true, value: await setAppleKey(input) };
    } catch (error) {
      throw mapAppleKeyError(error);
    }
  });

  app.post("/apple-key/ingest", async (request) => {
    const input = appleKeySetSchema.parse(request.body ?? {});
    try {
      return { ok: true, value: await setAppleKey(input) };
    } catch (error) {
      throw mapAppleKeyError(error);
    }
  });

  app.get("/projects/:id/pdf", async (request, reply) => {
    return sendStoredReport(getProjectId(request.params), getSourceQuery(request.query), getPdfSlotQuery(request.query), reply);
  });

  app.get("/projects/:id/pdfs/report", async (request, reply) => {
    return sendStoredReport(getProjectId(request.params), getSourceQuery(request.query), getPdfSlotQuery(request.query), reply);
  });

  app.post("/projects/:id/pdfs/generate", { bodyLimit: PDF_JSON_BODY_LIMIT_BYTES }, async (request) => {
    const input = pdfBatchSchema.parse(request.body ?? {});
    return buildGeneratedProjectPdfBatchResponse(getProjectId(request.params), input, request);
  });

  const enqueueProjectPdfSync = async (
    projectId: string,
    input: ReturnType<typeof pdfBatchSchema.parse>,
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const snapshot = resolvePdfSnapshot(null, { ...input, source: "inline" });
    const snapshotRecord = asRecord(snapshot);
    const revision = firstNonBlankString(
      input.pdf_sync_revision,
      snapshotRecord.pdfSyncRevision,
      snapshotRecord.pdf_sync_revision
    );
    if (!revision) {
      throw badRequest("missing_pdf_sync_revision", "A background PDF sync requires pdf_sync_revision.");
    }
    const recipeVersion = String(input.pdf_render_recipe_version ?? "").trim();
    if (recipeVersion !== PDF_RENDER_RECIPE_VERSION) {
      throw conflict("pdf_render_recipe_version_mismatch", "The client PDF renderer is out of date. Reload the editor and try again.", {
        expected: PDF_RENDER_RECIPE_VERSION,
        received: recipeVersion || null
      });
    }
    const outputs = normalizePdfOutputs(input, true).map((output) => ({
      ...output,
      persist: true,
      updateStatus: false
    }));
    const requestedAt = new Date().toISOString();
    const jobId = createHash("sha256")
      .update(`pdf.sync:${projectId}:${revision}:${Date.now()}:${Math.random()}`)
      .digest("hex")
      .slice(0, 32);

    await savePdfState(projectId, snapshot);
    await patchManifest(projectId, {
      pdf_sync: {
        latest_revision: revision,
        latest_job_id: jobId,
        status: "queued",
        requested_at: requestedAt,
        completed_at: null,
        failed_at: null,
        retry_of_job_id: null,
        checksum_match: null,
        checksum_comparison: [],
        render_checksum_match: null,
        render_checksum_comparison: [],
        byte_checksum_match: null,
        byte_checksum_comparison: [],
        client_checksums: {},
        client_render_checksums: {},
        error: null
      }
    });

    try {
      await enqueueFirstMeasureJob("pdf.sync", {
        project_id: projectId,
        revision,
        snapshot,
        outputs,
        pdf_render_recipe_version: recipeVersion,
        asset_base_url: resolvePublicAssetBaseUrl(request)
      }, { id: jobId, priority: 20, maxAttempts: 3 });
    } catch (error) {
      await patchManifest(projectId, {
        pdf_sync: {
          latest_revision: revision,
          latest_job_id: jobId,
          status: "failed",
          failed_at: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        }
      }).catch(() => undefined);
      throw error;
    }

    reply.code(202);
    return {
      ok: true,
      accepted: true,
      project_id: projectId,
      revision,
      job_id: jobId,
      status: "queued"
    };
  };

  app.post("/projects/:id/pdfs/sync", { bodyLimit: PDF_JSON_BODY_LIMIT_BYTES }, async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = pdfBatchSchema.parse(request.body ?? {});
    return enqueueProjectPdfSync(projectId, input, request, reply);
  });

  app.post("/projects/:id/pdfs/sync/uploads", async (request, reply) => {
    const projectId = getProjectId(request.params);
    await readManifest(projectId);
    const body = asRecord(request.body);
    const uploadId = normalizePdfSyncUploadId(body.upload_id);
    const chunkCount = normalizePdfSyncUploadInteger(body.chunk_count, "chunk_count", 1, PDF_SYNC_UPLOAD_MAX_CHUNKS);
    const payloadBytes = normalizePdfSyncUploadInteger(body.payload_bytes, "payload_bytes", 1, PDF_SYNC_UPLOAD_MAX_PAYLOAD_BYTES);
    const payloadSha256 = String(body.payload_sha256 ?? "").trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(payloadSha256)) {
      throw badRequest("invalid_pdf_sync_upload_checksum", "payload_sha256 must be a SHA-256 hex digest.");
    }
    const directory = pdfSyncUploadDirectory(projectId, uploadId);
    if (!isSpacesArtifactStorageEnabled()) {
      await rm(directory, { recursive: true, force: true });
      await mkdir(directory, { recursive: true });
    }
    const manifest: PdfSyncUploadManifest = {
      project_id: projectId,
      upload_id: uploadId,
      chunk_count: chunkCount,
      payload_bytes: payloadBytes,
      payload_sha256: payloadSha256,
      created_at: new Date().toISOString()
    };
    if (isSpacesArtifactStorageEnabled()) {
      await putProjectArtifact(projectId, pdfSyncUploadArtifactPath(uploadId, "upload.json"), JSON.stringify(manifest));
    } else {
      await writeFile(path.join(directory, "upload.json"), JSON.stringify(manifest));
    }
    reply.code(201);
    return { ok: true, upload_id: uploadId, chunk_count: chunkCount };
  });

  app.post(
    "/projects/:id/pdfs/sync/uploads/:uploadId/chunks/:chunkIndex",
    { bodyLimit: PDF_SYNC_UPLOAD_CHUNK_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const projectId = getProjectId(request.params);
      const params = asRecord(request.params);
      const uploadId = normalizePdfSyncUploadId(params.uploadId);
      const { directory, manifest } = await readPdfSyncUploadManifest(projectId, uploadId);
      const chunkIndex = normalizePdfSyncUploadInteger(params.chunkIndex, "chunk_index", 0, manifest.chunk_count - 1);
      const chunkBase64 = String(asRecord(request.body).chunk_base64 ?? "");
      if (!chunkBase64 || chunkBase64.length % 4 !== 0 || !/^[a-zA-Z0-9+/]*={0,2}$/.test(chunkBase64)) {
        throw badRequest("invalid_pdf_sync_upload_chunk", "The PDF sync upload chunk is not valid base64 data.");
      }
      const chunk = Buffer.from(chunkBase64, "base64");
      if (!chunk.length || chunk.length > PDF_SYNC_UPLOAD_MAX_CHUNK_BYTES) {
        throw badRequest(
          "invalid_pdf_sync_upload_chunk",
          `Each PDF sync upload chunk must be between 1 and ${PDF_SYNC_UPLOAD_MAX_CHUNK_BYTES} bytes.`
        );
      }
      if (isSpacesArtifactStorageEnabled()) {
        await putProjectArtifact(
          projectId,
          pdfSyncUploadArtifactPath(uploadId, `${String(chunkIndex).padStart(6, "0")}.part`),
          chunk
        );
      } else {
        await writeFile(pdfSyncUploadChunkPath(directory, chunkIndex), chunk);
      }
      reply.code(201);
      return { ok: true, upload_id: uploadId, chunk_index: chunkIndex, chunk_bytes: chunk.length };
    }
  );

  app.post("/projects/:id/pdfs/sync/uploads/:uploadId/complete", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const uploadId = normalizePdfSyncUploadId(asRecord(request.params).uploadId);
    const { directory, manifest } = await readPdfSyncUploadManifest(projectId, uploadId);
    const chunks: Buffer[] = [];
    const digest = createHash("sha256");
    let receivedBytes = 0;
    for (let index = 0; index < manifest.chunk_count; index += 1) {
      const chunkPath = pdfSyncUploadChunkPath(directory, index);
      const chunk = isSpacesArtifactStorageEnabled()
        ? await getProjectArtifact(projectId, pdfSyncUploadArtifactPath(uploadId, `${String(index).padStart(6, "0")}.part`))
        : (existsSync(chunkPath) ? await readFile(chunkPath) : null);
      if (!chunk) throw badRequest("incomplete_pdf_sync_upload", `PDF sync upload chunk ${index} is missing.`);
      receivedBytes += chunk.length;
      digest.update(chunk);
      chunks.push(chunk);
    }
    if (receivedBytes !== manifest.payload_bytes) {
      throw badRequest("invalid_pdf_sync_upload_size", "The assembled PDF sync payload size does not match the upload manifest.");
    }
    if (digest.digest("hex") !== manifest.payload_sha256) {
      throw badRequest("invalid_pdf_sync_upload_checksum", "The assembled PDF sync payload checksum does not match.");
    }
    let assembled: unknown;
    try {
      assembled = JSON.parse(Buffer.concat(chunks, receivedBytes).toString("utf8"));
    } catch {
      throw badRequest("invalid_pdf_sync_upload_json", "The assembled PDF sync payload is not valid JSON.");
    }
    const input = pdfBatchSchema.parse(assembled);
    const result = await enqueueProjectPdfSync(projectId, input, request, reply);
    if (isSpacesArtifactStorageEnabled()) {
      await Promise.all([
        deleteProjectArtifact(projectId, pdfSyncUploadArtifactPath(uploadId, "upload.json")),
        ...Array.from({ length: manifest.chunk_count }, (_, index) => (
          deleteProjectArtifact(projectId, pdfSyncUploadArtifactPath(uploadId, `${String(index).padStart(6, "0")}.part`))
        ))
      ]).catch(() => undefined);
    } else {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
    return result;
  });

  app.get("/projects/:id/pdfs/sync/:jobId", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const jobId = String(asRecord(request.params).jobId ?? "").trim();
    const job = await getFirstMeasureJob(jobId);
    if (!job || job.type !== "pdf.sync" || String(job.payload.project_id ?? "") !== projectId) {
      reply.code(404);
      return { ok: false, error: "pdf_sync_job_not_found" };
    }
    return {
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        error: job.error || null,
        result: job.result
      }
    };
  });

  app.post("/projects/:id/pdfs/sync/:jobId/client-checksums", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const jobId = String(asRecord(request.params).jobId ?? "").trim();
    const job = await getFirstMeasureJob(jobId);
    if (!job || job.type !== "pdf.sync" || String(job.payload.project_id ?? "") !== projectId) {
      reply.code(404);
      return { ok: false, error: "pdf_sync_job_not_found" };
    }
    const body = asRecord(request.body);
    const checksums = normalizePdfChecksumMap(body.checksums);
    const renderChecksums = normalizePdfChecksumMap(body.render_checksums);
    if (!Object.keys(checksums).length && !Object.keys(renderChecksums).length) {
      throw badRequest("missing_pdf_checksums", "At least one local PDF or render-recipe SHA-256 checksum is required.");
    }
    const revision = String(job.payload.revision ?? "").trim();
    const currentManifest = await readManifest(projectId);
    if (String(asRecord(currentManifest.pdf_sync).latest_revision ?? "") !== revision) {
      return { ok: true, accepted: false, stale: true, job_id: jobId };
    }
    const byteComparison = comparePdfChecksums(checksums, asRecord(job.result).outputs);
    const renderComparison = comparePdfRenderChecksums(renderChecksums, asRecord(job.result).outputs);
    await patchManifest(projectId, {
      pdf_sync: {
        latest_revision: revision,
        latest_job_id: jobId,
        client_checksums: checksums,
        client_render_checksums: renderChecksums,
        client_checksum_revision: revision,
        ...(renderComparison.compared ? {
          checksum_match: renderComparison.identical,
          checksum_comparison: renderComparison.rows,
          render_checksum_match: renderComparison.identical,
          render_checksum_comparison: renderComparison.rows,
          checksum_compared_at: new Date().toISOString()
        } : {}),
        ...(byteComparison.compared ? {
          byte_checksum_match: byteComparison.identical,
          byte_checksum_comparison: byteComparison.rows
        } : {})
      }
    });

    if (renderComparison.compared && !renderComparison.identical) {
      const retryJobId = createHash("sha256")
        .update(`pdf.sync.retry:${projectId}:${revision}:${Date.now()}:${Math.random()}`)
        .digest("hex")
        .slice(0, 32);
      await patchManifest(projectId, {
        pdf_sync: {
          latest_revision: revision,
          latest_job_id: retryJobId,
          status: "queued",
          retry_of_job_id: jobId,
          client_checksums: checksums,
          client_render_checksums: renderChecksums,
          client_checksum_revision: revision,
          checksum_match: false
        }
      });
      await enqueueFirstMeasureJob("pdf.sync", {
        ...job.payload,
        retry_of_job_id: jobId
      }, { id: retryJobId, priority: 25, maxAttempts: 2 });
      return {
        ok: true,
        accepted: true,
        job_id: retryJobId,
        retry_of_job_id: jobId,
        comparison: renderComparison,
        byte_comparison: byteComparison
      };
    }

    return {
      ok: true,
      accepted: true,
      job_id: jobId,
      comparison: renderComparison,
      byte_comparison: byteComparison
    };
  });

  app.post("/projects/:id/pdfs/generate/server", { bodyLimit: PDF_JSON_BODY_LIMIT_BYTES }, async (request) => {
    const input = pdfBatchSchema.parse(request.body ?? {});
    return buildGeneratedProjectPdfBatchResponse(getProjectId(request.params), input, request);
  });

  app.post("/projects/:id/pdfs/preview", { bodyLimit: PDF_JSON_BODY_LIMIT_BYTES }, async (request, reply) => {
    const input = pdfBatchSchema.parse(request.body ?? {});
    return sendPreviewProjectPdf(getProjectId(request.params), input, request, reply);
  });

  app.get("/projects/:id/pdfs/runtime", async (request) => {
    return buildProjectPdfClientRuntimeResponse(getProjectId(request.params), request);
  });

  app.get("/pdf-runtime/manifest", async (request) => {
    return {
      ok: true,
      runtime: buildPdfClientRuntimeManifest(request)
    };
  });

  app.get("/pdf-runtime/blank", async (_request, reply) => {
    reply.type("text/html; charset=utf-8");
    return reply.send("<!doctype html><html><head><meta charset=\"utf-8\"></head><body></body></html>");
  });

  app.get("/pdf-runtime/assets/:asset", async (request, reply) => {
    const assetName = getPdfRuntimeAssetName(request.params);
    const asset = await getSharedPdfRuntimeAsset(assetName);
    const content = await readFile(asset.filePath);
    reply.type(asset.contentType);
    reply.header("Cache-Control", "public, max-age=300");
    reply.header("Content-Disposition", `inline; filename=\"${asset.fileName}\"`);
    return reply.send(content);
  });

  app.get("/pdf-runtime/fonts/:name", async (request, reply) => {
    const fontName = String((request.params as Record<string, unknown>).name ?? "").trim().toLowerCase();
    const assetName: SharedPdfClientAssetName | null =
      fontName === "montserrat-regular.ttf" ? "font-regular" :
      fontName === "montserrat-bold.ttf" ? "font-bold" :
      null;
    if (!assetName) {
      throw badRequest("unknown_pdf_runtime_font", `Unknown PDF runtime font '${fontName}'.`);
    }
    const asset = await getSharedPdfRuntimeAsset(assetName);
    const content = await readFile(asset.filePath);
    reply.type(asset.contentType);
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send(content);
  });

  app.get("/pdf-runtime/images/:name", async (request, reply) => {
    const imageName = String((request.params as Record<string, unknown>).name ?? "").trim().toLowerCase();
    if (imageName !== "logo_red.png") {
      throw badRequest("unknown_pdf_runtime_image", `Unknown PDF runtime image '${imageName}'.`);
    }
    const asset = await getSharedPdfRuntimeAsset("default-logo");
    const content = await readFile(asset.filePath);
    reply.type(asset.contentType);
    reply.header("Cache-Control", "public, max-age=300");
    return reply.send(content);
  });

  app.post("/projects/:id/pdf/assemble", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    return sendGeneratedProjectReport(getProjectId(request.params), input, reply, true, request);
  });

  app.post("/projects/:id/pdfs/report/assemble", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    return sendGeneratedProjectReport(getProjectId(request.params), input, reply, true, request);
  });

  app.get("/projects/:id/xml", async (request, reply) => {
    const source = getSourceQuery(request.query);
    if (source !== "stored") {
      reply.code(400);
      return { ok: false, error: "custom_xml_fetch_requires_assemble_endpoint" };
    }
    return sendProjectXmlExport({
      projectId: getProjectId(request.params),
      requestedFormat: getXmlFormatQuery(request.query),
      source,
      reply
    });
  });

  app.post("/projects/:id/xml/assemble", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = xmlAssembleSchema.parse(request.body ?? {});
    return sendProjectXmlExport({
      projectId,
      requestedFormat: input.format,
      source: getSourceQuery(input),
      options: asRecord(input.options),
      persistFiles: input.persist_files,
      reply
    });
  });

  app.post("/projects/:id/render/report", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    return sendGeneratedProjectReport(getProjectId(request.params), input, reply, false, request);
  });

  app.post("/projects/:id/render/pdf", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    return sendGeneratedProjectReport(getProjectId(request.params), input, reply, false, request);
  });

  app.post("/projects/:id/render/pages", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = renderReportSchema.parse(request.body ?? {});
    const result = await renderStoredProject(projectId, input, {
      wholeDocument: false,
      title: "FirstMeasure Page Fragment Bundle"
    });
    reply.type("application/pdf");
    reply.header("Content-Disposition", 'inline; filename="firstmeasure-pages.pdf"');
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/projects/:id/render/page", async (request, reply) => {
    const projectId = getProjectId(request.params);
    const input = renderReportSchema.parse(request.body ?? {});
    const result = await renderStoredProject(projectId, input, {
      wholeDocument: false,
      title: "FirstMeasure Page Fragment"
    });
    reply.type("application/pdf");
    reply.header("Content-Disposition", 'inline; filename="firstmeasure-page.pdf"');
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/render/report", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    const result = await renderInlineProject(request.body, input, {
      wholeDocument: true,
      storedFileName: PDF_FILE_NAMES.report
    });
    reply.type("application/pdf");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/render/pdf", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    const result = await renderInlineProject(request.body, input, {
      wholeDocument: true,
      storedFileName: PDF_FILE_NAMES.report
    });
    reply.type("application/pdf");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/render/page", async (request, reply) => {
    const input = renderReportSchema.parse(request.body ?? {});
    const result = await renderInlineProject(request.body, input, {
      wholeDocument: false,
      title: "FirstMeasure Inline Page Fragment"
    });
    reply.type("application/pdf");
    reply.header("Content-Disposition", 'inline; filename="firstmeasure-inline-page.pdf"');
    return reply.send(Buffer.from(result.bytes));
  });

  app.post("/projects/:id/process/imagery", async (request, reply) => {
    return acceptProcessRequest("imagery", getProjectId(request.params), request.body, reply);
  });

  app.post("/projects/:id/process/mask", async (request, reply) => {
    return acceptProcessRequest("mask", getProjectId(request.params), request.body, reply);
  });

  app.post("/projects/:id/process/insights", async (request, reply) => {
    return acceptProcessRequest("insights", getProjectId(request.params), request.body, reply);
  });
};

async function sendStoredReport(
  projectId: string,
  source: "stored" | "custom",
  slot: PdfSlot,
  reply: FastifyReply
) {
  if (source !== "stored") {
    reply.code(400);
    return { ok: false, error: "custom_pdf_fetch_requires_assemble_endpoint" };
  }
  const pdf = await readStoredPdf(projectId, slot);
  reply.type("application/pdf");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("Content-Disposition", `inline; filename="${resolvePdfFileName(slot)}"`);
  return reply.send(pdf.content);
}

async function sendProjectXmlExport(input: {
  projectId: string;
  requestedFormat: unknown;
  source: "stored" | "custom";
  options?: Record<string, unknown>;
  persistFiles?: boolean;
  reply: FastifyReply;
}) {
  const format = resolveXmlExportFormat(input.requestedFormat);
  const manifest = await readManifest(input.projectId);
  const needsStoredRoofplan = format.resolvedFormat !== "firstmeasure";
  const storedRoofplanXml = needsStoredRoofplan
    ? (await readStoredXml(input.projectId)).content.toString("utf-8")
    : null;

  if (format.resolvedFormat === "firstmeasure" && input.source === "stored") {
    throw badRequest(
      "custom_xml_fetch_requires_assemble_endpoint",
      "FirstMeasure XML exports must be requested through the assemble endpoint."
    );
  }

  const payload = buildXmlExportPayload({
    format: format.resolvedFormat,
    manifest,
    storedRoofplanXml,
    options: input.options
  });

  if (input.persistFiles) {
    if (format.resolvedFormat === "roofplan" || format.resolvedFormat === "firstmeasure") {
      await saveArtifact(input.projectId, FIRSTMEASURE_FILE_NAMES.xmlGenerated, payload.content);
    } else {
      await saveArtifact(input.projectId, payload.fileName, payload.content);
    }
    const refreshed = await refreshArtifactFlags(input.projectId, await readManifest(input.projectId));
    await saveManifest(input.projectId, refreshed);
  }

  input.reply.type(payload.contentType);
  input.reply.header("Content-Disposition", `inline; filename="${payload.fileName}"`);
  input.reply.header("X-FirstMeasure-Xml-Format-Requested", format.requestedFormat);
  input.reply.header("X-FirstMeasure-Xml-Format-Resolved", format.resolvedFormat);
  input.reply.header("X-FirstMeasure-Xml-Format-Defaulted", String(format.defaulted));
  input.reply.header("X-FirstMeasure-Xml-Payload-Source", payload.payloadSource);
  return input.reply.send(payload.content);
}

async function buildProjectsListResponse(
  input: Record<string, unknown>,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const filter = String(input.filter ?? "mine").trim().toLowerCase() || "mine";
  const rawSearch = String(input.search ?? "").trim();
  const statusFilter = String(input.status_filter ?? "all").trim().toLowerCase() || "all";
  const complexityFilter = String(input.complexity_filter ?? input.complexity ?? "all").trim().toLowerCase() || "all";
  const actor = normalizeOptionalPortalActor(input.actor);
  const parsedQuery = parseProjectsQueryInput(input, {
    defaultLimit: 35,
    defaultActivityWindowDays: DEFAULT_PROJECT_ACTIVITY_WINDOW_DAYS
  });
  const page = clampPositiveInt(input.page, 1);
  const requestedLimit = Number.parseInt(String(input.limit ?? ""), 10);
  const wantsAll = Number.isFinite(requestedLimit) && requestedLimit === 0;
  const limit = wantsAll ? 5000 : Math.min(parsedQuery.limit ?? 35, 200);
  const view = getProjectListView(input);
  const result = await searchIndexedProjectsForLegacyList({
    filter,
    statusFilter,
    complexityFilter,
    page,
    limit,
    search: rawSearch,
    actor,
    includeInstantOnly: parsedQuery.includeInstantOnly,
    activityStartMs: parsedQuery.activityStartMs ?? null,
    activityEndMs: parsedQuery.activityEndMs ?? null,
    activityFields: parsedQuery.activityFields
  });
  const projects = view === "full"
    ? await Promise.all(
        result.rows.map((row) => buildLegacyProjectRow(row.manifest, request, row.thumbnailArtifactName))
      )
    : result.rows.map((row) => buildProjectListViewRow(row.manifest, request, view, row.thumbnailArtifactName));

  return {
    ok: true,
    success: true,
    view,
    projects,
    search: rawSearch || null,
    status_filter: statusFilter,
    activity_start: formatActivityBoundary(parsedQuery.activityStartMs ?? null),
    activity_end: formatActivityBoundary(parsedQuery.activityEndMs ?? null),
    activity_fields: parsedQuery.activityFields ?? DEFAULT_PROJECT_ACTIVITY_FIELDS,
    pagination: {
      current_page: page,
      page,
      limit,
      total_count: result.totalCount,
      total_pages: Math.max(1, Math.ceil(result.totalCount / limit))
    }
  };
}

async function buildQueueOverviewCompat(
  input: Record<string, unknown>,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const team = String(input.team ?? input.team_id ?? "all").trim();
  const teamId = !team || team === "all" ? undefined : team;
  const view = getProjectListView(input);
  const include = parseQueueOverviewCompatInclude(input.include);
  const wants = (...keys: string[]) => include.size === 0 || keys.some((key) => include.has(key));
  const bucketLimit = resolveQueueOverviewCompatBucketLimit(input);
  const cacheKey = buildQueueOverviewCompatCacheKey(input, request, teamId ?? "all", view);
  const cached = queueOverviewCompatCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const startMs = managementDayBounds().startMs;
  const nowMs = Date.now();
  const recentCompletedStartMs = Math.max(0, nowMs - (48 * 60 * 60 * 1000));
  const completedStartMs = wants("completed_any") ? recentCompletedStartMs : startMs;

  const [
    queued,
    requeue,
    inProgress,
    qa,
    pendingRejection,
    rejectedToday,
    cancelled,
    completedAny
  ] = await Promise.all([
    wants("queued") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["queued", "ready", "no_heightmap", "no_coverage_candidate", "coverage_failed", "needs_coverage_review", "coverage_review", "coverage_hold"]
    }) : Promise.resolve([]),
    wants("requeue") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["requeue", "correction_needed"]
    }) : Promise.resolve([]),
    wants("in_progress") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["processing", "in_progress"]
    }) : Promise.resolve([]),
    wants("qa", "manager") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["awaiting_review", "awaiting_manager_review", "submission_failed"]
    }) : Promise.resolve([]),
    wants("rejected", "pending_rejection") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["pending_rejection"]
    }) : Promise.resolve([]),
    wants("rejected", "rejected_today") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["rejected", "rejected_no_coverage"],
      activityStartMs: startMs,
      activityEndMs: nowMs,
      activityFields: ["rejected"]
    }) : Promise.resolve([]),
    wants("cancelled") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["cancelled"],
      activityStartMs: startMs,
      activityEndMs: nowMs,
      activityFields: ["cancelled"]
    }) : Promise.resolve([]),
    wants("completed_any", "completed_today") ? readQueueCompatRows({
      request,
      teamId,
      view,
      limit: bucketLimit,
      statuses: ["completed"],
      activityStartMs: completedStartMs,
      activityEndMs: nowMs,
      activityFields: ["completed"]
    }) : Promise.resolve([])
  ]);

  const rejected = pendingRejection.concat(rejectedToday);
  const completedToday = completedAny.filter((row) => {
    const ts = parseLegacySortTimestamp(String(row.completed_at ?? ""));
    return ts >= startMs && ts <= nowMs;
  });
  const indexedCounts = await getIndexedQueueCounts({ team_id: teamId });

  const response = {
    ok: true,
    success: true,
    view,
    queued,
    requeue,
    in_progress: inProgress,
    qa,
    rejected,
    cancelled,
    completed_today: completedToday,
    completed_any: completedAny,
    queue_meta: {
      source: "indexed",
      bucket_limit: bucketLimit,
      total_counts: indexedCounts.groups,
      total_count: indexedCounts.total,
      version: indexedCounts.version,
      legacy_full: toBooleanish(input.legacy_full)
    }
  };
  queueOverviewCompatCache.set(cacheKey, {
    expiresAt: Date.now() + QUEUE_OVERVIEW_COMPAT_CACHE_TTL_MS,
    value: response
  });
  pruneExpiredQueueOverviewCompatCache();
  return response;
}

async function readQueueCompatRows(input: {
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  };
  teamId?: string;
  view?: ProjectListView;
  limit?: number;
  statuses: string[];
  activityStartMs?: number | null;
  activityEndMs?: number | null;
  activityFields?: ProjectActivityField[];
}) {
  const result = await queryIndexedProjectManifests({
    statuses: input.statuses,
    team_id: input.teamId,
    activityStartMs: input.activityStartMs ?? null,
    activityEndMs: input.activityEndMs ?? null,
    activityFields: input.activityFields,
    limit: input.limit ?? QUEUE_OVERVIEW_COMPAT_DEFAULT_BUCKET_LIMIT
  });

  const view = input.view ?? "full";
  if (view !== "full") {
    return result.projects.map((manifest) => buildProjectListViewRow(manifest, input.request, view));
  }
  return Promise.all(
    result.projects.map((manifest) => buildLegacyProjectRow(manifest, input.request))
  );
}

function portalStatusBucketLabel(bucket: string) {
  const map: Record<string, string> = {
    needs_structure_pins: "Needs Pins",
    queued: "Queued",
    requeue: "Re-Queue",
    in_progress: "In Progress",
    qa_waiting: "QA Waiting",
    qa_in_progress: "QA In Progress",
    pending_rejection: "Pending Reject"
  };
  return map[bucket] ?? bucket.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function portalStatusBucketKey(row: Record<string, unknown>) {
  const status = String(row.status ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  if (!status || ["completed", "rejected", "rejected_no_coverage", "cancelled"].includes(status)) return null;
  if (["needs_structure_pins", "structure_pins_required"].includes(status)) return "needs_structure_pins";
  if (["queued", "ready", "submitted"].includes(status)) return "queued";
  if (["requeue", "correction_needed"].includes(status)) return "requeue";
  if (["processing", "in_progress"].includes(status)) return "in_progress";
  if (status === "awaiting_review" || status === "submission_failed") {
    const hasQaClaim = String(row.qa_claimed_at ?? "").trim() !== "" || String(row.qa_claimed_by_email ?? "").trim() !== "";
    return hasQaClaim ? "qa_in_progress" : "qa_waiting";
  }
  return status;
}

function statusTimestampMs(value: unknown) {
  return parseLegacySortTimestamp(String(value ?? ""));
}

function statusWorkHistory(row: Record<string, unknown>) {
  const workflow = asRecord(row.workflow);
  if (Array.isArray(row.work_history)) return row.work_history.map(asRecord);
  if (Array.isArray(workflow.history)) return workflow.history.map(asRecord);
  if (Array.isArray(workflow.work_history)) return workflow.work_history.map(asRecord);
  return [];
}

function statusEventTimestampMs(event: Record<string, unknown>) {
  return statusTimestampMs(event.ts ?? event.at ?? event.date ?? event.created_at);
}

function requeuePauseMs(row: Record<string, unknown>, startMs: number, endMs: number) {
  if (startMs <= 0 || endMs <= startMs) return 0;
  const pauseEvents = new Set([
    "qa_rejected",
    "qa_sent_back_to_tech",
    "manager_rejected",
    "manager_sent_back_to_tech",
    "force_requeued",
    "forced_requeue",
    "project_force_requeued",
    "sent_to_requeue",
    "moved_to_requeue",
    "requeued"
  ]);
  const resumeEvents = new Set([
    "claimed_correction",
    "claimed_new",
    "reopened_project_claimed"
  ]);
  const events = statusWorkHistory(row)
    .map((event) => ({
      event: String(event.event ?? event.type ?? "").trim().toLowerCase(),
      ts: statusEventTimestampMs(event)
    }))
    .filter((event) => event.event && event.ts > 0)
    .sort((a, b) => a.ts - b.ts || a.event.localeCompare(b.event));

  let pausedAt: number | null = null;
  let pausedMs = 0;
  for (const event of events) {
    if (event.ts < startMs) continue;
    if (event.ts > endMs) break;
    if (pauseEvents.has(event.event)) {
      if (pausedAt === null) pausedAt = event.ts;
    } else if (resumeEvents.has(event.event) && pausedAt !== null) {
      const pauseStart = Math.max(pausedAt, startMs);
      if (event.ts > pauseStart) pausedMs += event.ts - pauseStart;
      pausedAt = null;
    }
  }
  if (pausedAt !== null) {
    const pauseStart = Math.max(pausedAt, startMs);
    if (endMs > pauseStart) pausedMs += endMs - pauseStart;
  }
  return Math.max(0, pausedMs);
}

function elapsedExcludingRequeueMs(row: Record<string, unknown>, startMs: number, endMs: number) {
  if (startMs <= 0 || endMs <= startMs) return 0;
  return Math.max(0, (endMs - startMs) - requeuePauseMs(row, startMs, endMs));
}

function shouldExcludeStatusProject(row: Record<string, unknown>, options: {
  excludeTestProjects: boolean;
  excludeTutorialProjects: boolean;
}) {
  if (Boolean(row.is_filler)) return true;
  if (options.excludeTutorialProjects && Boolean(row.is_tutorial_instance)) return true;
  if (options.excludeTestProjects && Boolean(row.is_test_org)) return true;
  return false;
}

async function buildPortalStatusSnapshot(
  input: Record<string, unknown>,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  let avgLookbackHours = Number(input.average_lookback_hours ?? 1);
  if (!Number.isFinite(avgLookbackHours) || avgLookbackHours <= 0) avgLookbackHours = 1;
  avgLookbackHours = Math.max(1, Math.min(24 * 90, avgLookbackHours));

  let warningAgeHours = Number(input.warning_age_hours ?? 3);
  if (!Number.isFinite(warningAgeHours) || warningAgeHours <= 0) warningAgeHours = 3;
  warningAgeHours = Math.max(0.25, Math.min(24 * 14, warningAgeHours));

  let criticalWarningAgeHours = Number(input.critical_warning_age_hours ?? 4);
  if (!Number.isFinite(criticalWarningAgeHours) || criticalWarningAgeHours <= 0) criticalWarningAgeHours = 4;
  criticalWarningAgeHours = Math.max(warningAgeHours, Math.min(24 * 14, criticalWarningAgeHours));

  const excludeTestProjects = parseOptionalBoolean(input.exclude_test_projects) !== false;
  const excludeTutorialProjects = parseOptionalBoolean(input.exclude_tutorial_projects) !== false;
  const teamId = toOptionalString(input.team_id ?? input.team);

  const nowMs = Date.now();
  const avgLookbackStartMs = nowMs - Math.round(avgLookbackHours * 3_600_000);
  const warningAgeMs = Math.round(warningAgeHours * 3_600_000);
  const criticalWarningAgeMs = Math.round(criticalWarningAgeHours * 3_600_000);
  const bucketOrder = ["needs_structure_pins", "requeue", "queued", "in_progress", "qa_waiting", "qa_in_progress", "pending_rejection"];
  const bucketCounts: Record<string, number> = Object.fromEntries(bucketOrder.map((bucket) => [bucket, 0]));

  const [indexedCounts, completedProjects, activeGroups] = await Promise.all([
    getIndexedQueueCounts({ team_id: teamId ?? undefined }),
    readQueueCompatRows({
      request,
      teamId: teamId ?? undefined,
      view: "full",
      limit: 300,
      statuses: ["completed"],
      activityStartMs: avgLookbackStartMs,
      activityEndMs: nowMs,
      activityFields: ["completed"]
    }),
    Promise.all([
      readQueueCompatRows({ request, teamId: teamId ?? undefined, view: "full", limit: 300, statuses: ["queued", "ready", "submitted"] }),
      readQueueCompatRows({ request, teamId: teamId ?? undefined, view: "full", limit: 300, statuses: ["requeue", "correction_needed"] }),
      readQueueCompatRows({ request, teamId: teamId ?? undefined, view: "full", limit: 300, statuses: ["processing", "in_progress"] }),
      readQueueCompatRows({ request, teamId: teamId ?? undefined, view: "full", limit: 300, statuses: ["awaiting_review", "awaiting_manager_review"] }),
      readQueueCompatRows({ request, teamId: teamId ?? undefined, view: "full", limit: 300, statuses: ["pending_rejection"] })
    ])
  ]);

  bucketCounts.needs_structure_pins = Number(indexedCounts.groups.needs_structure_pins ?? 0) || 0;
  bucketCounts.requeue = Number(indexedCounts.groups.requeue ?? 0) || 0;
  bucketCounts.queued = (Number(indexedCounts.groups.waiting ?? 0) || 0) + (Number(indexedCounts.groups.queued ?? 0) || 0);
  bucketCounts.in_progress = Number(indexedCounts.groups.in_progress ?? 0) || 0;
  bucketCounts.qa_waiting = Number(indexedCounts.groups.qa_waiting ?? 0) || 0;
  bucketCounts.qa_in_progress = Number(indexedCounts.groups.qa_claimed ?? 0) || 0;

  const activeProjects = activeGroups.flat().map(asRecord);
  for (const row of activeProjects) {
    const bucket = portalStatusBucketKey(row);
    if (bucket === "pending_rejection") bucketCounts.pending_rejection = (bucketCounts.pending_rejection ?? 0) + 1;
  }

  let turnaroundTotalMs = 0;
  let turnaroundCount = 0;
  for (const project of completedProjects.map(asRecord)) {
    if (shouldExcludeStatusProject(project, { excludeTestProjects, excludeTutorialProjects })) continue;
    const createdMs = statusTimestampMs(project.created_at);
    const completedMs = statusTimestampMs(project.completed_at);
    if (createdMs > 0 && completedMs > createdMs && completedMs >= avgLookbackStartMs) {
      turnaroundTotalMs += elapsedExcludingRequeueMs(project, createdMs, completedMs);
      turnaroundCount += 1;
    }
  }

  let warningCount = 0;
  let criticalWarningCount = 0;
  let oldestActiveAgeMs = 0;
  const extraBucketCounts: Record<string, number> = {};
  for (const project of activeProjects) {
    if (shouldExcludeStatusProject(project, { excludeTestProjects, excludeTutorialProjects })) continue;
    const bucket = portalStatusBucketKey(project);
    if (!bucket) continue;
    if (!Object.prototype.hasOwnProperty.call(bucketCounts, bucket)) {
      extraBucketCounts[bucket] = (extraBucketCounts[bucket] ?? 0) + 1;
    }
    const createdMs = statusTimestampMs(project.created_at);
    if (createdMs <= 0) continue;
    const ageMs = elapsedExcludingRequeueMs(project, createdMs, nowMs);
    oldestActiveAgeMs = Math.max(oldestActiveAgeMs, ageMs);
    if (ageMs >= warningAgeMs) warningCount += 1;
    if (ageMs >= criticalWarningAgeMs) criticalWarningCount += 1;
  }

  const statusCounts = bucketOrder.map((bucket) => ({
    key: bucket,
    label: portalStatusBucketLabel(bucket),
    count: Math.max(0, Math.floor(bucketCounts[bucket] ?? 0))
  }));
  for (const bucket of Object.keys(extraBucketCounts).sort()) {
    statusCounts.push({
      key: bucket,
      label: portalStatusBucketLabel(bucket),
      count: Math.max(0, Math.floor(extraBucketCounts[bucket] ?? 0))
    });
  }

  return {
    ok: true,
    success: true,
    generated_at_utc: new Date().toISOString(),
    status_counts: statusCounts,
    active_count: statusCounts.reduce((sum, row) => sum + row.count, 0),
    average_completion_ms: turnaroundCount > 0 ? Math.round(turnaroundTotalMs / turnaroundCount) : null,
    average_completion_count: turnaroundCount,
    warning_count: warningCount,
    critical_warning_count: criticalWarningCount,
    oldest_active_age_ms: Math.round(oldestActiveAgeMs),
    source: "firstmeasure_node_status_snapshot",
    queue_version: indexedCounts.version
  };
}

function mergeLegacyHistoryEntries(...groups: unknown[]) {
  const merged: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      const record = asRecord(entry);
      if (!Object.keys(record).length) continue;
      const key = JSON.stringify(record);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(record);
    }
  }

  return merged;
}

function buildLegacyPersonRef(email: unknown, name: unknown = "") {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  const normalizedName = String(name ?? "").trim();
  if (!normalizedEmail && !normalizedName) return null;
  return {
    email: normalizedEmail,
    name: normalizedName || normalizedEmail
  };
}

function firstNonBlankString(...values: unknown[]) {
  for (const value of values) {
    if (value == null) continue;
    const stringValue = String(value).trim();
    if (stringValue) return stringValue;
  }
  return "";
}

function readLegacyObjectRef(value: unknown) {
  const record = asRecord(value);
  return buildLegacyPersonRef(record.email, record.name);
}

function findLatestProjectTechnicianFromHistory(entries: Array<Record<string, unknown>>) {
  let workerRef: { email: string; name: string } | null = null;
  let targetRef: { email: string; name: string } | null = null;
  let reservedRef: { email: string; name: string } | null = null;
  let claimedRef: { email: string; name: string } | null = null;
  let releasedRef: { email: string; name: string } | null = null;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(entries[index]);
    const event = String(entry.event ?? "").trim().toLowerCase();
    if (!workerRef) {
      workerRef = buildLegacyPersonRef(entry.worker_email, entry.worker_name);
    }
    if (!targetRef) {
      targetRef = buildLegacyPersonRef(entry.target_tech_email, entry.target_tech_name);
    }
    if (!reservedRef) {
      reservedRef = readLegacyObjectRef(entry.reserved_to);
    }
    if (!releasedRef) {
      releasedRef = readLegacyObjectRef(entry.previous_assigned_to);
    }
    if (!claimedRef && event === "claimed_new") {
      claimedRef = readLegacyObjectRef(entry.actor);
    }

    if (workerRef?.email && targetRef?.email && reservedRef?.email && claimedRef?.email && releasedRef?.email) {
      break;
    }
  }

  return workerRef ?? targetRef ?? reservedRef ?? claimedRef ?? releasedRef ?? null;
}

function deriveProjectTechnicianRef(
  manifest: Record<string, unknown> | null,
  legacy: Record<string, unknown>,
  workflow: Record<string, unknown>,
  workHistory: Array<Record<string, unknown>>
) {
  const assigned = asRecord(workflow.assigned_to);
  const correction = asRecord(workflow.correction_to);
  const reserved = asRecord(workflow.reserved_to);
  const editorPresence = asRecord(manifest?.editor_presence);
  const historyRef = findLatestProjectTechnicianFromHistory(workHistory);

  return (
    buildLegacyPersonRef(legacy.qa_paid_to_email, legacy.qa_paid_to_name)
    ?? buildLegacyPersonRef(legacy.assigned_to_email, legacy.assigned_to_name)
    ?? readLegacyObjectRef(assigned)
    ?? historyRef
    ?? readLegacyObjectRef(reserved)
    ?? readLegacyObjectRef(editorPresence)
    ?? buildLegacyPersonRef(legacy.correction_to_email, legacy.correction_to_name)
    ?? readLegacyObjectRef(correction)
    ?? { email: "", name: "" }
  );
}

function deriveLegacyQaRejectCount(
  qaHistory: Array<Record<string, unknown>>,
  workHistory: Array<Record<string, unknown>>
) {
  const qaRejections = qaHistory.filter((entry) => String(entry.decision ?? "").trim().toLowerCase() === "rejected").length;
  if (qaRejections > 0) return qaRejections;
  return workHistory.filter((entry) => {
    const event = String(entry.event ?? "").trim().toLowerCase();
    return event === "qa_rejected" || event === "qa_sent_back_to_tech";
  }).length;
}

function buildLegacyManifest(manifest: ProjectManifest) {
  const workflow = asRecord(manifest.workflow);
  const timestamps = asRecord(manifest.timestamps);
  const ownerRef = asRecord(manifest.owner_ref);
  const organizationRef = asRecord(manifest.organization_ref);
  const teamRef = asRecord(manifest.team_ref);
  const resident = asRecord(manifest.resident);
  const audit = asRecord(manifest.audit);
  const delivery = asRecord(manifest.delivery);
  const artifacts = asRecord(manifest.artifacts);
  const assigned = asRecord(workflow.assigned_to);
  const reserved = asRecord(workflow.reserved_to);
  const correction = asRecord(workflow.correction_to);
  const qaClaim = asRecord(workflow.qa_claim);
  const qaHistory = mergeLegacyHistoryEntries(
    (manifest as Record<string, unknown>).qa_history,
    workflow.qa_history
  );
  const workHistory = mergeLegacyHistoryEntries(
    (manifest as Record<string, unknown>).work_history,
    workflow.work_history,
    workflow.history
  );
  const qaRejectCount = Number(
    (manifest as Record<string, unknown>).qa_reject_count
    ?? deriveLegacyQaRejectCount(qaHistory, workHistory)
  );
  const derivedTechnician = deriveProjectTechnicianRef(
    manifest as Record<string, unknown>,
    {
      qa_paid_to_email: (manifest as Record<string, unknown>).qa_paid_to_email,
      qa_paid_to_name: (manifest as Record<string, unknown>).qa_paid_to_name,
      assigned_to_email: (manifest as Record<string, unknown>).assigned_to_email ?? assigned.email,
      assigned_to_name: (manifest as Record<string, unknown>).assigned_to_name ?? assigned.name,
      correction_to_email: (manifest as Record<string, unknown>).correction_to_email ?? correction.email,
      correction_to_name: (manifest as Record<string, unknown>).correction_to_name ?? correction.name
    },
    workflow,
    workHistory
  );
  const legacy: Record<string, unknown> = {
    ...manifest,
    is_vip: Boolean((manifest as Record<string, unknown>).is_vip),
    is_expedited: Boolean((manifest as Record<string, unknown>).is_expedited),
    owner_email: firstNonBlankString((manifest as Record<string, unknown>).owner_email, ownerRef.email),
    owner_name: firstNonBlankString((manifest as Record<string, unknown>).owner_name, ownerRef.name),
    resident_name: firstNonBlankString((manifest as Record<string, unknown>).resident_name, resident.name),
    resident_email: firstNonBlankString((manifest as Record<string, unknown>).resident_email, resident.email),
    resident_phone: firstNonBlankString((manifest as Record<string, unknown>).resident_phone, resident.phone),
    organization_id: firstNonBlankString((manifest as Record<string, unknown>).organization_id, organizationRef.id),
    team_id: firstNonBlankString((manifest as Record<string, unknown>).team_id, teamRef.id),
    created_at: firstNonBlankString((manifest as Record<string, unknown>).created_at, timestamps.created_at),
    queued_at: firstNonBlankString((manifest as Record<string, unknown>).queued_at, timestamps.queued_at),
    processed_at: firstNonBlankString((manifest as Record<string, unknown>).processed_at, timestamps.processed_at),
    started_at: firstNonBlankString((manifest as Record<string, unknown>).started_at, timestamps.started_at),
    uploaded_at: firstNonBlankString((manifest as Record<string, unknown>).uploaded_at, timestamps.uploaded_at),
    completed_at: firstNonBlankString((manifest as Record<string, unknown>).completed_at, timestamps.completed_at),
    rejected_at: firstNonBlankString((manifest as Record<string, unknown>).rejected_at, timestamps.rejected_at),
    cancelled_at: firstNonBlankString((manifest as Record<string, unknown>).cancelled_at, timestamps.cancelled_at),
    updated_at: firstNonBlankString((manifest as Record<string, unknown>).updated_at, timestamps.updated_at),
    assigned_to_email: firstNonBlankString((manifest as Record<string, unknown>).assigned_to_email, assigned.email),
    assigned_to_name: firstNonBlankString((manifest as Record<string, unknown>).assigned_to_name, assigned.name),
    assigned_at: (manifest as Record<string, unknown>).assigned_at ?? workflow.assigned_at ?? null,
    reserved_to_email: firstNonBlankString((manifest as Record<string, unknown>).reserved_to_email, reserved.email),
    reserved_to_name: firstNonBlankString((manifest as Record<string, unknown>).reserved_to_name, reserved.name),
    reserved_at: (manifest as Record<string, unknown>).reserved_at ?? workflow.reserved_at ?? null,
    correction_to_email: firstNonBlankString((manifest as Record<string, unknown>).correction_to_email, correction.email),
    correction_to_name: firstNonBlankString((manifest as Record<string, unknown>).correction_to_name, correction.name),
    qa_claimed_by_email: firstNonBlankString((manifest as Record<string, unknown>).qa_claimed_by_email, qaClaim.email),
    qa_claimed_by_name: firstNonBlankString((manifest as Record<string, unknown>).qa_claimed_by_name, qaClaim.name),
    qa_claimed_at: (manifest as Record<string, unknown>).qa_claimed_at ?? qaClaim.claimed_at ?? null,
    qa_paid_to_email: String((manifest as Record<string, unknown>).qa_paid_to_email ?? derivedTechnician.email ?? ""),
    qa_paid_to_name: String((manifest as Record<string, unknown>).qa_paid_to_name ?? derivedTechnician.name ?? ""),
    qa_reject_count: Number.isFinite(qaRejectCount) ? qaRejectCount : 0,
    qa_priority: Boolean((manifest as Record<string, unknown>).qa_priority),
    qa_priority_at: (manifest as Record<string, unknown>).qa_priority_at ?? null,
    qa_priority_by_email: String((manifest as Record<string, unknown>).qa_priority_by_email ?? ""),
    qa_priority_by_name: String((manifest as Record<string, unknown>).qa_priority_by_name ?? ""),
    qa_history: qaHistory,
    work_history: workHistory,
    manager_audit_status: (manifest as Record<string, unknown>).manager_audit_status ?? audit.manager_audit_status ?? null,
    manager_audit_note: (manifest as Record<string, unknown>).manager_audit_note ?? audit.manager_audit_note ?? null,
    manager_audit_annotations: (manifest as Record<string, unknown>).manager_audit_annotations ?? audit.manager_audit_annotations ?? null,
    report_sent_at: (manifest as Record<string, unknown>).report_sent_at ?? delivery.report_sent_at ?? null,
    email_state: (manifest as Record<string, unknown>).email_state ?? delivery.email_state ?? [],
    email_events: (manifest as Record<string, unknown>).email_events ?? delivery.email_events ?? [],
    has_report_pdf: Boolean(artifacts.has_report_pdf),
    has_summary_pdf: Boolean(artifacts.has_summary_pdf)
  };
  return legacy;
}

async function buildLegacyProjectRow(
  manifest: ProjectManifest,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  thumbnailArtifactName?: string | null
) {
  const legacy = buildLegacyManifest(manifest);
  let thumb: string | null = null;
  const releaseHeld = isReportReleaseHeld(legacy);
  const releaseHold = getReportReleaseHold(legacy);
  const isCustomerReady = String(legacy.status ?? "").trim().toLowerCase() === "completed" && Boolean(legacy.has_report_pdf) && !releaseHeld;
  const reportExpediteOption = String(legacy.report_expedite_option ?? "").trim();
  const hasExpeditedReportOption = isExpeditedReportOption(reportExpediteOption);

  if (thumbnailArtifactName) {
    thumb = buildProjectArtifactUrl(request, manifest.id, thumbnailArtifactName);
  }
  if (!thumb && isCustomerReady) {
    thumb = buildAbsoluteApiUrl(
      request,
      `/projects/${encodeURIComponent(manifest.id)}/pdf?slot=main`
    );
  }

  return {
    id: String(legacy.id ?? ""),
    address: String(legacy.address ?? ""),
    status: String(legacy.status ?? ""),
    owner: String(legacy.owner_name ?? legacy.owner_email ?? "Unknown"),
    owner_email: String(legacy.owner_email ?? ""),
    resident_name: String(legacy.resident_name ?? ""),
    resident_email: String(legacy.resident_email ?? ""),
    resident_phone: String(legacy.resident_phone ?? ""),
    project_type: String(legacy.project_type ?? "residential"),
    created_at: legacy.created_at ?? "",
    queued_at: legacy.queued_at ?? "",
    processed_at: legacy.processed_at ?? "",
    uploaded_at: legacy.uploaded_at ?? "",
    completed_at: legacy.completed_at ?? "",
    rejected_at: legacy.rejected_at ?? "",
    cancelled_at: legacy.cancelled_at ?? "",
    updated_at: legacy.updated_at ?? "",
    correction_requested_at: legacy.correction_requested_at ?? "",
    complexity: legacy.complexity ?? null,
    point_value: Number(legacy.point_value ?? 0) || null,
    amount_charged: Number(legacy.amount_charged ?? 0),
    refund_issued: Boolean(legacy.refund_issued),
    refund_pending: Boolean(legacy.refund_pending),
    refund_amount: Number(legacy.refund_amount ?? 0) || 0,
    refund_reason: legacy.refund_reason ?? null,
    refund_at: legacy.refund_at ?? null,
    rejection_reason: String(legacy.rejection_reason ?? ""),
    rejection_reason_details: Array.isArray(legacy.rejection_reason_details) ? legacy.rejection_reason_details : [],
    rejection_message: String(legacy.rejection_message ?? ""),
    rejection_note: String(legacy.rejection_note ?? legacy.rejection_notes ?? ""),
    customer_rejection_title: String(legacy.customer_rejection_title ?? ""),
    customer_rejection_message: String(legacy.customer_rejection_message ?? ""),
    correct_project_type: String(legacy.correct_project_type ?? legacy.rejection_correct_project_type ?? ""),
    rejection_correct_project_type: String(legacy.rejection_correct_project_type ?? ""),
    reorder_project_type: String(legacy.reorder_project_type ?? ""),
    reorder_url: String(legacy.reorder_url ?? ""),
    rejection_reorder: legacy.rejection_reorder ?? null,
    instant_rejection_reason: String(legacy.instant_rejection_reason ?? ""),
    pins: Array.isArray(legacy.pins) ? legacy.pins : [],
    cc_emails: Array.isArray(legacy.cc_emails) ? legacy.cc_emails : [],
    include_gutter_measurements: Boolean(legacy.include_gutter_measurements),
    is_filler: Boolean(legacy.is_filler),
    is_vip: Boolean(legacy.is_vip),
    is_expedited: Boolean(legacy.is_expedited) || hasExpeditedReportOption,
    report_expedite_option: reportExpediteOption || null,
    report_expedite_label: legacy.report_expedite_label ?? null,
    report_due_window_start: legacy.report_due_window_start ?? null,
    report_due_window_end: legacy.report_due_window_end ?? null,
    report_due_window_label: legacy.report_due_window_label ?? null,
    report_production_deadline_at: legacy.report_production_deadline_at ?? null,
    deadline_at: reportProductionDeadlineAt(legacy, hasExpeditedReportOption),
    instant_enabled: Boolean(legacy.instant_enabled),
    instant_only: Boolean(legacy.instant_only),
    is_test_org: Boolean(legacy.is_test_org),
    organization_id: String(legacy.organization_id ?? ""),
    team_id: String(legacy.team_id ?? ""),
    assigned_to_email: String(legacy.assigned_to_email ?? ""),
    assigned_to_name: String(legacy.assigned_to_name ?? ""),
    reserved_to_email: String(legacy.reserved_to_email ?? ""),
    reserved_to_name: String(legacy.reserved_to_name ?? ""),
    correction_to_email: String(legacy.correction_to_email ?? ""),
    correction_to_name: String(legacy.correction_to_name ?? ""),
    qa_claimed_by_email: String(legacy.qa_claimed_by_email ?? ""),
    qa_claimed_by_name: String(legacy.qa_claimed_by_name ?? ""),
    qa_priority: Boolean(legacy.qa_priority),
    qa_priority_at: legacy.qa_priority_at ?? null,
    qa_priority_by_email: String(legacy.qa_priority_by_email ?? ""),
    qa_priority_by_name: String(legacy.qa_priority_by_name ?? ""),
    qa_approved_by: String(legacy.qa_approved_by ?? ""),
    qa_approved_by_name: String(legacy.qa_approved_by_name ?? ""),
    qa_paid_to_email: String(legacy.qa_paid_to_email ?? ""),
    qa_paid_to_name: String(legacy.qa_paid_to_name ?? ""),
    qa_reject_count: Number(legacy.qa_reject_count ?? 0),
    rush_bonus_tag: Boolean(legacy.rush_bonus_tag),
    rush_bonus_eligible: Boolean(legacy.rush_bonus_eligible),
    rush_bonus_percent: Number(legacy.rush_bonus_percent ?? legacy.rush_bonus_amount ?? 0) || null,
    rush_bonus_mode_id: String(legacy.rush_bonus_mode_id ?? ""),
    rush_bonus_tagged_at: legacy.rush_bonus_tagged_at ?? null,
    rush_bonus_removed_at: legacy.rush_bonus_removed_at ?? null,
    rush_bonus_removed_reason: String(legacy.rush_bonus_removed_reason ?? ""),
    customer_rework_in_qa: Boolean(legacy.customer_rework_in_qa),
    customer_rework_submitted_to_qa_at: legacy.customer_rework_submitted_to_qa_at ?? null,
    customer_rework_request_id: legacy.customer_rework_request_id ?? null,
    customer_rework_request_type: legacy.customer_rework_request_type ?? null,
    customer_rework_request_label: legacy.customer_rework_request_label ?? null,
    customer_rework_completed_at: legacy.customer_rework_completed_at ?? null,
    customer_rework_completed_request_id: legacy.customer_rework_completed_request_id ?? null,
    customer_rework_completed_type: legacy.customer_rework_completed_type ?? null,
    customer_rework_completed_label: legacy.customer_rework_completed_label ?? null,
    latest_report_change_request: legacy.latest_report_change_request ?? null,
    report_change_requests: Array.isArray(legacy.report_change_requests) ? legacy.report_change_requests : [],
    manager_audit_status: legacy.manager_audit_status ?? null,
    manager_audit_note: legacy.manager_audit_note ?? null,
    work_history: Array.isArray(legacy.work_history) ? legacy.work_history : [],
    qa_history: Array.isArray(legacy.qa_history) ? legacy.qa_history : [],
    report_sent_at: legacy.report_sent_at ?? asRecord(legacy.delivery).report_sent_at ?? null,
    report_expedite_refund_status: legacy.report_expedite_refund_status ?? null,
    report_expedite_refund_amount: Number(legacy.report_expedite_refund_amount ?? 0) || 0,
    report_expedite_refund_at: legacy.report_expedite_refund_at ?? null,
    report_expedite_refund_due_at: legacy.report_expedite_refund_due_at ?? null,
    report_expedite_refund_reason: legacy.report_expedite_refund_reason ?? null,
    report_expedite_refund_message: legacy.report_expedite_refund_message ?? null,
    delivery_hold_status: releaseHold.status || null,
    delivery_hold_reason: releaseHold.reason || null,
    delivery_hold_scheduled_release_at: releaseHold.scheduled_release_at || null,
    delivery_hold_promised_delivery_at: releaseHold.promised_delivery_at || null,
    delivery_released_at: legacy.delivery_released_at ?? asRecord(asRecord(legacy.delivery).release_hold).released_at ?? null,
    delivery_release_hold: releaseHold,
    email_state: legacy.email_state ?? {},
    email_events: Array.isArray(legacy.email_events) ? legacy.email_events : [],
    thumbnail: thumb,
    pdf_url: isCustomerReady
      ? buildAbsoluteApiUrl(request, `/projects/${encodeURIComponent(manifest.id)}/pdf?slot=main`)
      : null
  };
}

function getProjectListView(input: Record<string, unknown>): ProjectListView {
  const raw = String(input.view ?? input.row_view ?? input.fields ?? "").trim().toLowerCase();
  if (["card", "cards", "browser", "thin", "summary"].includes(raw)) return "card";
  if (["stats", "statistics"].includes(raw)) return "stats";
  return "full";
}

function parseQueueOverviewCompatInclude(value: unknown) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value ?? "").split(",");
  const include = new Set<string>();
  for (const item of rawItems) {
    const key = String(item ?? "").trim().toLowerCase();
    if (key) include.add(key);
  }
  return include;
}

function resolveQueueOverviewCompatBucketLimit(input: Record<string, unknown>) {
  const requested = Number.parseInt(String(input.bucket_limit ?? input.limit ?? ""), 10);
  if (toBooleanish(input.legacy_full) && (!Number.isFinite(requested) || requested <= 0)) {
    return QUEUE_OVERVIEW_COMPAT_MAX_BUCKET_LIMIT;
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    return QUEUE_OVERVIEW_COMPAT_DEFAULT_BUCKET_LIMIT;
  }
  return Math.min(requested, QUEUE_OVERVIEW_COMPAT_MAX_BUCKET_LIMIT);
}

function buildProjectListViewRow(
  manifest: ProjectManifest,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  view: ProjectListView,
  thumbnailArtifactName?: string | null
) {
  const legacy = buildLegacyManifest(manifest);
  const id = String(legacy.id ?? "");
  const status = String(legacy.status ?? "");
  const releaseHeld = isReportReleaseHeld(legacy);
  const releaseHold = getReportReleaseHold(legacy);
  const isCustomerReady = status.trim().toLowerCase() === "completed" && Boolean(legacy.has_report_pdf) && !releaseHeld;
  const thumbnailSource = thumbnailArtifactName || pickProjectThumbnailSource(legacy);
  const reportExpediteOption = String(legacy.report_expedite_option ?? "").trim();
  const hasExpeditedReportOption = isExpeditedReportOption(reportExpediteOption);
  const qaClaimedByEmail = String(legacy.qa_claimed_by_email ?? "").trim();
  const hasQaClaim = qaClaimedByEmail !== "";

  const base = {
    id,
    folder: id,
    address: String(legacy.address ?? ""),
    status,
    owner: String(legacy.owner_name ?? legacy.owner_email ?? "Unknown"),
    owner_email: String(legacy.owner_email ?? ""),
    resident_name: String(legacy.resident_name ?? ""),
    resident_email: String(legacy.resident_email ?? ""),
    resident_phone: String(legacy.resident_phone ?? ""),
    project_type: String(legacy.project_type ?? "residential"),
    created_at: legacy.created_at ?? "",
    queued_at: legacy.queued_at ?? "",
    processed_at: legacy.processed_at ?? "",
    started_at: legacy.started_at ?? "",
    uploaded_at: legacy.uploaded_at ?? "",
    completed_at: legacy.completed_at ?? "",
    rejected_at: legacy.rejected_at ?? "",
    cancelled_at: legacy.cancelled_at ?? "",
    updated_at: legacy.updated_at ?? "",
    correction_requested_at: legacy.correction_requested_at ?? "",
    complexity: legacy.complexity ?? null,
    point_value: Number(legacy.point_value ?? 0) || null,
    amount_charged: Number(legacy.amount_charged ?? 0),
    refund_issued: Boolean(legacy.refund_issued),
    refund_pending: Boolean(legacy.refund_pending),
    refund_amount: Number(legacy.refund_amount ?? 0) || 0,
    refund_reason: legacy.refund_reason ?? null,
    refund_at: legacy.refund_at ?? null,
    rejection_reason: String(legacy.rejection_reason ?? ""),
    rejection_reason_details: Array.isArray(legacy.rejection_reason_details) ? legacy.rejection_reason_details : [],
    rejection_message: String(legacy.rejection_message ?? ""),
    rejection_note: String(legacy.rejection_note ?? legacy.rejection_notes ?? ""),
    customer_rejection_title: String(legacy.customer_rejection_title ?? ""),
    customer_rejection_message: String(legacy.customer_rejection_message ?? ""),
    correct_project_type: String(legacy.correct_project_type ?? legacy.rejection_correct_project_type ?? ""),
    rejection_correct_project_type: String(legacy.rejection_correct_project_type ?? ""),
    reorder_project_type: String(legacy.reorder_project_type ?? ""),
    reorder_url: String(legacy.reorder_url ?? ""),
    rejection_reorder: legacy.rejection_reorder ?? null,
    instant_rejection_reason: String(legacy.instant_rejection_reason ?? ""),
    include_gutter_measurements: Boolean(legacy.include_gutter_measurements),
    is_filler: Boolean(legacy.is_filler),
    is_vip: Boolean(legacy.is_vip),
    is_expedited: Boolean(legacy.is_expedited) || hasExpeditedReportOption,
    report_expedite_option: reportExpediteOption || null,
    report_expedite_label: legacy.report_expedite_label ?? null,
    report_due_window_start: legacy.report_due_window_start ?? null,
    report_due_window_end: legacy.report_due_window_end ?? null,
    report_due_window_label: legacy.report_due_window_label ?? null,
    report_production_deadline_at: legacy.report_production_deadline_at ?? null,
    deadline_at: reportProductionDeadlineAt(legacy, hasExpeditedReportOption),
    instant_enabled: Boolean(legacy.instant_enabled),
    instant_only: Boolean(legacy.instant_only),
    is_test_org: Boolean(legacy.is_test_org),
    organization_id: String(legacy.organization_id ?? ""),
    team_id: String(legacy.team_id ?? ""),
    assigned_to_email: String(legacy.assigned_to_email ?? ""),
    assigned_to_name: String(legacy.assigned_to_name ?? ""),
    assigned_at: legacy.assigned_at ?? null,
    reserved_to_email: String(legacy.reserved_to_email ?? ""),
    reserved_to_name: String(legacy.reserved_to_name ?? ""),
    reserved_at: legacy.reserved_at ?? null,
    correction_to_email: String(legacy.correction_to_email ?? ""),
    correction_to_name: String(legacy.correction_to_name ?? ""),
    qa_claimed_by_email: qaClaimedByEmail,
    qa_claimed_by_name: String(legacy.qa_claimed_by_name ?? ""),
    qa_claimed_at: legacy.qa_claimed_at ?? null,
    qa_available: !hasQaClaim,
    qa_availability_reason: hasQaClaim ? "claimed" : null,
    hidden_from_queue: hasQaClaim,
    qa_priority: Boolean(legacy.qa_priority),
    qa_priority_at: legacy.qa_priority_at ?? null,
    qa_priority_by_email: String(legacy.qa_priority_by_email ?? ""),
    qa_priority_by_name: String(legacy.qa_priority_by_name ?? ""),
    qa_approved_by: String(legacy.qa_approved_by ?? ""),
    qa_approved_by_name: String(legacy.qa_approved_by_name ?? ""),
    qa_approved_at: legacy.qa_approved_at ?? legacy.qa_reviewed_at ?? null,
    qa_reviewed_by: String(legacy.qa_reviewed_by ?? ""),
    qa_reviewed_by_name: String(legacy.qa_reviewed_by_name ?? ""),
    qa_reviewed_at: legacy.qa_reviewed_at ?? legacy.qa_approved_at ?? null,
    qa_paid_to_email: String(legacy.qa_paid_to_email ?? ""),
    qa_paid_to_name: String(legacy.qa_paid_to_name ?? ""),
    qa_reject_count: Number(legacy.qa_reject_count ?? 0),
    submission_status: String(legacy.submission_status ?? ""),
    submission_failure: legacy.submission_failure ?? null,
    delivery: legacy.delivery ?? null,
    qa_decision_type: String(legacy.qa_decision_type ?? ""),
    qa_correction_needed: Boolean(legacy.qa_correction_needed),
    qa_corrected_by_qa: Boolean(legacy.qa_corrected_by_qa),
    qa_correction_requested_from_technician: Boolean(legacy.qa_correction_requested_from_technician),
    qa_approved_without_changes: Boolean(legacy.qa_approved_without_changes),
    qa_correction_source: String(legacy.qa_correction_source ?? ""),
    rush_bonus_tag: Boolean(legacy.rush_bonus_tag),
    rush_bonus_eligible: Boolean(legacy.rush_bonus_eligible),
    rush_bonus_percent: Number(legacy.rush_bonus_percent ?? legacy.rush_bonus_amount ?? 0) || null,
    rush_bonus_mode_id: String(legacy.rush_bonus_mode_id ?? ""),
    rush_bonus_tagged_at: legacy.rush_bonus_tagged_at ?? null,
    rush_bonus_removed_at: legacy.rush_bonus_removed_at ?? null,
    rush_bonus_removed_reason: String(legacy.rush_bonus_removed_reason ?? ""),
    manager_audit_status: legacy.manager_audit_status ?? null,
    manager_audit_note: legacy.manager_audit_note ?? null,
    report_sent_at: legacy.report_sent_at ?? asRecord(legacy.delivery).report_sent_at ?? null,
    report_expedite_refund_status: legacy.report_expedite_refund_status ?? null,
    report_expedite_refund_amount: Number(legacy.report_expedite_refund_amount ?? 0) || 0,
    report_expedite_refund_at: legacy.report_expedite_refund_at ?? null,
    report_expedite_refund_due_at: legacy.report_expedite_refund_due_at ?? null,
    report_expedite_refund_reason: legacy.report_expedite_refund_reason ?? null,
    report_expedite_refund_message: legacy.report_expedite_refund_message ?? null,
    delivery_hold_status: releaseHold.status || null,
    delivery_hold_reason: releaseHold.reason || null,
    delivery_hold_scheduled_release_at: releaseHold.scheduled_release_at || null,
    delivery_hold_promised_delivery_at: releaseHold.promised_delivery_at || null,
    delivery_released_at: legacy.delivery_released_at ?? asRecord(asRecord(legacy.delivery).release_hold).released_at ?? null,
    delivery_release_hold: releaseHold,
    email_state: legacy.email_state ?? asRecord(legacy.delivery).email_state ?? {},
    email_events: Array.isArray(legacy.email_events)
      ? legacy.email_events
      : (Array.isArray(asRecord(legacy.delivery).email_events) ? asRecord(legacy.delivery).email_events : []),
    lat: toFiniteNumber(legacy.lat),
    lng: toFiniteNumber(legacy.lng),
    radius_meters: toFiniteNumber(legacy.radius_meters),
    structure_pin_mode: String(legacy.structure_pin_mode ?? ""),
    structure_pin_status: String(legacy.structure_pin_status ?? ""),
    structure_pin_error: String(legacy.structure_pin_error ?? ""),
    public_api: asRecord(legacy.public_api),
    pins: Array.isArray(legacy.pins) ? legacy.pins : [],
    pins_count: Array.isArray(legacy.pins) ? legacy.pins.length : 0,
    cc_email_count: Array.isArray(legacy.cc_emails) ? legacy.cc_emails.length : 0,
    thumbnail: id
      ? buildProjectThumbnailUrl(request, id, thumbnailSource)
      : null,
    thumbnail_source: thumbnailSource,
    pdf_url: isCustomerReady
      ? buildAbsoluteApiUrl(request, `/projects/${encodeURIComponent(id)}/pdf?slot=main`)
      : null
  };

  if (view === "stats") {
    return {
      ...base,
      pin_count: Array.isArray(legacy.pins) ? legacy.pins.length : 0,
      has_report_pdf: Boolean(legacy.has_report_pdf),
      has_summary_pdf: Boolean(legacy.has_summary_pdf)
    };
  }

  return base;
}

function reportProductionDeadlineAt(legacy: Record<string, unknown>, hasExpeditedReportOption = false) {
  if (!(Boolean(legacy.is_expedited) || hasExpeditedReportOption)) return null;
  const explicit = String(legacy.report_production_deadline_at ?? "").trim();
  if (explicit) return explicit;
  const submittedMs = firstManifestTimestamp(legacy, ["queued_at", "created_at", "processed_at", "updated_at"]);
  if (!submittedMs) return null;
  const optionKey = normalizeReportReleaseExpediteOption(legacy);
  const quote = buildReportExpediteOptions({
    projectType: legacy.project_type,
    structureCount: Math.max(1, countManifestPins(legacy as ProjectManifest) || 1),
    now: new Date(submittedMs)
  });
  const option = quote.options.find((entry) => entry.key === optionKey);
  return option?.production_deadline_at ?? option?.due_window_start ?? null;
}

const REPORT_EXPEDITE_TIMING_FIELDS = [
  "report_due_window_start",
  "report_due_window_end",
  "report_due_window_label",
  "report_production_deadline_at"
];

function hasOwnKey(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasReportExpediteTiming(manifest: Record<string, unknown>) {
  return Boolean(
    toOptionalString(manifest.report_expedite_option)
      || toOptionalString(manifest.report_due_window_start)
      || toOptionalString(manifest.report_due_window_end)
      || toOptionalString(manifest.report_production_deadline_at)
      || manifest.report_release_hold_enabled === true
  );
}

function withRecalculatedReportExpediteTiming(current: ProjectManifest, patch: Record<string, unknown>) {
  if (!hasOwnKey(patch, "pins")) return patch;
  if (REPORT_EXPEDITE_TIMING_FIELDS.some((key) => hasOwnKey(patch, key))) return patch;

  const candidate: Record<string, unknown> = {
    ...(current as Record<string, unknown>),
    ...patch,
    timestamps: {
      ...asRecord(current.timestamps),
      ...asRecord(patch.timestamps)
    }
  };
  if (!hasReportExpediteTiming(candidate)) return patch;

  const structureCount = countManifestPins(candidate as ProjectManifest);
  if (structureCount < 1) return patch;

  const submittedMs = firstManifestTimestamp(candidate, ["queued_at", "created_at", "processed_at", "updated_at"]);
  if (!submittedMs) return patch;

  const optionKey = normalizeReportReleaseExpediteOption(candidate);
  const quote = buildReportExpediteOptions({
    projectType: candidate.project_type,
    structureCount,
    now: new Date(submittedMs)
  });
  const option = quote.options.find((entry) => entry.key === optionKey)
    ?? quote.options.find((entry) => entry.key === REPORT_EXPEDITE_STANDARD_KEY);
  if (!option) return patch;

  return {
    ...patch,
    report_expedite_option: option.key,
    report_expedite_label: option.label,
    report_due_window_start: option.due_window_start,
    report_due_window_end: option.due_window_end,
    report_due_window_label: option.window_label,
    report_production_deadline_at: option.production_deadline_at
  };
}

function pickProjectThumbnailSource(legacy: Record<string, unknown>) {
  const artifacts = asRecord(legacy.artifacts);
  if (artifacts.has_google_image) return "google.png";
  if (artifacts.has_azure_image) return "azure.png";
  if (artifacts.has_apple_image) return "apple.png";
  const assets = asRecord(legacy.assets);
  for (const candidate of [
    legacy.browser_thumbnail,
    legacy.cover_thumbnail,
    legacy.top_down_thumbnail,
    assets.google,
    assets.azure,
    assets.apple
  ]) {
    const value = String(candidate ?? "").trim();
    if (value && !/^https?:\/\//i.test(value)) return value;
  }
  return "google.png";
}

async function readActorActiveProjectRows(
  actorEmail: unknown,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const email = String(actorEmail ?? "").trim().toLowerCase();
  if (!email) return [];
  await ensureFirstMeasureProjectIndexReady();
  const rows = isFirstMeasurePostgresEnabled()
    ? await (await import("./project_index_postgres.js")).queryPostgresRows<{
      manifest_json: ProjectManifest;
      thumbnail_artifact_name: string;
    }>(`
      SELECT manifest_json, thumbnail_artifact_name
      FROM projects
      WHERE status IN ('queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue')
        AND (assigned_to_email = $1 OR reserved_to_email = $1 OR correction_to_email = $1)
      ORDER BY CASE WHEN is_vip <> 0 OR is_expedited <> 0 THEN 1 ELSE 0 END DESC,
        updated_at_ms DESC, created_at_ms ASC, id ASC
      LIMIT 25
    `, [email])
    : getFirstMeasureProjectIndexDb().prepare(`
      SELECT manifest_json, thumbnail_artifact_name
      FROM projects
      WHERE status IN ('queued', 'ready', 'processing', 'in_progress', 'correction_needed', 'requeue')
        AND (assigned_to_email = $email OR reserved_to_email = $email OR correction_to_email = $email)
      ORDER BY CASE WHEN is_vip != 0 OR is_expedited != 0 THEN 1 ELSE 0 END DESC,
        updated_at_ms DESC, created_at_ms ASC, id ASC
      LIMIT 25
    `).all({ email }) as Array<{ manifest_json?: string; thumbnail_artifact_name?: string }>;

  const projects = [];
  for (const row of rows) {
    if (!row.manifest_json) continue;
    try {
      const manifest = typeof row.manifest_json === "string"
        ? JSON.parse(row.manifest_json) as ProjectManifest
        : row.manifest_json as ProjectManifest;
      if (hasPendingForceKickForEmail(manifest, email)) continue;
      projects.push(buildProjectListViewRow(
        manifest,
        request,
        "card",
        row.thumbnail_artifact_name || null
      ));
    } catch {
      continue;
    }
  }
  return projects;
}

function hasPendingForceKickForEmail(manifest: ProjectManifest, email: string) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return false;

  const forceKick = asRecord((manifest as Record<string, unknown>).force_kick);
  if (Boolean(forceKick.acknowledged)) return false;

  const kickEmail = String(forceKick.email ?? "").trim().toLowerCase();
  return kickEmail !== "" && kickEmail === normalizedEmail;
}

function matchesVisibilityFilter(
  manifest: ProjectManifest,
  filter: string,
  actor: Record<string, unknown> | null
) {
  return matchesLegacyProjectVisibilityDoc(buildLegacyProjectSearchDoc(manifest), filter, actor);
}

function matchesLegacyProjectVisibilityDoc(
  doc: LegacyProjectSearchDoc,
  filter: string,
  actor: Record<string, unknown> | null
) {
  if (!actor) return true;
  const actorEmail = String(actor.email ?? "").trim().toLowerCase();
  const actorTeamId = String(actor.team_id ?? "").trim();
  const actorOrgId = String(actor.organization_id ?? "").trim();
  const roles = Array.isArray(actor.roles) ? actor.roles.map((value) => String(value).toLowerCase()) : [];
  const isQueueAdmin = roles.includes("admin") || roles.includes("queue_admin") || roles.includes("manager");
  const isMine = actorEmail === "" || doc.relatedActorEmails.includes(actorEmail);

  if (filter === "all") {
    return isQueueAdmin || isMine;
  }
  if (filter === "team") {
    return (actorTeamId !== "" && doc.teamId !== "" && actorTeamId === doc.teamId) || isMine;
  }
  if (filter === "org") {
    return (actorOrgId !== "" && doc.organizationId !== "" && actorOrgId === doc.organizationId) || isMine;
  }
  return isMine;
}

function matchesLegacyProjectSearch(manifest: ProjectManifest, search: string) {
  const searchText = normalizeProjectSearchText(search);
  const tokens = tokenizeProjectSearch(search);
  if (!tokens.length) return true;
  return scoreLegacyProjectSearch(buildLegacyProjectSearchDoc(manifest), searchText, tokens) >= 0;
}

function compareLegacyProjectSort(a: ProjectManifest, b: ProjectManifest) {
  const aLegacy = buildLegacyManifest(a);
  const bLegacy = buildLegacyManifest(b);
  const aTs = parseLegacySortTimestamp(String(aLegacy.completed_at ?? aLegacy.uploaded_at ?? aLegacy.created_at ?? ""));
  const bTs = parseLegacySortTimestamp(String(bLegacy.completed_at ?? bLegacy.uploaded_at ?? bLegacy.created_at ?? ""));
  return bTs - aTs;
}

function parseLegacySortTimestamp(value: string) {
  if (!value) return 0;
  const raw = String(value).trim();
  if (!raw) return 0;
  const isoCandidate = raw.includes("T") ? raw : raw.replace(" ", "T");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoCandidate);
  const parsed = Date.parse(hasTimezone ? isoCandidate : `${isoCandidate}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function getLegacyProjectSearchCache(): Promise<LegacyProjectSearchCache> {
  const now = Date.now();
  if (legacyProjectSearchCache && legacyProjectSearchCache.expiresAt > now) {
    return legacyProjectSearchCache;
  }

  const manifests = await listProjectManifests();
  const docs = manifests
    .map((manifest) => buildLegacyProjectSearchDoc(manifest))
    .sort((a, b) => b.sortTs - a.sortTs);

  const docsByOrg = new Map<string, LegacyProjectSearchDoc[]>();
  const docsByTeam = new Map<string, LegacyProjectSearchDoc[]>();
  const docsByActorEmail = new Map<string, LegacyProjectSearchDoc[]>();

  for (const doc of docs) {
    if (doc.organizationId) {
      const bucket = docsByOrg.get(doc.organizationId) ?? [];
      bucket.push(doc);
      docsByOrg.set(doc.organizationId, bucket);
    }
    if (doc.teamId) {
      const bucket = docsByTeam.get(doc.teamId) ?? [];
      bucket.push(doc);
      docsByTeam.set(doc.teamId, bucket);
    }
    for (const email of new Set(doc.relatedActorEmails.filter(Boolean))) {
      const bucket = docsByActorEmail.get(email) ?? [];
      bucket.push(doc);
      docsByActorEmail.set(email, bucket);
    }
  }

  legacyProjectSearchCache = {
    expiresAt: now + LEGACY_PROJECT_SEARCH_CACHE_TTL_MS,
    docs,
    docsByOrg,
    docsByTeam,
    docsByActorEmail
  };
  return legacyProjectSearchCache;
}

function buildLegacyProjectSearchDoc(manifest: ProjectManifest): LegacyProjectSearchDoc {
  const legacy = buildLegacyManifest(manifest);
  const resident = asRecord(legacy.resident);
  const issuer = asRecord(legacy.issuer);
  const workflow = asRecord(manifest.workflow);
  const organizationId = String(legacy.organization_id ?? "").trim();
  const teamId = String(legacy.team_id ?? "").trim();
  const ownerEmail = normalizeProjectSearchText(legacy.owner_email);
  const issuerEmail = normalizeProjectSearchText(issuer.email);
  const assignedEmail = normalizeProjectSearchText(legacy.assigned_to_email);
  const reservedEmail = normalizeProjectSearchText(legacy.reserved_to_email);
  const correctionEmail = normalizeProjectSearchText(legacy.correction_to_email);
  const qaClaimedEmail = normalizeProjectSearchText(legacy.qa_claimed_by_email);
  const qaPaidToEmail = normalizeProjectSearchText(legacy.qa_paid_to_email);
  const originalTechnician = resolveOriginalTechnician(legacy, workflow);
  const originalTechnicianEmail = normalizeProjectSearchText(originalTechnician.email);
  const relatedActorEmails = Array.from(new Set([
    ownerEmail,
    issuerEmail,
    assignedEmail,
    reservedEmail,
    correctionEmail,
    qaClaimedEmail,
    qaPaidToEmail,
    originalTechnicianEmail
  ].filter(Boolean)));
  const searchText = normalizeProjectSearchText([
    legacy.id,
    legacy.address,
    legacy.status,
    legacy.owner_name,
    legacy.owner_email,
    legacy.assigned_to_name,
    legacy.assigned_to_email,
    legacy.reserved_to_name,
    legacy.reserved_to_email,
    legacy.correction_to_name,
    legacy.correction_to_email,
    legacy.qa_claimed_by_name,
    legacy.qa_claimed_by_email,
    legacy.qa_paid_to_name,
    legacy.qa_paid_to_email,
    issuer.name,
    issuer.email,
    resident.name,
    resident.email,
    resident.phone
  ].join(" "));

  return {
    manifest,
    legacy,
    searchText,
    idText: normalizeProjectSearchText(legacy.id),
    addressText: normalizeProjectSearchText(legacy.address),
    residentNameText: normalizeProjectSearchText(resident.name),
    issuerNameText: normalizeProjectSearchText(issuer.name),
    ownerNameText: normalizeProjectSearchText(legacy.owner_name),
    organizationId,
    teamId,
    ownerEmail,
    issuerEmail,
    assignedEmail,
    relatedActorEmails,
    sortTs: parseLegacySortTimestamp(String(legacy.completed_at ?? legacy.uploaded_at ?? legacy.created_at ?? ""))
  };
}

function getScopedLegacyProjectSearchDocs(
  cache: LegacyProjectSearchCache,
  filter: string,
  actor: Record<string, unknown> | null
) {
  if (!actor) return cache.docs;
  const actorEmail = normalizeProjectSearchText(actor.email);
  const actorOrgId = String(actor.organization_id ?? "").trim();
  const actorTeamId = String(actor.team_id ?? "").trim();

  if (filter === "org" && actorOrgId) {
    return mergeLegacyProjectSearchDocs(
      cache.docsByOrg.get(actorOrgId) ?? [],
      actorEmail ? (cache.docsByActorEmail.get(actorEmail) ?? []) : []
    ).filter((doc) =>
      matchesLegacyProjectVisibilityDoc(doc, filter, actor)
    );
  }
  if (filter === "team" && actorTeamId) {
    return mergeLegacyProjectSearchDocs(
      cache.docsByTeam.get(actorTeamId) ?? [],
      actorEmail ? (cache.docsByActorEmail.get(actorEmail) ?? []) : []
    ).filter((doc) =>
      matchesLegacyProjectVisibilityDoc(doc, filter, actor)
    );
  }
  return cache.docs.filter((doc) => matchesLegacyProjectVisibilityDoc(doc, filter, actor));
}

function mergeLegacyProjectSearchDocs(...groups: LegacyProjectSearchDoc[][]) {
  const merged: LegacyProjectSearchDoc[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const doc of group) {
      const key = String(doc.legacy.id ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(doc);
    }
  }
  return merged.sort((a, b) => b.sortTs - a.sortTs);
}

function matchesLegacyProjectStatusFilterDoc(doc: LegacyProjectSearchDoc, statusFilter: string) {
  if (!statusFilter || statusFilter === "all") return true;
  const status = String(doc.legacy.status ?? "").trim().toLowerCase();
  const hasReport = Boolean(doc.legacy.has_report_pdf) || Boolean(doc.legacy.has_report);
  const isCustomerReady = status === "completed" && hasReport;
  if (statusFilter === "rejected") return status === "rejected_no_coverage" || status === "rejected";
  if (statusFilter === "cancelled") return status === "cancelled";
  if (statusFilter === "ready") return isCustomerReady;
  if (statusFilter === "processing") return !isCustomerReady && status !== "rejected_no_coverage" && status !== "rejected" && status !== "cancelled";
  return true;
}

function normalizeProjectSearchText(value: unknown) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeProjectSearch(value: string) {
  const normalized = normalizeProjectSearchText(value);
  if (normalized.length < 2) return [];
  return normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreLegacyProjectSearch(doc: LegacyProjectSearchDoc, searchText: string, searchTokens: string[]) {
  if (!searchTokens.length) return 0;
  if (searchTokens.some((token) => !doc.searchText.includes(token))) return -1;

  let score = 0;
  if (doc.idText === searchText) score += 220;
  else if (doc.idText.startsWith(searchText)) score += 140;
  else if (doc.idText.includes(searchText)) score += 80;

  if (doc.addressText === searchText) score += 180;
  else if (doc.addressText.startsWith(searchText)) score += 130;
  else if (doc.addressText.includes(searchText)) score += 90;

  if (doc.residentNameText === searchText) score += 170;
  else if (doc.residentNameText.startsWith(searchText)) score += 120;
  else if (doc.residentNameText.includes(searchText)) score += 95;

  if (doc.issuerNameText === searchText) score += 120;
  else if (doc.issuerNameText.startsWith(searchText)) score += 80;
  else if (doc.issuerNameText.includes(searchText)) score += 55;

  if (doc.ownerNameText === searchText) score += 90;
  else if (doc.ownerNameText.startsWith(searchText)) score += 60;
  else if (doc.ownerNameText.includes(searchText)) score += 40;

  score += Math.max(0, 20 - (searchTokens.length * 2));
  return score;
}

function clampPositiveInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clampQueueBucketLimit(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseProjectsQueryInput(
  input: Record<string, unknown>,
  options: {
    defaultLimit: number;
    defaultActivityWindowDays: number;
  }
) {
  const limit = Math.min(clampPositiveInt(input.limit, options.defaultLimit), 500);
  const statuses = normalizeStringArray(input.statuses);
  const activityFields = normalizeActivityFields(input.activity_fields);
  const includeAll = toBooleanish(input.include_all);
  const activityWindow = resolveActivityWindow({
    rawStart: input.activity_start,
    rawEnd: input.activity_end,
    includeAll,
    defaultWindowDays: options.defaultActivityWindowDays
  });

  return {
    search: toOptionalString(input.search),
    statuses: statuses.length > 0 ? statuses : undefined,
    limit,
    owner_email: toOptionalString(input.owner_email),
    organization_id: toOptionalString(input.organization_id),
    team_id: toOptionalString(input.team_id),
    project_type: toOptionalString(input.project_type),
    has_report_pdf: parseOptionalBoolean(input.has_report_pdf),
    includeInstantOnly: toBooleanish(input.include_instant_only),
    activityStartMs: activityWindow?.startMs ?? null,
    activityEndMs: activityWindow?.endMs ?? null,
    activityFields
  };
}

function resolveActivityWindow(input: {
  rawStart: unknown;
  rawEnd: unknown;
  includeAll: boolean;
  defaultWindowDays: number;
}) {
  if (input.includeAll) {
    return null;
  }

  const explicitStart = parseActivityBoundary(input.rawStart, false);
  const explicitEnd = parseActivityBoundary(input.rawEnd, true);
  if (explicitStart !== null || explicitEnd !== null) {
    return {
      startMs: explicitStart ?? 0,
      endMs: explicitEnd ?? Date.now()
    };
  }

  const endMs = Date.now();
  const startMs = endMs - (input.defaultWindowDays * 24 * 60 * 60 * 1000);
  return { startMs, endMs };
}

function parseActivityBoundary(value: unknown, endOfDayIfDateOnly: boolean) {
  if (value == null || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  if (/^\d+$/.test(raw)) {
    const parsedNumber = Number(raw);
    return Number.isFinite(parsedNumber) ? parsedNumber : null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const stamped = `${raw}T${endOfDayIfDateOnly ? "23:59:59.999" : "00:00:00.000"}Z`;
    const parsedDateOnly = Date.parse(stamped);
    return Number.isFinite(parsedDateOnly) ? parsedDateOnly : null;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeActivityFields(value: unknown): ProjectActivityField[] | undefined {
  const rawValues = normalizeStringArray(value)
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is ProjectActivityField =>
      entry === "created"
      || entry === "queued"
      || entry === "started"
      || entry === "uploaded"
      || entry === "completed"
      || entry === "rejected"
      || entry === "cancelled"
      || entry === "updated"
    );
  return rawValues.length > 0 ? Array.from(new Set(rawValues)) : undefined;
}

function normalizeStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry).trim())
      .filter(Boolean);
  }
  const single = String(value ?? "").trim();
  if (!single) {
    return [];
  }
  if (!single.includes(",")) {
    return [single];
  }
  return single.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseOptionalBoolean(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function toBooleanish(value: unknown) {
  return parseOptionalBoolean(value) === true;
}

function formatActivityBoundary(value: number | null) {
  return value == null ? null : new Date(value).toISOString();
}

function normalizePortalActor(input: Record<string, unknown>) {
  const actor = normalizeOptionalPortalActor(input.actor);
  if (actor) return actor;
  const email = normalizePortalActorEmail(input.user_email);
  if (email) return { email };
  throw badRequest("missing_actor", "A real actor email is required.");
}

function normalizeOptionalPortalActor(value: unknown) {
  const actor = asRecord(value);
  const email = normalizePortalActorEmail(actor.email);
  const id = toOptionalString(actor.id);
  const name = toOptionalString(actor.name);
  const teamId = toOptionalString(actor.team_id);
  const organizationId = toOptionalString(actor.organization_id);
  const roles = Array.isArray(actor.roles) ? actor.roles.map((role) => String(role)) : [];

  if (!email && !id) return null;
  return {
    ...(id ? { id } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(teamId ? { team_id: teamId } : {}),
    ...(organizationId ? { organization_id: organizationId } : {}),
    ...(roles.length > 0 ? { roles } : {})
  };
}

function normalizePortalActorEmail(value: unknown) {
  const email = toOptionalString(value)?.toLowerCase() ?? "";
  if (INVALID_PORTAL_ACTOR_EMAILS.has(email)) return undefined;
  return email;
}

function canAccessFirstMeasureDebugTools(actor: ReturnType<typeof normalizeOptionalPortalActor>) {
  if (!actor) {
    return false;
  }
  const roles = Array.isArray(actor.roles)
    ? actor.roles.map((role) => String(role).trim().toLowerCase())
    : [];
  return roles.includes("admin") || roles.includes("firstmeasure_debugger");
}

async function requireQaBulkApprovalAdmin(actorEmail: string) {
  const user = await readInternalUser(actorEmail.toLowerCase()).catch(() => null);
  const role = String(user?.role ?? "").trim().toLowerCase();
  const permissions = asRecord(user?.permissions);
  const isFullAdmin = role === "admin"
    || role === "system_admin"
    || Boolean(user?.is_admin)
    || Boolean(permissions.is_admin_legacy)
    || Boolean(permissions.platform_admin);
  if (!isFullAdmin) {
    throw new FirstMeasureError("admin_required", 403, "Only full admins can bulk approve QA projects.");
  }
  return user;
}

async function maybeEvaluateAutomaticRushMode(app: FastifyInstance, projectId: string) {
  try {
    const result = await evaluateAutomaticRushMode();
    if (result.triggered) {
      app.log.info({ projectId, rushModeId: result.rush_mode?.id }, "Automatic rush mode triggered");
    }
  } catch (error) {
    app.log.error({ err: error, projectId }, "Automatic rush mode evaluation failed");
  }
}

function withDerivedProjectRefs<T extends Record<string, unknown>>(input: T): T {
  const actor = normalizeOptionalPortalActor(input.actor);
  const ownerRef = asRecord(input.owner_ref);
  const organizationRef = asRecord(input.organization_ref);
  const teamRef = asRecord(input.team_ref);
  const next: Record<string, unknown> = { ...input };

  if (!Object.keys(ownerRef).length && (actor?.email || actor?.name)) {
    next.owner_ref = {
      ...(actor?.name ? { name: actor.name } : {}),
      ...(actor?.email ? { email: actor.email } : {})
    };
  }
  if (!Object.keys(organizationRef).length && actor?.organization_id) {
    next.organization_ref = { id: actor.organization_id };
  }
  if (!Object.keys(teamRef).length && actor?.team_id) {
    next.team_ref = { id: actor.team_id };
  }

  return next as T;
}

async function reopenRejectedProjectForReorder(
  projectId: string,
  input: Record<string, unknown>,
  rawInput: Record<string, unknown>
) {
  const existing = await readManifest(projectId).catch(() => null);
  if (!existing) {
    throw badRequest("reorder_project_not_found", "The rejected project to reorder could not be found.");
  }
  const currentStatus = String(existing.status ?? "").trim().toLowerCase();
  if (currentStatus !== "rejected" && currentStatus !== "rejected_no_coverage") {
    throw badRequest("reorder_project_not_rejected", "Only rejected projects can be reordered into the same project.");
  }

  const nowIso = new Date().toISOString();
  const nowSql = toSqlDateString(new Date());
  const existingRecord = existing as Record<string, unknown>;
  const existingHistory = Array.isArray(existingRecord.work_history) ? existingRecord.work_history : [];
  const previousRejections = Array.isArray(existingRecord.rejection_history)
    ? existingRecord.rejection_history
    : [];
  const rejectionSnapshot = {
    rejection_reason: existingRecord.rejection_reason ?? null,
    rejection_note: existingRecord.rejection_note ?? existingRecord.rejection_notes ?? null,
    rejection_reason_details: existingRecord.rejection_reason_details ?? null,
    rejected_at: existingRecord.rejected_at ?? asRecord(existing.timestamps).rejected_at ?? null,
    refund_issued: existingRecord.refund_issued ?? null,
    refund_amount: existingRecord.refund_amount ?? null,
    correct_project_type: existingRecord.correct_project_type ?? existingRecord.rejection_correct_project_type ?? null,
    reorder_url: existingRecord.reorder_url ?? null
  };

  const patch: Record<string, unknown> = {
    __allow_terminal_status_transition: true,
    status: "queued",
    project_type: String(input.project_type ?? existing.project_type ?? "residential"),
    address: String(input.address ?? existing.address ?? ""),
    lat: typeof input.lat === "number" ? input.lat : existing.lat,
    lng: typeof input.lng === "number" ? input.lng : existing.lng,
    pins: Array.isArray(input.pins) ? input.pins : existing.pins,
    include_gutter_measurements: Boolean(input.include_gutter_measurements ?? false),
    include_weather_report: Boolean(input.include_weather_report ?? false),
    weather_report_tier: input.weather_report_tier == null ? null : String(input.weather_report_tier),
    weather_report_id: input.weather_report_id == null ? null : String(input.weather_report_id),
    weather_report_pdf_url: input.weather_report_pdf_url == null ? null : String(input.weather_report_pdf_url),
    radius_meters: input.radius_meters ?? existing.radius_meters ?? null,
    is_expedited: Boolean(input.is_expedited ?? false),
    report_expedite_option: input.report_expedite_option == null ? null : String(input.report_expedite_option),
    report_expedite_label: input.report_expedite_label == null ? null : String(input.report_expedite_label),
    report_due_window_start: input.report_due_window_start == null ? null : String(input.report_due_window_start),
    report_due_window_end: input.report_due_window_end == null ? null : String(input.report_due_window_end),
    report_due_window_label: input.report_due_window_label == null ? null : String(input.report_due_window_label),
    report_production_deadline_at: input.report_production_deadline_at == null ? null : String(input.report_production_deadline_at),
    report_release_hold_enabled: input.report_release_hold_enabled == null ? null : input.report_release_hold_enabled === true,
    report_mode: input.report_mode == null ? "full" : String(input.report_mode),
    owner_ref: asRecord(input.owner_ref),
    organization_ref: asRecord(input.organization_ref),
    team_ref: asRecord(input.team_ref),
    resident: asRecord(input.resident),
    issuer: asRecord(input.issuer),
    cc_emails: Array.isArray(input.cc_emails) ? input.cc_emails.map((value) => String(value)) : [],
    tech_notes: input.tech_notes == null ? null : String(input.tech_notes),
    amount_charged: typeof input.amount_charged === "number" ? input.amount_charged : 0,
    charge_token: input.charge_token == null ? null : String(input.charge_token),
    public_api: asRecord(input.public_api),
    refund_issued: false,
    refund_amount: 0,
    refund_reason: null,
    refund_pending: false,
    rejection_reason: null,
    rejection_note: null,
    rejection_notes: null,
    rejection_reason_details: null,
    correct_project_type: null,
    rejection_correct_project_type: null,
    reorder_project_type: null,
    reorder_url: null,
    rejection_reorder: null,
    customer_rejection_title: null,
    customer_rejection_message: null,
    rejected_at: null,
    rejected_by: null,
    rejection_history: [
      ...previousRejections,
      {
        ...rejectionSnapshot,
        reordered_at: nowSql,
        reordered_as_project_type: String(input.project_type ?? existing.project_type ?? "residential")
      }
    ],
    reordered_from_rejection: true,
    reordered_at: nowSql,
    reordered_source_project_id: projectId,
    work_history: [
      ...existingHistory,
      {
        event: "reordered_rejected_project",
        ts: nowIso,
        project_type: String(input.project_type ?? existing.project_type ?? "residential"),
        source: "customer_reorder",
        platform_project_id: rawInput.platform_project_id ?? rawInput.base_project_id ?? null
      }
    ],
    workflow: {
      ...asRecord(existing.workflow),
      assigned_to: null,
      assigned_at: null,
      reserved_to: null,
      reserved_at: null,
      correction_to: null,
      qa_claim: null
    },
    timestamps: {
      ...asRecord(existing.timestamps),
      queued_at: nowSql,
      rejected_at: null,
      completed_at: null,
      cancelled_at: null,
      updated_at: nowSql
    }
  };

  return patchManifest(projectId, patch);
}

async function findPreviousReportImportCandidate(
  address: string,
  options: { excludeProjectId?: string } = {}
) {
  const excludeProjectId = toOptionalString(options.excludeProjectId);
  const matches = await findIndexedProjectsByNormalizedAddress(address, { limit: 25 });
  const candidates: Array<{
    candidate: Record<string, unknown>;
    isComplete: boolean;
    pointCount: number;
    sortTs: number;
  }> = [];

  for (const manifest of matches) {
    const projectId = toOptionalString(manifest.id);
    if (!projectId) continue;
    if (excludeProjectId && projectId === excludeProjectId) continue;

    const metadata = asRecord(await readAppMetadata(projectId).catch(() => ({})));
    const pdfState = asRecord(await readPdfState(projectId).catch(() => ({})));
    const metadataGeometry = asRecord(metadata.geometry);
    const pdfGeometry = asRecord(pdfState.geometry);
    const geometry = Array.isArray(metadataGeometry.points) ? metadataGeometry : pdfGeometry;
    const points = Array.isArray(geometry.points) ? geometry.points : [];
    if (points.length < 2) continue;

    const connections = Array.isArray(geometry.connections) ? geometry.connections : [];
    const timestamps = asRecord(manifest.timestamps);
    const pins = Array.isArray(manifest.pins)
      ? manifest.pins
          .map((pin) => {
            const lat = toFiniteNumber(asRecord(pin).lat);
            const lng = toFiniteNumber(asRecord(pin).lng);
            return lat != null && lng != null ? { lat, lng } : null;
          })
          .filter((pin): pin is { lat: number; lng: number } => Boolean(pin))
      : [];

    const isComplete = isPreviousReportImportComplete(manifest);
    const completedAt = toOptionalString(timestamps.completed_at) ?? null;
    const uploadedAt = toOptionalString(timestamps.uploaded_at) ?? null;
    const updatedAt = toOptionalString(timestamps.updated_at) ?? null;
    candidates.push({
      isComplete,
      pointCount: points.length,
      sortTs: parseDateLikeTimestamp(completedAt ?? uploadedAt ?? updatedAt ?? toOptionalString(timestamps.created_at)),
      candidate: {
      status: "pending",
      source_project_id: projectId,
      source_address: String(manifest.address ?? address),
      source_project_type: String(manifest.project_type ?? ""),
      source_created_at: toOptionalString(timestamps.created_at) ?? null,
        source_completed_at: completedAt,
        source_uploaded_at: uploadedAt,
        source_is_complete: isComplete,
      source_lat: toFiniteNumber(manifest.lat),
      source_lng: toFiniteNumber(manifest.lng),
      source_pins: pins,
      source_radius_meters: toFiniteNumber(manifest.radius_meters),
      source_image: {
        width: toFiniteNumber(metadata.imageWidth),
        height: toFiniteNumber(metadata.imageHeight)
      },
      geometry_point_count: points.length,
      geometry_connection_count: connections.length,
      detected_at: new Date().toISOString()
      }
    });
  }

  candidates.sort((a, b) => {
    if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1;
    if (a.pointCount !== b.pointCount) return b.pointCount - a.pointCount;
    return b.sortTs - a.sortTs;
  });

  return candidates[0]?.candidate ?? null;
}

function isPreviousReportImportComplete(manifest: ProjectManifest) {
  const status = String(manifest.status ?? "").trim().toLowerCase();
  const timestamps = asRecord(manifest.timestamps);
  const artifacts = asRecord(manifest.artifacts);
  return status === "completed"
    || status === "awaiting_review"
    || Boolean(timestamps.completed_at)
    || Boolean(timestamps.uploaded_at)
    || Boolean(artifacts.has_report_pdf)
    || Boolean(artifacts.has_main_pdf)
    || Boolean(artifacts.has_summary_pdf)
    || Boolean(artifacts.has_model_data);
}

function parseDateLikeTimestamp(value: unknown) {
  const raw = toOptionalString(value);
  if (!raw) return 0;
  const isoCandidate = raw.includes("T") ? raw : raw.replace(" ", "T");
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(isoCandidate);
  const normalized = hasTimezone ? isoCandidate : `${isoCandidate}Z`;
  const normalizedMs = Date.parse(normalized);
  if (Number.isFinite(normalizedMs)) return normalizedMs;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

function toQueueMode(value: unknown): "all" | "new_only" | "corrections_only" | "wait_for_feedback" {
  switch (String(value ?? "").trim()) {
    case "wait_for_feedback":
      return "wait_for_feedback";
    case "new_only":
      return "new_only";
    case "corrections_only":
      return "corrections_only";
    case "disabled":
    case "hot_swap":
    case "all":
    default:
      return "all";
  }
}

async function resolveQueueModeValue(actorEmail: string | undefined, requestedValue: unknown) {
  const requested = String(requestedValue ?? "").trim();
  if (requested) {
    return {
      selected: requested,
      internal: toQueueMode(requested)
    };
  }

  const user = actorEmail ? await readPortalUserByEmail(actorEmail) : null;
  const selected = String(user?.queue_mode ?? "disabled").trim() || "disabled";
  return {
    selected,
    internal: toQueueMode(selected)
  };
}

function getProjectEmailSummary(manifest: ProjectManifest) {
  const legacy = buildLegacyManifest(manifest);
  const emailState = asRecord(legacy.email_state);
  const summarize = (state: Record<string, unknown>) => ({
    sent_ok: Boolean(state.sent_ok),
    sent_at_utc: state.sent_at_utc ?? null,
    attempts: Number(state.attempts ?? 0),
    last_ok: Boolean(state.last_ok),
    last_attempt_utc: state.last_attempt_utc ?? null,
    last_http: state.last_http ?? null,
    last_to: state.last_to ?? null,
    message_id: state.message_id ?? null,
    request_id: state.request_id ?? null
  });
  return {
    report_email: summarize(asRecord(emailState.report_email)),
    report_rework_email: summarize(asRecord(emailState.report_rework_email))
  };
}

function normalizeCustomerReworkType(value: unknown) {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "additional_structure") return "additional_structure";
  if (key === "change_correction" || key === "correction" || key === "change") return "change_correction";
  if (key === "report_issue" || key === "issue") return "report_issue";
  return key || "";
}

function customerReworkTypeLabel(value: unknown) {
  const key = normalizeCustomerReworkType(value);
  if (key === "additional_structure") return "Additional Structure";
  if (key === "change_correction") return "Change / Correction";
  if (key === "report_issue") return "Reported Issue";
  return "Customer Rework";
}

function isActionableCustomerReworkRequest(request: Record<string, unknown>) {
  const type = normalizeCustomerReworkType(request.type ?? request.request_type);
  if (type === "report_issue" || !type) return false;
  const status = String(request.status ?? "").trim().toLowerCase();
  return !["completed", "finalized", "rejected", "cancelled", "canceled", "sent_to_support"].includes(status);
}

function getCustomerReworkRequests(manifest: Record<string, unknown>) {
  const requests = Array.isArray(manifest.report_change_requests)
    ? manifest.report_change_requests.map((item) => asRecord(item))
    : [];
  const latest = asRecord(manifest.latest_report_change_request);
  if (Object.keys(latest).length > 0 && !requests.some((request) => String(request.id ?? "") === String(latest.id ?? ""))) {
    requests.push(latest);
  }
  return requests;
}

function getActiveCustomerReworkRequest(manifest: Record<string, unknown>) {
  const latest = asRecord(manifest.latest_report_change_request);
  if (Object.keys(latest).length > 0 && isActionableCustomerReworkRequest(latest)) return latest;
  const requests = getCustomerReworkRequests(manifest);
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    if (request && isActionableCustomerReworkRequest(request)) return request;
  }
  return null;
}

function applyCustomerReworkRequestStatus(
  manifest: Record<string, unknown>,
  request: Record<string, unknown>,
  status: string,
  fields: Record<string, unknown>
) {
  const requestId = String(request.id ?? "").trim();
  const updateRequest = (candidate: Record<string, unknown>) => {
    const sameId = requestId && String(candidate.id ?? "").trim() === requestId;
    const sameObject = !requestId && candidate === request;
    if (!sameId && !sameObject) return candidate;
    return {
      ...candidate,
      status,
      ...fields
    };
  };
  const requests = Array.isArray(manifest.report_change_requests)
    ? manifest.report_change_requests.map((item) => updateRequest(asRecord(item)))
    : [updateRequest(request)];
  const latest = updateRequest(asRecord(manifest.latest_report_change_request ?? request));
  return {
    report_change_requests: requests,
    latest_report_change_request: latest
  };
}

function buildCustomerReworkSubmittedToQaPatch(manifest: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  const request = getActiveCustomerReworkRequest(manifest);
  if (!request) return {};
  const type = normalizeCustomerReworkType(request.type ?? request.request_type);
  const label = customerReworkTypeLabel(type);
  return {
    ...applyCustomerReworkRequestStatus(manifest, request, "submitted_to_qa", {
      submitted_to_qa_at: nowIso
    }),
    customer_rework_in_qa: true,
    customer_rework_submitted_to_qa_at: nowIso,
    customer_rework_request_id: request.id ?? null,
    customer_rework_request_type: type,
    customer_rework_request_label: label,
    customer_rework_completed_at: null,
    customer_rework_completed_request_id: null
  };
}

function buildCustomerReworkCompletionPatch(
  manifest: Record<string, unknown>,
  nowIso: string,
  actorEmail: string,
  actorName: string
) {
  const requestId = String(manifest.customer_rework_request_id ?? "").trim();
  const requests = getCustomerReworkRequests(manifest);
  const request = (requestId
    ? requests.find((item) => String(item.id ?? "").trim() === requestId)
    : null) ?? getActiveCustomerReworkRequest(manifest);
  if (!request && !Boolean(manifest.customer_rework_in_qa)) return {};
  const effective = request ?? {
    id: requestId || null,
    type: manifest.customer_rework_request_type ?? "change_correction"
  };
  const type = normalizeCustomerReworkType(effective.type ?? effective.request_type ?? manifest.customer_rework_request_type);
  const label = customerReworkTypeLabel(type);
  return {
    ...applyCustomerReworkRequestStatus(manifest, effective, "completed", {
      completed_at: nowIso,
      completed_by_email: actorEmail || null,
      completed_by_name: actorName || null
    }),
    customer_rework_in_qa: false,
    customer_rework_completed_at: nowIso,
    customer_rework_completed_request_id: (effective.id ?? requestId) || null,
    customer_rework_completed_type: type,
    customer_rework_completed_label: label,
    customer_rework_pdf_label: "Corrected report"
  };
}

function getCompletedCustomerReworkForDelivery(manifest: Record<string, unknown>) {
  const requestId = String(manifest.customer_rework_completed_request_id ?? "").trim();
  const completedAt = String(manifest.customer_rework_completed_at ?? "").trim();
  if (!requestId && !completedAt) return null;
  const request = requestId
    ? getCustomerReworkRequests(manifest).find((item) => String(item.id ?? "").trim() === requestId)
    : null;
  return {
    request_id: requestId || request?.id || null,
    request_type: normalizeCustomerReworkType(
      request?.type ?? request?.request_type ?? manifest.customer_rework_completed_type ?? manifest.customer_rework_request_type
    ),
    label: String(
      manifest.customer_rework_completed_label
        ?? request?.label
        ?? customerReworkTypeLabel(request?.type ?? manifest.customer_rework_completed_type)
    ),
    completed_at: completedAt || request?.completed_at || null
  };
}

type ReportReleaseHoldPlan = {
  hold: boolean;
  reason: string;
  expedite_option: string;
  scheduled_release_at: string | null;
  promised_delivery_at: string | null;
  completed_at: string;
  random_offset_minutes: number;
};

function normalizeReportReleaseExpediteOption(manifest: Record<string, unknown>) {
  return normalizeReportExpediteKey(manifest.report_expedite_option ?? "standard_3_6");
}

function truthyManifestFlag(value: unknown) {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes" || text === "on";
}

function reportPriorityLevelFromManifest(manifest: Record<string, unknown>) {
  const rawLevel = Number.parseInt(String(manifest.priority_level ?? manifest.queue_priority_level ?? ""), 10);
  if ([1, 2, 3].includes(rawLevel)) return rawLevel;
  if (truthyManifestFlag(manifest.qa_priority) || truthyManifestFlag(manifest.manual_priority) || truthyManifestFlag(manifest.prioritized)) {
    return 1;
  }

  const expediteOption = normalizeReportReleaseExpediteOption(manifest);
  let level = reportExpeditePriorityLevel(expediteOption, truthyManifestFlag(manifest.is_expedited));
  if (truthyManifestFlag(manifest.is_vip)) {
    level = Math.min(level, 2);
  }
  return level;
}

function isPriorityOneReportProject(manifest: Record<string, unknown>) {
  return reportPriorityLevelFromManifest(manifest) === 1;
}

function firstManifestTimestamp(manifest: Record<string, unknown>, keys: string[]) {
  const timestamps = asRecord(manifest.timestamps);
  for (const key of keys) {
    const direct = parseDateLikeTimestamp(manifest[key]);
    if (direct) return direct;
    const nested = parseDateLikeTimestamp(timestamps[key]);
    if (nested) return nested;
  }
  return 0;
}

function deterministicOffsetMinutes(seed: string, minInclusive: number, maxInclusive: number) {
  const min = Math.min(minInclusive, maxInclusive);
  const max = Math.max(minInclusive, maxInclusive);
  const span = max - min + 1;
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const value = Number.parseInt(hex, 16);
  return min + (Number.isFinite(value) ? value % span : 0);
}

function buildReportReleaseHoldPlan(manifest: Record<string, unknown>, completedAtMs = Date.now()): ReportReleaseHoldPlan {
  const projectId = String(manifest.id ?? "");
  const expediteOption = normalizeReportReleaseExpediteOption(manifest);
  const completedMs = completedAtMs || Date.now();
  const completedAt = new Date(completedMs).toISOString();

  if (isPriorityOneReportProject(manifest)) {
    return {
      hold: false,
      reason: "priority_one_immediate",
      expedite_option: expediteOption,
      scheduled_release_at: null,
      promised_delivery_at: null,
      completed_at: completedAt,
      random_offset_minutes: 0
    };
  }

  if (expediteOption === REPORT_EXPEDITE_UNDER_1_KEY) {
    return {
      hold: false,
      reason: "rush_under_1_immediate",
      expedite_option: expediteOption,
      scheduled_release_at: null,
      promised_delivery_at: null,
      completed_at: completedAt,
      random_offset_minutes: 0
    };
  }

  const vipStandardP2Release = truthyManifestFlag(manifest.is_vip) && expediteOption === REPORT_EXPEDITE_STANDARD_KEY;
  if (expediteOption === REPORT_EXPEDITE_1_3_KEY || vipStandardP2Release) {
    const submittedMs = firstManifestTimestamp(manifest, ["queued_at", "created_at", "processed_at", "updated_at"]);
    if (!submittedMs) {
      return {
        hold: false,
        reason: vipStandardP2Release ? "vip_p2_missing_submission_time" : "rush_1_3_missing_submission_time",
        expedite_option: expediteOption,
        scheduled_release_at: null,
        promised_delivery_at: null,
        completed_at: completedAt,
        random_offset_minutes: 0
      };
    }
    const dueStartMs = vipStandardP2Release ? 0 : parseDateLikeTimestamp(manifest.report_due_window_start);
    const releaseWindowStartMs = dueStartMs || submittedMs + 60 * 60_000;
    const releaseWindowEndMs = releaseWindowStartMs + 60 * 60_000;
    const promisedDeliveryMs = vipStandardP2Release
      ? submittedMs + 180 * 60_000
      : (parseDateLikeTimestamp(manifest.report_due_window_end) || releaseWindowEndMs);
    const releaseWindowKey = vipStandardP2Release ? "vip_p2" : "rush_1_3";
    const randomOffsetMinutes = deterministicOffsetMinutes(`${projectId}:${releaseWindowKey}:${new Date(submittedMs).toISOString().slice(0, 10)}`, 0, 60);
    const scheduledMs = releaseWindowStartMs + randomOffsetMinutes * 60_000;
    if (completedMs >= releaseWindowEndMs || scheduledMs <= completedMs) {
      return {
        hold: false,
        reason: vipStandardP2Release ? "vip_p2_elapsed" : "rush_1_3_elapsed",
        expedite_option: expediteOption,
        scheduled_release_at: null,
        promised_delivery_at: new Date(promisedDeliveryMs).toISOString(),
        completed_at: completedAt,
        random_offset_minutes: randomOffsetMinutes
      };
    }
    return {
      hold: true,
      reason: vipStandardP2Release ? "vip_p2_release_window" : "rush_1_3_release_window",
      expedite_option: expediteOption,
      scheduled_release_at: new Date(scheduledMs).toISOString(),
      promised_delivery_at: new Date(promisedDeliveryMs).toISOString(),
      completed_at: completedAt,
      random_offset_minutes: randomOffsetMinutes
    };
  }

  const dueEndMs = parseDateLikeTimestamp(manifest.report_due_window_end);
  if (!dueEndMs) {
    return {
      hold: false,
      reason: "standard_missing_due_window",
      expedite_option: expediteOption,
      scheduled_release_at: null,
      promised_delivery_at: null,
      completed_at: completedAt,
      random_offset_minutes: 0
    };
  }

  const minutesBeforeDue = deterministicOffsetMinutes(`${projectId}:standard:${new Date(dueEndMs).toISOString().slice(0, 10)}`, 10, 15);
  const scheduledMs = dueEndMs - minutesBeforeDue * 60_000;
  const skipHoldAfterMs = dueEndMs - 15 * 60_000;
  if (completedMs >= skipHoldAfterMs || scheduledMs <= completedMs) {
    return {
      hold: false,
      reason: "standard_within_release_window",
      expedite_option: expediteOption,
      scheduled_release_at: null,
      promised_delivery_at: new Date(dueEndMs).toISOString(),
      completed_at: completedAt,
      random_offset_minutes: minutesBeforeDue
    };
  }

  return {
    hold: true,
    reason: "standard_release_window",
    expedite_option: expediteOption,
    scheduled_release_at: new Date(scheduledMs).toISOString(),
    promised_delivery_at: new Date(dueEndMs).toISOString(),
    completed_at: completedAt,
    random_offset_minutes: minutesBeforeDue
  };
}

function getReportReleaseHold(manifest: Record<string, unknown>) {
  const delivery = asRecord(manifest.delivery);
  return {
    ...asRecord(delivery.release_hold),
    status: String(manifest.delivery_hold_status ?? asRecord(delivery.release_hold).status ?? "").trim().toLowerCase(),
    scheduled_release_at: String(manifest.delivery_hold_scheduled_release_at ?? asRecord(delivery.release_hold).scheduled_release_at ?? "").trim(),
    promised_delivery_at: String(manifest.delivery_hold_promised_delivery_at ?? asRecord(delivery.release_hold).promised_delivery_at ?? "").trim(),
    reason: String(manifest.delivery_hold_reason ?? asRecord(delivery.release_hold).reason ?? "").trim()
  };
}

function isReportReleaseHeld(manifest: Record<string, unknown>, nowMs = Date.now()) {
  if (isPriorityOneReportProject(manifest)) return false;
  const hold = getReportReleaseHold(manifest);
  if (hold.status !== "holding") return false;
  const scheduledMs = parseDateLikeTimestamp(hold.scheduled_release_at);
  return Boolean(scheduledMs && scheduledMs > nowMs);
}

async function applyReportReleaseHold(projectId: string, legacy: Record<string, unknown>, plan: ReportReleaseHoldPlan) {
  if (!plan.hold || !plan.scheduled_release_at) return;
  const nowIso = new Date().toISOString();
  const delivery = asRecord(legacy.delivery);
  const releaseHold = {
    status: "holding",
    reason: plan.reason,
    expedite_option: plan.expedite_option,
    scheduled_release_at: plan.scheduled_release_at,
    promised_delivery_at: plan.promised_delivery_at,
    completed_at: plan.completed_at,
    created_at: nowIso,
    random_offset_minutes: plan.random_offset_minutes
  };
  await patchManifest(projectId, {
    delivery_hold_status: "holding",
    delivery_hold_reason: plan.reason,
    delivery_hold_scheduled_release_at: plan.scheduled_release_at,
    delivery_hold_promised_delivery_at: plan.promised_delivery_at,
    delivery_hold_created_at: nowIso,
    delivery_hold_random_offset_minutes: plan.random_offset_minutes,
    delivery_released_at: null,
    delivery_released_by: null,
    delivery: {
      ...delivery,
      release_hold: releaseHold
    }
  });
  await ensureReportReleaseJob(projectId, plan.scheduled_release_at);
}

function reportReleaseJobId(projectId: string, scheduledReleaseAt: string) {
  return createHash("sha256")
    .update(`report.release:${projectId}:${scheduledReleaseAt}`)
    .digest("hex")
    .slice(0, 32);
}

async function ensureReportReleaseJob(projectId: string, scheduledReleaseAt: string) {
  const availableAtMs = parseDateLikeTimestamp(scheduledReleaseAt);
  if (!availableAtMs) throw new Error("A valid scheduled release time is required.");
  const id = reportReleaseJobId(projectId, scheduledReleaseAt);
  await enqueueFirstMeasureJob("report.release", {
    project_id: projectId,
    scheduled_release_at: scheduledReleaseAt
  }, {
    id,
    priority: 20,
    maxAttempts: 5,
    availableAtMs,
    idempotent: true
  });
  return id;
}

function buildReportReleasePatch(
  legacy: Record<string, unknown>,
  eventTs: string,
  source: "scheduled" | "forced" | "immediate"
) {
  const delivery = asRecord(legacy.delivery);
  const hold = {
    ...getReportReleaseHold(legacy),
    status: source === "forced" ? "force_released" : "released",
    released_at: eventTs,
    released_by: source
  };
  return {
    delivery_hold_status: hold.status,
    delivery_released_at: eventTs,
    delivery_released_by: source,
    delivery: {
      ...delivery,
      release_hold: hold
    }
  };
}

function startReportReleaseHoldProcessor(app: FastifyInstance) {
  if (!shouldRunFirstMeasureBackgroundProcessor()) return;
  if (reportReleaseHoldTimer) return;
  const run = () => {
    void processDueReportReleaseHolds(app).catch((error) => {
      app.log.error({ err: error }, "Failed to process held report releases");
    });
  };
  reportReleaseHoldTimer = setInterval(run, REPORT_RELEASE_HOLD_POLL_MS);
  reportReleaseHoldTimer.unref?.();
  run();
}

async function processDueReportReleaseHolds(app: FastifyInstance) {
  const result = await queryIndexedQueueBucket({
    group: "release_holding",
    limit: REPORT_RELEASE_HOLD_BATCH_LIMIT,
    offset: 0,
    includeInstantOnly: false
  });
  const nowMs = Date.now();
  let released = 0;
  for (const row of result.rows) {
    const manifest = row.manifest as Record<string, unknown>;
    const projectId = String(manifest.id ?? "").trim();
    if (!projectId) continue;
    const hold = getReportReleaseHold(manifest);
    const scheduledMs = parseDateLikeTimestamp(hold.scheduled_release_at);
    if (!scheduledMs || scheduledMs > nowMs) continue;
    const releaseResult = await releaseProjectReport(projectId, "scheduled").catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
    if (Boolean(releaseResult.ok)) released += 1;
  }
  if (released > 0) {
    app.log.info({ released }, "Processed held report releases");
  }
}

function isExpeditedReportOption(value: unknown) {
  return isExpeditedReportExpediteKey(value);
}

async function reportReleaseHoldEnabled(manifest: Record<string, unknown>) {
  if (manifest.report_release_hold_enabled === true) return true;
  if (manifest.report_release_hold_enabled === false) return false;
  if (isExpeditedReportOption(manifest.report_expedite_option)) return true;
  const orgId = firstNonBlankString(manifest.organization_id, asRecord(manifest.organization_ref).id);
  if (!orgId) return false;
  return await isAppFlagEnabled(orgId, "firstmeasure", "report_expedite_options").catch(() => false);
}

function getInitialReportSentAtMs(manifest: ProjectManifest | Record<string, unknown>) {
  const legacy = buildLegacyManifest(manifest as ProjectManifest);
  const summary = getProjectEmailSummary(manifest as ProjectManifest).report_email;
  return parseDateLikeTimestamp(
    summary.sent_at_utc
      ?? summary.last_attempt_utc
      ?? legacy.report_sent_at
      ?? asRecord(legacy.delivery).report_sent_at
  );
}

function expediteMissedPromiseDue(manifest: ProjectManifest | Record<string, unknown>, nowMs = Date.now()) {
  const legacy = buildLegacyManifest(manifest as ProjectManifest);
  const refundStatus = String(legacy.report_expedite_refund_status ?? "").trim().toLowerCase();
  const emailState = asRecord(legacy.email_state);
  const missedPromiseEmail = asRecord(emailState.expedite_missed_promise_email);
  if ((refundStatus === "refunded" || refundStatus === "no_charge") && missedPromiseEmail.sent_ok === true) return false;
  if (!isExpeditedReportOption(legacy.report_expedite_option)) return false;
  const status = String(legacy.status ?? "").trim().toLowerCase();
  if (["cancelled", "rejected", "rejected_no_coverage", "pending_rejection"].includes(status)) return false;
  const dueEndMs = parseDateLikeTimestamp(legacy.report_due_window_end);
  if (!dueEndMs || nowMs < dueEndMs) return false;
  const sentAtMs = getInitialReportSentAtMs(legacy);
  return !sentAtMs || sentAtMs > dueEndMs;
}

function calculateExpediteRefundAmount(manifest: ProjectManifest | Record<string, unknown>) {
  const legacy = buildLegacyManifest(manifest as ProjectManifest);
  const pins = Array.isArray(legacy.pins) ? legacy.pins : [];
  const standardAmount = firstMeasurePublicReportAmount({
    project_type: legacy.project_type,
    report_mode: legacy.report_mode ?? "full",
    report_expedite_option: "standard_3_6",
    include_gutter_measurements: legacy.include_gutter_measurements,
    include_weather_report: legacy.include_weather_report,
    pins
  });
  const currentAmount = moneyAmount(legacy.amount_charged);
  return {
    currentAmount,
    standardAmount,
    refundAmount: moneyAmount(Math.max(0, currentAmount - standardAmount))
  };
}

function buildExpediteMissedPromiseEmailText(input: {
  address: string;
  refundAmount: number;
  dueLabel: string;
}) {
  const refundLine = input.refundAmount > 0
    ? `We have refunded $${input.refundAmount.toFixed(2).replace(/\.00$/, "")} in expedite fees back to your credits.`
    : "If any expedite charge was applied to this order, it has been removed.";
  return [
    "We need a little more time on your expedited roof report.",
    `Address: ${input.address}`,
    input.dueLabel ? `Promised delivery window: ${input.dueLabel}` : "",
    "Your report is almost done, but we missed the expedited delivery window we quoted. We are sorry about the delay, and we will deliver the report as soon as possible.",
    refundLine,
    "You do not need to do anything else. The report will continue processing normally."
  ].filter(Boolean).join("\n\n");
}

function buildExpediteMissedPromiseEmailHtml(input: {
  address: string;
  refundAmount: number;
  dueLabel: string;
}) {
  const refundLine = input.refundAmount > 0
    ? `We have refunded <strong>$${escapeHtml(input.refundAmount.toFixed(2).replace(/\.00$/, ""))}</strong> in expedite fees back to your credits.`
    : "If any expedite charge was applied to this order, it has been removed.";
  return [
    "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;font-weight:700;\">We need a little more time on your expedited roof report.</p>",
    `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;"><strong>Address:</strong> ${escapeHtml(input.address)}</p>`,
    input.dueLabel
      ? `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;"><strong>Promised delivery window:</strong> ${escapeHtml(input.dueLabel)}</p>`
      : "",
    "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;\">Your report is almost done, but we missed the expedited delivery window we quoted. We are sorry about the delay, and we will deliver the report as soon as possible.</p>",
    `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;">${refundLine}</p>`,
    "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;\">You do not need to do anything else. The report will continue processing normally.</p>"
  ].filter(Boolean).join("");
}

async function sendExpediteMissedPromiseEmail(projectId: string, manifest: ProjectManifest | Record<string, unknown>) {
  const legacy = buildLegacyManifest(manifest as ProjectManifest);
  const emailState = asRecord(legacy.email_state);
  const current = asRecord(emailState.expedite_missed_promise_email);
  if (current.sent_ok === true) return { ok: true, already_sent: true };

  const issuer = asRecord(legacy.issuer);
  const to = String(issuer.email ?? "").trim().toLowerCase();
  const cc = Array.isArray(legacy.cc_emails)
    ? legacy.cc_emails
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value && value.includes("@") && value !== to)
    : [];
  const recipients = Array.from(new Set([...(to ? [to] : []), ...cc]));
  if (recipients.length === 0) return { ok: false, error: "missing_recipient" };

  const refundAmount = moneyAmount(legacy.report_expedite_refund_amount);
  const address = String(legacy.address ?? "Project");
  const dueLabel = String(legacy.report_due_window_label ?? "");
  const subject = `Update on your expedited roof report - ${address}`;
  const sendResult = await sendPostmarkEmail({
    to: recipients.join(","),
    subject,
    textBody: buildExpediteMissedPromiseEmailText({ address, refundAmount, dueLabel }),
    htmlBody: buildExpediteMissedPromiseEmailHtml({ address, refundAmount, dueLabel })
  });

  const eventTs = new Date().toISOString();
  const updatedState = {
    ...emailState,
    expedite_missed_promise_email: {
      ...current,
      type: "expedite_missed_promise_email",
      last_attempt_utc: eventTs,
      last_ok: Boolean(sendResult.ok),
      last_error: sendResult.error ?? null,
      last_http: sendResult.http ?? null,
      last_to: recipients.join(","),
      last_subject: subject,
      attempts: Number(current.attempts ?? 0) + 1,
      sent_ok: Boolean(sendResult.ok) ? true : Boolean(current.sent_ok),
      sent_at_utc: Boolean(sendResult.ok) ? eventTs : (current.sent_at_utc ?? null),
      message_id: Boolean(sendResult.ok) && asRecord(sendResult.postmark).MessageID
        ? asRecord(sendResult.postmark).MessageID
        : (current.message_id ?? null)
    }
  };
  const updatedEvents = Array.isArray(legacy.email_events) ? [...legacy.email_events] : [];
  updatedEvents.push({
    ts_utc: eventTs,
    type: "expedite_missed_promise_email",
    to: recipients.join(","),
    subject,
    ok: Boolean(sendResult.ok),
    error: sendResult.error ?? null,
    http: sendResult.http ?? null,
    meta: { project_id: projectId, refund_amount: refundAmount },
    postmark: sendResult.postmark ?? null
  });
  if (updatedEvents.length > 200) updatedEvents.splice(0, updatedEvents.length - 200);

  await patchManifest(projectId, {
    email_state: updatedState,
    email_events: updatedEvents,
    delivery: {
      ...asRecord(legacy.delivery),
      email_state: updatedState,
      email_events: updatedEvents
    }
  });

  return sendResult;
}

async function applyExpediteMissedPromiseRefund(projectId: string, manifest: ProjectManifest | Record<string, unknown>) {
  const legacy = buildLegacyManifest(manifest as ProjectManifest);
  const refundStatus = String(legacy.report_expedite_refund_status ?? "").trim().toLowerCase();
  if (refundStatus === "refunded" || refundStatus === "no_charge") return buildLegacyManifest(await readManifest(projectId));
  const nowIso = new Date().toISOString();
  const dueEnd = String(legacy.report_due_window_end ?? "");
  const { currentAmount, standardAmount, refundAmount } = calculateExpediteRefundAmount(legacy);
  const orgId = await resolvePortalOrganizationIdForProject(legacy as ProjectManifest);
  if (refundAmount > 0 && !orgId) {
    await patchManifest(projectId, {
      report_expedite_refund_status: "refund_failed",
      report_expedite_refund_error: "missing_organization",
      report_expedite_refund_due_at: dueEnd,
      report_expedite_refund_checked_at: nowIso
    });
    return null;
  }

  if (refundAmount > 0 && orgId) {
    await refundPublicFirstMeasureOrder({
      orgId,
      amount: refundAmount,
      actorEmail: "system@1m8.ai",
      reason: "firstmeasure_expedite_missed_promise_refund",
      meta: {
        project_id: projectId,
        source: "firstmeasure_expedite_missed_promise",
        report_expedite_option: legacy.report_expedite_option ?? null,
        promised_due_at: dueEnd || null,
        previous_amount: currentAmount,
        standard_amount: standardAmount
      }
    });
  }

  const finalAmount = moneyAmount(currentAmount - refundAmount);
  const delivery = asRecord(legacy.delivery);
  const patch = {
    amount_charged: finalAmount,
    report_expedite_refund_status: refundAmount > 0 ? "refunded" : "no_charge",
    report_expedite_refund_amount: refundAmount,
    report_expedite_refund_at: nowIso,
    report_expedite_refund_due_at: dueEnd || null,
    report_expedite_refund_reason: "missed_delivery_window",
    report_expedite_refund_previous_amount: currentAmount,
    report_expedite_refund_standard_amount: standardAmount,
    report_expedite_refund_message: refundAmount > 0
      ? `Expedite fee refunded because the report missed the promised delivery window.`
      : `Expedite delivery window was missed; no paid expedite fee was available to refund.`,
    delivery: {
      ...delivery,
      expedite_refund: {
        status: refundAmount > 0 ? "refunded" : "no_charge",
        amount: refundAmount,
        refunded_at: nowIso,
        due_at: dueEnd || null,
        reason: "missed_delivery_window"
      }
    }
  };
  const updated = await patchManifest(projectId, patch);

  if (orgId) {
    const record = await findPublicFirstMeasureReportByProjectId(orgId, projectId).catch(() => null);
    if (record) {
      await updatePublicFirstMeasureReportRecord(record.report_id, orgId, {
        amount_charged: finalAmount,
        metadata: {
          expedite_refund: {
            amount: refundAmount,
            refunded_at: nowIso,
            due_at: dueEnd || null,
            reason: "missed_delivery_window"
          }
        }
      }).catch(() => null);
    }
  }

  return buildLegacyManifest(updated);
}

async function processExpediteMissedPromiseProject(projectId: string) {
  const manifest = await readManifest(projectId).catch(() => null);
  if (!manifest || !expediteMissedPromiseDue(manifest)) return { ok: true, skipped: true };
  const refunded = await applyExpediteMissedPromiseRefund(projectId, manifest);
  if (!refunded) return { ok: false, error: "refund_failed" };
  const emailResult = await sendExpediteMissedPromiseEmail(projectId, refunded).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  return { ok: Boolean(emailResult.ok), refund: refunded, email: emailResult };
}

function startExpediteMissedPromiseProcessor(app: FastifyInstance) {
  if (!EXPEDITE_MISSED_PROMISE_AUTOMATIC_REFUNDS_ENABLED) {
    app.log.info("Automatic expedited missed-promise refunds are disabled.");
    return;
  }
  if (!shouldRunFirstMeasureBackgroundProcessor()) return;
  if (expediteMissedPromiseTimer) return;
  const run = () => {
    void processExpediteMissedPromises(app).catch((error) => {
      app.log.error({ err: error }, "Failed to process overdue expedited report refunds");
    });
  };
  expediteMissedPromiseTimer = setInterval(run, EXPEDITE_MISSED_PROMISE_POLL_MS);
  expediteMissedPromiseTimer.unref?.();
  run();
}

async function processExpediteMissedPromises(app: FastifyInstance) {
  if (!EXPEDITE_MISSED_PROMISE_AUTOMATIC_REFUNDS_ENABLED) {
    app.log.info("Skipped overdue expedited report refunds because automatic refunds are disabled.");
    return;
  }
  const groups: FirstMeasureQueueGroup[] = [
    "needs_structure_pins",
    "waiting",
    "queued",
    "requeue",
    "in_progress",
    "qa_waiting",
    "qa_claimed",
    "release_holding",
    "completed"
  ];
  let refunded = 0;
  for (const group of groups) {
    const result = await queryIndexedQueueBucket({
      group,
      limit: EXPEDITE_MISSED_PROMISE_BATCH_LIMIT,
      offset: 0,
      includeInstantOnly: false
    });
    for (const row of result.rows) {
      const manifest = row.manifest;
      const projectId = String(manifest.id ?? "").trim();
      if (!projectId || !expediteMissedPromiseDue(manifest)) continue;
      const processed = await processExpediteMissedPromiseProject(projectId);
      if (processed.ok) refunded += 1;
    }
  }
  if (refunded > 0) {
    app.log.info({ refunded }, "Processed overdue expedited report refunds");
  }
}

async function sendProjectEmail(projectId: string, force: boolean) {
  const manifest = await readManifest(projectId);
  const legacy = buildLegacyManifest(manifest);
  const reworkDelivery = getCompletedCustomerReworkForDelivery(legacy);
  const emailKind = reworkDelivery ? "report_rework_email" : "report_email";
  const issuer = asRecord(legacy.issuer);
  const to = String(issuer.email ?? "").trim().toLowerCase();
  const cc = Array.isArray(legacy.cc_emails)
    ? legacy.cc_emails
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value && value.includes("@") && value !== to)
    : [];
  const recipients = Array.from(new Set([...(to ? [to] : []), ...cc]));
  if (recipients.length === 0) {
    return { ok: false, error: "missing_recipient" };
  }

  const currentSummary = getProjectEmailSummary(manifest)[emailKind];
  if (!force && currentSummary.sent_ok && (!reworkDelivery || currentSummary.request_id === reworkDelivery.request_id)) {
    return { ok: true, already_sent: true };
  }
  const releaseHoldExpediteOption = normalizeReportReleaseExpediteOption(legacy);
  const releaseHoldEnabled = !force && !reworkDelivery
    ? await reportReleaseHoldEnabled(legacy)
    : false;
  const releaseHoldPriorityOne = isPriorityOneReportProject(legacy);
  const canHoldForRelease = releaseHoldEnabled
    && releaseHoldExpediteOption !== REPORT_EXPEDITE_UNDER_1_KEY
    && (releaseHoldExpediteOption === REPORT_EXPEDITE_1_3_KEY || !releaseHoldPriorityOne);
  if (canHoldForRelease) {
    const existingHold = getReportReleaseHold(legacy);
    if (existingHold.status === "holding" && isReportReleaseHeld(legacy)) {
      await ensureReportReleaseJob(projectId, existingHold.scheduled_release_at);
      return {
        ok: true,
        held: true,
        scheduled_release_at: existingHold.scheduled_release_at || null,
        promised_delivery_at: existingHold.promised_delivery_at || null,
        reason: existingHold.reason || null
      };
    }
    if (existingHold.status !== "holding") {
      const completedMs = firstManifestTimestamp(legacy, ["completed_at", "updated_at"]) || Date.now();
      const holdPlan = buildReportReleaseHoldPlan(legacy, completedMs);
      if (holdPlan.hold) {
        await applyReportReleaseHold(projectId, legacy, holdPlan);
        return {
          ok: true,
          held: true,
          scheduled_release_at: holdPlan.scheduled_release_at,
          promised_delivery_at: holdPlan.promised_delivery_at,
          reason: holdPlan.reason
        };
      }
    }
  }

  const safeAddress = sanitizeEmailFileLabel(String(legacy.address ?? "Project"));
  const attachments: Array<{ Name: string; Content: string; ContentType: string }> = [];

  const mainPdf = await readStoredPdf(projectId, "main").catch(() => null);
  if (!mainPdf) {
    return { ok: false, error: "missing_pdf" };
  }
  attachments.push({
    Name: `${reworkDelivery ? "Corrected Report" : "Report"} - ${safeAddress}.pdf`,
    Content: mainPdf.content.toString("base64"),
    ContentType: "application/pdf"
  });

  const summaryPdf = await readStoredPdf(projectId, "summary").catch(() => null);
  if (summaryPdf) {
    attachments.push({
      Name: `${reworkDelivery ? "Corrected Summary" : "Summary"} - ${safeAddress}.pdf`,
      Content: summaryPdf.content.toString("base64"),
      ContentType: "application/pdf"
    });
  }

  const xmlFile = await readStoredXml(projectId).catch(() => null);
  if (xmlFile) {
    attachments.push({
      Name: `Model - ${safeAddress}.xml`,
      Content: xmlFile.content.toString("base64"),
      ContentType: "text/xml"
    });
  }

  if (projectIncludesWeatherReport(legacy)) {
    const weather = await ensureProjectWeatherReport(projectId, legacy);
    attachments.push({
      Name: `Historical Weather - ${safeAddress}.pdf`,
      Content: weather.pdf.bytes.toString("base64"),
      ContentType: "application/pdf"
    });
  }

  const address = String(legacy.address ?? "Project");
  const subject = reworkDelivery
    ? `Corrected Roof Report - ${address}`
    : `Roof Report - ${address}`;
  const bonusOfferTeaser = reworkDelivery
    ? false
    : await bonusOfferEmailTeaserForProject(manifest);
  const textBody = buildReportEmailTextBody(address || "Unknown", bonusOfferTeaser, { reworkDelivery });
  const sendResult = await sendPostmarkEmail({
    to: recipients.join(","),
    subject,
    textBody,
    htmlBody: buildReportEmailHtmlBody(address || "Unknown", bonusOfferTeaser, { reworkDelivery }),
    attachments
  });

  const updatedState = asRecord(legacy.email_state);
  const updatedEvents = Array.isArray(legacy.email_events) ? [...legacy.email_events] : [];
  const eventTs = new Date().toISOString();
  const event = {
    ts_utc: eventTs,
    type: emailKind,
    to: recipients.join(","),
    subject,
    ok: Boolean(sendResult.ok),
    error: sendResult.error ?? null,
    http: sendResult.http ?? null,
    meta: { project_id: projectId, rework: reworkDelivery ?? null },
    postmark: sendResult.postmark ?? null
  };
  updatedEvents.push(event);
  if (updatedEvents.length > 200) {
    updatedEvents.splice(0, updatedEvents.length - 200);
  }
  const reportState = {
    ...asRecord(updatedState[emailKind]),
    type: emailKind,
    request_id: reworkDelivery?.request_id ?? null,
    request_type: reworkDelivery?.request_type ?? null,
    last_attempt_utc: eventTs,
    last_ok: Boolean(sendResult.ok),
    last_error: sendResult.error ?? null,
    last_http: sendResult.http ?? null,
    last_to: recipients.join(","),
    last_subject: subject,
    attempts: Number(asRecord(updatedState[emailKind]).attempts ?? 0) + 1,
    sent_ok: Boolean(sendResult.ok) ? true : Boolean(asRecord(updatedState[emailKind]).sent_ok),
    sent_at_utc: Boolean(sendResult.ok) ? eventTs : (asRecord(updatedState[emailKind]).sent_at_utc ?? null),
    message_id: Boolean(sendResult.ok) && asRecord(sendResult.postmark).MessageID
      ? asRecord(sendResult.postmark).MessageID
      : (asRecord(updatedState[emailKind]).message_id ?? null)
  };
  updatedState[emailKind] = reportState;

  const releasePatch = !reworkDelivery && Boolean(sendResult.ok)
    ? buildReportReleasePatch(
        legacy,
        eventTs,
        force ? "forced" : (canHoldForRelease && getReportReleaseHold(legacy).status === "holding" ? "scheduled" : "immediate")
      )
    : {};

  await patchManifest(projectId, {
    ...releasePatch,
    email_state: updatedState,
    email_events: updatedEvents,
    delivery: {
      ...asRecord(legacy.delivery),
      ...asRecord((releasePatch as Record<string, unknown>).delivery),
      email_state: updatedState,
      email_events: updatedEvents,
      report_sent_at: !reworkDelivery && Boolean(sendResult.ok) ? eventTs : asRecord(legacy.delivery).report_sent_at ?? null,
      rework_report_sent_at: reworkDelivery && Boolean(sendResult.ok) ? eventTs : asRecord(legacy.delivery).rework_report_sent_at ?? null
    }
  });

  if (!reworkDelivery && sendResult.ok && bonusOfferTeaser) {
    await markBonusOfferEmailSent(bonusOfferTeaser, eventTs, projectId).catch(() => null);
  }

  return sendResult;
}

function projectEmailFailureMessage(result: Record<string, unknown>) {
  const postmark = asRecord(result.postmark);
  return firstNonBlankString(
    result.error,
    postmark.Message,
    postmark.message,
    postmark.ErrorCode,
    "report_email_failed"
  );
}

async function releaseProjectReport(projectId: string, source: "scheduled" | "forced") {
  const releaseLock = await acquireFirstMeasureLock(`report-release:${projectId}`, {
    ttlMs: 120_000,
    waitMs: 120_000,
    retryMs: 100
  });
  try {
    return await releaseProjectReportLocked(projectId, source);
  } finally {
    await releaseLock().catch(() => undefined);
  }
}

async function releaseProjectReportLocked(projectId: string, source: "scheduled" | "forced") {
  const emailResult = await sendProjectEmail(projectId, source === "forced").catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  if (asRecord(emailResult).held === true) {
    return {
      ok: true,
      released: false,
      held: true,
      email: emailResult
    };
  }

  const manifest = await readManifest(projectId);
  const legacy = buildLegacyManifest(manifest);
  const hold = getReportReleaseHold(legacy);
  const holdStatus = String(hold.status ?? "").trim().toLowerCase();
  const alreadyReleased = holdStatus === "released" || holdStatus === "force_released";
  const emailSent = Boolean(asRecord(emailResult).ok);

  if (alreadyReleased) {
    return {
      ok: true,
      released: true,
      email_sent: emailSent,
      warning: emailSent ? null : "report_email_failed",
      email: emailResult,
      manifest: legacy
    };
  }

  const eventTs = new Date().toISOString();
  const releasePatch = buildReportReleasePatch(legacy, eventTs, source);
  const delivery = asRecord(legacy.delivery);
  const emailWarning = emailSent ? null : projectEmailFailureMessage(asRecord(emailResult));
  const updated = await patchManifest(projectId, {
    ...releasePatch,
    delivery_release_email_status: emailSent ? "sent" : "failed",
    delivery_release_email_warning: emailWarning,
    delivery_release_email_http: asRecord(emailResult).http ?? null,
    delivery: {
      ...delivery,
      ...asRecord((releasePatch as Record<string, unknown>).delivery),
      release_email_status: emailSent ? "sent" : "failed",
      release_email_warning: emailWarning,
      release_email_http: asRecord(emailResult).http ?? null
    }
  });

  return {
    ok: true,
    released: true,
    email_sent: emailSent,
    warning: emailWarning ? "report_email_failed" : null,
    email: emailResult,
    manifest: buildLegacyManifest(updated)
  };
}

async function runBackgroundReportReleaseJob(job: {
  id: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
}, logger?: {
  info?: (value: unknown, message?: string) => void;
  warn?: (value: unknown, message?: string) => void;
}) {
  const projectId = String(job.payload.project_id ?? "").trim();
  const scheduledReleaseAt = String(job.payload.scheduled_release_at ?? "").trim();
  if (!projectId || !scheduledReleaseAt) {
    throw new Error("Background report release is missing its project or scheduled release time.");
  }
  const manifest = await readManifest(projectId);
  const legacy = buildLegacyManifest(manifest);
  const hold = getReportReleaseHold(legacy);
  const status = String(hold.status ?? "").trim().toLowerCase();
  if (status === "released" || status === "force_released") {
    return { ok: true, skipped: true, reason: "already_released" };
  }
  if (status !== "holding" || String(hold.scheduled_release_at ?? "") !== scheduledReleaseAt) {
    return { ok: true, skipped: true, reason: "stale_release_job" };
  }
  const scheduledMs = parseDateLikeTimestamp(scheduledReleaseAt);
  if (!scheduledMs || scheduledMs > Date.now()) {
    throw new Error("Background report release was claimed before its scheduled time.");
  }
  const result = await releaseProjectReport(projectId, "scheduled");
  if (!result.ok) throw new Error(String(asRecord(result).error ?? "Scheduled report release failed."));
  logger?.info?.({ projectId, jobId: job.id }, "Background report release completed.");
  return result;
}

function projectIncludesWeatherReport(project: Record<string, unknown>) {
  return Boolean(project.include_weather_report || project.weather_report_id);
}

function projectWeatherReportMayGenerate(project: Record<string, unknown>) {
  const status = String(project.status ?? "").trim().toLowerCase();
  return status === "completed"
    || status === "complete"
    || status === "ready"
    || status === "rework_requested"
    || status === "reworking"
    || status === "customer_rework_requested"
    || Boolean(project.completed_at || project.report_sent_at || asRecord(project.delivery).report_sent_at);
}

function projectWeatherPdfUrl(reportId: string) {
  return `/v1/weather/reports/${encodeURIComponent(reportId)}/pdf`;
}

async function ensureProjectWeatherReport(projectId: string, sourceManifest?: Record<string, unknown>) {
  const current = sourceManifest && Object.keys(sourceManifest).length
    ? sourceManifest
    : buildLegacyManifest(await readManifest(projectId));
  let reportId = firstNonBlankString(current.weather_report_id, asRecord(current.weather_report).id);
  if (!reportId) {
    const resident = asRecord(current.resident);
    const lat = typeof current.lat === "number" ? current.lat : Number(current.lat);
    const lng = typeof current.lng === "number" ? current.lng : Number(current.lng);
    const property: { address?: string; lat?: number; lon?: number } = {};
    const address = firstNonBlankString(current.address);
    if (address) property.address = address;
    if (Number.isFinite(lat)) property.lat = lat;
    if (Number.isFinite(lng)) property.lon = lng;
    const reportResult = await buildWeatherReport({
      tier: "history",
      property,
      customer_name: firstNonBlankString(resident.name),
      claim_reference: projectId,
      peril: "all",
      persist: true,
      include_ai_summary: false
    });
    reportId = reportResult.report.id;
  }
  const pdf = await generateWeatherReportPdf(reportId);
  const patch = {
    include_weather_report: true,
    weather_report_tier: "history",
    weather_report_id: reportId,
    weather_report_pdf_url: projectWeatherPdfUrl(reportId),
    weather_report_generated_at: pdf.report.generated_at,
    weather_report_status: "ready"
  };
  await patchManifest(projectId, patch);
  return { reportId, pdf, patch };
}

function queueProjectWeatherReportGeneration(projectId: string, sourceManifest?: Record<string, unknown>, refund?: {
  orgId: string;
  actorEmail: string;
  chargeToken: string;
  amount: number;
}) {
  if (weatherReportGenerationQueue.has(projectId)) return;
  weatherReportGenerationQueue.add(projectId);
  void ensureProjectWeatherReport(projectId, sourceManifest)
    .then(() => {
      weatherReportGenerationQueue.delete(projectId);
    })
    .catch(async (error) => {
      weatherReportGenerationQueue.delete(projectId);
      const message = error instanceof Error ? error.message : String(error);
      const current: Record<string, unknown> = await readManifest(projectId)
        .then((manifest) => buildLegacyManifest(manifest))
        .catch(() => ({} as Record<string, unknown>));
      const failurePatch: Record<string, unknown> = {
        weather_report_status: "failed",
        weather_report_error: message
      };
      if (refund) {
        await refundPublicFirstMeasureOrder({
          orgId: refund.orgId,
          amount: refund.amount,
          actorEmail: refund.actorEmail,
          reason: "api_firstmeasure_weather_report_refund",
          meta: {
            charge_token: refund.chargeToken,
            project_id: projectId,
            error: message
          }
        }).catch(() => null);
        failurePatch.amount_charged = Math.max(0, moneyAmount(current.amount_charged) - moneyAmount(refund.amount));
        failurePatch.weather_report_refund_amount = refund.amount;
        failurePatch.weather_report_refunded_at = new Date().toISOString();
      }
      await patchManifest(projectId, failurePatch).catch(() => null);
    });
}

async function sendProjectRejectionEmail(projectId: string, force: boolean) {
  const manifest = await readManifest(projectId);
  const legacy = buildLegacyManifest(manifest);
  const issuer = asRecord(legacy.issuer);
  const to = String(issuer.email ?? "").trim().toLowerCase();
  const cc = Array.isArray(legacy.cc_emails)
    ? legacy.cc_emails
        .map((value) => String(value).trim().toLowerCase())
        .filter((value) => value && value.includes("@") && value !== to)
    : [];
  const recipients = Array.from(new Set([...(to ? [to] : []), ...cc]));
  if (recipients.length === 0) {
    return { ok: false, error: "missing_recipient" };
  }

  const emailState = asRecord(legacy.email_state);
  const currentState = asRecord(emailState.rejection_email);
  if (!force && Boolean(currentState.sent_ok)) {
    return { ok: true, already_sent: true };
  }

  const address = String(legacy.address ?? "Project");
  const subject = `Unable to complete roof report - ${address}`;
  const textBody = buildRejectionEmailTextBody(legacy);
  const htmlBody = buildRejectionEmailHtmlBody(legacy);
  const sendResult = await sendPostmarkEmail({
    to: recipients.join(","),
    subject,
    textBody,
    htmlBody
  });

  const updatedState = {
    ...emailState,
    rejection_email: {
      ...currentState,
      type: "rejection_email",
      last_attempt_utc: new Date().toISOString(),
      last_ok: Boolean(sendResult.ok),
      last_error: sendResult.error ?? null,
      last_http: sendResult.http ?? null,
      last_to: recipients.join(","),
      last_subject: subject,
      attempts: Number(currentState.attempts ?? 0) + 1,
      sent_ok: Boolean(sendResult.ok) ? true : Boolean(currentState.sent_ok),
      sent_at_utc: Boolean(sendResult.ok) ? new Date().toISOString() : (currentState.sent_at_utc ?? null),
      message_id: Boolean(sendResult.ok) && asRecord(sendResult.postmark).MessageID
        ? asRecord(sendResult.postmark).MessageID
        : (currentState.message_id ?? null)
    }
  };
  const updatedEvents = Array.isArray(legacy.email_events) ? [...legacy.email_events] : [];
  updatedEvents.push({
    ts_utc: new Date().toISOString(),
    type: "rejection_email",
    to: recipients.join(","),
    subject,
    ok: Boolean(sendResult.ok),
    error: sendResult.error ?? null,
    http: sendResult.http ?? null,
    meta: {
      project_id: projectId,
      rejection_reason: String(legacy.rejection_reason ?? "")
    },
    postmark: sendResult.postmark ?? null
  });
  if (updatedEvents.length > 200) {
    updatedEvents.splice(0, updatedEvents.length - 200);
  }

  await patchManifest(projectId, {
    email_state: updatedState,
    email_events: updatedEvents,
    delivery: {
      email_state: updatedState,
      email_events: updatedEvents
    }
  });

  return sendResult;
}

async function sendPostmarkEmail(input: {
  to: string;
  subject: string;
  textBody: string;
  htmlBody?: string;
  attachments?: Array<{ Name: string; Content: string; ContentType: string }>;
}) {
  const token = await readPostmarkToken();
  if (!token) {
    return { ok: false, error: "Postmark token missing" };
  }

  const payload = {
    From: "noreply@1m8.ai",
    To: input.to,
    Subject: input.subject,
    TextBody: wrapEmailText(input.textBody),
    HtmlBody: wrapEmailHtml(input.htmlBody ?? `<div>${escapeHtml(input.textBody).replace(/\n/g, "<br>")}</div>`),
    ReplyTo: "support@1m8.ai",
    Attachments: input.attachments ?? []
  };

  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Postmark-Server-Token": token
    },
    body: JSON.stringify(payload)
  });

  let postmark: Record<string, unknown> | null = null;
  try {
    postmark = await response.json() as Record<string, unknown>;
  } catch {
    postmark = null;
  }

  return {
    ok: response.ok,
    http: response.status,
    postmark
  };
}

async function readPostmarkToken() {
  for (const key of ["FIRSTMEASURE_POSTMARK_TOKEN", "POSTMARK_SERVER_TOKEN", "POSTMARK_API_TOKEN"]) {
    const token = String(process.env[key] ?? "").trim();
    if (token) return token;
  }

  const candidates = [
    path.resolve(process.cwd(), "./storage/secrets/pm_server_token.txt"),
    path.resolve(process.cwd(), "./pm_server_token.txt"),
    path.resolve(API_MODULE_DIR, "../../storage/secrets/pm_server_token.txt"),
    path.resolve(API_MODULE_DIR, "../pm_server_token.txt")
  ];

  for (const filePath of candidates) {
    try {
      const raw = await readFile(filePath, "utf8");
      const token = raw.trim();
      if (token) return token;
    } catch {
      continue;
    }
  }

  return null;
}

function sanitizeEmailFileLabel(value: string) {
  const safe = value.replace(/[^a-zA-Z0-9 \-]/g, "").replace(/\s+/g, " ").trim();
  return safe || "Project";
}

type BonusOfferEmailTeaser = {
  org_id: string;
  instance_id: string;
  rollout_id: string;
  max_bonus_dollars: number;
};

function bonusOfferCampaignStatus(instanceInput: unknown, nowMs = Date.now()) {
  const instance = asRecord(instanceInput);
  const status = String(instance.status ?? "scheduled").trim().toLowerCase();
  if (status === "cancelled" || status === "archived") return "cancelled";
  if (instance.claimed === true || status === "claimed" || firstNonBlankString(instance.claimed_at)) return "claimed";
  const startsAt = parseDateLikeTimestamp(instance.starts_at || instance.scheduled_at || instance.created_at);
  if (startsAt && nowMs < startsAt) return "scheduled";
  const viewedAt = parseDateLikeTimestamp(instance.viewed_at || instance.first_shown_at);
  const expiresAt = parseDateLikeTimestamp(instance.expires_at || instance.ends_at);
  if (viewedAt && expiresAt && nowMs > expiresAt) return "expired";
  return viewedAt ? "viewed" : "available";
}

function bonusOfferEmailAlreadySent(instanceInput: unknown) {
  const instance = asRecord(instanceInput);
  return Boolean(firstNonBlankString(
    instance.bonus_offer_email_sent_at,
    instance.report_email_teaser_sent_at,
    instance.email_sent_at
  ));
}

function bonusOfferMaxBonusDollars(instanceInput: unknown) {
  const rawTiers = asRecord(instanceInput).tiers;
  const tiers: unknown[] = Array.isArray(rawTiers) ? rawTiers : [];
  return tiers.reduce<number>((max, tierInput) => {
    const tier = asRecord(tierInput);
    return Math.max(max, moneyAmount(tier.bonus_dollars ?? tier.bonus));
  }, 0);
}

async function bonusOfferEmailTeaserForProject(manifest: ProjectManifest): Promise<BonusOfferEmailTeaser | false> {
  const orgId = await resolvePortalOrganizationIdForProject(manifest);
  if (!orgId) return false;
  const flagEnabled = await isAppFlagEnabled(orgId, "firstmeasure", "bonus_upfront_match").catch(() => false);
  if (!flagEnabled) return false;
  const global = await readGlobal(orgId).catch(() => null);
  const instances = Object.values(asRecord(asRecord(global?.data).bonus_offer_instances))
    .map((entry) => asRecord(entry))
    .filter((instance) => {
      if (firstNonBlankString(instance.offer_id || "bonus_upfront_match_v1") !== "bonus_upfront_match_v1") return false;
      if (!firstNonBlankString(instance.id)) return false;
      if (bonusOfferEmailAlreadySent(instance)) return false;
      const status = bonusOfferCampaignStatus(instance);
      if (status !== "available" && status !== "viewed") return false;
      return bonusOfferMaxBonusDollars(instance) > 0;
    })
    .sort((a, b) => {
      const aStart = parseDateLikeTimestamp(a.starts_at || a.scheduled_at || a.created_at);
      const bStart = parseDateLikeTimestamp(b.starts_at || b.scheduled_at || b.created_at);
      return bStart - aStart || firstNonBlankString(b.id).localeCompare(firstNonBlankString(a.id));
    });
  const instance = instances[0];
  if (!instance) return false;
  return {
    org_id: orgId,
    instance_id: firstNonBlankString(instance.id),
    rollout_id: firstNonBlankString(instance.rollout_id),
    max_bonus_dollars: bonusOfferMaxBonusDollars(instance)
  };
}

async function markBonusOfferEmailSent(teaser: BonusOfferEmailTeaser, sentAt: string, projectId: string) {
  if (!teaser.org_id || !teaser.instance_id) return;
  const global = await readGlobal(teaser.org_id);
  const data = asRecord(global.data);
  const instances = asRecord(data.bonus_offer_instances);
  const instance = asRecord(instances[teaser.instance_id]);
  if (!firstNonBlankString(instance.id) || bonusOfferEmailAlreadySent(instance)) return;
  await saveGlobal(teaser.org_id, {
    data: {
      bonus_offer_instances: {
        ...instances,
        [teaser.instance_id]: {
          ...instance,
          bonus_offer_email_sent_at: sentAt,
          report_email_teaser_sent_at: sentAt,
          report_email_teaser_project_id: projectId,
          updated_at: sentAt
        }
      }
    }
  });
}

function formatEmailMoney(value: unknown) {
  return `$${Math.max(0, Math.round(moneyAmount(value))).toLocaleString("en-US")}`;
}

function buildReportEmailTextBody(
  address: string,
  bonusOfferTeaser: BonusOfferEmailTeaser | false,
  options: { reworkDelivery?: Record<string, unknown> | null } = {}
) {
  if (options.reworkDelivery) {
    const label = String(options.reworkDelivery.label ?? "rework request");
    return [
      "Your corrected roof report is ready.",
      `We finalized the ${label.toLowerCase()} for this project and attached the corrected report PDFs.`,
      `Address: ${address}`,
      `Order another report: ${APP_ORDER_REPORT_URL}`
    ].join("\n\n");
  }

  const sections = [
    bonusOfferTeaser
      ? [
          `Limited time offer: get up to ${formatEmailMoney(bonusOfferTeaser.max_bonus_dollars)} in free credits`,
          `Claim your offer: ${APP_ORDER_REPORT_URL}`
        ].join("\n")
      : null,
    "Your roof report is ready!",
    `Address: ${address}`,
    `Order another report: ${APP_ORDER_REPORT_URL}`
  ].filter((section): section is string => Boolean(section));

  return sections.join("\n\n");
}

function buildReportEmailHtmlBody(
  address: string,
  bonusOfferTeaser: BonusOfferEmailTeaser | false,
  options: { reworkDelivery?: Record<string, unknown> | null } = {}
) {
  if (options.reworkDelivery) {
    const label = String(options.reworkDelivery.label ?? "rework request").toLowerCase();
    return [
      "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;font-weight:700;\">Your corrected roof report is ready.</p>",
      `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;">We finalized the ${escapeHtml(label)} for this project and attached the corrected report PDFs.</p>`,
      `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;"><strong>Address:</strong> ${escapeHtml(address)}</p>`,
      `<p style="margin:20px 0 32px;"><a href="${APP_ORDER_REPORT_URL}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#db0000;color:#ffffff;text-decoration:none;font-weight:700;">Order another report</a></p>`
    ].join("");
  }

  const bonusBanner = bonusOfferTeaser
    ? [
        "<div style=\"display:inline-block;margin:0 0 18px;\">",
        "<div style=\"display:inline-block;padding:16px 18px;border-radius:16px;background:linear-gradient(135deg,#db0000 0%,#7a1010 100%);color:#ffffff;\">",
        "<div style=\"font-size:11px;font-weight:800;letter-spacing:0.12em;text-transform:uppercase;opacity:0.84;\">Limited Time Offer</div>",
        `<div style="margin-top:8px;font-size:24px;line-height:1.25;font-weight:800;white-space:nowrap;">Get up to ${formatEmailMoney(bonusOfferTeaser.max_bonus_dollars)} in free credits</div>`,
        `<div style="margin-top:14px;"><a href="${APP_ORDER_REPORT_URL}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#ffffff;color:#b10000;text-decoration:none;font-weight:800;">Claim offer</a></div>`,
        "</div>",
        "</div>"
      ].join("")
    : "";

  return [
    bonusBanner,
    "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;font-weight:700;\">Your roof report is ready!</p>",
    `<p style="margin:0 0 14px;font-size:17px;line-height:1.45;"><strong>Address:</strong> ${escapeHtml(address)}</p>`,
    `<p style="margin:20px 0 32px;"><a href="${APP_ORDER_REPORT_URL}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#db0000;color:#ffffff;text-decoration:none;font-weight:700;">Order another report</a></p>`
  ].join("");
}

function projectTypeLabelForCustomer(value: unknown) {
  const type = String(value ?? "residential").trim().toLowerCase().replace(/_/g, "-");
  if (type === "multi-family" || type === "multifamily") return "multi-family";
  if (type === "commercial") return "commercial";
  return "residential";
}

function normalizeStructureReorderProjectType(value: unknown) {
  const type = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-");
  if (type === "multi-family" || type === "multifamily") return "multifamily";
  if (type === "commercial") return "commercial";
  return "";
}

function buildStructureTypeReorderPayload(
  projectId: string,
  project: Record<string, unknown>,
  correctProjectType: "commercial" | "multifamily"
): StructureTypeReorderPayload {
  const prefillKeys = [
    "address",
    "lat",
    "lng",
    "pins",
    "radius_meters",
    "report_mode",
    "include_gutter_measurements",
    "report_expedite_option",
    "cc_emails",
    "branding_defaults",
    "metadata"
  ];
  const prefill: Record<string, unknown> = {
    source_project_id: projectId,
    project_type: correctProjectType
  };
  for (const key of prefillKeys) {
    if (project[key] !== undefined && project[key] !== null && project[key] !== "") {
      prefill[key] = project[key];
    }
  }

  const url = new URL(APP_ORDER_REPORT_URL);
  url.searchParams.set("reorder_project_id", projectId);
  url.searchParams.set("source_project_id", projectId);
  url.searchParams.set("project_type", correctProjectType);
  url.searchParams.set("prefill", "previous_order");
  url.searchParams.set("prefill_data", JSON.stringify(prefill));
  if (typeof prefill.address === "string" && prefill.address.trim() !== "") {
    url.searchParams.set("address", prefill.address.trim());
  }
  for (const key of ["lat", "lng", "report_mode", "include_gutter_measurements", "report_expedite_option"]) {
    if (prefill[key] !== undefined && prefill[key] !== null && prefill[key] !== "") {
      url.searchParams.set(key, String(prefill[key]));
    }
  }

  return {
    correctProjectType,
    correctProjectTypeLabel: projectTypeLabelForCustomer(correctProjectType),
    url: url.toString(),
    prefill
  };
}

function buildRejectionMessageParagraphs(project: Record<string, unknown>) {
  const instantMiss = String(project.instant_rejection_reason ?? "").trim().toLowerCase() === "no_structure_at_pin";
  if (instantMiss) {
    return [
      "We could not generate a FirstMeasure Instant for this pin because the selected point did not land on a structure with accurate instant data. We currently have about 90% coverage across the US for instant reports, but there are still some places where we do not have accurate enough data for this product.",
      "Note: This only affects the instant report for this pinned structure. You can still order a standard full report for this property below."
    ];
  }

  const noCoverage = [
    "We do not currently have coverage for this address. We currently cover 95% of all buildings in the United States and we are actively working on increasing our area to cover more of the remaining buildings. We've logged your interest in structures like this and will prioritize being able to cover these in the near future. We apologize for any inconvenience this may have caused.",
    "Note: Our coverage is based on individual structure, not area - so we may have coverage for other properties in this same neighborhood."
  ];

  const rejectionReason = String(project.rejection_reason ?? "").trim().toLowerCase();
  if (rejectionReason === "obscured_visibility") {
    return [
      "We were not able to complete this report because the structure is too obscured in the available imagery. This can happen when trees, shadows, image quality, or other visual obstructions prevent us from confidently identifying and measuring the roof.",
      "We apologize for any inconvenience this may have caused."
    ];
  }
  if (rejectionReason === "invalid_pin_placement") {
    return [
      "We were not able to complete this report because the selected pin does not appear to be placed on a structure we can measure. This can happen if the pin is on a yard, driveway, nearby object, or a structure that does not have enough usable imagery for accurate measurement.",
      "We apologize for any inconvenience this may have caused."
    ];
  }
  if (rejectionReason === "incorrect_structure_type") {
    const projectType = projectTypeLabelForCustomer(project.project_type);
    const correctProjectType = normalizeStructureReorderProjectType(
      project.correct_project_type
      ?? project.rejection_correct_project_type
      ?? asRecord(project.rejection_reorder).project_type
    );
    const correctProjectTypeLabel = correctProjectType
      ? projectTypeLabelForCustomer(correctProjectType)
      : "the correct";
    return [
      `We were not able to complete this report because the selected structure does not match the project type that was ordered. This order was submitted as a ${projectType} project, but it appears to require a ${correctProjectTypeLabel} report.`,
      `We have reimbursed you for the original report. You can reorder this project as ${correctProjectTypeLabel} using the link below.`
    ];
  }
  if (rejectionReason === "api_insufficient_credits") {
    return [
      String(project.rejection_message ?? "").trim()
        || "We were not able to complete this API report because your organization did not have enough credits for the additional structures on the parcel, and Auto Top-Up was not able to complete.",
      "No additional structure-pin billing was kept for this rejected report."
    ];
  }

  return noCoverage;
}

function buildRejectionRefundText(project: Record<string, unknown>) {
  const amount = Number(project.refund_amount ?? 0);
  if (Boolean(project.refund_issued) && Number.isFinite(amount) && amount > 0) {
    return `A credit of $${Math.round(amount)} has been refunded to your account for this order.`;
  }
  if (Boolean(project.refund_pending)) {
    return "We are returning a credit for this order.";
  }
  return "";
}

function buildRejectionEmailTextBody(project: Record<string, unknown>) {
  const address = String(project.address ?? "Unknown");
  const refundText = buildRejectionRefundText(project);
  const reorderUrl = String(project.reorder_url ?? asRecord(project.rejection_reorder).url ?? "").trim();
  return [
    "Unable to complete roof report",
    `Address: ${address}`,
    "",
    ...buildRejectionMessageParagraphs(project),
    reorderUrl ? `Reorder this project: ${reorderUrl}` : "",
    refundText
  ].filter((section) => String(section).trim() !== "").join("\n\n");
}

function buildRejectionEmailHtmlBody(project: Record<string, unknown>) {
  const address = String(project.address ?? "Unknown");
  const refundText = buildRejectionRefundText(project);
  const reorderUrl = String(project.reorder_url ?? asRecord(project.rejection_reorder).url ?? "").trim();
  const reorderProjectType = normalizeStructureReorderProjectType(
    project.correct_project_type
    ?? project.rejection_correct_project_type
    ?? asRecord(project.rejection_reorder).project_type
  );
  const reorderLabel = reorderProjectType
    ? `Reorder as ${projectTypeLabelForCustomer(reorderProjectType)}`
    : "Reorder this project";
  const paragraphs = buildRejectionMessageParagraphs(project)
    .map((paragraph) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;">${escapeHtml(paragraph)}</p>`)
    .join("");
  const refundHtml = refundText
    ? `<div style="margin:16px 0 0;padding:10px 14px;background:#fce8e6;border:1px solid #f4b4ae;border-radius:8px;color:#7a1b18;font-weight:600;">${escapeHtml(refundText)}</div>`
    : "";
  const reorderHtml = reorderUrl
    ? `<p style="margin:20px 0 16px;"><a href="${escapeHtml(reorderUrl)}" style="display:inline-block;padding:11px 16px;border-radius:10px;background:#db0000;color:#ffffff;text-decoration:none;font-weight:700;">${escapeHtml(reorderLabel)}</a></p>`
    : "";
  return [
    "<p style=\"margin:0 0 14px;font-size:17px;line-height:1.45;font-weight:700;\">Unable to complete roof report</p>",
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.5;"><strong>Address:</strong> ${escapeHtml(address)}</p>`,
    paragraphs,
    reorderHtml,
    refundHtml
  ].join("");
}

function wrapEmailText(text: string) {
  if (text.includes("\n--\nThe FirstMeasure Team")) return text;
  return `${text}\n\n--\nThe FirstMeasure Team\n1m8.ai`;
}

function wrapEmailHtml(html: string) {
  if (html.includes("The FirstMeasure Team")) return html;
  return `${html}<hr><div style="font-size:12px;color:#777;">The FirstMeasure Team<br><a href="https://1m8.ai">1m8.ai</a></div>`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toSqlDateString(date: Date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const REVIEW_SUBMISSION_STATUSES = new Set(["awaiting_review", "awaiting_manager_review"]);
const TECH_EDITOR_PRESENCE_WINDOW_MS = 60_000;
// Queue pages refresh activity every 30 seconds. Four polling intervals gives
// active technicians enough tolerance for a delayed request without treating a
// long-closed browser session as online.
const TECH_RECENT_ACTIVITY_WINDOW_MS = 2 * 60_000;
const ONLINE_TIMESTAMP_CLOCK_SKEW_MS = 60_000;
const API_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_USERS_DIR_CANDIDATES = [
  path.resolve(process.cwd(), "../measure/internal/users"),
  path.resolve(process.cwd(), "./measure/internal/users"),
  path.resolve(API_MODULE_DIR, "../../measure/internal/users"),
  path.resolve(API_MODULE_DIR, "../../../measure/internal/users")
];
const INTERNAL_USERS_DIR = INTERNAL_USERS_DIR_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? path.resolve(process.cwd(), "../measure/internal/users");
const INTERNAL_ROOT_CANDIDATES = [
  path.resolve(process.cwd(), "../measure/internal"),
  path.resolve(process.cwd(), "./measure/internal"),
  path.resolve(API_MODULE_DIR, "../../measure/internal"),
  path.resolve(API_MODULE_DIR, "../../../measure/internal")
];
const INTERNAL_ROOT_DIR = INTERNAL_ROOT_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? path.resolve(process.cwd(), "../measure/internal");
const REJECTION_REASONS_CONFIG_PATH = path.join(INTERNAL_ROOT_DIR, "config", "rejection_reasons.json");
const INTERNAL_ORGANIZATIONS_DIR = process.env.FIRSTMEASURE_ORGANIZATION_STORAGE_DIR
  ? path.resolve(process.env.FIRSTMEASURE_ORGANIZATION_STORAGE_DIR)
  : path.join(INTERNAL_ROOT_DIR, "storage", "organizations");

type RejectionReasonConfigEntry = {
  id?: unknown;
  label?: unknown;
  icon?: unknown;
};

const DEFAULT_REJECTION_REASONS = [
  { id: "no_height_map", label: "No height map", icon: "fas fa-mountain" },
  { id: "no_satellite_image", label: "No satellite image", icon: "fas fa-satellite" },
  { id: "obscured_visibility", label: "Obscured visibility", icon: "fas fa-cloud" },
  { id: "invalid_pin_placement", label: "Invalid pin placement", icon: "fas fa-map-pin" },
  { id: "incorrect_structure_type", label: "Incorrect Structure Type", icon: "fas fa-building" }
];

let rejectionReasonsCache: Array<{ id: string; label: string; icon: string }> | null = null;

function normalizeRejectionReasonId(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function getRejectionReasons() {
  if (rejectionReasonsCache) return rejectionReasonsCache;

  let source: RejectionReasonConfigEntry[] = DEFAULT_REJECTION_REASONS;
  try {
    const raw = await readFile(REJECTION_REASONS_CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) source = parsed as RejectionReasonConfigEntry[];
  } catch {
    source = DEFAULT_REJECTION_REASONS;
  }

  const seen = new Set<string>();
  const normalized: Array<{ id: string; label: string; icon: string }> = [];
  for (const entry of source) {
    const id = normalizeRejectionReasonId(entry?.id);
    const label = String(entry?.label ?? "").trim();
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      label,
      icon: String(entry?.icon ?? "fas fa-circle-exclamation").trim() || "fas fa-circle-exclamation"
    });
  }

  rejectionReasonsCache = normalized.length > 0 ? normalized : DEFAULT_REJECTION_REASONS;
  return rejectionReasonsCache;
}

async function resolveRejectionReasonId(value: unknown) {
  const candidate = normalizeRejectionReasonId(value);
  const reasons = await getRejectionReasons();
  for (const reason of reasons) {
    if (candidate === reason.id || candidate === normalizeRejectionReasonId(reason.label)) {
      return reason.id;
    }
  }
  throw badRequest("invalid_rejection_reason", "A valid rejection reason is required.");
}

const IMMUTABLE_TERMINAL_PROJECT_STATUSES = new Set([
  "completed",
  "rejected",
  "rejected_no_coverage",
  "cancelled"
]);

function isReviewSubmissionStatus(status: unknown) {
  return REVIEW_SUBMISSION_STATUSES.has(String(status ?? "").trim().toLowerCase());
}

function projectHasTechnicianCorrection(workHistory: Array<Record<string, unknown>>) {
  return workHistory.some((entry) => {
    const event = String(entry.event ?? "").trim().toLowerCase();
    return event === "qa_sent_back_to_tech"
      || event === "manager_sent_back_to_tech"
      || event === "qa_rejected"
      || event === "manager_rejected"
      || event === "correction_submitted";
  });
}

async function buildRushBonusPatchForSubmission(
  currentStatus: string,
  workHistory: Array<Record<string, unknown>>,
  nowIso: string
) {
  if (["correction_needed", "requeue"].includes(currentStatus)) return {};
  if (projectHasTechnicianCorrection(workHistory)) return {};
  const rush = await getCurrentRushMode();
  const mode = rush.rush_mode;
  if (!rush.active || !mode) return {};
  return {
    rush_bonus_tag: true,
    rush_bonus_eligible: true,
    rush_bonus_percent: RUSH_BONUS_PERCENT,
    rush_bonus_mode_id: mode.id,
    rush_bonus_tagged_at: nowIso,
    rush_bonus_start_at: mode.start_at,
    rush_bonus_end_at: mode.end_at
  };
}

function rushBonusRemovalPatch(reason: string, nowSql: string) {
  return {
    rush_bonus_tag: false,
    rush_bonus_eligible: false,
    rush_bonus_removed_at: nowSql,
    rush_bonus_removed_reason: reason
  };
}

export async function updateStatusForSubmission(projectId: string, requestedStatus: string) {
  const manifest = await readManifest(projectId);
  const currentStatus = String(manifest.status ?? "").trim().toLowerCase();
  if (IMMUTABLE_TERMINAL_PROJECT_STATUSES.has(currentStatus)) {
    return manifest;
  }
  const normalizedRequested = String(requestedStatus ?? "").trim().toLowerCase();
  const nextStatus = REVIEW_SUBMISSION_STATUSES.has(currentStatus) && REVIEW_SUBMISSION_STATUSES.has(normalizedRequested)
    ? currentStatus
    : normalizedRequested;
  if (REVIEW_SUBMISSION_STATUSES.has(nextStatus) && !REVIEW_SUBMISSION_STATUSES.has(currentStatus)) {
    const nowIso = new Date().toISOString();
    const workflow = asRecord(manifest.workflow);
    const workHistory = mergeLegacyHistoryEntries(
      (manifest as Record<string, unknown>).work_history,
      workflow.work_history,
      workflow.history
    );
    const lastEvent = asRecord(workHistory[workHistory.length - 1]);
    const lastEventName = String(lastEvent.event ?? "").trim().toLowerCase();
    const lastEventTs = Date.parse(String(lastEvent.ts ?? ""));
    const alreadyRecorded = ["submitted_for_qa", "correction_submitted"].includes(lastEventName)
      && Number.isFinite(lastEventTs)
      && Math.abs(Date.parse(nowIso) - lastEventTs) < 10_000;
    const rushBonusPatch = await buildRushBonusPatchForSubmission(currentStatus, workHistory, nowIso);
    const customerReworkPatch = buildCustomerReworkSubmittedToQaPatch(manifest, nowIso);
    const isCustomerReworkSubmission = Object.keys(customerReworkPatch).length > 0;
    if (!alreadyRecorded) {
      workHistory.push({
        ts: nowIso,
        event: "submitted_for_qa"
      });
    }
    if (isCustomerReworkSubmission) {
      const requestId = String(customerReworkPatch.customer_rework_request_id ?? "").trim();
      const hasReworkEvent = workHistory.some((entry) => {
        const item = asRecord(entry);
        return String(item.event ?? "").trim().toLowerCase() === "customer_rework_submitted_for_qa"
          && String(item.request_id ?? "").trim() === requestId;
      });
      if (!hasReworkEvent) {
        workHistory.push({
          ts: nowIso,
          event: "customer_rework_submitted_for_qa",
          request_id: customerReworkPatch.customer_rework_request_id ?? null,
          request_type: customerReworkPatch.customer_rework_request_type ?? null,
          request_label: customerReworkPatch.customer_rework_request_label ?? null
        });
      }
    }
    if (!alreadyRecorded || Object.keys(rushBonusPatch).length > 0 || isCustomerReworkSubmission) {
      const nowSql = toSqlDateString(new Date());
      return patchManifest(projectId, {
        ...rushBonusPatch,
        ...customerReworkPatch,
        status: nextStatus,
        timestamps: {
          uploaded_at: nowSql,
          updated_at: nowSql
        },
        work_history: workHistory,
        workflow: {
          ...workflow,
          work_history: workHistory
        }
      });
    }
  }
  return updateStatus(projectId, nextStatus);
}

function resolveOriginalTechnician(legacy: Record<string, unknown>, workflow: Record<string, unknown>) {
  const workHistory = mergeLegacyHistoryEntries(
    legacy.work_history,
    workflow.work_history,
    workflow.history
  );
  return deriveProjectTechnicianRef(null, legacy, workflow, workHistory);
}

function isProjectEditorOnlineForTech(manifest: Record<string, unknown>, techEmail: string) {
  if (!techEmail) return false;
  const editorPresence = asRecord(manifest.editor_presence);
  const presenceEmail = String(editorPresence.email ?? "").trim().toLowerCase();
  const presenceAt = Date.parse(String(editorPresence.at ?? ""));
  const presenceAge = Date.now() - presenceAt;
  return presenceEmail === techEmail
    && Number.isFinite(presenceAt)
    && presenceAge >= -ONLINE_TIMESTAMP_CLOCK_SKEW_MS
    && presenceAge <= TECH_EDITOR_PRESENCE_WINDOW_MS;
}

async function readPortalUserByEmail(email?: string) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return null;
  try {
    const user = await readInternalUser(normalizedEmail);
    if (user) return asRecord(user);
  } catch {
    // Fall through to the legacy file lookup below.
  }
  try {
    const legacyFileName = `${normalizedEmail.replace(/[^a-z0-9@._+-]/g, "_")}.json`;
    const raw = await readFile(path.join(INTERNAL_USERS_DIR, legacyFileName), "utf8");
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

type QaRankedProject = {
  manifest: ProjectManifest;
  rank: Awaited<ReturnType<typeof buildQaRankMeta>>;
};

type DrafterRank = "junior" | "standard" | "senior";

function normalizeDrafterRank(value: unknown): DrafterRank {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "senior") return "senior";
  if (raw === "standard" || raw === "mid" || raw === "intermediate") return "standard";
  return "junior";
}

function normalizeDrafterRankMap(value: unknown) {
  const out = new Map<string, DrafterRank>();
  const record = asRecord(value);
  for (const [email, rank] of Object.entries(record)) {
    const key = String(email ?? "").trim().toLowerCase();
    if (!key) continue;
    out.set(key, normalizeDrafterRank(rank));
  }
  return out;
}

function qaClaimEmail(manifest: ProjectManifest) {
  const workflow = asRecord(manifest.workflow);
  const qaClaim = asRecord(workflow.qa_claim);
  return String((manifest as Record<string, unknown>).qa_claimed_by_email ?? qaClaim.email ?? "").trim().toLowerCase();
}

function resolveCorrectionReturnQa(legacy: Record<string, unknown>) {
  const explicitEmail = String(
    legacy.qa_return_to_email
    ?? legacy.correction_requested_by
    ?? ""
  ).trim().toLowerCase();
  const explicitName = String(legacy.qa_return_to_name ?? "").trim();
  if (explicitEmail) return { email: explicitEmail, name: explicitName || explicitEmail };

  const qaHistory = Array.isArray(legacy.qa_history) ? legacy.qa_history : [];
  for (let index = qaHistory.length - 1; index >= 0; index -= 1) {
    const entry = asRecord(qaHistory[index]);
    if (String(entry.decision ?? "").trim().toLowerCase() !== "rejected") continue;
    const email = String(entry.qa_email ?? "").trim().toLowerCase();
    if (!email) continue;
    return {
      email,
      name: String(entry.qa_name ?? email).trim() || email
    };
  }
  return { email: "", name: "" };
}

function qaClaimedAt(manifest: ProjectManifest) {
  const workflow = asRecord(manifest.workflow);
  const qaClaim = asRecord(workflow.qa_claim);
  return String((manifest as Record<string, unknown>).qa_claimed_at ?? qaClaim.claimed_at ?? "").trim();
}

function qaCorrectionReturnHoldExpiresAt(manifest: ProjectManifest) {
  const workflow = asRecord(manifest.workflow);
  const qaClaim = asRecord(workflow.qa_claim);
  return String(
    (manifest as Record<string, unknown>).qa_return_hold_expires_at
    ?? qaClaim.hold_expires_at
    ?? ""
  ).trim();
}

function isQaCorrectionReturn(manifest: ProjectManifest) {
  const legacy = buildLegacyManifest(manifest);
  const workflow = asRecord(manifest.workflow);
  const qaClaim = asRecord(workflow.qa_claim);
  return String(qaClaim.claim_reason ?? "").trim().toLowerCase() === "correction_return"
    || (
      String(legacy.qa_return_to_email ?? "").trim() !== ""
      && String(legacy.qa_return_submitted_at ?? "").trim() !== ""
      && String(legacy.qa_return_hold_expires_at ?? "").trim() !== ""
    );
}

function isQaCorrectionReturnHoldExpired(manifest: ProjectManifest) {
  if (!isQaCorrectionReturn(manifest)) return false;
  const expiresAt = Date.parse(qaCorrectionReturnHoldExpiresAt(manifest));
  return Number.isFinite(expiresAt) && Date.now() >= expiresAt;
}

async function isQaClaimStale(email: string, claimedAt?: unknown, manifest?: ProjectManifest) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return false;
  // A correction-return hold is the ownership boundary. Once it expires, the
  // item must be claimable even if the former reviewer is otherwise active.
  if (manifest && isQaCorrectionReturnHoldExpired(manifest)) return true;
  const user = await readPortalUserByEmail(normalizedEmail);
  // General portal activity is not proof that somebody is still in a QA
  // session. Only the QA bootstrap/heartbeat/queue endpoints update this
  // field. The claim timestamp below remains a grace period for fresh and
  // legacy claims whose owner has no QA activity record yet.
  const qaHeartbeat = user?.last_qa_heartbeat_at ?? null;
  const qaActivity = user?.last_qa_activity_at ?? null;
  if (
    isTimestampWithinWindow(qaHeartbeat, QA_SESSION_IDLE_RELEASE_MS)
    || isTimestampWithinWindow(qaActivity, QA_SESSION_IDLE_RELEASE_MS)
  ) return false;

  const claimTs = Date.parse(String(claimedAt ?? ""));
  if (Number.isFinite(claimTs) && Date.now() - claimTs <= QA_SESSION_IDLE_RELEASE_MS) return false;
  return true;
}

async function renewQaClaimForActor(
  projectId: string,
  actor: ReturnType<typeof normalizeOptionalPortalActor>
) {
  const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
  if (!projectId || !actorEmail) return false;
  return withQaProjectClaimLock(projectId, async () => {
    const manifest = await readManifest(projectId).catch(() => null);
    if (!manifest || !["awaiting_review", "submission_failed"].includes(String(manifest.status ?? "").trim().toLowerCase())) {
      return false;
    }
    if (qaClaimEmail(manifest) !== actorEmail) return false;
    // Claim age and session liveness are separate concerns. The heartbeat has
    // already refreshed the actor's last_qa_activity_at via
    // touchPortalUserActivity(). Rewriting claimed_at here resets the dashboard
    // timer on every heartbeat and lets multiple tabs continually move its
    // origin, as well as creating a manifest revision every two minutes.
    return true;
  });
}

async function readQaQueueVersion() {
  if (isFirstMeasurePostgresEnabled()) {
    return (await import("./project_index_postgres.js")).readPostgresQueueVersion();
  }
  const db = getFirstMeasureProjectIndexDb();
  const row = db.prepare(`
    SELECT MAX(version) AS version
    FROM project_queue_events
  `).get() as { version?: number } | undefined;
  return Number(row?.version ?? 0);
}

function startQaStaleClaimProcessor(app: FastifyInstance) {
  if (!shouldRunFirstMeasureBackgroundProcessor()) return;
  if (qaStaleClaimSweepTimer) return;
  const run = () => {
    if (qaStaleClaimSweepInFlight) return;
    qaStaleClaimSweepInFlight = true;
    void releaseStaleQaClaims("background_sweep")
      .catch((error) => {
        app.log.error({ err: error }, "Failed to release stale QA claims");
      })
      .finally(() => {
        qaStaleClaimSweepInFlight = false;
      });
  };
  qaStaleClaimSweepTimer = setInterval(run, QA_STALE_CLAIM_SWEEP_MS);
  qaStaleClaimSweepTimer.unref?.();
  run();
}

async function listAwaitingReviewManifests(teamId?: string | null) {
  return queryIndexedQaCandidateManifests({
    team_id: teamId || undefined,
    limit: 20_000
  });
}

async function reconcileQaClaimIndex(manifest: ProjectManifest) {
  try {
    await upsertProjectIndex(manifest, {
      storagePath: projectDir(manifest.id)
    });
    clearQaClaimCaches();
  } catch (error) {
    // Claim enforcement must remain available even if this best-effort repair
    // encounters a transient index error.
    console.error(`Failed to reconcile QA claim index for '${manifest.id}'.`, error);
  }
}

async function releaseQaClaimsForActor(
  email: string,
  actor: ReturnType<typeof normalizeOptionalPortalActor>,
  reason: string,
  projectIds: string[] | null = null
) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return 0;
  if (projectIds) {
    const uniqueIds = Array.from(new Set(projectIds.map((id) => String(id ?? "").trim()).filter(Boolean))).slice(0, 100);
    let released = 0;
    for (const projectId of uniqueIds) {
      const didRelease = await withQaProjectClaimLock(projectId, async () => {
        const manifest = await readManifest(projectId).catch(() => null);
        if (!manifest || qaClaimEmail(manifest) !== normalizedEmail) return false;
        await releaseQaClaimOnManifest(manifest, actor, reason);
        return true;
      });
      if (didRelease) released += 1;
    }
    if (released > 0) qaTechQueueCache.clear();
    return released;
  }
  const manifests = await listQaClaimedManifestsForActor(normalizedEmail, null, 100);
  let released = 0;
  for (const manifest of manifests) {
    await releaseQaClaimOnManifest(manifest, actor, reason);
    released += 1;
  }
  if (released > 0) qaTechQueueCache.clear();
  return released;
}

async function releaseStaleQaClaims(reason: string, exemptEmails: string[] = []) {
  const exempt = new Set(exemptEmails.map((email) => String(email ?? "").trim().toLowerCase()).filter(Boolean));
  const manifests = await listAwaitingReviewManifests();
  let released = 0;
  for (const manifest of manifests) {
    const email = qaClaimEmail(manifest);
    if (!email) continue;
    if (exempt.has(email)) continue;
    if (!(await isQaClaimStale(email, qaClaimedAt(manifest), manifest))) continue;
    await releaseQaClaimOnManifest(manifest, null, reason);
    released += 1;
  }
  if (released > 0) qaTechQueueCache.clear();
  return released;
}

async function releaseQaClaimOnManifest(
  manifest: ProjectManifest,
  actor: ReturnType<typeof normalizeOptionalPortalActor>,
  reason: string
) {
  const legacy = buildLegacyManifest(manifest);
  const workflow = asRecord(manifest.workflow);
  const previous = qaClaimEmail(manifest);
  const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
  workHistory.push({
    ts: new Date().toISOString(),
    event: "qa_claim_released",
    previous_claimer: previous || null,
    released_by: actor?.email ?? null,
    reason
  });
  const released = await patchManifest(manifest.id, {
    qa_claimed_by_email: null,
    qa_claimed_by_name: null,
    qa_claimed_at: null,
    qa_available: true,
    qa_availability_reason: null,
    hidden_from_queue: false,
    work_history: workHistory,
    workflow: {
      ...workflow,
      qa_claim: null
    }
  }, { backup: false });
  clearQaClaimCaches();
  return released;
}

async function withQaProjectClaimLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const key = String(projectId ?? "").trim().toLowerCase();
  const previous = qaProjectClaimLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current, () => current);
  qaProjectClaimLocks.set(key, tail);
  await previous.catch(() => undefined);
  const releaseSharedLock = await acquireFirstMeasureLock(`qa-claim:${key}`, {
    ttlMs: 60_000,
    waitMs: 15_000,
    retryMs: 25,
    owner: `${process.pid}:qa:${key}`
  });
  try {
    return await fn();
  } finally {
    await releaseSharedLock().catch(() => undefined);
    release();
    if (qaProjectClaimLocks.get(key) === tail) {
      qaProjectClaimLocks.delete(key);
    }
  }
}

async function listQaClaimedManifestsForActor(email: string, teamId?: string | null, limit = 10) {
  await ensureFirstMeasureProjectIndexReady();
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return [];
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 10)));
  if (isFirstMeasurePostgresEnabled()) {
    const values: unknown[] = [normalizedEmail];
    const teamWhere = teamId ? ` AND team_id = $${values.push(String(teamId).trim())}` : "";
    values.push(cappedLimit);
    const rows = await (await import("./project_index_postgres.js")).queryPostgresRows<{
      manifest_json: ProjectManifest;
    }>(`
      SELECT manifest_json
      FROM projects
      WHERE status IN ('awaiting_review', 'submission_failed')
        AND qa_claimed_by_email = $1${teamWhere}
      ORDER BY updated_at_ms DESC, id DESC
      LIMIT $${values.length}
    `, values);
    return rows.map((row) => row.manifest_json).filter(Boolean);
  }
  const db = getFirstMeasureProjectIndexDb();
  const params: Record<string, string | number> = {
    email: normalizedEmail,
    limit: cappedLimit
  };
  const where = [
    "status IN ('awaiting_review', 'submission_failed')",
    "qa_claimed_by_email = $email"
  ];
  if (teamId) {
    where.push("team_id = $teamId");
    params.teamId = String(teamId).trim();
  }
  const rows = db.prepare(`
    SELECT manifest_json
    FROM projects
    WHERE ${where.join(" AND ")}
    ORDER BY updated_at_ms DESC, id DESC
    LIMIT $limit
  `).all(params) as Array<{ manifest_json?: string }>;
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

async function countQaReviewedTodayByActor(email: string, teamId?: string | null) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return 0;
  const start = managementDayBounds().startMs;
  const bucket = await queryIndexedQueueBucket({
    group: "completed",
    team_id: teamId || undefined,
    limit: 5000,
    offset: 0,
    activityStartMs: start,
    activityEndMs: Date.now(),
    activityFields: ["completed"]
  });
  let count = 0;
  for (const row of bucket.rows) {
    const legacy = buildLegacyManifest(row.manifest);
    const reviewer = String(
      legacy.qa_reviewed_by_email
      ?? legacy.qa_reviewed_by
      ?? legacy.qa_approved_by_email
      ?? legacy.qa_approved_by
      ?? ""
    ).trim().toLowerCase();
    if (reviewer === normalizedEmail) count += 1;
  }
  return count;
}

async function buildQaTechnicianStatus(
  actor: ReturnType<typeof normalizeOptionalPortalActor>,
  teamId: string | null,
  request: { headers: Record<string, unknown>; protocol?: string }
) {
  const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
  const [claimedManifests, leaderboardToday, counts] = await Promise.all([
    listQaClaimedManifestsForActor(actorEmail, teamId, 8),
    loadQaShiftLeaderboard(qaShiftDateKey(), teamId),
    getIndexedQueueCounts({ team_id: teamId || undefined })
  ]);
  const claimedProjects = await Promise.all(
    claimedManifests.map(async (manifest) => buildProjectListViewRow(manifest, request, "card"))
  );
  const myShiftRow = leaderboardToday.leaderboard.find((row) => row.email === actorEmail);
  const hasAvailableNext = (counts.groups.qa_waiting ?? 0) > 0 || claimedProjects.length > 0;
  return {
    can_manage_queue: false,
    can_do_qa: true,
    can_manager_review: false,
    pending: claimedProjects,
    claimed_projects: claimedProjects,
    history: [],
    manager: [],
    manager_history: [],
    stats: {
      claimed_count: claimedProjects.length,
      reviewed_today_count: myShiftRow?.approved_count ?? 0,
      qa_rates_today: [],
      qa_leaderboard_today: leaderboardToday,
      preferred_project_id: "",
      preferred_project_address: "",
      preferred_project_available: false,
      next_candidate_id: hasAvailableNext ? "__server_pull__" : null,
      next_candidate_address: null,
      has_available_next: hasAvailableNext,
      queue_counts: counts.groups
    },
    manual_top_ids: [],
    team: teamId || "all",
    source: "qa_me_status"
  };
}

function qaClaimEmailFromLegacyRow(row: Record<string, unknown>) {
  const workflow = asRecord(row.workflow);
  const claim = asRecord(workflow.qa_claim);
  return String(row.qa_claimed_by_email ?? claim.email ?? "").trim().toLowerCase();
}

function qaClaimAvailableForActor(row: Record<string, unknown>, actorEmail: string) {
  const claimedBy = qaClaimEmailFromLegacyRow(row);
  if (!claimedBy || claimedBy === actorEmail) return true;
  if (String(row.qa_availability_reason ?? "").trim().toLowerCase() === "claimer_offline") return true;
  return row.hidden_from_queue !== true && row.qa_available !== false;
}

function qaReviewerEmailFromLegacyRow(row: Record<string, unknown>) {
  const direct = String(
    row.qa_reviewed_by_email
    ?? row.qa_reviewed_by
    ?? row.qa_approved_by_email
    ?? row.qa_approved_by
    ?? ""
  ).trim().toLowerCase();
  if (direct) return direct;
  const history = Array.isArray(row.work_history) ? row.work_history : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = asRecord(history[index]);
    const name = String(event.event ?? event.type ?? "").trim().toLowerCase();
    if (!["qa_approved", "qa_approved_pending_manager", "qa_reviewed", "qa_claimed"].includes(name)) continue;
    const email = String(event.qa_email ?? event.qa_reviewer_email ?? event.by_email ?? event.user_email ?? "").trim().toLowerCase();
    if (email) return email;
  }
  return "";
}

function qaReviewerNameFromLegacyRow(row: Record<string, unknown>) {
  return String(
    row.qa_approved_by_name
    ?? row.qa_reviewed_by_name
    ?? row.qa_reviewer_name
    ?? qaReviewerEmailFromLegacyRow(row)
    ?? ""
  ).trim();
}

function isTodayInManagementTime(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return false;
  const bounds = managementDayBounds();
  return parsed >= bounds.startMs && parsed < bounds.endExclusiveMs;
}

function qaCompletedProjectPoints(row: Record<string, unknown>) {
  for (const key of ["point_value", "project_points", "points_value", "points"]) {
    const value = Number(row[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const normalized = String(row.complexity ?? "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const points: Record<string, number> = {
    "1": 2, "2": 3, "3": 4, "4": 6, "5": 10,
    very_simple: 2, very_simple_project: 2, simple: 3, simple_project: 3,
    standard: 4, standard_project: 4, complex: 6, complex_project: 6,
    very_complex: 10, very_complex_project: 10
  };
  return points[normalized] ?? 1;
}

function qaShiftPointEventFromManifest(manifest: ProjectManifest): QaShiftPointEvent | null {
  const row = asRecord(buildLegacyManifest(manifest));
  if (row.is_filler === true || row.is_tutorial_instance === true) return null;
  const email = qaReviewerEmailFromLegacyRow(row);
  if (!email) return null;
  const occurredAtMs = parseDateLikeTimestamp(row.qa_approved_at ?? row.qa_reviewed_at ?? row.qa_completed_at);
  if (!Number.isFinite(occurredAtMs) || occurredAtMs <= 0) return null;
  return {
    email,
    name: qaReviewerNameFromLegacyRow(row) || email,
    occurredAtMs,
    points: qaCompletedProjectPoints(row),
    projectId: String(row.id ?? row.folder ?? row.project_id ?? "").trim()
  };
}

async function loadQaShiftLeaderboard(date: string, teamId?: string | null, force = false) {
  const normalizedDate = normalizeQaShiftDateKey(date);
  const normalizedTeam = normalizeQaTeamFilter(teamId) || "all";
  const cacheKey = `${normalizedTeam.toLowerCase()}|${normalizedDate}`;
  const cached = qaShiftLeaderboardCache.get(cacheKey);
  if (!force && cached && cached.expiresAt > Date.now()) {
    return { ...cached.value, cached: true };
  }
  const window = qaShiftQueryWindow(normalizedDate);
  const result = await queryIndexedProjectManifests({
    team_id: normalizedTeam === "all" ? undefined : normalizedTeam,
    activityStartMs: window.queryStartMs,
    activityEndMs: window.queryEndMs,
    activityFields: ["completed", "updated"],
    limit: 20_000
  });
  const events = result.projects
    .map((manifest) => qaShiftPointEventFromManifest(manifest as ProjectManifest))
    .filter((event): event is QaShiftPointEvent => Boolean(event));
  const value = buildQaShiftLeaderboard(events, normalizedDate);
  qaShiftLeaderboardCache.set(cacheKey, {
    expiresAt: Date.now() + (normalizedDate === qaShiftDateKey() ? 15_000 : 3_600_000),
    value
  });
  if (qaShiftLeaderboardCache.size > 250) {
    const oldestKey = qaShiftLeaderboardCache.keys().next().value;
    if (oldestKey) qaShiftLeaderboardCache.delete(oldestKey);
  }
  return value;
}

function buildQaLeaderboardFromRows(rows: Record<string, unknown>[]) {
  const bounds = managementDayBounds();
  const elapsedHours = Math.max(1 / 60, (Date.now() - bounds.startMs) / 3_600_000);
  const byEmail = new Map<string, { email: string; name: string; approved_count: number; points: number; projects_per_hour: number; points_per_hour: number; rank?: number }>();
  for (const row of rows) {
    const completedAt = row.qa_approved_at ?? row.qa_reviewed_at ?? row.completed_at ?? row.date;
    if (!isTodayInManagementTime(completedAt)) continue;
    const email = qaReviewerEmailFromLegacyRow(row);
    if (!email) continue;
    if (!byEmail.has(email)) {
      byEmail.set(email, {
        email,
        name: qaReviewerNameFromLegacyRow(row) || email,
        approved_count: 0,
        points: 0,
        projects_per_hour: 0,
        points_per_hour: 0
      });
    }
    const reviewer = byEmail.get(email)!;
    reviewer.approved_count += 1;
    reviewer.points += qaCompletedProjectPoints(row);
  }
  const leaderboard = [...byEmail.values()].sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    if (a.approved_count !== b.approved_count) return b.approved_count - a.approved_count;
    return a.name.localeCompare(b.name);
  });
  leaderboard.forEach((row, index) => {
    row.rank = index + 1;
    row.points = Math.round(row.points * 100) / 100;
    row.projects_per_hour = Math.round((row.approved_count / elapsedHours) * 100) / 100;
    row.points_per_hour = Math.round((row.points / elapsedHours) * 100) / 100;
  });
  return {
    success: true,
    leaderboard,
    date: managementDateKey(),
    timezone: MANAGEMENT_TIME_ZONE,
    cached: true
  };
}

export function qaQueueEnteredAtMs(legacy: Record<string, unknown>) {
  // QA resubmission timestamps must not make an older customer order look new.
  for (const key of ["created_at", "date", "uploaded_at", "qa_submitted_at", "queued_at"]) {
    const ts = Date.parse(String(legacy[key] ?? ""));
    if (Number.isFinite(ts)) return ts;
  }
  return 0;
}

function drafterEmailForQaRank(legacy: Record<string, unknown>) {
  const direct = String(
    legacy.qa_paid_to_email
    ?? legacy.assigned_to_email
    ?? legacy.drafter_email
    ?? legacy.technician_email
    ?? ""
  ).trim().toLowerCase();
  if (direct) return direct;
  const history = Array.isArray(legacy.work_history) ? legacy.work_history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const event = asRecord(history[i]);
    const email = String(event.worker_email ?? event.assigned_to_email ?? "").trim().toLowerCase();
    if (email) return email;
  }
  return "";
}

async function readSolarImageryQualityFromInsights(projectId: string) {
  try {
    const artifact = await readArtifact(projectId, "insights.json");
    const parsed = JSON.parse(artifact.content.toString("utf8")) as Record<string, unknown>;
    const quality = String(parsed.imageryQuality ?? "").trim().toUpperCase();
    if (!quality) return "";
    await patchManifest(projectId, {
      solar_imagery_quality: quality,
      height_map_quality: quality,
      ...(parsed.imageryDate ? { solar_imagery_date: parsed.imageryDate } : {}),
      ...(parsed.imageryProcessedDate ? { solar_imagery_processed_date: parsed.imageryProcessedDate } : {})
    }).catch(() => null);
    return quality;
  } catch {
    return "";
  }
}

async function heightQualityPenaltyMeta(legacy: Record<string, unknown>, projectId: string) {
  const qualityKeys = [
    "solar_imagery_quality",
    "height_map_quality",
    "heightmap_quality",
    "dsm_quality",
    "height_quality",
    "height_map_quality_score",
    "heightmap_quality_score"
  ];
  let raw: unknown = null;
  let source = "default";
  for (const key of qualityKeys) {
    const value = legacy[key];
    if (value === null || value === undefined || value === "") continue;
    raw = value;
    source = key;
    break;
  }
  // Queue reads must stay read-only. Missing quality is backfilled by project
  // processing; never open artifacts or patch manifests while ranking QA work.
  if (raw === null || raw === undefined || raw === "") {
    return { points: 5, source: "default", raw: null };
  }
  let points = 5;
  if (typeof raw === "number" || /^-?\d+(\.\d+)?$/.test(String(raw))) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return { points: 5, source, raw };
    if (value >= 0 && value <= 1) points = Math.max(0, Math.min(10, (1 - value) * 10));
    else if (value >= 1 && value <= 5) points = Math.max(0, Math.min(10, ((value - 1) / 4) * 10));
    else if (value >= 0 && value <= 10) points = Math.max(0, Math.min(10, value));
    else if (value >= 0 && value <= 100) points = Math.max(0, Math.min(10, 10 - (value / 10)));
    return { points: Math.round(points * 100) / 100, source, raw };
  }
  const label = String(raw).trim().toLowerCase();
  if (["excellent", "best", "high", "highest", "good"].includes(label)) points = 0;
  else if (["medium", "standard", "average", "ok"].includes(label)) points = 5;
  else if (["base", "poor", "low", "lowest", "bad"].includes(label)) points = 10;
  return { points: Math.round(points * 100) / 100, source, raw };
}

function qaTopRankGroup(legacy: Record<string, unknown>) {
  if (Boolean(legacy.qa_priority)) return 0;
  if (Boolean(legacy.is_vip) || Boolean(legacy.is_expedited)) return 1;
  if (Boolean(legacy.is_filler)) return 3;
  return 2;
}

async function buildQaRankMeta(manifest: ProjectManifest, drafterRanks: Map<string, DrafterRank>) {
  const legacy = buildLegacyManifest(manifest);
  const enteredAtMs = qaQueueEnteredAtMs(legacy);
  const drafterEmail = drafterEmailForQaRank(legacy);
  const rank = drafterRanks.get(drafterEmail) ?? "junior";
  const drafterPenalty = rank === "senior" ? 0 : (rank === "standard" ? 5 : 10);
  const projectPoints = Number(legacy.point_value ?? (manifest as Record<string, unknown>).point_value ?? 0)
    || firstMeasurePointValueForComplexity(legacy.complexity)
    || 0;
  const heightMeta = await heightQualityPenaltyMeta(legacy, manifest.id);
  const heightPenalty = heightMeta.points;
  const errorScore = projectPoints + drafterPenalty + heightPenalty;
  return {
    priority_level: reportPriorityLevelFromManifest(legacy),
    correction_return: isQaCorrectionReturn(manifest),
    top_group: qaTopRankGroup(legacy),
    batch_start_ms: enteredAtMs > 0 ? Math.floor(enteredAtMs / QA_BATCH_INTERVAL_MS) * QA_BATCH_INTERVAL_MS : 0,
    entered_at_ms: enteredAtMs,
    error_score: Math.round(errorScore * 100) / 100,
    project_points: projectPoints,
    drafter_rank: rank,
    drafter_rank_points: drafterPenalty,
    height_quality_points: Math.round(heightPenalty * 100) / 100,
    height_quality_source: heightMeta.source,
    height_quality_raw: heightMeta.raw
  };
}

function compareQaRankedProjects(a: QaRankedProject, b: QaRankedProject) {
  if (a.rank.priority_level !== b.rank.priority_level) return a.rank.priority_level - b.rank.priority_level;
  const aReturned = a.rank.correction_return ? 0 : 1;
  const bReturned = b.rank.correction_return ? 0 : 1;
  if (aReturned !== bReturned) return aReturned - bReturned;
  const aFailed = String(a.manifest.status ?? "").trim().toLowerCase() === "submission_failed" ? 0 : 1;
  const bFailed = String(b.manifest.status ?? "").trim().toLowerCase() === "submission_failed" ? 0 : 1;
  if (aFailed !== bFailed) return aFailed - bFailed;
  if (a.rank.top_group !== b.rank.top_group) return a.rank.top_group - b.rank.top_group;
  if (a.rank.batch_start_ms !== b.rank.batch_start_ms) return a.rank.batch_start_ms - b.rank.batch_start_ms;
  if (a.rank.error_score !== b.rank.error_score) return a.rank.error_score - b.rank.error_score;
  if (a.rank.entered_at_ms !== b.rank.entered_at_ms) return a.rank.entered_at_ms - b.rank.entered_at_ms;
  return String(a.manifest.id ?? "").localeCompare(String(b.manifest.id ?? ""));
}

function qaBulkApprovalMatches(
  manifest: ProjectManifest,
  rank: QaRankedProject["rank"],
  criteria: Record<string, unknown>
) {
  const legacy = buildLegacyManifest(manifest);
  const maxScore = Number(criteria.max_score ?? 10);
  if (Number.isFinite(maxScore) && rank.error_score > maxScore) return false;

  const maxHeightPoints = Number(criteria.max_height_points ?? "");
  if (Number.isFinite(maxHeightPoints) && rank.height_quality_points > maxHeightPoints) return false;

  const maxProjectPoints = Number(criteria.max_project_points ?? "");
  if (Number.isFinite(maxProjectPoints) && rank.project_points > maxProjectPoints) return false;

  const allowedRanks = Array.isArray(criteria.drafter_ranks)
    ? criteria.drafter_ranks.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowedRanks.length && !allowedRanks.includes(rank.drafter_rank)) return false;

  const technicianEmail = String(criteria.technician_email ?? "").trim().toLowerCase();
  if (technicianEmail && drafterEmailForQaRank(legacy) !== technicianEmail) return false;

  const complexity = String(legacy.complexity ?? "").trim().toLowerCase();
  const allowedComplexities = Array.isArray(criteria.complexities)
    ? criteria.complexities.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
    : [];
  if (allowedComplexities.length && !allowedComplexities.includes(complexity)) return false;

  if (criteria.include_vip === false && Boolean(legacy.is_vip ?? manifest.is_vip)) return false;
  if (criteria.include_expedited === false && Boolean(legacy.is_expedited ?? manifest.is_expedited)) return false;
  return true;
}

async function approveQaProjectFromBulk(
  manifest: ProjectManifest,
  actor: ReturnType<typeof normalizeOptionalPortalActor>,
  criteria: Record<string, unknown>
) {
  const projectId = manifest.id;
  const actorEmail = actor?.email ?? "";
  const actorName = actor?.name ?? actorEmail;
  const nowIso = new Date().toISOString();
  const nowSql = toSqlDateString(new Date());
  const legacy = buildLegacyManifest(manifest);
  const workflow = asRecord(manifest.workflow);
  const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
  const qaHistory = Array.isArray(legacy.qa_history) ? [...legacy.qa_history] : [];
  const isVip = Boolean(legacy.is_vip ?? manifest.is_vip);

      const mainPdf = await readStoredPdf(projectId, "main").catch(() => null);
      if (!mainPdf) {
        return { success: false, id: projectId, error: "missing_pdf" };
      }

  qaHistory.push({
    ts: nowIso,
    qa_email: actorEmail || null,
    qa_name: actorName || null,
    decision: "approved",
    decision_type: "bulk_low_risk_approval",
    correction_needed: false,
    corrected_by_qa: false,
    approved_without_changes: true,
    bulk_approved: true
  });
  workHistory.push({
    ts: nowIso,
    event: "qa_bulk_approved",
    qa_email: actorEmail || null,
    qa_name: actorName || null,
    decision_type: "bulk_low_risk_approval",
    approved_without_changes: true,
    criteria
  });

  await patchManifest(projectId, {
    qa_decision_type: "bulk_low_risk_approval",
    ...buildCustomerReworkCompletionPatch(legacy, nowIso, actorEmail, actorName),
    qa_correction_needed: false,
    qa_corrected_by_qa: false,
    qa_correction_requested_from_technician: false,
    qa_approved_without_changes: true,
    qa_correction_source: "none",
    qa_threads: [],
    qa_history: qaHistory,
    qa_approved_by: actorEmail || null,
    qa_approved_by_name: actorName || null,
    qa_approved_at: nowSql,
    qa_reviewed_by: actorEmail || null,
    qa_reviewed_by_name: actorName || null,
    qa_reviewed_at: nowSql,
    qa_completed_at: nowSql,
    qa_paid_to_email: String(legacy.assigned_to_email ?? "") || null,
    qa_paid_to_name: String(legacy.assigned_to_name ?? "") || null,
    qa_fix_required: false,
    qa_fix_by_email: null,
    qa_fix_by_name: null,
    qa_fix_required_at: null,
    correction_to_email: null,
    correction_to_name: null,
    correction_requested_at: null,
    qa_claimed_by_email: null,
    qa_claimed_by_name: null,
    qa_claimed_at: null,
    bulk_qa_approved_by: actorEmail || null,
    bulk_qa_approved_by_name: actorName || null,
    bulk_qa_approved_at: nowSql,
    bulk_qa_approval_criteria: criteria,
    ...(isVip ? {
      manager_approved_by: actorEmail || null,
      manager_approved_by_name: actorName || null,
      manager_approved_at: nowSql
    } : {}),
    work_history: workHistory,
    workflow: {
      ...workflow,
      correction_to: null,
      qa_claim: null
    }
  });

  const updated = await updateStatus(projectId, "completed");
  const updatedLegacy = buildLegacyManifest(updated);
  const updatedStatus = String(updatedLegacy.status ?? updated.status ?? "").trim().toLowerCase();
  if (updatedStatus !== "completed") {
    return {
      success: false,
      id: projectId,
      error: "status_not_completed",
      status: updatedStatus || null
    };
  }
  const delivery = await enqueueProjectReportDelivery(projectId);

  return {
    success: true,
    id: projectId,
    manifest: updatedLegacy,
    accepted: true,
    email_result: { ok: true, accepted: true, job_id: delivery.jobId },
    delivery_job_id: delivery.jobId
  };
}

function qaQueueCacheKey(teamId: string | null | undefined, drafterRanks: Map<string, DrafterRank>) {
  const rankKey = Array.from(drafterRanks.entries()).sort().map(([email, rank]) => `${email}:${rank}`).join("|");
  return `${teamId || "all"}:${rankKey}`;
}

async function getRankedQaQueueManifests(input: {
  teamId?: string | null;
  live: boolean;
  drafterRanks: Map<string, DrafterRank>;
}) {
  const key = qaQueueCacheKey(input.teamId, input.drafterRanks);
  const cached = qaTechQueueCache.get(key);
  const now = Date.now();
  const version = await readQaQueueVersion();
  if (cached && cached.expiresAt > now && cached.version === version) {
    return cached.ranked;
  }

  const activeBuild = qaTechQueueBuilds.get(key);
  if (activeBuild) return activeBuild;

  const build = (async () => {
    const eligible = await listAwaitingReviewManifests(input.teamId);
    const ranked = (await Promise.all(
      eligible.map(async (manifest) => ({ manifest, rank: await buildQaRankMeta(manifest, input.drafterRanks) }))
    )).sort(compareQaRankedProjects);
    qaTechQueueCache.set(key, {
      expiresAt: Date.now() + QA_TECH_QUEUE_CACHE_TTL_MS,
      version,
      ranked
    });
    return ranked;
  })();
  qaTechQueueBuilds.set(key, build);
  try {
    return await build;
  } finally {
    if (qaTechQueueBuilds.get(key) === build) qaTechQueueBuilds.delete(key);
  }
}

async function reserveNextQaProjects(input: {
  actor: ReturnType<typeof normalizeOptionalPortalActor>;
  teamId?: string | null;
  count: number;
  drafterRanks: Map<string, DrafterRank>;
}) {
  const actorEmail = String(input.actor?.email ?? "").trim().toLowerCase();
  const reserved: QaRankedProject[] = [];
  const existing = await getRankedQaQueueManifests({
    teamId: input.teamId,
    live: true,
    drafterRanks: input.drafterRanks
  });
  for (const entry of existing) {
    if (qaClaimEmail(entry.manifest) === actorEmail && !isQaCorrectionReturn(entry.manifest)) reserved.push(entry);
  }

  const ranked = await getRankedQaQueueManifests({
    teamId: input.teamId,
    live: false,
    drafterRanks: input.drafterRanks
  });
  const cached = qaTechQueueCache.get(qaQueueCacheKey(input.teamId, input.drafterRanks));
  const source = cached
    && cached.expiresAt > Date.now()
    && cached.version === await readQaQueueVersion()
    ? "cache"
    : "live";
  const queueCacheAgeMs = cached ? Math.max(0, QA_TECH_QUEUE_CACHE_TTL_MS - (cached.expiresAt - Date.now())) : 0;
  for (const entry of ranked) {
    if (reserved.length >= input.count) break;
    const id = String(entry.manifest.id ?? "");
    if (!id || reserved.some((item) => item.manifest.id === id)) continue;
    const claimed = await withQaProjectClaimLock(id, async () => {
      const fresh = await readManifest(id).catch(() => null);
      if (!fresh || !["awaiting_review", "submission_failed"].includes(String(fresh.status ?? "").trim().toLowerCase())) return null;
      const claimedBy = qaClaimEmail(fresh);
      if (claimedBy && claimedBy !== actorEmail && !(await isQaClaimStale(claimedBy, qaClaimedAt(fresh), fresh))) return null;
      if (claimedBy && claimedBy !== actorEmail) {
        await releaseQaClaimOnManifest(fresh, input.actor, "claimed_stale_takeover");
      }
      return claimedBy === actorEmail && !isQaCorrectionReturn(fresh)
        ? fresh
        : await claimQaProjectForActor(fresh, input.actor);
    });
    if (!claimed) continue;
    reserved.push({ manifest: claimed, rank: await buildQaRankMeta(claimed, input.drafterRanks) });
  }
  return { reserved: reserved.slice(0, input.count), source, queueCacheAgeMs };
}

async function claimQaProjectForActor(manifest: ProjectManifest, actor: ReturnType<typeof normalizeOptionalPortalActor>) {
  const actorEmail = String(actor?.email ?? "").trim().toLowerCase();
  const actorName = String(actor?.name ?? actorEmail).trim() || actorEmail;
  const legacy = buildLegacyManifest(manifest);
  const workflow = asRecord(manifest.workflow);
  const existingClaim = asRecord(workflow.qa_claim);
  const existingClaimEmail = qaClaimEmail(manifest);
  const existingClaimedAt = qaClaimedAt(manifest);
  const isSameClaim = existingClaimEmail === actorEmail && existingClaimedAt !== "";
  const nowIso = new Date().toISOString();
  const claimedAt = isSameClaim ? existingClaimedAt : nowIso;
  const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
  if (!isSameClaim) {
    workHistory.push({
      ts: nowIso,
      event: "qa_claimed",
      qa_email: actorEmail,
      qa_name: actorName,
      reserve_source: "qa_preload"
    });
  }
  const claimed = await patchManifest(manifest.id, {
    qa_claimed_by_email: actorEmail,
    qa_claimed_by_name: actorName,
    qa_claimed_at: claimedAt,
    qa_available: false,
    qa_availability_reason: "claimed",
    hidden_from_queue: true,
    qa_return_hold_expires_at: null,
    work_history: workHistory,
    workflow: {
      ...workflow,
      qa_claim: {
        ...(isSameClaim ? existingClaim : {}),
        ...(actor?.id ? { id: actor.id } : {}),
        email: actorEmail,
        name: actorName,
        claimed_at: claimedAt,
        // Opening a correction returned to this reviewer converts its temporary
        // hold into a normal claim without inventing a new timer origin.
        claim_reason: undefined,
        hold_expires_at: undefined
      }
    }
  }, { backup: false });
  clearQaClaimCaches();
  return claimed;
}

async function buildQaRankedProjectRow(
  entry: QaRankedProject,
  request: { headers: Record<string, unknown>; protocol?: string },
  view: ProjectListView
) {
  const row = await buildProjectListViewRow(entry.manifest, request, view);
  return {
    ...row,
    qa_rank: entry.rank,
    qa_priority_rank_score: entry.rank.error_score,
    qa_error_score: entry.rank.error_score,
    project_points: entry.rank.project_points,
    drafter_rank: entry.rank.drafter_rank,
    drafter_rank_points: entry.rank.drafter_rank_points,
    height_quality_points: entry.rank.height_quality_points,
    height_quality_source: entry.rank.height_quality_source,
    height_quality_raw: entry.rank.height_quality_raw
  };
}

async function touchPortalUserActivity(
  email?: string,
  options?: { qaActive?: boolean; qaHeartbeat?: boolean; currentFolder?: string }
) {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return;
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { last_activity_at: now };
  if (options?.qaActive) patch.last_qa_activity_at = now;
  if (options?.qaHeartbeat) {
    patch.last_qa_heartbeat_at = now;
    patch.qa_heartbeat_active = true;
    patch.qa_heartbeat_current_folder = String(options.currentFolder ?? "").trim();
  }
  try {
    const updated = await patchInternalUser(normalizedEmail, patch);
    if (updated) return;
  } catch {
    // Fall through to the legacy file write below.
  }
  try {
    const legacyFileName = `${normalizedEmail.replace(/[^a-z0-9@._+-]/g, "_")}.json`;
    const filePath = path.join(INTERNAL_USERS_DIR, legacyFileName);
    const raw = await readFile(filePath, "utf8");
    const user = asRecord(JSON.parse(raw));
    await writeFile(filePath, `${JSON.stringify({ ...user, ...patch }, null, 2)}\n`);
  } catch {
    // Activity is best-effort; queue behavior should not fail because a portal user record is unavailable.
  }
}

function isTimestampWithinWindow(value: unknown, windowMs: number) {
  const timestamp = Date.parse(String(value ?? ""));
  const age = Date.now() - timestamp;
  return Number.isFinite(timestamp)
    && age >= -ONLINE_TIMESTAMP_CLOCK_SKEW_MS
    && age <= windowMs;
}

async function isTechnicianOnlineForReturn(manifest: Record<string, unknown>, techEmail: string) {
  const normalizedEmail = String(techEmail ?? "").trim().toLowerCase();
  if (!normalizedEmail) return false;
  if (isProjectEditorOnlineForTech(manifest, normalizedEmail)) return true;

  const user = await readPortalUserByEmail(normalizedEmail);
  if (!user) return false;
  if (toBooleanish(user.is_offline)) return false;

  const availabilityStatus = String(user.availability_status ?? "").trim().toLowerCase();
  if (availabilityStatus === "offline") return false;

  const lastActivity = user.last_activity_at ?? user.last_login_at ?? user.last_login ?? null;
  return isTimestampWithinWindow(lastActivity, TECH_RECENT_ACTIVITY_WINDOW_MS);
}

async function routeProjectBackToTechnician(options: {
  projectId: string;
  manifest: Record<string, unknown>;
  actor: ReturnType<typeof normalizeOptionalPortalActor>;
  patch: Record<string, unknown>;
  targetTech: { email: string; name: string };
  source: "qa" | "manager";
}) {
  const targetName = options.targetTech.name || options.targetTech.email || "the original tech";
  const techOnline = await isTechnicianOnlineForReturn(options.manifest, options.targetTech.email);

  await patchManifest(options.projectId, options.patch);
  await updateStatus(options.projectId, "requeue");

  let updatedManifest = await readManifest(options.projectId);
  if (techOnline && options.targetTech.email) {
    updatedManifest = await reserveProject(options.projectId, {
      actor: options.actor
        ? {
            ...(options.actor.id ? { id: options.actor.id } : {}),
            ...(options.actor.email ? { email: options.actor.email } : {}),
            ...(options.actor.name ? { name: options.actor.name } : {}),
            ...(options.actor.team_id ? { team_id: options.actor.team_id } : {})
          }
        : undefined,
      reserved_for: {
        email: options.targetTech.email,
        name: targetName
      },
      notes: `${options.source}_send_back_to_tech`
    });
  } else {
    const queuedAt = new Date().toISOString();
    updatedManifest = await patchManifest(options.projectId, {
      timestamps: {
        ...asRecord(updatedManifest.timestamps),
        queued_at: queuedAt,
        started_at: null,
        updated_at: queuedAt
      }
    });
    updatedManifest = await updateStatus(options.projectId, "queued");
  }

  return {
    manifest: updatedManifest,
    techOnline,
    targetTech: {
      email: options.targetTech.email,
      name: targetName
    },
    deliveryMode: techOnline ? "reserved_queue" : "unreserved_queue",
    message: techOnline
      ? `Sent back to ${targetName}. They are online, so the project was moved to queued and reserved for them.`
      : `${targetName} is offline, so the project was moved to the unreserved queue for the next eligible technician.`
  };
}

async function sendGeneratedProjectReport(
  projectId: string,
  input: RenderReportInput,
  reply: FastifyReply,
  refreshArtifactsAfterPersist: boolean,
  request: FastifyRequest
) {
  const outputSlot = resolveOutputSlot(input.output_slot);
  const generated = await renderStoredProjectWithSharedRuntime(projectId, input, request, outputSlot);
  const result = generated.outputs[0];
  if (!result) {
    throw new Error("Shared PDF runtime did not return a rendered PDF.");
  }

  if (input.persist_files && result.persist) {
    await saveStoredPdf(projectId, outputSlot, result.bytes);
    if (result.updateStatus || input.update_status) {
      await updateStatusForSubmission(projectId, "awaiting_review");
    }
    if (refreshArtifactsAfterPersist) {
      const refreshed = await refreshArtifactFlags(projectId, await readManifest(projectId));
      await saveManifest(projectId, refreshed);
    }
  }

  reply.type("application/pdf");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
  return reply.send(result.bytes);
}

async function buildGeneratedProjectPdfBatchResponse(
  projectId: string,
  input: Record<string, unknown>,
  request: FastifyRequest
) {
  const detail = await getProjectDetail(projectId);
  const snapshot = resolvePdfSnapshot(detail.pdf_state, input);
  const outputs = normalizePdfOutputs(input, true);
  const organization = await resolveProjectOrganizationContext(projectId, detail.manifest, detail.branding_defaults);
  const rendered = await renderProjectPdfBatch({
    projectId,
    snapshot,
    manifest: detail.manifest,
    organization,
    outputs,
    request
  });

  const persistedOutputs: Array<Record<string, unknown>> = [];
  let refreshedManifestNeeded = false;

  for (const item of rendered.outputs) {
    if (item.persist) {
      await saveStoredPdf(projectId, item.slot, item.bytes);
      refreshedManifestNeeded = true;
    }
    if (item.updateStatus) {
      await updateStatusForSubmission(projectId, "awaiting_review");
    }
    persistedOutputs.push({
      slot: item.slot,
      mode: item.mode,
      file_name: item.fileName,
      persisted: item.persist,
      update_status: item.updateStatus,
      sha256: createHash("sha256").update(item.bytes).digest("hex"),
      pdf_url: buildAbsoluteApiUrl(request, `/projects/${encodeURIComponent(projectId)}/pdf?slot=${item.slot}`)
    });
  }

  if (refreshedManifestNeeded) {
    const refreshed = await refreshArtifactFlags(projectId, await readManifest(projectId));
    await saveManifest(projectId, refreshed);
  }

  return {
    ok: true,
    project_id: projectId,
    source: input.source === "inline" ? "inline" : "saved",
    outputs: persistedOutputs,
    debug: rendered.debug
  };
}

function normalizePdfChecksumMap(value: unknown) {
  const raw = asRecord(value);
  const checksums: Record<string, string> = {};
  for (const slot of ["main", "summary"]) {
    const checksum = String(raw[slot] ?? "").trim().toLowerCase();
    if (/^[a-f0-9]{64}$/.test(checksum)) checksums[slot] = checksum;
  }
  return checksums;
}

function canonicalizePdfChecksumValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizePdfChecksumValue);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined || typeof item === "function") continue;
    output[key] = canonicalizePdfChecksumValue(item);
  }
  return output;
}

function normalizePdfRenderContractOutput(spec: SharedPdfOutputSpec) {
  const raw = spec as Record<string, unknown>;
  const mode = spec.mode === "summary" ? "summary" : "full";
  return {
    slot: spec.slot ?? (mode === "summary" ? "summary" : "main"),
    mode,
    applyBrandingToFull: Boolean(spec.applyBrandingToFull ?? spec.apply_branding_to_full),
    disableOrganizationBranding: Boolean(spec.disableOrganizationBranding ?? spec.disable_organization_branding),
    useProjectOrganizationBranding: Boolean(spec.useProjectOrganizationBranding ?? spec.use_project_organization_branding),
    clearBrandingOverrides: Boolean(spec.clearBrandingOverrides ?? spec.clear_branding_overrides),
    pageConfigOverride: spec.pageConfigOverride ?? spec.page_config ?? {},
    brandingOverrides: spec.brandingOverrides ?? raw.branding_overrides ?? {},
    statePatch: spec.statePatch ?? spec.snapshot_patch ?? {},
    pdfConfigPatch: spec.pdfConfigPatch ?? spec.pdf_config_patch ?? {},
    coverTitle: spec.coverTitle ?? spec.cover_title ?? (mode === "summary" ? "Roof Summary" : "Project Overview")
  };
}

function buildPdfRenderContractChecksum(snapshot: unknown, spec: SharedPdfOutputSpec) {
  const value = canonicalizePdfChecksumValue({
    version: PDF_RENDER_RECIPE_VERSION,
    snapshot,
    output: normalizePdfRenderContractOutput(spec)
  });
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function comparePdfChecksums(clientChecksums: Record<string, string>, serverOutputs: unknown) {
  const outputs = Array.isArray(serverOutputs) ? serverOutputs : [];
  const rows = outputs.map((value) => {
    const output = asRecord(value);
    const slot = output.slot === "summary" ? "summary" : "main";
    const clientSha256 = clientChecksums[slot] ?? null;
    const serverSha256 = String(output.sha256 ?? "").trim().toLowerCase() || null;
    return {
      slot,
      client_sha256: clientSha256,
      server_sha256: serverSha256,
      identical: Boolean(clientSha256 && serverSha256 && clientSha256 === serverSha256)
    };
  });
  const comparedRows = rows.filter((row) => row.client_sha256 && row.server_sha256);
  return {
    compared: comparedRows.length > 0,
    identical: comparedRows.length > 0 && comparedRows.every((row) => row.identical),
    rows
  };
}

function comparePdfRenderChecksums(clientChecksums: Record<string, string>, serverOutputs: unknown) {
  const outputs = Array.isArray(serverOutputs) ? serverOutputs : [];
  const rows = outputs.map((value) => {
    const output = asRecord(value);
    const slot = output.slot === "summary" ? "summary" : "main";
    const clientSha256 = clientChecksums[slot] ?? null;
    const serverSha256 = String(output.render_checksum ?? "").trim().toLowerCase() || null;
    return {
      slot,
      client_render_sha256: clientSha256,
      server_render_sha256: serverSha256,
      identical: Boolean(clientSha256 && serverSha256 && clientSha256 === serverSha256)
    };
  });
  const comparedRows = rows.filter((row) => row.client_render_sha256 && row.server_render_sha256);
  return {
    compared: comparedRows.length > 0,
    identical: comparedRows.length > 0 && comparedRows.every((row) => row.identical),
    rows
  };
}

async function runBackgroundPdfSyncJob(job: {
  id: string;
  attempts?: number;
  payload: Record<string, unknown>;
}, logger?: {
  info?: (value: unknown, message?: string) => void;
  warn?: (value: unknown, message?: string) => void;
}) {
  const payload = asRecord(job.payload);
  const projectId = String(payload.project_id ?? "").trim();
  const revision = String(payload.revision ?? "").trim();
  const snapshot = payload.snapshot;
  const outputs = Array.isArray(payload.outputs)
    ? payload.outputs as SharedPdfOutputSpec[]
    : [];
  const recipeVersion = String(payload.pdf_render_recipe_version ?? "").trim();
  const assetBaseUrl = String(payload.asset_base_url ?? "").trim();
  if (!projectId || !revision || !snapshot || !outputs.length || !assetBaseUrl || recipeVersion !== PDF_RENDER_RECIPE_VERSION) {
    throw new Error("Background PDF sync job is missing required payload fields.");
  }

  const releaseLock = await acquireFirstMeasureLock(`pdf-sync:${projectId}`, {
    ttlMs: 300_000,
    waitMs: 300_000,
    owner: `${process.pid}:pdf-sync:${job.id}`
  });
  const startedAt = Date.now();
  try {
    const before = await readManifest(projectId);
    const beforeSync = asRecord(before.pdf_sync);
    if (String(beforeSync.latest_revision ?? "") !== revision) {
      return { project_id: projectId, revision, stale: true, persisted: false };
    }

    await patchManifest(projectId, {
      pdf_sync: {
        latest_revision: revision,
        latest_job_id: job.id,
        status: "rendering",
        started_at: new Date().toISOString(),
        error: null
      }
    });

    const detail = await getProjectDetail(projectId);
    const organization = await resolveProjectOrganizationContext(
      projectId,
      detail.manifest,
      detail.branding_defaults
    );
    const rendered = await renderSharedProjectPdfs({
      snapshot,
      manifest: detail.manifest,
      organization,
      assetBaseUrl,
      outputs
    });

    const afterRender = await readManifest(projectId);
    if (String(asRecord(afterRender.pdf_sync).latest_revision ?? "") !== revision) {
      return { project_id: projectId, revision, stale: true, persisted: false };
    }

    const renderedOutputs: Array<Record<string, unknown>> = [];
    for (const item of rendered.outputs) {
      await saveStoredPdf(projectId, item.slot, item.bytes);
      const outputSpec = outputs.find((spec) => (spec.slot ?? (spec.mode === "summary" ? "summary" : "main")) === item.slot);
      renderedOutputs.push({
        slot: item.slot,
        mode: item.mode,
        file_name: item.fileName,
        byte_length: item.bytes.byteLength,
        sha256: createHash("sha256").update(item.bytes).digest("hex"),
        render_checksum: outputSpec ? buildPdfRenderContractChecksum(snapshot, outputSpec) : item.renderChecksum
      });
    }

    const completedAt = new Date().toISOString();
    const latestBeforePersist = await readManifest(projectId);
    const latestSyncState = asRecord(latestBeforePersist.pdf_sync);
    const hasCurrentClientChecksums = String(latestSyncState.client_checksum_revision ?? "").trim() === revision;
    const clientChecksums = hasCurrentClientChecksums
      ? normalizePdfChecksumMap(latestSyncState.client_checksums)
      : {};
    const clientRenderChecksums = hasCurrentClientChecksums
      ? normalizePdfChecksumMap(latestSyncState.client_render_checksums)
      : {};
    const byteComparison = comparePdfChecksums(clientChecksums, renderedOutputs);
    const renderComparison = comparePdfRenderChecksums(clientRenderChecksums, renderedOutputs);
    if (
      renderComparison.compared
      && !renderComparison.identical
      && Number(job.attempts ?? 0) < 2
      && !String(payload.retry_of_job_id ?? "").trim()
    ) {
      throw new Error("Server PDF checksums differed from the local render; retrying once.");
    }
    await patchManifest(projectId, {
      pdf_sync: {
        latest_revision: revision,
        latest_job_id: job.id,
        status: "completed",
        completed_at: completedAt,
        failed_at: null,
        duration_ms: Date.now() - startedAt,
        outputs: renderedOutputs,
        client_checksums: clientChecksums,
        client_render_checksums: clientRenderChecksums,
        client_checksum_revision: hasCurrentClientChecksums ? revision : null,
        checksum_match: renderComparison.compared ? renderComparison.identical : null,
        checksum_comparison: renderComparison.rows,
        render_checksum_match: renderComparison.compared ? renderComparison.identical : null,
        render_checksum_comparison: renderComparison.rows,
        byte_checksum_match: byteComparison.compared ? byteComparison.identical : null,
        byte_checksum_comparison: byteComparison.rows,
        checksum_compared_at: renderComparison.compared ? completedAt : null,
        error: null
      }
    });
    logger?.info?.({ projectId, revision, jobId: job.id, outputs: renderedOutputs }, "Background PDF sync completed.");
    return {
      project_id: projectId,
      revision,
      persisted: true,
      duration_ms: Date.now() - startedAt,
      outputs: renderedOutputs,
      checksum_match: renderComparison.compared ? renderComparison.identical : null,
      checksum_comparison: renderComparison.rows,
      render_checksum_match: renderComparison.compared ? renderComparison.identical : null,
      render_checksum_comparison: renderComparison.rows,
      byte_checksum_match: byteComparison.compared ? byteComparison.identical : null,
      byte_checksum_comparison: byteComparison.rows
    };
  } catch (error) {
    await patchManifest(projectId, {
      pdf_sync: {
        latest_revision: revision,
        latest_job_id: job.id,
        status: "failed",
        failed_at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      }
    }).catch(() => undefined);
    logger?.warn?.({ err: error, projectId, revision, jobId: job.id }, "Background PDF sync failed.");
    throw error;
  } finally {
    await releaseLock();
  }
}

async function waitForPdfSyncJob(jobId: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await getFirstMeasureJob(jobId);
    if (!job) throw new Error(`PDF sync job '${jobId}' was not found.`);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(job.error || "PDF sync failed.");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for PDF sync job '${jobId}'.`);
}

async function resolveProjectPdfSyncReference(
  projectId: string,
  requestedJobIdValue?: unknown,
  requestedRevisionValue?: unknown
) {
  const requestedJobId = String(requestedJobIdValue ?? '').trim();
  const requestedRevision = String(requestedRevisionValue ?? '').trim();
  if (Boolean(requestedJobId) !== Boolean(requestedRevision)) {
    throw badRequest(
      'incomplete_pdf_sync_reference',
      'Both pdf_sync_job_id and pdf_sync_revision are required when submitting a reviewed PDF.'
    );
  }

  const manifest = await readManifest(projectId);
  const pdfSync = asRecord(manifest.pdf_sync);
  const latestJobId = String(pdfSync.latest_job_id ?? '').trim();
  const latestRevision = String(pdfSync.latest_revision ?? '').trim();
  const jobId = requestedJobId || latestJobId;
  const revision = requestedRevision || latestRevision;
  if (!jobId || !revision) return null;

  if (requestedJobId && (requestedJobId !== latestJobId || requestedRevision !== latestRevision)) {
    throw conflict('stale_pdf_sync_reference', 'The reviewed PDF is no longer the latest synchronized revision. Regenerate the preview and try again.', {
      requested_job_id: requestedJobId,
      requested_revision: requestedRevision,
      latest_job_id: latestJobId || null,
      latest_revision: latestRevision || null
    });
  }

  const job = await getFirstMeasureJob(jobId);
  const jobProjectId = String(job?.payload?.project_id ?? '').trim();
  const jobRevision = String(job?.payload?.revision ?? '').trim();
  if (!job || job.type !== 'pdf.sync' || jobProjectId !== projectId || jobRevision !== revision) {
    throw conflict('pdf_sync_reference_not_found', 'The reviewed PDF synchronization job is unavailable. Regenerate the preview and try again.', {
      job_id: jobId,
      revision
    });
  }
  if (job.status === 'failed') {
    throw conflict('pdf_sync_failed', 'The server copy of the reviewed PDF failed to render. Regenerate the preview and try again.', {
      job_id: jobId,
      revision,
      error: job.error || null
    });
  }
  return { jobId, revision, status: job.status };
}

async function enqueueProjectReportDelivery(
  projectId: string,
  requestedPdfSyncJobId?: string,
  requestedPdfSyncRevision?: string
) {
  const resolvedPdfSync = await resolveProjectPdfSyncReference(
    projectId,
    requestedPdfSyncJobId,
    requestedPdfSyncRevision
  );
  const pdfSyncJobId = resolvedPdfSync?.jobId ?? '';
  const pdfSyncRevision = resolvedPdfSync?.revision ?? '';
  const jobId = createHash("sha256")
    .update(`report.delivery:${projectId}:${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 32);
  await patchManifest(projectId, {
    submission_status: "submitting",
    submission_failure: null,
    delivery: {
      report_job_id: jobId,
      report_job_status: "queued",
      report_job_requested_at: new Date().toISOString(),
      waiting_for_pdf_sync_job_id: pdfSyncJobId || null,
      waiting_for_pdf_sync_revision: pdfSyncRevision || null
    }
  });
  try {
    await enqueueFirstMeasureJob("report.delivery", {
      project_id: projectId,
      pdf_sync_job_id: pdfSyncJobId || null,
      pdf_sync_revision: pdfSyncRevision || null
    }, { id: jobId, priority: 10, maxAttempts: 5 });
  } catch (error) {
    const failedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const manifest = await readManifest(projectId).catch(() => null);
    const legacy = manifest ? buildLegacyManifest(manifest) : {};
    const workHistory = Array.isArray(legacy.work_history) ? [...legacy.work_history] : [];
    workHistory.push({ ts: failedAt, event: "report_email_enqueue_failed", delivery_job_id: jobId, error: message });
    await patchManifest(projectId, {
      submission_status: "submitted",
      submission_failure: null,
      work_history: workHistory,
      delivery: {
        report_job_id: jobId,
        report_job_status: "failed",
        report_job_error: message,
        report_job_completed_at: failedAt
      }
    });
    qaTechQueueCache.clear();
  }
  return { jobId, pdfSyncJobId, pdfSyncRevision };
}

async function runBackgroundReportDeliveryJob(job: {
  id: string;
  type: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
}, logger?: {
  info?: (value: unknown, message?: string) => void;
  warn?: (value: unknown, message?: string) => void;
}) {
  const projectId = String(job.payload.project_id ?? "").trim();
  const pdfSyncJobId = String(job.payload.pdf_sync_job_id ?? "").trim();
  const pdfSyncRevision = String(job.payload.pdf_sync_revision ?? "").trim();
  if (!projectId) throw new Error("Background report delivery is missing project_id.");
  try {
    if (pdfSyncJobId) await waitForPdfSyncJob(pdfSyncJobId);

    if (pdfSyncJobId) {
      const manifest = await readManifest(projectId);
      const pdfSync = asRecord(manifest.pdf_sync);
      if (
        String(pdfSync.latest_job_id ?? '').trim() !== pdfSyncJobId
        || String(pdfSync.latest_revision ?? '').trim() !== pdfSyncRevision
      ) {
        throw new Error('The reviewed PDF revision was superseded before delivery.');
      }
      if (pdfSync.render_checksum_match === false || pdfSync.checksum_match === false) {
        throw new Error('The server PDF did not match the locally reviewed PDF after retry.');
      }
    }

    await patchManifest(projectId, {
      submission_status: "submitting",
      delivery: {
        report_job_id: job.id,
        report_job_status: "sending",
        report_job_started_at: new Date().toISOString(),
        report_job_attempt: job.attempts,
        report_job_max_attempts: job.max_attempts,
        report_job_next_retry_at: null
      }
    });
    const result = await sendProjectEmail(projectId, false);
    if (!result.ok) {
      throw new Error(String(result.error ?? "The customer report email failed to send."));
    }
    await patchManifest(projectId, {
      submission_status: "submitted",
      submission_failure: null,
      delivery: {
        report_job_id: job.id,
        report_job_status: "sent",
        report_job_completed_at: new Date().toISOString(),
        report_job_error: null,
        report_job_next_retry_at: null
      }
    });
    logger?.info?.({ projectId, jobId: job.id, ok: true }, "Background report delivery completed.");
    return { project_id: projectId, email: result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const terminal = job.attempts >= job.max_attempts;
    const retryDelayMs = terminal ? 0 : getFirstMeasureJobRetryDelayMs(job);
    const failureAt = new Date().toISOString();
    const current = await readManifest(projectId).catch(() => null);
    const currentLegacy = current ? buildLegacyManifest(current) : {};
    const workHistory = Array.isArray(currentLegacy.work_history) ? [...currentLegacy.work_history] : [];
    if (terminal) {
      workHistory.push({
        ts: failureAt,
        event: "report_email_delivery_failed",
        delivery_job_id: job.id,
        attempts: job.attempts,
        error: message
      });
    }
    await patchManifest(projectId, {
      // QA completion and customer notification are separate outcomes. A failed
      // email remains visible in delivery/email_state, but must not roll a
      // completed project back into the QA queue or hide it from the portal.
      submission_status: terminal ? "submitted" : "submitting",
      submission_failure: null,
      ...(terminal ? {
        work_history: workHistory
      } : {}),
      delivery: {
        report_job_id: job.id,
        report_job_status: terminal ? "failed" : "retrying",
        report_job_error: message,
        report_job_attempt: job.attempts,
        report_job_max_attempts: job.max_attempts,
        report_job_next_retry_at: terminal ? null : new Date(Date.now() + retryDelayMs).toISOString(),
        report_job_completed_at: terminal ? failureAt : null
      }
    });
    if (terminal) qaTechQueueCache.clear();
    logger?.warn?.({ projectId, jobId: job.id, terminal, attempt: job.attempts, error: message }, "Background report delivery failed.");
    throw error;
  }
}

async function sendPreviewProjectPdf(
  projectId: string,
  input: Record<string, unknown>,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const detail = await getProjectDetail(projectId);
  const snapshot = resolvePdfSnapshot(detail.pdf_state, input);
  const rawOutputs = Array.isArray(input.outputs) && input.outputs.length > 0
    ? input.outputs
    : [{ slot: "main", mode: "full", persist: false, update_status: false }];
  const previewInput = {
    ...input,
    persist_files: false,
    update_status: false,
    outputs: [asRecord(rawOutputs[0])]
  };
  const outputs = normalizePdfOutputs(previewInput, false).map((output) => ({
    ...output,
    persist: false,
    updateStatus: false
  }));
  const organization = await resolveProjectOrganizationContext(projectId, detail.manifest, detail.branding_defaults);
  const rendered = await renderProjectPdfBatch({
    projectId,
    snapshot,
    manifest: detail.manifest,
    organization,
    outputs,
    request
  });
  const result = rendered.outputs[0];
  if (!result) {
    throw new Error("Preview PDF renderer did not return a PDF.");
  }

  reply.type("application/pdf");
  reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  reply.header("Pragma", "no-cache");
  reply.header("Expires", "0");
  reply.header("Content-Disposition", `inline; filename="${result.fileName || "preview.pdf"}"`);
  return reply.send(result.bytes);
}

async function buildProjectPdfClientRuntimeResponse(
  projectId: string,
  request: FastifyRequest
) {
  const detail = await getProjectDetail(projectId);
  const snapshot = resolvePdfSnapshot(detail.pdf_state, {});
  const organization = await resolveProjectOrganizationContext(projectId, detail.manifest, detail.branding_defaults);
  return {
    ok: true,
    project_id: projectId,
    snapshot,
    manifest: detail.manifest,
    organization,
    runtime: buildPdfClientRuntimeManifest(request)
  };
}

async function renderStoredProjectWithSharedRuntime(
  projectId: string,
  input: RenderReportInput,
  request: FastifyRequest,
  outputSlot: PdfSlot
) {
  const detail = await getProjectDetail(projectId);
  const snapshot = resolvePdfSnapshot(detail.pdf_state, {});
  const organization = await resolveProjectOrganizationContext(projectId, detail.manifest, detail.branding_defaults);
  const outputs = normalizePdfOutputs({
    outputs: [{
      slot: outputSlot,
      mode: outputSlot === "summary" ? "summary" : "full",
      file_name: resolvePdfFileName(outputSlot),
      page_config: input.page_config,
      branding: input.branding,
      prepared_for: input.prepared_for,
      persist: !!input.persist_files,
      update_status: !!input.update_status
    }]
  }, false);
  return renderProjectPdfBatch({
    projectId,
    snapshot,
    manifest: detail.manifest,
    organization,
    outputs,
    request
  });
}

async function resolveProjectOrganizationContext(
  projectId: string,
  manifest: ProjectManifest,
  storedBrandingDefaults: unknown
) {
  const storedRaw = asRecord(storedBrandingDefaults);
  const stored = normalizeOrganizationBrandingContext(storedRaw);
  const fallback = await loadPortalOrganizationContextForProject(manifest).catch(() => null);
  const preferCurrentOrganization = shouldPreferCurrentOrganizationContext(fallback, storedRaw);
  const merged = normalizeOrganizationBrandingContext(preferCurrentOrganization
    ? mergeOrganizationContext(stored, fallback ?? {})
    : mergeOrganizationContext(fallback, stored));

  if (
    fallback
    && hasOrganizationBrandingContext(merged)
    && (!hasOrganizationBrandingContext(stored) || preferCurrentOrganization)
  ) {
    await saveBrandingDefaults(projectId, merged).catch(() => undefined);
  }

  return merged;
}

function shouldPreferCurrentOrganizationContext(
  fallback: Record<string, unknown> | null | undefined,
  stored: Record<string, unknown>
) {
  const fallbackOrgId = normalizePortalOrganizationId(asRecord(fallback).id);
  if (!fallbackOrgId || !Object.keys(stored).length) return false;

  const source = toOptionalString(stored.source);
  if (source && source !== "portal_organization_context") return false;

  const storedOrgId = normalizePortalOrganizationId(
    toOptionalString(stored.id)
      ?? toOptionalString(stored.organization_id)
      ?? toOptionalString(asRecord(stored.organization_ref).id)
  );
  return storedOrgId === fallbackOrgId;
}

function mergeOrganizationContext(
  fallback: Record<string, unknown> | null | undefined,
  stored: Record<string, unknown>
) {
  const base = asRecord(fallback);
  const current = asRecord(stored);
  const baseBranding = asRecord(base.branding);
  const currentBranding = asRecord(current.branding);
  const baseColors = asRecord(baseBranding.colors);
  const currentColors = asRecord(currentBranding.colors);
  return {
    ...base,
    ...current,
    report_settings: Object.keys(asRecord(current.report_settings)).length
      ? current.report_settings
      : base.report_settings,
    branding: {
      ...baseBranding,
      ...currentBranding,
      logo: firstLogoValue(currentBranding, current, baseBranding, base),
      logo_url: firstLogoValue(currentBranding, current, baseBranding, base),
      logo_node_url: firstLogoValue(currentBranding, current, baseBranding, base),
      colors: {
        ...baseColors,
        ...currentColors
      }
    }
  };
}

function normalizeOrganizationBrandingContext(source: Record<string, unknown>) {
  const direct = asRecord(source);
  const existingBranding = asRecord(direct.branding);
  const existingColors = asRecord(existingBranding.colors);
  const logo = firstLogoValue(existingBranding, direct);
  const primary = toOptionalString(existingColors.primary)
    ?? toOptionalString(direct.primary_color);
  const secondary = toOptionalString(existingColors.secondary)
    ?? toOptionalString(direct.secondary_color);
  const accent = toOptionalString(existingColors.accent)
    ?? toOptionalString(direct.accent_color);
  const branding = {
    ...existingBranding,
    ...(logo ? { logo } : {}),
    colors: {
      ...existingColors,
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {}),
      ...(accent ? { accent } : {})
    }
  };

  return {
    ...direct,
    ...(logo ? { logo_url: toOptionalString(direct.logo_url) ?? logo } : {}),
    ...(primary ? { primary_color: toOptionalString(direct.primary_color) ?? primary } : {}),
    ...(secondary ? { secondary_color: toOptionalString(direct.secondary_color) ?? secondary } : {}),
    branding
  };
}

function firstLogoValue(...sources: Array<Record<string, unknown>>) {
  const logos: string[] = [];
  for (const source of sources) {
    const record = asRecord(source);
    const nestedBranding = record.branding && typeof record.branding === "object" ? asRecord(record.branding) : null;
    const candidates = [
      record.logo,
      record.logo_node_url,
      record.logo_url,
      record.logoDataUrl,
      record.logo_data_url,
      nestedBranding?.logo,
      nestedBranding?.logo_node_url,
      nestedBranding?.logo_url,
      nestedBranding?.logoDataUrl,
      nestedBranding?.logo_data_url
    ];
    for (const candidate of candidates) {
      const logo = toOptionalString(candidate);
      if (logo) logos.push(logo);
    }
  }
  return logos.find(isAbsoluteOrDataUrl) ?? logos[0];
}

function isAbsoluteOrDataUrl(value: string) {
  return /^(?:[a-z]+:)?\/\//i.test(value) || value.startsWith("data:");
}

function hasOrganizationBrandingContext(context: Record<string, unknown>) {
  const normalized = asRecord(normalizeOrganizationBrandingContext(context));
  const branding = asRecord(normalized.branding);
  const colors = asRecord(branding.colors);
  return !!(
    toOptionalString(branding.logo)
    || toOptionalString(normalized.logo_url)
    || toOptionalString(colors.primary)
    || toOptionalString(colors.secondary)
    || Object.keys(asRecord(normalized.report_settings)).length
  );
}

async function loadPortalOrganizationContextForProject(manifest: ProjectManifest) {
  const orgId = await resolvePortalOrganizationIdForProject(manifest);
  if (!orgId) return null;
  const branchId = resolvePortalBranchIdForProject(manifest);
  const org = await readPortalOrganizationManifest(orgId, branchId);
  if (!org) return null;
  const branding = asRecord(org.branding);
  const colors = asRecord(branding.colors);
  const logo = await resolvePortalOrganizationLogo(firstLogoValue(branding, org), orgId);
  return normalizeOrganizationBrandingContext({
    source: "portal_organization_context",
    id: orgId,
    branch_id: branchId,
    name: toOptionalString(org.name) ?? "",
    logo_url: logo ?? undefined,
    primary_color: toOptionalString(colors.primary) ?? undefined,
    secondary_color: toOptionalString(colors.secondary) ?? undefined,
    branding: {
      logo: logo ?? undefined,
      colors: {
        ...(toOptionalString(colors.primary) ? { primary: toOptionalString(colors.primary) } : {}),
        ...(toOptionalString(colors.secondary) ? { secondary: toOptionalString(colors.secondary) } : {}),
        ...(toOptionalString(colors.accent) ? { accent: toOptionalString(colors.accent) } : {})
      }
    },
    report_settings: asRecord(org.report_settings)
  });
}

function resolvePortalBranchIdForProject(manifest: ProjectManifest) {
  const manifestRecord = asRecord(manifest);
  const teamRef = asRecord(manifestRecord.team_ref);
  const branchId = toOptionalString(manifestRecord.branch_id)
    ?? toOptionalString(manifestRecord.branchId)
    ?? toOptionalString(teamRef.branch_id)
    ?? toOptionalString(teamRef.branchId)
    ?? toOptionalString(teamRef.id)
    ?? "default";
  return normalizePortalBranchId(branchId);
}

async function resolvePortalOrganizationIdForProject(manifest: ProjectManifest) {
  const manifestRecord = asRecord(manifest);
  const organizationRef = asRecord(manifestRecord.organization_ref);
  const directOrgId = normalizePortalOrganizationId(
    toOptionalString(organizationRef.id)
      ?? toOptionalString(manifestRecord.organization_id)
  );
  if (directOrgId) return directOrgId;

  const ownerRef = asRecord(manifestRecord.owner_ref);
  const issuer = asRecord(manifestRecord.issuer);
  const emails = [
    toOptionalString(ownerRef.email),
    toOptionalString(manifestRecord.owner_email),
    toOptionalString(issuer.email)
  ].filter((value): value is string => !!value);

  for (const email of emails) {
    const userOrgId = await readPortalUserOrganizationId(email);
    if (userOrgId) return userOrgId;
  }

  return null;
}

function normalizePortalOrganizationId(value: unknown) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || null;
}

function normalizePortalBranchId(value: unknown) {
  return String(value ?? "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "default";
}

async function readPortalUserOrganizationId(email: string) {
  const fileName = `${String(email).trim().toLowerCase().replace(/[^a-z0-9@._+-]/g, "_")}.json`;
  const user = await readJsonIfExists(path.join(INTERNAL_USERS_DIR, fileName));
  return normalizePortalOrganizationId(asRecord(user).organization_id);
}

async function readPortalOrganizationManifest(orgId: string, branchId = "default") {
  const safeOrgId = normalizePortalOrganizationId(orgId);
  if (!safeOrgId) return null;
  const platformOrg = await readPlatformOrganizationBrandingContext(safeOrgId, branchId);
  if (platformOrg) return platformOrg;

  const candidates = [
    path.join(INTERNAL_ORGANIZATIONS_DIR, safeOrgId, "manifest.json"),
    path.join(INTERNAL_ROOT_DIR, "organizations", safeOrgId, "manifest.json")
  ];
  for (const candidate of candidates) {
    const org = await readJsonIfExists(candidate);
    if (org && typeof org === "object") return asRecord(org);
  }
  return null;
}

async function readPlatformOrganizationBrandingContext(orgId: string, branchId = "default") {
  const safeBranchId = normalizePortalBranchId(branchId);
  const [organization, global, branch, style] = await Promise.all([
    readOrganization(orgId).catch(() => null),
    readGlobal(orgId).catch(() => null),
    readDocument(orgId, "branch", safeBranchId).catch(() => null),
    readBranchModule(orgId, safeBranchId, "presentation_style").catch(() => null)
  ]);
  if (!organization && !global) return null;

  const globalData = asRecord(global?.data);
  const metadata = asRecord(organization?.metadata);
  const branchData = asRecord(branch?.data);
  const styleData = asRecord(style?.data);
  const legacyGlobal = asRecord(globalData.legacy_org_snapshot);
  const legacyMetadata = asRecord(metadata.legacy_snapshot);
  return {
    ...asRecord(organization),
    id: orgId,
    branch_id: safeBranchId,
    name: toOptionalString(branchData.name)
      ?? toOptionalString(styleData.companyName)
      ?? toOptionalString(organization?.name)
      ?? toOptionalString(globalData.name)
      ?? toOptionalString(legacyGlobal.name)
      ?? toOptionalString(legacyMetadata.name)
      ?? "",
    branding: mergeBrandingContextRecords(
      asRecord(legacyMetadata.branding),
      asRecord(legacyGlobal.branding),
      asRecord(organization?.branding),
      asRecord(metadata.branding),
      asRecord(globalData.branding),
      asRecord(branchData.branding),
      asRecord(styleData.branding)
    ),
    report_settings: {
      ...asRecord(legacyMetadata.report_settings),
      ...asRecord(legacyGlobal.report_settings),
      ...asRecord(globalData.report_settings),
      ...asRecord(branchData.report_settings),
      ...asRecord(styleData.report_settings)
    }
  };
}

function mergeBrandingContextRecords(...sources: Array<Record<string, unknown>>) {
  return sources.reduce<Record<string, unknown>>((merged, source) => {
    if (!Object.keys(source).length) return merged;
    return {
      ...merged,
      ...source,
      colors: {
        ...asRecord(merged.colors),
        ...asRecord(source.colors)
      }
    };
  }, {});
}

async function resolvePortalOrganizationLogo(logo: string | null | undefined, orgId: string) {
  const raw = toOptionalString(logo);
  if (!raw) return null;
  if (/^(?:[a-z]+:)?\/\//i.test(raw) || raw.startsWith("data:")) return raw;

  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  const candidates = normalized.startsWith("organizations/")
    ? [
        path.join(INTERNAL_ROOT_DIR, normalized),
        path.join(INTERNAL_ROOT_DIR, "storage", normalized)
      ]
    : [
        path.join(INTERNAL_ORGANIZATIONS_DIR, orgId, normalized),
        path.join(INTERNAL_ROOT_DIR, "organizations", orgId, normalized)
      ];

  for (const candidate of candidates) {
    const dataUrl = await readImageDataUrlIfExists(candidate);
    if (dataUrl) return dataUrl;
  }

  return raw;
}

async function readJsonIfExists(filePath: string) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

async function readImageDataUrlIfExists(filePath: string) {
  try {
    const resolved = path.resolve(filePath);
    const allowedRoots = [
      path.resolve(INTERNAL_ROOT_DIR),
      path.resolve(INTERNAL_ORGANIZATIONS_DIR)
    ];
    if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
      return null;
    }
    const bytes = await readFile(resolved);
    const mime = getMimeType(resolved);
    if (!mime.startsWith("image/")) return null;
    return `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

async function renderProjectPdfBatch(input: {
  projectId: string;
  snapshot: unknown;
  manifest: ProjectManifest;
  organization: Record<string, unknown>;
  outputs: SharedPdfOutputSpec[];
  request: FastifyRequest;
}) {
  return renderSharedProjectPdfs({
    snapshot: input.snapshot,
    manifest: input.manifest,
    organization: input.organization,
    assetBaseUrl: resolvePublicAssetBaseUrl(input.request),
    outputs: input.outputs
  });
}

function resolvePdfSnapshot(savedSnapshot: unknown, input: Record<string, unknown>) {
  if (input.source === "inline") {
    if (!Object.prototype.hasOwnProperty.call(input, "snapshot")) {
      throw badRequest("missing_pdf_snapshot", "An inline PDF render requires a snapshot payload.");
    }
    return input.snapshot;
  }
  const inlineSnapshot = Object.prototype.hasOwnProperty.call(input, "snapshot") ? input.snapshot : undefined;
  const snapshot = inlineSnapshot ?? savedSnapshot;
  if (!snapshot || typeof snapshot !== "object") {
    throw badRequest("missing_pdf_snapshot", "This project does not have a saved PDF snapshot yet.");
  }
  return snapshot;
}

function normalizePdfOutputs(input: Record<string, unknown>, defaultPersist: boolean) {
  const globalPersist = typeof input.persist_files === "boolean" ? input.persist_files : defaultPersist;
  const globalUpdateStatus = typeof input.update_status === "boolean" ? input.update_status : false;
  const rawOutputs = Array.isArray(input.outputs) && input.outputs.length > 0
    ? input.outputs
    : [
        { slot: "main", mode: "full", persist: globalPersist, update_status: globalUpdateStatus, apply_branding_to_full: true },
        { slot: "summary", mode: "summary", persist: globalPersist, update_status: false }
      ];

  return rawOutputs.map((output, index) => normalizePdfOutput(output, globalPersist, globalUpdateStatus, index));
}

function normalizePdfOutput(
  value: unknown,
  globalPersist: boolean,
  globalUpdateStatus: boolean,
  index: number
): SharedPdfOutputSpec {
  const raw = asRecord(value);
  const slot = raw.slot === "summary" ? "summary" : (raw.slot === "main" ? "main" : (index === 1 ? "summary" : "main"));
  const mode = raw.mode === "summary" ? "summary" : (raw.mode === "full" ? "full" : (slot === "summary" ? "summary" : "full"));
  const preparedResident = mapPreparedForToResident(asRecord(raw.prepared_for));
  const snapshotPatch = asRecord(raw.snapshot_patch);
  const mergedStatePatch = preparedResident
    ? mergeRecords(snapshotPatch, { report: mergeRecords(asRecord(snapshotPatch.report), { resident: preparedResident }) })
    : snapshotPatch;
  const organizationBranding = mapBrandingToOrganization(asRecord(raw.branding));
  const rawBrandingOverrides = Object.keys(asRecord(raw.brandingOverrides)).length > 0
    ? asRecord(raw.brandingOverrides)
    : asRecord(raw.branding_overrides);
  const useProjectOrganizationBranding = typeof raw.use_project_organization_branding === "boolean"
    ? raw.use_project_organization_branding
    : (typeof raw.useProjectOrganizationBranding === "boolean" ? raw.useProjectOrganizationBranding : undefined);
  const disableOrganizationBranding = typeof raw.disable_organization_branding === "boolean"
    ? raw.disable_organization_branding
    : (typeof raw.disableOrganizationBranding === "boolean" ? raw.disableOrganizationBranding : undefined);
  const clearBrandingOverrides = typeof raw.clear_branding_overrides === "boolean"
    ? raw.clear_branding_overrides
    : (typeof raw.clearBrandingOverrides === "boolean" ? raw.clearBrandingOverrides : undefined);

  return {
    slot,
    mode,
    outputFileName: typeof raw.file_name === "string" && raw.file_name.trim() ? raw.file_name.trim() : resolvePdfFileName(slot),
    coverTitle: typeof raw.cover_title === "string" && raw.cover_title.trim() ? raw.cover_title.trim() : undefined,
    pageConfigOverride: asRecord(raw.page_config),
    organizationBranding: organizationBranding || undefined,
    brandingOverrides: Object.keys(rawBrandingOverrides).length > 0 ? rawBrandingOverrides : undefined,
    useProjectOrganizationBranding: useProjectOrganizationBranding ?? (organizationBranding ? true : undefined),
    disableOrganizationBranding,
    applyBrandingToFull: typeof raw.apply_branding_to_full === "boolean"
      ? raw.apply_branding_to_full
      : (typeof raw.applyBrandingToFull === "boolean" ? raw.applyBrandingToFull : undefined),
    clearBrandingOverrides,
    persist: typeof raw.persist === "boolean" ? raw.persist : globalPersist,
    updateStatus: typeof raw.update_status === "boolean" ? raw.update_status : (slot === "main" ? globalUpdateStatus : false),
    statePatch: Object.keys(mergedStatePatch).length > 0 ? mergedStatePatch : undefined,
    pdfConfigPatch: asRecord(raw.pdf_config_patch)
  };
}

function resolvePublicAssetBaseUrl(request: FastifyRequest) {
  const configured = process.env.FIRSTMEASURE_PDF_RUNTIME_BASE_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, "");
  const port = Number.parseInt(String(process.env.V1_PORT ?? "3111"), 10);
  const configuredHost = String(process.env.V1_HOST ?? "").trim();
  const host = configuredHost && configuredHost !== "0.0.0.0" && configuredHost !== "::"
    ? configuredHost
    : "127.0.0.1";
  if (Number.isFinite(port) && port > 0) {
    return `http://${host}:${port}${buildApiPath("/pdf-runtime")}`;
  }
  return buildAbsoluteApiUrl(request, "/pdf-runtime");
}

function buildPdfClientRuntimeManifest(
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const baseUrl = buildAbsoluteApiUrl(request, "/pdf-runtime");
  return {
    renderer: "browser-shared-runtime",
    base_url: baseUrl,
    blank_url: `${baseUrl}/blank`,
    script_urls: {
      jspdf: `${baseUrl}/assets/jspdf`,
      pdf: `${baseUrl}/assets/pdf`,
      pdf_standalone: `${baseUrl}/assets/pdf-standalone`
    },
    asset_urls: {
      font_regular: `${baseUrl}/fonts/Montserrat-Regular.ttf`,
      font_bold: `${baseUrl}/fonts/Montserrat-Bold.ttf`,
      default_logo: `${baseUrl}/images/logo_red.png`
    }
  };
}

function getPdfRuntimeAssetName(params: unknown): SharedPdfClientAssetName {
  const asset = String((params as Record<string, unknown> | undefined)?.asset ?? "").trim().toLowerCase();
  switch (asset) {
    case "jspdf":
      return "jspdf";
    case "pdf":
      return "pdf";
    case "pdf-standalone":
      return "pdf-standalone";
    case "font-regular":
      return "font-regular";
    case "font-bold":
      return "font-bold";
    case "default-logo":
      return "default-logo";
    default:
      throw badRequest("unknown_pdf_runtime_asset", `Unknown PDF runtime asset '${asset}'.`);
  }
}

function mapBrandingToOrganization(branding: Record<string, unknown>) {
  const logo = firstLogoValue(branding) ?? null;
  const primary = typeof branding.primary_color === "string" && branding.primary_color.trim() ? branding.primary_color.trim() : null;
  const secondary = typeof branding.secondary_color === "string" && branding.secondary_color.trim() ? branding.secondary_color.trim() : null;
  if (!logo && !primary && !secondary) return null;
  return {
    logo: logo || undefined,
    colors: {
      ...(primary ? { primary } : {}),
      ...(secondary ? { secondary } : {})
    }
  };
}

function mapPreparedForToResident(preparedFor: Record<string, unknown>) {
  const name = typeof preparedFor.name === "string" ? preparedFor.name : "";
  const email = typeof preparedFor.email === "string" ? preparedFor.email : "";
  const phone = typeof preparedFor.phone === "string" ? preparedFor.phone : "";
  if (!name && !email && !phone) return null;
  return { name, email, phone };
}

function mergeRecords(base: Record<string, unknown>, patch: Record<string, unknown>) {
  return {
    ...base,
    ...patch
  };
}

async function renderStoredProject(
  projectId: string,
  input: RenderReportInput,
  options: {
    wholeDocument: boolean;
    storedFileName?: string;
    title?: string;
  }
) {
  const manifest = await readManifest(projectId);
  const brandingDefaults = await readBrandingDefaults(projectId);
  return renderProjectPdf(manifest, {
    ...input,
    branding: resolveBranding(input.branding, brandingDefaults)
  }, options);
}

async function renderInlineProject(
  body: unknown,
  input: RenderReportInput,
  options: {
    wholeDocument: boolean;
    storedFileName?: string;
    title?: string;
  }
) {
  return renderProjectPdf(buildInlineManifest(body), {
    ...input,
    branding: resolveBranding(input.branding, asRecord(asRecord(body).branding_defaults))
  }, options);
}

function getProjectId(params: unknown) {
  const projectId = String((params as Record<string, unknown>).id ?? "");
  if (!projectId.trim()) {
    throw badRequest("missing_project_id", "Project id is required.");
  }
  return projectId;
}

function getFileName(params: unknown) {
  const fileName = String((params as Record<string, unknown>).name ?? "");
  if (!fileName.trim()) {
    throw badRequest("missing_file_name", "File name is required.");
  }
  return fileName;
}

function getSourceQuery(query: unknown) {
  const source = String((query as Record<string, unknown> | undefined)?.source ?? "stored");
  return source === "custom" ? "custom" : "stored";
}

function getPdfSlotQuery(query: unknown): PdfSlot {
  return resolveOutputSlot((query as Record<string, unknown> | undefined)?.slot);
}

function getXmlFormatQuery(query: unknown) {
  return (query as Record<string, unknown> | undefined)?.format;
}

function resolveOutputSlot(value: unknown): PdfSlot {
  return value === "summary" ? "summary" : "main";
}

function resolvePdfFileName(slot: PdfSlot) {
  return slot === "summary" ? PDF_FILE_NAMES.summary : PDF_FILE_NAMES.main;
}

function matchesProjectQuery(manifest: ProjectManifest, query: Record<string, unknown>) {
  if (query.search) {
    const needle = String(query.search).toLowerCase();
    const haystack = `${manifest.id} ${manifest.address} ${manifest.status}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (Array.isArray(query.statuses) && query.statuses.length > 0 && !query.statuses.includes(manifest.status)) {
    return false;
  }
  if (query.project_type && String(query.project_type) !== String(manifest.project_type)) {
    return false;
  }
  if (query.owner_email && String(query.owner_email) !== String(asRecord(manifest.owner_ref).email ?? "")) {
    return false;
  }
  if (query.organization_id && String(query.organization_id) !== String(asRecord(manifest.organization_ref).id ?? "")) {
    return false;
  }
  if (query.team_id && String(query.team_id) !== String(asRecord(manifest.team_ref).id ?? "")) {
    return false;
  }
  if (typeof query.has_report_pdf === "boolean") {
    const hasReport = Boolean(asRecord(manifest.artifacts).has_report_pdf);
    if (hasReport !== query.has_report_pdf) return false;
  }
  return true;
}

function buildInlineManifest(body: unknown): ProjectManifest {
  const source = asRecord(body);
  const complexity = (typeof source.complexity === "number" || typeof source.complexity === "string")
    ? source.complexity
    : null;
  return {
    schema_version: 1,
    id: "inline",
    status: "inline",
    project_type: String(source.project_type ?? "residential"),
    address: String(source.address ?? "Inline Render"),
    components: asRecord(source.components),
    lat: typeof source.lat === "number" ? source.lat : null,
    lng: typeof source.lng === "number" ? source.lng : null,
    pins: Array.isArray(source.pins) ? source.pins as Array<{ lat: number; lng: number }> : [],
    include_gutter_measurements: Boolean(source.include_gutter_measurements),
    include_weather_report: Boolean(source.include_weather_report),
    weather_report_tier: source.weather_report_tier == null ? null : String(source.weather_report_tier),
    weather_report_id: source.weather_report_id == null ? null : String(source.weather_report_id),
    weather_report_pdf_url: source.weather_report_pdf_url == null ? null : String(source.weather_report_pdf_url),
    radius_meters: typeof source.radius_meters === "number" ? source.radius_meters : null,
    complexity,
    point_value: firstMeasurePointValueForComplexity(complexity)
      ?? (typeof source.point_value === "number" && Number.isFinite(source.point_value) ? source.point_value : null),
    is_custom_pin: Boolean(source.is_custom_pin),
    is_filler: Boolean(source.is_filler),
    is_vip: Boolean(source.is_vip),
    is_expedited: Boolean(source.is_expedited),
    report_expedite_option: source.report_expedite_option == null ? null : String(source.report_expedite_option),
    report_expedite_label: source.report_expedite_label == null ? null : String(source.report_expedite_label),
    report_due_window_start: source.report_due_window_start == null ? null : String(source.report_due_window_start),
    report_due_window_end: source.report_due_window_end == null ? null : String(source.report_due_window_end),
    report_due_window_label: source.report_due_window_label == null ? null : String(source.report_due_window_label),
    report_production_deadline_at: source.report_production_deadline_at == null ? null : String(source.report_production_deadline_at),
    report_release_hold_enabled: source.report_release_hold_enabled == null ? null : source.report_release_hold_enabled === true,
    instant_enabled: Boolean(source.instant_enabled ?? source.instant_only),
    instant_only: Boolean(source.instant_only),
    owner_ref: asRecord(source.owner_ref),
    organization_ref: asRecord(source.organization_ref),
    team_ref: asRecord(source.team_ref),
    resident: asRecord(source.resident),
    issuer: asRecord(source.issuer),
    cc_emails: Array.isArray(source.cc_emails) ? source.cc_emails.map((value) => String(value)) : [],
    tech_notes: source.tech_notes == null ? null : String(source.tech_notes),
    amount_charged: typeof source.amount_charged === "number" ? source.amount_charged : 0,
    timestamps: asRecord(source.timestamps),
    workflow: asRecord(source.workflow),
    audit: asRecord(source.audit),
    delivery: asRecord(source.delivery),
    artifacts: asRecord(source.artifacts)
  };
}

async function buildEditorBundle(
  projectId: string,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const detail = await getProjectDetail(projectId);
  const organization = await resolveProjectOrganizationContext(projectId, detail.manifest, detail.branding_defaults);
  const files = detail.files;
  const assets: Record<string, string> = {};
  let insights: unknown = null;

  for (const file of files) {
    const baseName = path.parse(file.name).name.toLowerCase();
    assets[baseName] = buildProjectArtifactUrl(request, projectId, file.name, stableFileVersion(file));
    if (file.name === "insights.json") {
      try {
        const artifact = await readArtifact(projectId, file.name);
        insights = JSON.parse(artifact.content.toString("utf8"));
      } catch {
        insights = null;
      }
    }
  }

  if (await projectGoogle3dCaptureExists(projectId)) {
    assets.google_3d_manifest = buildAbsoluteApiUrl(request, buildProjectGoogle3dManifestRoute(projectId));
  }

  return {
    manifest: detail.manifest,
    app_metadata: detail.app_metadata ?? {},
    pdf_state: detail.pdf_state ?? null,
    pdf_state_asset: buildAbsoluteApiUrl(request, `/projects/${encodeURIComponent(projectId)}/editor/pdf-state`),
    assets,
    insights,
    organization,
    files
  };
}

async function buildInstantResponse(
  projectId: string,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const detail = await getProjectDetail(projectId);
  const manifest = detail.manifest;
  const files = new Set(detail.files.map((file) => file.name.toLowerCase()));
  const buildAssetUrl = (fileName: string) => (
    files.has(fileName.toLowerCase())
      ? buildProjectArtifactUrl(request, projectId, fileName)
      : null
  );
  if (!projectHasInstantArtifacts(manifest) && !manifest.instant_enabled && !manifest.instant_only) {
    throw badRequest(
      "instant_not_available",
      "This project does not have FirstMeasure Instant data yet."
    );
  }

  const [insightsArtifact, structureInsightsArtifact] = await Promise.all([
    readArtifact(projectId, "insights.json").catch(() => null),
    readArtifact(projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME).catch(() => null)
  ]);
  if (!insightsArtifact) {
    return buildPendingProjectInstantPayload({
      manifest,
      assetUrls: {
        preview_image_url: buildAssetUrl("google.png"),
        solar_rgb_url: buildAssetUrl("rgb.tif"),
        height_map_url: buildAssetUrl("dsm.tif"),
        mask_url: buildAssetUrl("mask.tif"),
        insights_url: null,
        structure_insights_url: buildAssetUrl(INSTANT_STRUCTURE_INSIGHTS_FILE_NAME),
        instant_pdf_url: buildAssetUrl(INSTANT_PDF_FILE_NAME)
      }
    });
  }

  const [heightMapArtifact, maskArtifact] = await Promise.all([
    readArtifact(projectId, "dsm.tif").catch(() => null),
    readArtifact(projectId, "mask.tif").catch(() => null)
  ]);
  const rgbArtifact = await readArtifact(projectId, "rgb.tif").catch(() => null);
  const insights = JSON.parse(insightsArtifact.content.toString("utf8"));
  const structureInsights = structureInsightsArtifact
    ? JSON.parse(structureInsightsArtifact.content.toString("utf8"))
    : null;

  const instantPdf = triggerInstantPdfArtifact({
    projectId,
    manifest,
    brandingDefaults: detail.branding_defaults ?? null,
    insights,
    structureInsights,
    rgbContent: rgbArtifact?.content ?? null,
    heightMapContent: heightMapArtifact?.content ?? null,
    maskContent: maskArtifact?.content ?? null
  });

  if (instantPdf?.fileName) {
    files.add(instantPdf.fileName.toLowerCase());
  } else if (Boolean(asRecord(manifest.artifacts).has_instant_pdf)) {
    files.add(INSTANT_PDF_FILE_NAME.toLowerCase());
  }

  const payload = buildProjectInstantPayload({
    manifest,
    insights,
    structureInsights,
    assetUrls: {
      preview_image_url: buildAssetUrl("google.png"),
      solar_rgb_url: buildAssetUrl("rgb.tif"),
      height_map_url: buildAssetUrl("dsm.tif"),
      mask_url: buildAssetUrl("mask.tif"),
      insights_url: buildAssetUrl("insights.json"),
      structure_insights_url: buildAssetUrl(INSTANT_STRUCTURE_INSIGHTS_FILE_NAME),
      instant_pdf_url: buildAssetUrl(INSTANT_PDF_FILE_NAME)
    }
  });
  const renderData = await buildInstantRenderData({
    heightMapContent: heightMapArtifact?.content ?? null,
    maskContent: maskArtifact?.content ?? null
  }).catch(() => null);
  return {
    ...payload,
    instant_pdf: {
      status: instantPdf?.status ?? "pending",
      error: instantPdf?.error ?? null
    },
    ...(renderData ? { render_data: renderData } : {})
  };
}

async function ensureProjectInstantResponse(
  projectId: string,
  request: {
    body?: unknown;
    headers: Record<string, unknown>;
    protocol?: string;
  }
) {
  const manifest = await readManifest(projectId);
  const requestBody = asRecord(request.body);
  const existingStructureInsights = await readArtifact(projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME).catch(() => null);
  let repaired = false;

  if (
    Boolean(requestBody.force)
    || projectNeedsInstantStructureRepair(manifest, existingStructureInsights?.content ?? null)
    || projectNeedsPartialInstantRefundRefresh(manifest, existingStructureInsights?.content ?? null)
  ) {
    await processProjectInsights(projectId, {
      address: manifest.address,
      lat: manifest.lat,
      lng: manifest.lng,
      radius_meters: manifest.radius_meters
    });
    repaired = true;
  }

  return {
    repaired,
    instant: await buildInstantResponse(projectId, request)
  };
}

function buildProjectArtifactUrl(
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  projectId: string,
  fileName: string,
  version?: string | null
) {
  const query = version ? `?v=${encodeURIComponent(version)}` : "";
  return buildAbsoluteApiUrl(
    request,
    `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(fileName)}${query}`
  );
}

function stableFileVersion(file: { size?: number; updated_at?: string }) {
  const updatedAt = String(file.updated_at ?? "").trim();
  const size = Number(file.size);
  const sizePart = Number.isFinite(size) && size >= 0 ? String(size) : "";
  return [updatedAt, sizePart].filter(Boolean).join("-");
}

function buildProjectThumbnailUrl(
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  projectId: string,
  source?: string | null
) {
  const query = new URLSearchParams();
  query.set("w", String(PROJECT_THUMBNAIL_DEFAULT_WIDTH));
  if (source) query.set("source", source);
  return buildAbsoluteApiUrl(
    request,
    `/projects/${encodeURIComponent(projectId)}/thumbnail?${query.toString()}`
  );
}

async function sendArtifactContent(
  artifact: { name: string; path: string; content: Buffer },
  reply: FastifyReply
) {
  const fileStat = await stat(artifact.path).catch(() => null);
  const etag = fileStat ? buildWeakEtag(artifact.name, fileStat.size, fileStat.mtimeMs) : null;
  if (etag && requestHasMatchingEtag(reply.request, etag)) {
    reply.code(304);
    return reply.send();
  }
  reply.type(getMimeType(artifact.name));
  reply.header("Content-Disposition", `inline; filename="${artifact.name}"`);
  reply.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
  if (etag) reply.header("ETag", etag);
  if (fileStat) reply.header("Last-Modified", fileStat.mtime.toUTCString());
  return reply.send(artifact.content);
}

async function sendProjectThumbnail(projectId: string, query: Record<string, unknown>, reply: FastifyReply) {
  const width = clampThumbnailWidth(query.w ?? query.width);
  const format = String(query.format ?? "webp").trim().toLowerCase() === "jpeg" ? "jpeg" : "webp";
  const requestedSource = String(query.source ?? "").trim();
  await readManifest(projectId);
  const sources = Array.from(new Set([
    requestedSource,
    "browser_thumbnail.webp",
    "browser_thumbnail.jpg",
    "browser_thumbnail.jpeg",
    "browser_thumbnail.png",
    "google.png",
    "azure.png",
    "apple.png",
    "rgb.png",
    "rgb.jpg",
    "rgb.tif"
  ].filter(Boolean)));

  for (const source of sources) {
    const cachedPath = thumbnailCachePath(projectId, source, width, format);
    const cached = await readCachedThumbnail(cachedPath, reply);
    if (cached) return cached;

    const artifact = await readProjectArtifactFile(projectId, source).catch(() => null);
    if (!artifact) continue;

    let sharp: any;
    try {
      sharp = (await import("sharp")).default;
    } catch (error) {
      reply.header("X-FirstMeasure-Thumbnail-Fallback", "sharp_unavailable");
      return sendArtifactContent(artifact, reply);
    }

    const generated = await sharp(artifact.content, {
        limitInputPixels: 12000 * 12000,
        failOn: "none"
      })
        .rotate()
        .resize({
          width,
          height: width,
          fit: "cover",
          withoutEnlargement: true
        })
        [format]({
          quality: format === "jpeg" ? 78 : 72,
          effort: format === "webp" ? 4 : undefined
        })
        .toBuffer();

    await mkdir(path.dirname(cachedPath), { recursive: true });
    await writeFile(cachedPath, generated);
    const fileStat = await stat(cachedPath).catch(() => undefined);
    return sendThumbnailBuffer(generated, cachedPath, format, reply, fileStat);
  }

  throw badRequest("thumbnail_source_not_found", "No thumbnail-compatible project image was found.");
}

async function readProjectArtifactFile(projectId: string, fileName: string) {
  return readArtifact(projectId, sanitizeFileName(fileName));
}

async function readCachedThumbnail(cachedPath: string, reply: FastifyReply) {
  const fileStat = await stat(cachedPath).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return null;
  const etag = buildWeakEtag(path.basename(cachedPath), fileStat.size, fileStat.mtimeMs);
  if (requestHasMatchingEtag(reply.request, etag)) {
    reply.code(304);
    return reply.send();
  }
  return sendThumbnailBuffer(await readFile(cachedPath), cachedPath, thumbnailFormatFromPath(cachedPath), reply, fileStat);
}

function sendThumbnailBuffer(
  content: Buffer,
  filePath: string,
  format: "webp" | "jpeg",
  reply: FastifyReply,
  fileStat?: { size: number; mtimeMs: number; mtime: Date }
) {
  const etag = buildWeakEtag(path.basename(filePath), fileStat?.size ?? content.length, fileStat?.mtimeMs ?? Date.now());
  reply.type(format === "jpeg" ? "image/jpeg" : "image/webp");
  reply.header("Cache-Control", `public, max-age=${PROJECT_THUMBNAIL_CACHE_MAX_AGE_SECONDS}, stale-while-revalidate=86400`);
  reply.header("Content-Disposition", `inline; filename="${path.basename(filePath)}"`);
  reply.header("ETag", etag);
  if (fileStat) reply.header("Last-Modified", fileStat.mtime.toUTCString());
  return reply.send(content);
}

function thumbnailCachePath(projectId: string, source: string, width: number, format: "webp" | "jpeg") {
  const safeSource = path.basename(source).replace(/[^a-z0-9._-]/gi, "_");
  return path.join(projectDir(projectId), "_thumbnails", `${PROJECT_THUMBNAIL_FILE_NAME}_${width}_${safeSource}.${format}`);
}

function thumbnailFormatFromPath(filePath: string): "webp" | "jpeg" {
  return filePath.toLowerCase().endsWith(".jpeg") || filePath.toLowerCase().endsWith(".jpg") ? "jpeg" : "webp";
}

function clampThumbnailWidth(value: unknown) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return PROJECT_THUMBNAIL_DEFAULT_WIDTH;
  return Math.max(96, Math.min(PROJECT_THUMBNAIL_MAX_WIDTH, parsed));
}

function buildWeakEtag(name: string, size: number, mtimeMs: number) {
  return `W/"${Buffer.from(`${name}:${size}:${Math.round(mtimeMs)}`).toString("base64url")}"`;
}

function requestHasMatchingEtag(request: FastifyRequest, etag: string) {
  const value = String(request.headers["if-none-match"] ?? "");
  return value.split(",").map((part) => part.trim()).includes(etag);
}

function buildQueueOverviewCompatCacheKey(
  input: Record<string, unknown>,
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  teamId: string,
  view: ProjectListView
) {
  const host = String(request.headers["x-forwarded-host"] ?? request.headers.host ?? "");
  const proto = String(request.headers["x-forwarded-proto"] ?? request.protocol ?? "");
  return JSON.stringify({
    host,
    proto,
    teamId,
    view,
    include: input.include ?? null,
    bucket_limit: input.bucket_limit ?? input.limit ?? null,
    legacy_full: toBooleanish(input.legacy_full)
  });
}

function pruneExpiredQueueOverviewCompatCache() {
  if (queueOverviewCompatCache.size < 100) return;
  const now = Date.now();
  for (const [key, entry] of queueOverviewCompatCache) {
    if (entry.expiresAt <= now) queueOverviewCompatCache.delete(key);
  }
}

function buildAbsoluteApiUrl(
  request: {
    headers: Record<string, unknown>;
    protocol?: string;
  },
  routePath: string
) {
  const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const protocol = forwardedProto || request.protocol || "http";
  const forwardedHost = String(request.headers["x-forwarded-host"] ?? "").split(",")[0]?.trim();
  const host = forwardedHost || String(request.headers.host ?? "127.0.0.1:3111");
  return `${protocol}://${host}${buildApiPath(routePath)}`;
}

function buildApiPath(routePath: string) {
  return `/v1/firstmeasure${routePath}`;
}

function sanitizeUploadFileName(fieldName: string, fileName?: string) {
  const preferred = String(fileName ?? "").trim();
  if (preferred) return preferred;
  const cleanedField = String(fieldName || "upload").trim().replace(/[^a-z0-9._-]/gi, "_");
  return `${cleanedField || "upload"}.bin`;
}

function tryParseJsonBuffer(buffer: Buffer) {
  return tryParseJsonString(buffer.toString("utf8"), null);
}

function tryParseJsonString(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch {
    return fallback;
  }
}

function extractRadiusFromMetadata(value: unknown) {
  const metadata = asRecord(value);
  const layerConfig = asRecord(metadata.layer_config);
  const radius = asRecord(layerConfig.__radius).scale;
  return typeof radius === "number" && Number.isFinite(radius) && radius > 0
    ? radius
    : null;
}

function toFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : null);
}

function resolveGoogle3dCaptureRadius(body: Record<string, unknown>, manifest: ProjectManifest) {
  const requestedRadius = toFiniteNumber(body.radius_meters) ?? toFiniteNumber(body.capture_radius_meters);
  if (requestedRadius && requestedRadius > 0) {
    return Math.max(80, Math.min(180, requestedRadius));
  }

  const manifestRadius = typeof manifest.radius_meters === "number" && Number.isFinite(manifest.radius_meters)
    ? manifest.radius_meters
    : null;
  return Math.max(100, Math.min(180, (manifestRadius ?? 50) * 2));
}

function toOptionalString(value: unknown) {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeQaTeamFilter(value: unknown) {
  const text = toOptionalString(value);
  if (!text) return null;
  const normalized = text.toLowerCase();
  if (normalized === "default" || normalized === "all") return null;
  return text;
}

async function acceptProcessRequest(
  kind: "imagery" | "mask" | "insights",
  projectId: string,
  body: unknown,
  reply: FastifyReply
) {
  const input = asRecord(body);
  if (kind === "imagery" && wantsBackgroundProcessing(input)) {
    await patchManifest(projectId, {
      status: "needs_structure_pins",
      structure_pin_status: "generating",
      structure_pin_error: null,
      timestamps: {
        structure_pins_generation_started_at: new Date().toISOString()
      }
    });
    void runBackgroundImageryProcess(projectId, input);
    const project = await getProjectDetail(projectId);
    reply.code(202);
    return {
      ok: true,
      accepted: true,
      background: true,
      process: kind,
      project_id: projectId,
      project
    };
  }

  if (kind === "imagery") {
    const billing = await finalizePublicApiStructurePinBilling(projectId, body);
    if ("rejected" in billing && billing.rejected) {
      const project = await getProjectDetail(projectId);
      reply.code(402);
      return {
        ok: false,
        success: false,
        accepted: false,
        error: "api_structure_pin_billing_failed",
        message: billing.message,
        billing,
        project
      };
    }
  }

  let result;
  if (kind === "imagery") {
    result = await processProjectImagery(projectId, input);
  } else if (kind === "mask") {
    result = await processProjectMask(projectId, input);
  } else {
    result = await processProjectInsights(projectId, input);
  }
  const project = await getProjectDetail(projectId);
  reply.code(200);
  return {
    ok: true,
    accepted: true,
    process: kind,
    project_id: projectId,
    generated_files: result.generated_files,
    project
  };
}

function wantsBackgroundProcessing(input: Record<string, unknown>) {
  return input.process_async === true || input.background === true || input.async === true;
}

async function runBackgroundImageryProcess(projectId: string, input: Record<string, unknown>) {
  try {
    const billing = await finalizePublicApiStructurePinBilling(projectId, input);
    if ("rejected" in billing && billing.rejected) return;
    await processProjectImagery(projectId, input);
    await patchManifest(projectId, {
      structure_pin_status: "ready",
      structure_pin_error: null,
      timestamps: {
        structure_pins_processed_at: new Date().toISOString()
      }
    });
  } catch (error) {
    await patchManifest(projectId, {
      status: "needs_structure_pins",
      structure_pin_status: "failed",
      structure_pin_error: String((error as Error)?.message ?? error ?? "Pin generation failed."),
      timestamps: {
        structure_pins_failed_at: new Date().toISOString()
      }
    }).catch(() => null);
  }
}

async function finalizePublicApiStructurePinBilling(projectId: string, body: unknown) {
  const manifest = await readManifest(projectId);
  const publicApi = asRecord((manifest as Record<string, unknown>).public_api);
  const orgRef = asRecord((manifest as Record<string, unknown>).organization_ref);
  const orgId = String(orgRef.id ?? "").trim();
  const publicKeyId = String(publicApi.key_id ?? "").trim();
  if (!orgId || !publicKeyId) {
    return { skipped: true, reason: "not_public_api_project" };
  }

  const mode = String((manifest as Record<string, unknown>).structure_pin_mode ?? "").trim().toLowerCase();
  const wasApiNoPinOrder = mode === "all_structures_on_parcel" || mode === "employee_supplied";
  if (!wasApiNoPinOrder) {
    return { skipped: true, reason: "not_employee_pin_order" };
  }

  const pins = Array.isArray((manifest as Record<string, unknown>).pins)
    ? ((manifest as Record<string, unknown>).pins as unknown[])
    : [];
  const pinCount = countManifestPins(manifest);
  if (pinCount < 1) {
    return { skipped: true, reason: "no_structure_pins" };
  }

  const currentAmount = moneyAmount((manifest as Record<string, unknown>).amount_charged);
  const finalAmount = firstMeasurePublicReportAmount({
    project_type: (manifest as Record<string, unknown>).project_type,
    report_mode: (manifest as Record<string, unknown>).report_mode,
    report_expedite_option: (manifest as Record<string, unknown>).report_expedite_option,
    include_gutter_measurements: (manifest as Record<string, unknown>).include_gutter_measurements,
    include_weather_report: (manifest as Record<string, unknown>).include_weather_report,
    pins
  });
  const delta = moneyAmount(finalAmount - currentAmount);
  if (delta <= 0) {
    return { ok: true, skipped: true, reason: "already_fully_charged", final_amount: finalAmount, current_amount: currentAmount };
  }

  const report = await findPublicFirstMeasureReportByProjectId(orgId, projectId);
  if (!report) {
    return { skipped: true, reason: "public_report_record_missing", final_amount: finalAmount, current_amount: currentAmount };
  }

  const actor = asRecord(asRecord(body).actor);
  const actorEmail = String(actor.email ?? asRecord((manifest as Record<string, unknown>).issuer).email ?? `api+${publicKeyId.toLowerCase()}@firstmeasure.internal`).trim();
  const baseChargeToken = String((manifest as Record<string, unknown>).charge_token ?? report.charge_token ?? "").trim();
  const deltaChargeToken = `${baseChargeToken || report.report_id}:structure_pins:${pinCount}:${finalAmount}`;
  try {
    const charge = await chargePublicFirstMeasureOrder({
      orgId,
      amount: delta,
      actorEmail,
      meta: {
        charge_token: deltaChargeToken,
        parent_charge_token: baseChargeToken || null,
        public_report_id: report.report_id,
        external_id: report.external_id,
        address: (manifest as Record<string, unknown>).address ?? null,
        project_type: (manifest as Record<string, unknown>).project_type ?? "residential",
        report_mode: (manifest as Record<string, unknown>).report_mode ?? "full",
        pin_count: pinCount,
        previous_amount: currentAmount,
        final_amount: finalAmount,
        source: "public_firstmeasure_api_structure_pin_finalization"
      }
    });

    const autoTopup = asRecord(asRecord(charge).auto_topup);
    if (Object.keys(autoTopup).length > 0 && autoTopup.success === false) {
      await refundPublicFirstMeasureOrder({
        orgId,
        amount: delta,
        actorEmail,
        meta: {
          charge_token: deltaChargeToken,
          public_report_id: report.report_id,
          project_id: projectId,
          reason: "auto_topup_failed_after_structure_pin_delta",
          auto_topup: autoTopup
        }
      }).catch(() => null);
      return rejectPublicApiStructurePinBilling(projectId, {
        orgId,
        reportId: report.report_id,
        pinCount,
        currentAmount,
        finalAmount,
        delta,
        message: "This API report was rejected because the organization did not have enough credits for the additional structures and auto top-up failed."
      });
    }

    await updatePublicFirstMeasureReportRecord(report.report_id, orgId, {
      amount_charged: finalAmount,
      metadata: {
        structure_pin_billing: {
          status: "finalized",
          finalized_at: new Date().toISOString(),
          pin_count: pinCount,
          previous_amount: currentAmount,
          final_amount: finalAmount,
          delta_charged: delta
        }
      }
    });
    await patchManifest(projectId, {
      amount_charged: finalAmount,
      public_api: {
        structure_pin_billing: {
          status: "finalized",
          finalized_at: new Date().toISOString(),
          pin_count: pinCount,
          previous_amount: currentAmount,
          final_amount: finalAmount,
          delta_charged: delta,
          ledger_count: charge.ledger_count ?? null,
          auto_topup: asRecord(charge).auto_topup ?? null
        }
      }
    });
    return { ok: true, finalized: true, final_amount: finalAmount, delta_charged: delta, pin_count: pinCount, balance: charge.balance };
  } catch (error) {
    return rejectPublicApiStructurePinBilling(projectId, {
      orgId,
      reportId: report.report_id,
      pinCount,
      currentAmount,
      finalAmount,
      delta,
      message: "This API report was rejected because the organization did not have enough credits for the additional structures.",
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function rejectPublicApiStructurePinBilling(
  projectId: string,
  input: {
    orgId: string;
    reportId: string;
    pinCount: number;
    currentAmount: number;
    finalAmount: number;
    delta: number;
    message: string;
    error?: string;
  }
) {
  const nowSql = toSqlDateString(new Date());
  await updatePublicFirstMeasureReportRecord(input.reportId, input.orgId, {
    metadata: {
      structure_pin_billing: {
        status: "rejected",
        rejected_at: new Date().toISOString(),
        pin_count: input.pinCount,
        previous_amount: input.currentAmount,
        final_amount: input.finalAmount,
        delta_required: input.delta,
        error: input.error ?? null
      }
    }
  }).catch(() => null);
  await patchManifest(projectId, {
    status: "rejected",
    structure_pin_status: "rejected",
    structure_pin_error: input.message,
    rejection_reason: "api_insufficient_credits",
    rejection_message: input.message,
    refund_pending: false,
    timestamps: {
      rejected_at: nowSql
    },
    public_api: {
      structure_pin_billing: {
        status: "rejected",
        rejected_at: new Date().toISOString(),
        pin_count: input.pinCount,
        previous_amount: input.currentAmount,
        final_amount: input.finalAmount,
        delta_required: input.delta,
        error: input.error ?? null
      }
    }
  });
  const email = await sendProjectRejectionEmail(projectId, true).catch((error) => ({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  return {
    rejected: true,
    message: input.message,
    pin_count: input.pinCount,
    current_amount: input.currentAmount,
    final_amount: input.finalAmount,
    delta_required: input.delta,
    email
  };
}

function moneyAmount(value: unknown) {
  const number = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function resolveBranding(requestBranding: unknown, brandingDefaults: unknown) {
  return mergeBrandingVariant(
    extractBrandingVariant(brandingDefaults),
    extractBrandingVariant(requestBranding)
  );
}

function extractBrandingVariant(source: unknown) {
  for (const candidate of collectBrandingVariantRecords(source)) {
    if (isBrandingVariant(candidate)) {
      return normalizeBrandingVariant(candidate);
    }
  }

  return {};
}

function isBrandingVariant(value: Record<string, unknown>) {
  const colors = asRecord(value.colors);
  return typeof value.logo === "string"
    || typeof value.logo_node_url === "string"
    || typeof value.logo_url === "string"
    || typeof value.logoDataUrl === "string"
    || typeof value.logo_data_url === "string"
    || typeof value.logo_path === "string"
    || typeof value.primary_color === "string"
    || typeof value.primary === "string"
    || typeof value.primaryColor === "string"
    || typeof value.secondary_color === "string"
    || typeof value.secondary === "string"
    || typeof value.secondaryColor === "string"
    || typeof value.accent_color === "string"
    || typeof value.accent === "string"
    || typeof colors.primary === "string"
    || typeof colors.secondary === "string"
    || typeof colors.accent === "string";
}

function normalizeBrandingVariant(value: Record<string, unknown>) {
  const colors = asRecord(value.colors);
  const logo = toOptionalString(value.logo_url)
    ?? toOptionalString(value.logo)
    ?? toOptionalString(value.logo_node_url)
    ?? toOptionalString(value.logoDataUrl)
    ?? toOptionalString(value.logo_data_url)
    ?? toOptionalString(value.logo_path)
    ?? toOptionalString(asRecord(value.logo).url)
    ?? toOptionalString(asRecord(value.logo).path);
  const primary = toOptionalString(value.primary_color)
    ?? toOptionalString(value.primary)
    ?? toOptionalString(value.primaryColor)
    ?? toOptionalString(colors.primary)
    ?? toOptionalString(value.accent_color)
    ?? toOptionalString(value.accent)
    ?? toOptionalString(colors.accent);
  const secondary = toOptionalString(value.secondary_color)
    ?? toOptionalString(value.secondary)
    ?? toOptionalString(value.secondaryColor)
    ?? toOptionalString(colors.secondary);
  return {
    ...value,
    ...(logo ? { logo_url: logo } : {}),
    ...(primary ? { primary_color: primary } : {}),
    ...(secondary ? { secondary_color: secondary } : {})
  };
}

function collectBrandingVariantRecords(source: unknown) {
  const root = asRecord(source);
  const nestedBranding = asRecord(root.branding);
  const records: Record<string, unknown>[] = [root, nestedBranding];
  for (const key of ["report", "default", "full", "main", "summary"]) {
    records.push(asRecord(root[key]));
    records.push(asRecord(nestedBranding[key]));
  }
  return records.filter((record) => Object.keys(record).length > 0);
}

function mergeBrandingVariant(...variants: Array<Record<string, unknown>>) {
  return variants.reduce<Record<string, unknown>>((merged, variant) => ({
    ...merged,
    ...variant
  }), {});
}

function getMimeType(fileName: string) {
  switch (path.extname(fileName).toLowerCase()) {
    case ".glb": return "model/gltf-binary";
    case ".json": return "application/json; charset=utf-8";
    case ".pdf": return "application/pdf";
    case ".xml": return "application/xml; charset=utf-8";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".txt": return "text/plain; charset=utf-8";
    default: return "application/octet-stream";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function countManifestPins(manifest: ProjectManifest) {
  if (!Array.isArray(manifest.pins)) {
    return 0;
  }
  return manifest.pins.reduce((count, pin) => {
    const lat = typeof pin?.lat === "number" ? pin.lat : Number(pin?.lat);
    const lng = typeof pin?.lng === "number" ? pin.lng : Number(pin?.lng);
    return Number.isFinite(lat) && Number.isFinite(lng) ? count + 1 : count;
  }, 0);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length || 1));
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

function countStructureArtifactEntries(content: Buffer | null) {
  if (!content) {
    return 0;
  }
  try {
    const parsed = JSON.parse(content.toString("utf8"));
    const structures = asRecord(parsed).structures;
    return Array.isArray(structures) ? structures.length : 0;
  } catch {
    return 0;
  }
}

function projectNeedsInstantStructureRepair(
  manifest: ProjectManifest,
  structureInsightsContent: Buffer | null
) {
  const pinCount = countManifestPins(manifest);
  if (pinCount <= 1) {
    return false;
  }
  return countStructureArtifactEntries(structureInsightsContent) < pinCount;
}

function projectNeedsPartialInstantRefundRefresh(
  manifest: ProjectManifest,
  structureInsightsContent: Buffer | null
) {
  const projectType = String(manifest.project_type ?? "").trim().toLowerCase();
  const normalizedProjectType = projectType
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const reportMode = String(manifest.report_mode ?? "").trim().toLowerCase();
  if (
    !(normalizedProjectType === "commercial" || normalizedProjectType === "multifamily" || normalizedProjectType === "multi_family")
    || reportMode !== "instant"
  ) {
    return false;
  }
  if (Boolean(manifest.refund_pending) || Boolean(manifest.refund_issued)) {
    return false;
  }
  if (!structureInsightsContent) {
    return false;
  }
  try {
    const parsed = JSON.parse(structureInsightsContent.toString("utf8"));
    const structureList = asRecord(parsed).structures;
    const structures = Array.isArray(structureList) ? structureList : [];
    return structures.some((entry) => String(asRecord(entry).status ?? "").trim().toLowerCase() !== "ok");
  } catch {
    return false;
  }
}

function mapAppleKeyError(error: unknown) {
  const code = error instanceof Error ? error.message : "invalid_apple_key";
  switch (code) {
    case "missing_apple_key":
      return badRequest("missing_apple_key", "A key or Apple Maps URL is required.");
    case "invalid_apple_key_length":
      return badRequest("invalid_apple_key_length", "Apple key length is invalid.");
    case "invalid_apple_key_characters":
      return badRequest("invalid_apple_key_characters", "Apple key contains invalid characters.");
    default:
      return badRequest("invalid_apple_key", "Apple key payload is invalid.");
  }
}
