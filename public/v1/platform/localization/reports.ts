import { readTerminologyMappings } from "./terminology-settings.js";
import { resolveContext } from "./core.js";
import { snapshotLanguage, serverLanguage } from "./server.js";
import type { ReportPreferences } from "../../firstmeasure/report_preferences.js";

export async function freezeReportLanguage(input: Record<string, unknown>, preferences: ReportPreferences) {
  const orgId = String((input.organization_ref as Record<string, unknown>)?.id || "");
  const branchId = String(input.branch_id || "default");
  const mappings = orgId ? await readTerminologyMappings(orgId, branchId) : null;
  const snapshot = await snapshotLanguage(resolveContext(preferences), ["shared", "terminology", "reports"], mappings || {});
  const language = await serverLanguage(resolveContext(preferences), ["reports"], snapshot);
  const keys = ["color", "colors", "colored", "center", "centered", "aluminum", "gray", "labor", "vapor", "miter", "miters", "story", "stories", "meters", "meter", "millimeters", "millimeter", "square footage"];
  return { ...snapshot, report_dictionary: Object.fromEntries(keys.map(key => [key, language.text("reports", key, key)])) };
}
