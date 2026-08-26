import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import {
  FIRSTMEASURE_FILE_NAMES,
  FIRSTMEASURE_SCHEMA_VERSION,
  PDF_FILE_NAMES,
  firstMeasurePointValueForComplexity,
  type PdfSlot,
  type PdfType
} from "./constants.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { enforceProjectLifecycleStatus } from "./project_lifecycle.js";
import {
  listIndexedProjectManifests,
  queryIndexedProjectManifests,
  readIndexedProjectArtifactState,
  upsertProjectIndex
} from "./project_index.js";

export type JsonObject = Record<string, unknown>;

const IMMUTABLE_TERMINAL_PROJECT_STATUSES = new Set([
  "completed",
  "rejected",
  "rejected_no_coverage",
  "cancelled"
]);

function normalizeProjectStatus(status: unknown) {
  return String(status ?? "").trim().toLowerCase();
}

function isImmutableTerminalProjectStatus(status: unknown) {
  return IMMUTABLE_TERMINAL_PROJECT_STATUSES.has(normalizeProjectStatus(status));
}

function normalizeProjectPriorityFlags(manifest: ProjectManifest) {
  manifest.is_vip = Boolean(manifest.is_vip);
  manifest.is_expedited = Boolean(manifest.is_expedited);
}

export type ProjectManifest = JsonObject & {
  schema_version: number;
  id: string;
  status: string;
  project_type: string;
  address: string;
  components: Record<string, unknown>;
  lat: number | null;
  lng: number | null;
  pins: Array<{ lat: number; lng: number }>;
  include_gutter_measurements: boolean;
  include_weather_report: boolean;
  weather_report_tier: string | null;
  weather_report_id: string | null;
  weather_report_pdf_url: string | null;
  radius_meters: number | null;
  complexity: number | string | null;
  point_value: number | null;
  is_custom_pin: boolean;
  is_filler: boolean;
  is_vip: boolean;
  is_expedited: boolean;
  report_expedite_option: string | null;
  report_expedite_label: string | null;
  report_due_window_start: string | null;
  report_due_window_end: string | null;
  report_due_window_label: string | null;
  report_production_deadline_at?: string | null;
  report_release_hold_enabled: boolean | null;
  instant_enabled: boolean;
  instant_only: boolean;
  owner_ref: Record<string, unknown>;
  organization_ref: Record<string, unknown>;
  team_ref: Record<string, unknown>;
  resident: Record<string, unknown>;
  issuer: Record<string, unknown>;
  cc_emails: string[];
  tech_notes: string | null;
  amount_charged: number;
  timestamps: Record<string, unknown>;
  workflow: Record<string, unknown>;
  audit: Record<string, unknown>;
  delivery: Record<string, unknown>;
  artifacts: Record<string, unknown>;
};

type FileEntry = {
  name: string;
  size: number;
  updated_at: string;
};

const atomicWriteQueues = new Map<string, Promise<void>>();
const projectMutationQueues = new Map<string, Promise<unknown>>();
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_MAX_ATTEMPTS = 12;

async function wait(milliseconds: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function renameWithRetry(sourcePath: string, destinationPath: string) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        process.platform !== "win32"
        || !WINDOWS_RENAME_RETRY_CODES.has(code)
        || attempt >= WINDOWS_RENAME_MAX_ATTEMPTS
      ) {
        throw error;
      }
      await wait(Math.min(10 * (2 ** (attempt - 1)), 250));
    }
  }
}

async function serializeAtomicWrite(filePath: string, operation: () => Promise<void>) {
  const resolvedPath = path.resolve(filePath);
  const queueKey = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
  const previous = atomicWriteQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  atomicWriteQueues.set(queueKey, current);
  try {
    await current;
  } finally {
    if (atomicWriteQueues.get(queueKey) === current) {
      atomicWriteQueues.delete(queueKey);
    }
  }
}

