import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError } from "../platform/errors.js";

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
export function documentDeliveryDefaults(data: JsonObject = {}, legacy: JsonObject = {}) {
  const value = (key: string) => data[key] ?? legacy[key];
  return {
    send_include_pdf: value("send_include_pdf") !== false,
    send_include_portal: value("send_include_portal") !== false,
    completion_message: String(value("completion_message") ?? "{{company}} will reach out with next steps.").trim()
  };
}

/** Read-only compatibility: new document settings win, including false/empty values. */
export async function readDocumentDeliveryDefaults(orgId: string, branchId = "default") {
  const optionalModule = async (id: string) => {
    try { return await readBranchModule(orgId, branchId, id); }
    catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; }
  };
  const [settings, style] = await Promise.all([
    optionalModule("document_settings"),
    optionalModule("presentation_style")
  ]);
  return documentDeliveryDefaults(object(object(settings).data), object(object(object(style).data).proposal_defaults));
}

const PINNED_TEMPLATES_MODULE = "document_template_pins";
/**
 * The templates an organization keeps at the top of New document, in order.
 * null means it has never chosen, and the picker shows its own everyday set.
 */
export async function readPinnedTemplateIds(orgId: string): Promise<string[] | null> {
  try {
    const ids = object(object(await readBranchModule(orgId, "default", PINNED_TEMPLATES_MODULE)).data).template_ids;
    return Array.isArray(ids) ? ids.map(id => String(id)).filter(Boolean) : null;
  } catch (error) {
    if (error instanceof PlatformError && error.statusCode === 404) return null;
    throw error;
  }
}
export async function savePinnedTemplateIds(orgId: string, templateIds: string[]) {
  const ids = [...new Set(templateIds.map(id => String(id).trim()).filter(Boolean))].slice(0, 12);
  await saveBranchModule(orgId, "default", PINNED_TEMPLATES_MODULE, { data: { template_ids: ids } }, { replace: true });
  return ids;
}

/** Completion is scoped to this issued document, never another project's payment. */
export function documentCustomerComplete(document: JsonObject, snapshot: JsonObject, signing: JsonObject | null, obligations: JsonObject[]) {
  if (["canceled", "declined", "expired"].includes(String(document.status))) return false;
  if (String(object(document.delivery).current_snapshot_id) !== String(snapshot.id)) return false;
  const signed = signing ? signing.status === "completed" : ["signed", "completed"].includes(String(document.status));
  if (!signed) return false;
  const deposits = obligations.filter(item => {
    const source = object(item.source);
    return source.type === "document" && source.id === document.id && source.snapshot_id === snapshot.id
      && (item.kind === "deposit" || item.due_rule === "on_signature") && item.status !== "superseded";
  });
  if (deposits.some(item => Number(item.amount_cents || 0) > Number(item.allocated_cents || 0))) return false;
  // A required payment output may have a gate independent of receivables.
  const requiredPayment = Object.values(object(snapshot.output_defs)).some(value => {
    const def = object(value);
    return def.type === "payment" && (def.required === true || ["signed", "completed"].includes(String(def.required_for)));
  });
  return !requiredPayment || document.status === "completed";
}
