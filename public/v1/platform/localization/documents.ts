import { readBranchModule } from "../storage.js";
import { companyLocalization } from "./settings.js";
import { snapshotLanguage } from "./server.js";

export const DOCUMENT_NAMESPACES = ["shared", "terminology", "doc-model", "doc-renderer", "doc-widgets", "notifications"];

export async function companyDocumentLanguage(orgId: string, branchId = "default") {
  const [settings, mappings] = await Promise.all([
    companyLocalization(orgId, branchId),
    readBranchModule(orgId, branchId, "variable_mappings").catch(() => null)
  ]);
  return snapshotLanguage(settings.context, DOCUMENT_NAMESPACES, mappings?.data || {});
}