async function serializeProjectMutation<T>(projectId: string, operation: () => Promise<T>) {
  const queueKey = sanitizeProjectId(projectId);
  const previous = projectMutationQueues.get(queueKey) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectMutationQueues.set(queueKey, current);
  try {
    return await current;
  } finally {
    if (projectMutationQueues.get(queueKey) === current) {
      projectMutationQueues.delete(queueKey);
    }
  }
}

export function resolveFirstMeasureStorageRoot(): string {
  return path.resolve(process.cwd(), env.firstmeasureStorageRoot);
}

function projectsRoot(): string {
  return path.join(resolveFirstMeasureStorageRoot(), "projects");
}

export async function ensureFirstMeasureStorage() {
  await mkdir(projectsRoot(), { recursive: true });
}

export function projectDir(projectId: string): string {
  return path.join(projectsRoot(), sanitizeProjectId(projectId));
}

export function sanitizeProjectId(projectId: string): string {
  const cleaned = projectId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  if (!cleaned) {
    throw badRequest("invalid_project_id", "Project id must contain at least one letter or number.");
  }
  return cleaned;
}

export function sanitizeFileName(fileName: string): string {
  const base = path.basename(fileName).trim();
  if (!base || base === "." || base === "..") {
    throw badRequest("invalid_file_name", "File name is required.");
  }
  return base.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
}

export function generateProjectId() {
  return randomBytes(16).toString("hex");
}

function organizationIdFromProjectInput(input: JsonObject) {
  const organizationRef = asRecord(input.organization_ref);
  return String(input.organization_id ?? organizationRef.id ?? "").trim();
}

async function shouldAutoVipFirstOrganizationProject(input: JsonObject) {
  const organizationId = organizationIdFromProjectInput(input);
  if (!organizationId) return false;
  const existing = await queryIndexedProjectManifests({
    organization_id: organizationId,
    includeInstantOnly: true,
    limit: 1
  }).catch(() => null);
  return Boolean(existing && existing.count === 0);
}

export async function writeFileAtomic(filePath: string, content: string | Uint8Array) {
  await serializeAtomicWrite(filePath, async () => {
    const directory = path.dirname(filePath);
    await mkdir(directory, { recursive: true });
    const tempPath = path.join(
      directory,
      `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`
    );
    try {
      await writeFile(tempPath, content);
      await renameWithRetry(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true });
    }
  });
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2));
}

