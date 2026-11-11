import { SUPPORTED_LOCALES } from "../platform/localization/languages.js";
import { organizationProfile } from "../commerce/profile.js";
import { z } from "zod";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { readDocument } from "../platform/storage.js";

/**
 * How roof pitch is written (1M8-255): rise over a 12 run (6/12, the US convention) or degrees (26.6°, how roofers
 * outside the US write it). A company setting beside the measurement system; without one, metric means degrees.
 */
export const PITCH_NOTATIONS = ["rise_12", "degrees"] as const;
export type PitchNotation = typeof PITCH_NOTATIONS[number];
export function defaultPitchNotation(measurementSystem: unknown): PitchNotation {
  return measurementSystem === "metric" ? "degrees" : "rise_12";
}

export const reportPreferencesSchema = z.object({
  measurement_system: z.enum(["imperial", "metric"]).optional(),
  report_language: z.enum(SUPPORTED_LOCALES).optional(),
  pitch_notation: z.enum(PITCH_NOTATIONS).optional()
});
export type ReportPreferences = { measurement_system: "imperial" | "metric"; report_language: string; pitch_notation: PitchNotation };

export function normalizeReportPreferences(input: Record<string, unknown> = {}): ReportPreferences {
  const value = reportPreferencesSchema.parse(input);
  const measurement_system = value.measurement_system ?? "imperial";
  return { measurement_system, report_language: value.report_language ?? "en-US", pitch_notation: value.pitch_notation ?? defaultPitchNotation(measurement_system) };
}

/** Resolve once when ordering. Existing projects never inherit later company changes. */
export async function resolveOrderReportPreferences(input: Record<string, unknown>): Promise<ReportPreferences> {
  const ref = input.organization_ref as Record<string, unknown> | undefined;
  const orgId = String(ref?.id || "");
  if (!orgId) return normalizeReportPreferences(input); // Internal standalone projects.
  const [customize, metric, profile] = await Promise.all([
    isAppFlagEnabled(orgId, "firstmeasure", "report_localization"),
    isAppFlagEnabled(orgId, "firstmeasure", "metric_measurements"),
    organizationProfile(orgId)
  ]);
  // Without language customization nothing is chosen: pitch notation follows the measurement system.
  if (!customize) return normalizeReportPreferences({ measurement_system: metric ? "metric" : "imperial", report_language: "en-US" });
  const branch = await readDocument(orgId, "branch", String(input.branch_id || "default")).catch(() => null);
  const legacy = (branch?.data?.report_preferences || {}) as Record<string, unknown>;
  const localization = (branch?.data?.localization || {}) as Record<string, unknown>;
  const saved = { ...legacy, measurement_system: localization.measurement_system ?? legacy.measurement_system, report_language: localization.locale ?? legacy.report_language, pitch_notation: localization.pitch_notation ?? legacy.pitch_notation };
  return normalizeReportPreferences({
    measurement_system: input.measurement_system ?? saved.measurement_system ?? (metric ? "metric" : profile.measurement_system),
    report_language: input.report_language ?? saved.report_language ?? profile.locale,
    pitch_notation: input.pitch_notation ?? saved.pitch_notation
  });
}
