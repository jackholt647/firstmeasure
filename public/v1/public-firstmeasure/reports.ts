import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { notFound } from "../platform/errors.js";
import { asObject, cleanText, normalizeId } from "./util.js";

export type PublicFirstMeasureReportRecord = {
  schema_version: 1;
  report_id: string;
  org_id: string;
  firstmeasure_project_id: string;
  mode?: "test" | "live";
  external_id: string | null;
  idempotency_key_hash: string | null;
  charge_token: string | null;
  amount_charged: number;
  quoted_amount?: number;
  created_at: string;
  updated_at: string;
  created_by_key_id: string;
  request: Record<string, unknown>;
  metadata: Record<string, unknown>;
  test_report?: Record<string, unknown> | null;
};

export function publicFirstMeasureReportRoot() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "public_firstmeasure", "reports");
}

function reportPath(reportId: string) {
  return path.join(publicFirstMeasureReportRoot(), `${normalizePublicReportId(reportId)}.json`);
}

export function generatePublicReportId() {
  return `fmr_${randomBytes(10).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`;
}

export function normalizePublicReportId(value: unknown) {
  const text = cleanText(value);
  if (!/^fmr_[A-Za-z0-9_-]{8,40}$/.test(text)) {
    throw notFound("report_not_found", "The requested report was not found.");
  }
  return text;
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, JSON.stringify(value, null, 2));
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true });
  }
}

export async function createPublicFirstMeasureReportRecord(input: Omit<PublicFirstMeasureReportRecord, "schema_version" | "created_at" | "updated_at">) {
  const now = new Date().toISOString();
  const record: PublicFirstMeasureReportRecord = {
    schema_version: 1,
    ...input,
    org_id: normalizeId(input.org_id, "organization_id"),
    created_at: now,
    updated_at: now
  };
  await writeJsonAtomic(reportPath(record.report_id), record);
  return record;
}

export async function readPublicFirstMeasureReport(reportId: string, orgId: string) {
  const raw = await readFile(reportPath(reportId), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw notFound("report_not_found", "The requested report was not found.");
    throw error;
  });
  const record = JSON.parse(raw) as PublicFirstMeasureReportRecord;
  if (record.org_id !== orgId) throw notFound("report_not_found", "The requested report was not found.");
  return record;
}

export async function updatePublicFirstMeasureReportRecord(
  reportId: string,
  orgId: string,
  patch: Partial<Pick<PublicFirstMeasureReportRecord, "amount_charged" | "charge_token" | "metadata">>
) {
  const record = await readPublicFirstMeasureReport(reportId, orgId);
  const updated: PublicFirstMeasureReportRecord = {
    ...record,
    ...patch,
    metadata: {
      ...asObject(record.metadata),
      ...asObject(patch.metadata)
    },
    updated_at: new Date().toISOString()
  };
  await writeJsonAtomic(reportPath(updated.report_id), updated);
  return updated;
}

export async function listPublicFirstMeasureReports(input: {
  orgId: string;
  mode?: "test" | "live";
  externalId?: string | null;
  limit?: number;
}) {
  await mkdir(publicFirstMeasureReportRoot(), { recursive: true });
  const entries = await readdir(publicFirstMeasureReportRoot(), { withFileTypes: true });
  const records: PublicFirstMeasureReportRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      const record = JSON.parse(await readFile(path.join(publicFirstMeasureReportRoot(), entry.name), "utf8")) as PublicFirstMeasureReportRecord;
      if (record.org_id !== input.orgId) continue;
      if (input.mode && (record.mode ?? "live") !== input.mode) continue;
      if (input.externalId && record.external_id !== input.externalId) continue;
      records.push(record);
    } catch {
      // Ignore damaged report mappings.
    }
  }
  return records
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(1, Math.min(500, Math.floor(input.limit ?? 100))));
}

export async function findPublicFirstMeasureReportByIdempotency(orgId: string, idempotencyHash: string | null, mode?: "test" | "live") {
  if (!idempotencyHash) return null;
  const records = await listPublicFirstMeasureReports({ orgId, mode, limit: 500 });
  return records.find((record) => record.idempotency_key_hash === idempotencyHash) ?? null;
}

export async function findPublicFirstMeasureReportByProjectId(orgId: string, projectId: string) {
  const records = await listPublicFirstMeasureReports({ orgId, limit: 500 });
  return records.find((record) => record.firstmeasure_project_id === projectId) ?? null;
}

export function publicReportSummary(record: PublicFirstMeasureReportRecord, project: unknown = null) {
  if ((record.mode ?? "live") === "test") {
    const testReport = asObject(record.test_report);
    const artifacts = asObject(testReport.artifacts);
    return {
      id: record.report_id,
      external_id: record.external_id,
      mode: "test",
      test_mode: true,
      status: cleanText(testReport.status) || "completed",
      address: cleanText(testReport.address || asObject(record.request).address),
      project_type: cleanText(testReport.project_type || asObject(record.request).project_type) || "residential",
      amount_charged: record.amount_charged,
      quoted_amount: record.quoted_amount ?? null,
      charge_token: record.charge_token,
      created_at: record.created_at,
      updated_at: record.updated_at,
      completed_at: testReport.completed_at ?? record.created_at,
      artifacts: {
        has_report_pdf: artifacts.has_report_pdf !== false,
        has_summary_pdf: artifacts.has_summary_pdf !== false,
        has_model_data: artifacts.has_model_data !== false,
        has_pdf_state: artifacts.has_pdf_state === true
      },
      links: {
        self: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}`,
        pdf: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/pdf`,
        measurements: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/measurements`
      },
      rejection: null,
      metadata: record.metadata
    };
  }

  const projectObject = asObject(project);
  const manifest = asObject(projectObject.manifest);
  const artifacts = asObject(manifest.artifacts);
  const timestamps = asObject(manifest.timestamps);
  const rejectionReason = cleanText(manifest.rejection_reason || manifest.instant_rejection_reason);
  const emailState = asObject(manifest.email_state);
  const rejectionEmail = asObject(emailState.rejection_email);
  return {
    id: record.report_id,
    external_id: record.external_id,
    status: cleanText(manifest.status) || "unknown",
    address: cleanText(manifest.address),
    project_type: cleanText(manifest.project_type),
    amount_charged: record.amount_charged,
    charge_token: record.charge_token,
    created_at: record.created_at,
    updated_at: record.updated_at,
    completed_at: timestamps.completed_at ?? null,
    artifacts: {
      has_report_pdf: artifacts.has_report_pdf === true || artifacts.has_main_pdf === true,
      has_summary_pdf: artifacts.has_summary_pdf === true,
      has_model_data: artifacts.has_model_data === true,
      has_pdf_state: artifacts.has_pdf_state === true
    },
    links: {
      self: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}`,
      pdf: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/pdf`,
      measurements: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/measurements`
    },
    rejection: (rejectionReason || cleanText(manifest.status) === "rejected") ? {
      reason: rejectionReason || null,
      message: cleanText(manifest.rejection_message) || null,
      email: {
        sent: rejectionEmail.sent_ok === true,
        last_attempt_at: rejectionEmail.last_attempt_utc ?? null,
        last_error: rejectionEmail.last_error ?? null
      }
    } : null,
    metadata: record.metadata
  };
}