export async function createProject(input: JsonObject & { address: string }) {
  await ensureFirstMeasureStorage();

  const projectId = input.id ? sanitizeProjectId(String(input.id)) : generateProjectId();
  const nowIso = new Date().toISOString();
  const nowSql = toSqlDate(nowIso);
  const directory = projectDir(projectId);

  if (await pathExists(path.join(directory, FIRSTMEASURE_FILE_NAMES.manifest))) {
    throw conflict("project_already_exists", `Project '${projectId}' already exists.`);
  }

  await mkdir(directory, { recursive: true });

  const initialComplexity = (input.complexity as number | string | null | undefined) ?? null;
  const initialIsVip = Boolean(input.is_vip ?? false) || await shouldAutoVipFirstOrganizationProject(input);
  const manifest: ProjectManifest = {
    schema_version: FIRSTMEASURE_SCHEMA_VERSION,
    id: projectId,
    status: String(input.status ?? "queued"),
    project_type: String(input.project_type ?? "residential"),
    address: String(input.address),
    components: asRecord(input.components),
    lat: toNullableNumber(input.lat),
    lng: toNullableNumber(input.lng),
    pins: Array.isArray(input.pins) ? (input.pins as Array<{ lat: number; lng: number }>) : [],
    include_gutter_measurements: Boolean(
      input.include_gutter_measurements
      ?? asRecord(input.gutter_profile).enabled
      ?? false
    ),
    include_weather_report: Boolean(input.include_weather_report ?? false),
    weather_report_tier: input.weather_report_tier == null ? null : String(input.weather_report_tier),
    weather_report_id: input.weather_report_id == null ? null : String(input.weather_report_id),
    weather_report_pdf_url: input.weather_report_pdf_url == null ? null : String(input.weather_report_pdf_url),
    radius_meters: toNullableNumber(input.radius_meters),
    complexity: initialComplexity,
    point_value: firstMeasurePointValueForComplexity(initialComplexity),
    is_custom_pin: Boolean(input.is_custom_pin ?? false),
    structure_pin_mode: input.structure_pin_mode == null ? null : String(input.structure_pin_mode),
    structure_pin_status: input.structure_pin_status == null ? null : String(input.structure_pin_status),
    structure_pin_error: input.structure_pin_error == null ? null : String(input.structure_pin_error),
    is_filler: Boolean(input.is_filler ?? false),
    is_vip: initialIsVip,
    is_expedited: Boolean(input.is_expedited ?? false),
    report_expedite_option: input.report_expedite_option == null ? null : String(input.report_expedite_option),
    report_expedite_label: input.report_expedite_label == null ? null : String(input.report_expedite_label),
    report_due_window_start: input.report_due_window_start == null ? null : String(input.report_due_window_start),
    report_due_window_end: input.report_due_window_end == null ? null : String(input.report_due_window_end),
    report_due_window_label: input.report_due_window_label == null ? null : String(input.report_due_window_label),
    report_production_deadline_at: input.report_production_deadline_at == null ? null : String(input.report_production_deadline_at),
    report_release_hold_enabled: input.report_release_hold_enabled == null ? null : input.report_release_hold_enabled === true,
    instant_enabled: Boolean(input.instant_enabled ?? input.instant_only ?? false),
    instant_only: Boolean(input.instant_only ?? false),
    owner_ref: asRecord(input.owner_ref),
    organization_ref: asRecord(input.organization_ref),
    team_ref: asRecord(input.team_ref),
    resident: asRecord(input.resident),
    issuer: asRecord(input.issuer),
    cc_emails: Array.isArray(input.cc_emails) ? input.cc_emails.map((value) => String(value)) : [],
    tech_notes: input.tech_notes == null ? null : String(input.tech_notes),
    amount_charged: typeof input.amount_charged === "number" ? input.amount_charged : 0,
    report_mode: input.report_mode == null ? "full" : String(input.report_mode),
    charge_token: input.charge_token == null ? null : String(input.charge_token),
    public_api: asRecord(input.public_api),
    refund_issued: Boolean(input.refund_issued ?? false),
    refund_amount: typeof input.refund_amount === "number" ? input.refund_amount : 0,
    refund_reason: input.refund_reason == null ? null : String(input.refund_reason),
    refund_pending: Boolean(input.refund_pending ?? false),
    instant_status: input.instant_status == null ? null : String(input.instant_status),
    instant_rejection_reason: input.instant_rejection_reason == null ? null : String(input.instant_rejection_reason),
    timestamps: {
      created_at: nowSql,
      queued_at: nowSql,
      processed_at: null,
      started_at: null,
      uploaded_at: null,
      completed_at: null,
      rejected_at: null,
      updated_at: nowSql
    },
    workflow: {
      assigned_to: null,
      assigned_at: null,
      reserved_to: null,
      reserved_at: null,
      correction_to: null,
      qa_claim: null,
      qa_history: [],
      work_history: [],
      history: []
    },
    audit: {
      manager_audit_status: null,
      manager_audit_note: null,
      manager_audit_annotations: null
    },
    delivery: {
      email_events: [],
      report_sent_at: null
    },
    artifacts: {
      has_insights: false,
      has_pdf_state: false,
      has_report_pdf: false,
      has_instant_pdf: false,
      has_model_data: false,
      has_google_image: false,
      has_mask_tif: false,
      has_dsm_tif: false
    }
  };

  normalizeProjectPriorityFlags(manifest);
  await saveManifest(projectId, manifest);

  if (input.branding_defaults && typeof input.branding_defaults === "object") {
    await saveBrandingDefaults(projectId, input.branding_defaults);
  }

  return getProjectDetail(projectId);
}

