import { organizationProfile } from "../../commerce/profile.js";
import { z } from "zod";
import { readDocument } from "../storage.js";
import { isAppFlagEnabled } from "../app_flags.js";
import { SUPPORTED_LOCALES } from "./languages.js";
import { resolveContext } from "./core.js";

export const localeSchema = z.enum(SUPPORTED_LOCALES);
export const localizationSchema = z.object({
  locale: localeSchema.optional(),
  measurement_system: z.enum(["imperial", "metric"]).optional(),
  // FM-401: roof pitch is a report preference (report_preferences.pitch_notation), not localization. Still accepted
  // because 1M8-255 wrote it here and saved branches send it back; nothing reads it except as that legacy fallback.
  pitch_notation: z.enum(["rise_12", "degrees"]).optional(),
  time_zone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }, "Unsupported time zone").optional()
}).strict();

export async function companyLocalization(orgId: string, branchId = "default") {
  const [branch, enabled, metric, profile] = await Promise.all([
    readDocument(orgId, "branch", branchId).catch(() => null),
    isAppFlagEnabled(orgId, "firstmeasure", "report_localization"),
    isAppFlagEnabled(orgId, "firstmeasure", "metric_measurements"),
    organizationProfile(orgId)
  ]);
  const data = branch?.data || {};
  const legacy = (data.report_preferences || {}) as Record<string, unknown>;
  const saved = (data.localization || {}) as Record<string, unknown>;
  const company: Record<string, unknown> = enabled ? {
    ...saved,
    locale: saved.locale || legacy.report_language || profile.locale,
    measurement_system: saved.measurement_system || legacy.measurement_system || (metric ? "metric" : profile.measurement_system)
  } : { locale: "en-US", measurement_system: metric ? "metric" : "imperial" };
  delete company.pitch_notation; // FM-401: a report preference (firstmeasure/report_preferences.ts), not company localization.
  return { enabled, company, context: resolveContext(company) };
}
