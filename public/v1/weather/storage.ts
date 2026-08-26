import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { env } from "../src/config/env.js";
import type { WeatherReport } from "./types.js";

export function sanitizeWeatherId(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
}

export async function saveWeatherReport(report: WeatherReport) {
  const dir = path.resolve(env.weatherStorageRoot, "reports");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sanitizeWeatherId(report.id)}.json`);
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf8");
  return filePath;
}

export async function readWeatherReport(id: string): Promise<WeatherReport> {
  const filePath = path.resolve(env.weatherStorageRoot, "reports", `${sanitizeWeatherId(id)}.json`);
  return JSON.parse(await readFile(filePath, "utf8")) as WeatherReport;
}