export async function listProjectManifests() {
  return listIndexedProjectManifests();
}

export async function readManifest(projectId: string): Promise<ProjectManifest> {
  if (isFirstMeasurePostgresEnabled()) {
    const { readPostgresManifestById } = await import("./project_index_postgres.js");
    const postgresManifest = await readPostgresManifestById(projectId);
    if (!postgresManifest) {
      throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
    }
    return postgresManifest;
  }
  const manifestPath = path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.manifest);
  const manifest = await readJsonFile<ProjectManifest>(manifestPath, {
    code: "project_not_found",
    message: `Project '${projectId}' does not exist.`
  });
  const indexedArtifacts = await readIndexedProjectArtifactState(projectId);
  if (!indexedArtifacts) {
    return manifest;
  }
  manifest.artifacts = {
    ...asRecord(manifest.artifacts),
    ...indexedArtifacts
  };
  return manifest;
}

export async function saveManifest(
  projectId: string,
  manifest: ProjectManifest,
  options?: {
    artifactFileName?: string | null;
    backup?: boolean;
  }
) {
  const directory = projectDir(projectId);
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, FIRSTMEASURE_FILE_NAMES.manifest);
  enforceProjectLifecycleStatus(manifest);
  normalizeProjectPriorityFlags(manifest);
  normalizeProjectPointValue(manifest);
  if (isFirstMeasurePostgresEnabled()) {
    await upsertProjectIndex(manifest, {
      storagePath: directory,
      artifactFileName: options?.artifactFileName ?? ""
    });
    await writeProjectManifestMirror(projectId, manifest).catch((error) => {
      console.error(`PostgreSQL saved project '${projectId}', but its JSON mirror could not be written.`, error);
    });
    return;
  }
  if (options?.backup !== false) {
    await backupManifestIfPresent(directory, manifestPath);
  }
  await writeJsonAtomic(manifestPath, manifest);
  await upsertProjectIndex(manifest, {
    storagePath: directory,
    artifactFileName: options?.artifactFileName ?? ""
  });
}

