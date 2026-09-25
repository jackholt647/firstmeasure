import { SUPPORTED_LOCALES } from "../platform/localization/languages.js";
import { organizationProfile } from "../commerce/profile.js";
import { z } from "zod";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { readDocument } from "../platform/storage.js";
export const reportPreferencesSchema = z.object({
    measurement_system: z.enum(["imperial", "metric"]).optional(),
    report_language: z.enum(SUPPORTED_LOCALES).optional()
});
export function normalizeReportPreferences(input = {}) {
    const value = reportPreferencesSchema.parse(input);
    return { measurement_system: value.measurement_system ?? "imperial", report_language: value.report_language ?? "en-US" };
}
/** Resolve once when ordering. Existing projects never inherit later company changes. */
export async function resolveOrderReportPreferences(input) {
    const ref = input.organization_ref;
    const orgId = String(ref?.id || "");
    if (!orgId)
        return normalizeReportPreferences(input); // Internal standalone projects.
    const [customize, metric, profile] = await Promise.all([
        isAppFlagEnabled(orgId, "firstmeasure", "report_localization"),
        isAppFlagEnabled(orgId, "firstmeasure", "metric_measurements"),
        organizationProfile(orgId)
    ]);
    if (!customize)
        return { measurement_system: metric ? "metric" : "imperial", report_language: "en-US" };
    const branch = await readDocument(orgId, "branch", String(input.branch_id || "default")).catch(() => null);
    const legacy = (branch?.data?.report_preferences || {});
    const localization = (branch?.data?.localization || {});
    const saved = { ...legacy, measurement_system: localization.measurement_system ?? legacy.measurement_system, report_language: localization.locale ?? legacy.report_language };
    return normalizeReportPreferences({
        measurement_system: input.measurement_system ?? saved.measurement_system ?? (metric ? "metric" : profile.measurement_system),
        report_language: input.report_language ?? saved.report_language ?? profile.locale
    });
}
