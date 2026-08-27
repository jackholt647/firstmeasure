import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { readSharedDocument, replaceSharedDocument } from "../src/database/shared_documents.js";
import type { WeatherReport } from "./types.js";

export function sanitizeWeatherId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

export async function saveWeatherReport(report: WeatherReport) {
  if (isFirstMeasurePostgresEnabled()) {
    const id = sanitizeWeatherId(report.id);
    await replaceSharedDocument({ namespace: "weather", collection: "reports", id }, report);
    return `postgres://weather/reports/${id}`;
  }
  const dir = path.resolve(env.weatherStorageRoot, "reports");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeWeatherId(report.id)}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

export async function readWeatherReport(id: string): Promise<WeatherReport> {
  if (isFirstMeasurePostgresEnabled()) {
    const report = await readSharedDocument<WeatherReport>({ namespace: "weather", collection: "reports", id: sanitizeWeatherId(id) });
    if (!report) {
      const error = new Error("Weather report not found.") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return report;
  }
  const filePath = path.resolve(env.weatherStorageRoot, "reports", `${sanitizeWeatherId(id)}.json`);
  return JSON.parse(await readFile(filePath, "utf8")) as WeatherReport;
}