export async function patchManifest(
  projectId: string,
  patch: JsonObject,
  options?: { refreshArtifacts?: boolean; backup?: boolean }
) {
  if (isFirstMeasurePostgresEnabled()) {
    const { mutatePostgresManifest } = await import("./project_index_postgres.js");
    const directory = projectDir(projectId);
    const updated = await mutatePostgresManifest(projectId, async (current) => {
      const currentStatus = normalizeProjectStatus(current.status);
      const allowTerminalStatusTransition = patch.__allow_terminal_status_transition === true;
      const cleanPatch = { ...patch };
      delete cleanPatch.__allow_terminal_status_transition;
      const merged = deepMerge(current, cleanPatch) as ProjectManifest;
      if (isImmutableTerminalProjectStatus(currentStatus) && !allowTerminalStatusTransition) {
        merged.status = current.status;
        merged.timestamps = { ...asRecord(current.timestamps), ...asRecord(merged.timestamps) };
        const terminalKey = currentStatus === "completed" ? "completed_at" : currentStatus === "cancelled" ? "cancelled_at" : "rejected_at";
        if (current.timestamps?.[terminalKey]) (merged.timestamps as JsonObject)[terminalKey] = current.timestamps[terminalKey];
      }
      normalizeProjectPriorityFlags(merged);
      normalizeProjectPointValue(merged);
      merged.timestamps = {
        ...asRecord(current.timestamps), ...asRecord(merged.timestamps), updated_at: toSqlDate(new Date().toISOString())
      };
      return options?.refreshArtifacts ? refreshArtifactFlags(projectId, merged) : merged;
    }, { storagePath: directory });
    if (!updated) throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
    await writeProjectManifestMirror(projectId, updated).catch((error) => {
      console.error(`PostgreSQL patched project '${projectId}', but its JSON mirror could not be written.`, error);
    });
    return updated;
  }
  return serializeProjectMutation(projectId, async () => {
    const current = await readManifest(projectId);
    const currentStatus = normalizeProjectStatus(current.status);
    const allowTerminalStatusTransition = patch.__allow_terminal_status_transition === true;
    const cleanPatch = { ...patch };
    delete cleanPatch.__allow_terminal_status_transition;
    const merged = deepMerge(current, cleanPatch) as ProjectManifest;
    if (isImmutableTerminalProjectStatus(currentStatus) && !allowTerminalStatusTransition) {
      merged.status = current.status;
      merged.timestamps = {
        ...asRecord(current.timestamps),
        ...asRecord(merged.timestamps)
      };
      const terminalKey = currentStatus === "completed"
        ? "completed_at"
        : (currentStatus === "cancelled" ? "cancelled_at" : "rejected_at");
      if (current.timestamps?.[terminalKey]) {
        (merged.timestamps as JsonObject)[terminalKey] = current.timestamps[terminalKey];
      }
    }
    normalizeProjectPriorityFlags(merged);
    normalizeProjectPointValue(merged);
    merged.timestamps = {
      ...asRecord(current.timestamps),
      ...asRecord(merged.timestamps),
      updated_at: toSqlDate(new Date().toISOString())
    };
    const updated = options?.refreshArtifacts ? await refreshArtifactFlags(projectId, merged) : merged;
    await saveManifest(projectId, updated, { backup: options?.backup });
    return updated;
  });
}

export async function writeProjectManifestMirror(projectId: string, manifest: ProjectManifest) {
  const directory = projectDir(projectId);
  await mkdir(directory, { recursive: true });
  const manifestPath = path.join(directory, FIRSTMEASURE_FILE_NAMES.manifest);
  await backupManifestIfPresent(directory, manifestPath);
  await writeJsonAtomic(manifestPath, manifest);
}

export async function updateStatus(projectId: string, status: string) {
  const requestedStatus = normalizeProjectStatus(status);
  const nowSql = toSqlDate(new Date().toISOString());
  const timestamps: JsonObject = { updated_at: nowSql };
  if (requestedStatus === "completed") timestamps.completed_at = nowSql;
  if (requestedStatus === "awaiting_review") timestamps.uploaded_at = nowSql;
  if (requestedStatus === "cancelled") timestamps.cancelled_at = nowSql;
  return patchManifest(projectId, {
    status: requestedStatus || status,
    timestamps
  });
}

export async function getProjectDetail(projectId: string) {
  const manifest = await readManifest(projectId);
  const [appMetadata, pdfState, brandingDefaults] = await Promise.all([
    readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.appMetadata)),
    readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.pdfState)),
    readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.brandingDefaults))
  ]);

  return {
    manifest,
    app_metadata: appMetadata,
    pdf_state: pdfState,
    branding_defaults: brandingDefaults,
    files: await listProjectFiles(projectId)
  };
}

export async function listProjectFiles(projectId: string): Promise<FileEntry[]> {
  const directory = projectDir(projectId);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
    }
    throw error;
  });
  const fileEntries = entries.filter((entry) => entry.isFile());
  const files = await Promise.all(fileEntries.map(async (entry): Promise<FileEntry> => {
    const filePath = path.join(directory, entry.name);
    const fileStat = await stat(filePath);
    return {
      name: entry.name,
      size: fileStat.size,
      updated_at: fileStat.mtime.toISOString()
    };
  }));
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveAppMetadata(projectId: string, value: unknown) {
  await assertProjectExists(projectId);
  const filePath = path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.appMetadata);
  await writeJsonAtomic(filePath, value);
  return value;
}

