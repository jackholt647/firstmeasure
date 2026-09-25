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
    time_zone: z.string().max(100).refine(value => { try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return true;
    }
    catch {
        return false;
    } }, "Unsupported time zone").optional()
}).strict();
export async function companyLocalization(orgId, branchId = "default") {
    const [branch, enabled, metric, profile] = await Promise.all([
        readDocument(orgId, "branch", branchId).catch(() => null),
        isAppFlagEnabled(orgId, "firstmeasure", "report_localization"),
        isAppFlagEnabled(orgId, "firstmeasure", "metric_measurements"),
        organizationProfile(orgId)
    ]);
    const data = branch?.data || {};
    const legacy = (data.report_preferences || {});
    const saved = (data.localization || {});
    const company = enabled ? {
        ...saved,
        locale: saved.locale || legacy.report_language || profile.locale,
        measurement_system: saved.measurement_system || legacy.measurement_system || (metric ? "metric" : profile.measurement_system)
    } : { locale: "en-US", measurement_system: metric ? "metric" : "imperial" };
    return { enabled, company, context: resolveContext(company) };
}
