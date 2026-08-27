import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";
import { notFound } from "./errors.js";
import type { CodeReport } from "./types.js";

export function codeReportStorageRoot() {
  return path.resolve(process.cwd(), env.codeReportStorageRoot);
}

export function generateCodeReportId() {
  return `cr_${randomBytes(10).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 14)}`;
}

function normalizeReportId(id: string) {
  const cleaned = id.trim();
  if (!/^cr_[A-Za-z0-9_-]{8,40}$/.test(cleaned)) {
    throw notFound("The requested code report was not found.");
  }
  return cleaned;
}

function reportPath(id: string) {
  return path.join(codeReportStorageRoot(), "reports", `${normalizeReportId(id)}.json`);
}

export async function saveCodeReport(report: CodeReport) {
  if (isFirstMeasurePostgresEnabled()) {
    const id = normalizeReportId(report.id);
    await replaceSharedDocument({ namespace: "code_reports", collection: "reports", id }, report);
    return `postgres://code-reports/reports/${id}`;
  }
  const filePath = reportPath(report.id);
  await writeJsonAtomic(filePath, report);
  return filePath;
}

export async function readCodeReport(id: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const report = await readSharedDocument<CodeReport>({ namespace: "code_reports", collection: "reports", id: normalizeReportId(id) });
    if (!report) throw notFound("The requested code report was not found.");
    return report;
  }
  const raw = await readFile(reportPath(id), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw notFound("The requested code report was not found.");
    throw error;
  });
  return JSON.parse(raw) as CodeReport;
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