export async function readAppMetadata(projectId: string) {
  return readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.appMetadata));
}

export async function savePdfState(projectId: string, value: unknown) {
  await assertProjectExists(projectId);
  const filePath = path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.pdfState);
  await writeJsonAtomic(filePath, value);
  await patchManifest(projectId, {
    artifacts: { has_pdf_state: true }
  });
  return value;
}

export async function readPdfState(projectId: string) {
  return readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.pdfState));
}

export async function saveBrandingDefaults(projectId: string, value: unknown) {
  await assertProjectExists(projectId);
  const filePath = path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.brandingDefaults);
  await writeJsonAtomic(filePath, value);
  return value;
}

export async function readBrandingDefaults(projectId: string) {
  return readOptionalJson(path.join(projectDir(projectId), FIRSTMEASURE_FILE_NAMES.brandingDefaults));
}

export async function saveArtifact(projectId: string, fileName: string, content: Uint8Array | string) {
  await assertProjectExists(projectId);
  const safeName = sanitizeFileName(fileName);
  const filePath = path.join(projectDir(projectId), safeName);
  await writeFileAtomic(filePath, content);
  if (isFirstMeasurePostgresEnabled()) {
    const { mutatePostgresManifest } = await import("./project_index_postgres.js");
    const updated = await mutatePostgresManifest(projectId, async (manifest) => {
      applyArtifactNameToManifest(manifest, safeName);
      return refreshArtifactFlags(projectId, manifest);
    }, { storagePath: projectDir(projectId), artifactFileName: safeName });
    if (!updated) throw notFound("project_not_found", `Project '${projectId}' does not exist.`);
    await writeProjectManifestMirror(projectId, updated).catch((error) => {
      console.error(`PostgreSQL saved artifact for '${projectId}', but its JSON mirror could not be written.`, error);
    });
  } else {
    await serializeProjectMutation(projectId, async () => {
      const manifest = await readManifest(projectId);
      applyArtifactNameToManifest(manifest, safeName);
      const refreshed = await refreshArtifactFlags(projectId, manifest);
      await saveManifest(projectId, refreshed, { artifactFileName: safeName });
    });
  }
  return {
    name: safeName,
    path: filePath
  };
}

export async function readArtifact(projectId: string, fileName: string) {
  await assertProjectExists(projectId);
  const safeName = sanitizeFileName(fileName);
  const filePath = path.join(projectDir(projectId), safeName);
  const content = await readFile(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw notFound("artifact_not_found", `Artifact '${safeName}' was not found for project '${projectId}'.`);
    }
    throw error;
  });
  return {
    name: safeName,
    path: filePath,
    content
  };
}

export async function readStoredPdf(projectId: string, type: PdfType | PdfSlot) {
  return readArtifact(projectId, resolveStoredPdfFileName(type));
}

export async function saveStoredPdf(projectId: string, type: PdfType | PdfSlot, content: Uint8Array) {
  return saveArtifact(projectId, resolveStoredPdfFileName(type), content);
}

export async function readStoredXml(projectId: string) {
  return readArtifact(projectId, FIRSTMEASURE_FILE_NAMES.xmlStored);
}

export async function saveGeneratedXml(projectId: string, content: string) {
  return saveArtifact(projectId, FIRSTMEASURE_FILE_NAMES.xmlGenerated, content);
}

export async function saveStoredXml(projectId: string, content: string) {
  return saveArtifact(projectId, FIRSTMEASURE_FILE_NAMES.xmlStored, content);
}

