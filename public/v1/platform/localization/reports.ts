import { readTerminologyMappings } from "./terminology-settings.js";
import { resolveContext } from "./core.js";
import { snapshotLanguage, serverLanguage, frozenCatalogs } from "./server.js";
import type { ReportPreferences } from "../../firstmeasure/report_preferences.js";

export async function freezeReportLanguage(input: Record<string, unknown>, preferences: ReportPreferences) {
  const orgId = String((input.organization_ref as Record<string, unknown>)?.id || "");
  const branchId = String(input.branch_id || "default");
  const mappings = orgId ? await readTerminologyMappings(orgId, branchId) : null;
  const snapshot = await snapshotLanguage(resolveContext(preferences), ["shared", "terminology", "reports"], mappings || {});
  const language = await serverLanguage(resolveContext(preferences), ["reports"], snapshot);
  // Copy every registered report message from the same immutable catalog version.
  // Source phrases are retained as aliases for the PDF renderer; catalog IDs remain
  // available for future templates. Never consult current catalogs during replay.
  const bundles = await frozenCatalogs(snapshot, ["reports"]);
  const dictionary: Record<string, string> = {};
  for (const bundle of bundles) {
    const source = bundle.namespaces.reports?.["en-US"] || {};
    for (const [key, entry] of Object.entries(source)) {
      const phrase = typeof entry === "string" ? entry : entry.message;
      // Preserve template arguments until quantities/customer values are inserted
      // by the PDF renderer, rather than formatting an incomplete server message.
      const placeholders = Object.fromEntries([...phrase.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map(match => [match[1], match[0]]));
      const translated = language.text("reports", key, phrase, placeholders);
      dictionary[key] = translated;
      dictionary[phrase] = translated;
    }
  }
  return { ...snapshot, report_dictionary: dictionary };
}