export async function refreshArtifactFlags(projectId: string, manifest: ProjectManifest) {
  const detail = await listProjectFiles(projectId).catch(() => []);
  const names = new Set(detail.map((entry) => entry.name));

  manifest.artifacts = {
    ...asRecord(manifest.artifacts),
    has_insights: names.has("insights.json"),
    has_pdf_state: names.has(FIRSTMEASURE_FILE_NAMES.pdfState),
    has_report_pdf: names.has(PDF_FILE_NAMES.main),
    has_main_pdf: names.has(PDF_FILE_NAMES.main),
    has_summary_pdf: names.has(PDF_FILE_NAMES.summary),
    has_instant_pdf: names.has("Instant Report.pdf"),
    has_model_data: names.has(FIRSTMEASURE_FILE_NAMES.xmlStored),
    has_google_image: names.has("google.png"),
    has_mask_tif: names.has("mask.tif"),
    has_dsm_tif: names.has("dsm.tif")
  };

  return manifest;
}

function applyArtifactNameToManifest(manifest: ProjectManifest, fileName: string) {
  const lower = fileName.toLowerCase();
  const artifacts = {
    ...asRecord(manifest.artifacts)
  };

  if (lower === "insights.json") {
    artifacts.has_insights = true;
  }
  if (lower === FIRSTMEASURE_FILE_NAMES.pdfState.toLowerCase()) {
    artifacts.has_pdf_state = true;
  }
  if (lower === PDF_FILE_NAMES.main.toLowerCase()) {
    artifacts.has_report_pdf = true;
    artifacts.has_main_pdf = true;
  }
  if (lower === PDF_FILE_NAMES.summary.toLowerCase()) {
    artifacts.has_summary_pdf = true;
  }
  if (lower === "instant report.pdf") {
    artifacts.has_instant_pdf = true;
  }
  if (lower === FIRSTMEASURE_FILE_NAMES.xmlStored.toLowerCase()) {
    artifacts.has_model_data = true;
  }
  if (lower === "google.png") {
    artifacts.has_google_image = true;
  }
  if (lower === "mask.tif") {
    artifacts.has_mask_tif = true;
  }
  if (lower === "dsm.tif") {
    artifacts.has_dsm_tif = true;
  }

  manifest.artifacts = artifacts;
}

async function backupManifestIfPresent(directory: string, manifestPath: string) {
  try {
    const existing = await readFile(manifestPath);
    const backupDirectory = path.join(directory, "manifest_backups");
    await mkdir(backupDirectory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(backupDirectory, `manifest_${stamp}.json`);
    await writeFileAtomic(backupPath, existing);
  } catch {
    return;
  }
}

async function readJsonFile<T>(
  filePath: string,
  missing?: {
    code: string;
    message: string;
  }
): Promise<T> {
  const raw = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" && missing) {
      throw notFound(missing.code, missing.message);
    }
    throw error;
  });
  return JSON.parse(raw) as T;
}

async function readOptionalJson(filePath: string) {
  try {
    return await readJsonFile(filePath);
  } catch {
    return null;
  }
}

async function assertProjectExists(projectId: string) {
  await readManifest(projectId);
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch)) {
    return patch;
  }
  if (isRecord(base) && isRecord(patch)) {
    const output: JsonObject = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      output[key] = key in output ? deepMerge(output[key], value) : value;
    }
    return output;
  }
  return patch;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

function toNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeProjectPointValue(manifest: ProjectManifest) {
  const pointCalculation = asRecord(manifest.point_calculation);
  const explicitPointValue = toNullableNumber(manifest.point_value);
  if (
    String(pointCalculation.mode ?? "").trim().toLowerCase() === "multi_structure_rollup"
    && explicitPointValue !== null
    && explicitPointValue > 0
  ) {
    manifest.point_value = explicitPointValue;
    return;
  }

  const pointValue = firstMeasurePointValueForComplexity(manifest.complexity);
  if (pointValue !== null) {
    manifest.point_value = pointValue;
    return;
  }
  manifest.point_value = null;
}

function resolveStoredPdfFileName(type: PdfType | PdfSlot) {
  if (type === "summary") {
    return PDF_FILE_NAMES.summary;
  }
  return PDF_FILE_NAMES.main;
}

function toSqlDate(isoString: string) {
  return isoString.slice(0, 19).replace("T", " ");
}
