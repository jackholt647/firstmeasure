import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { PlatformError, badRequest } from "../platform/errors.js";
import { documentType, listDocumentTypes } from "./types/registry.js";

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

const DOCUMENT_TYPES_MODULE = "document_types";
export type OrganizationDocumentType = { id: string; label: string; color: string; icon: string; kind: string; department_ids: string[]; archived: boolean };
/**
 * An organization's document types: its own groupings of templates, with a
 * name, a color and the departments that use them. `kind` says what a blank
 * document of the type is (the built-in behavior: a proposal is signed, an
 * invoice is owed); a type with no kind is a plain document. Until an
 * organization edits them, its types are one per built-in kind.
 * `assignments` moves a template to a type other than its kind's.
 */
export async function readOrganizationDocumentTypes(orgId: string): Promise<{ types: OrganizationDocumentType[]; assignments: Record<string, string>; customized: boolean }> {
  let stored: JsonObject = {};
  try { stored = object(object(await readBranchModule(orgId, "default", DOCUMENT_TYPES_MODULE)).data); }
  catch (error) { if (!(error instanceof PlatformError && error.statusCode === 404)) throw error; }
  if (Array.isArray(stored.types)) return { types: normalizeDocumentTypes(stored.types), assignments: normalizeAssignments(stored.assignments), customized: true };
  // The receipt is produced by payments, never started from New document.
  const types = listDocumentTypes().filter(kind => kind.id !== "payment_receipt")
    .map(kind => ({ id: kind.id, label: kind.id === "generic" ? "Other" : kind.label, color: "", icon: kind.icon, kind: kind.id, department_ids: [], archived: false }));
  return { types, assignments: {}, customized: false };
}
const typeSlug = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
function normalizeDocumentTypes(value: unknown): OrganizationDocumentType[] {
  const seen = new Set<string>();
  const out: OrganizationDocumentType[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = object(raw), label = String(entry.label ?? "").trim().slice(0, 60);
    let id = typeSlug(entry.id) || typeSlug(label);
    if (!label || !id) continue;
    for (let n = 2; seen.has(id); n += 1) id = `${typeSlug(entry.id) || typeSlug(label)}_${n}`;
    seen.add(id);
    const kind = String(entry.kind ?? "").trim().toLowerCase();
    out.push({
      id, label,
      color: /^#[0-9a-f]{6}$/i.test(String(entry.color ?? "")) ? String(entry.color) : "",
      icon: /^fa-[a-z0-9-]{1,40}$/.test(String(entry.icon ?? "")) ? String(entry.icon) : "",
      kind: documentType(kind) ? kind : "generic",
      department_ids: (Array.isArray(entry.department_ids) ? entry.department_ids : []).map(String).filter(Boolean).slice(0, 50),
      archived: entry.archived === true
    });
  }
  return out;
}
function normalizeAssignments(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value)).map(([template, type]) => [String(template).slice(0, 160), typeSlug(type)]).filter(([template, type]) => template && type).slice(0, 2000));
}
export async function saveOrganizationDocumentTypes(orgId: string, input: { types: unknown; assignments?: unknown }) {
  const types = normalizeDocumentTypes(input.types);
  if (!types.length || types.length > 60) throw badRequest("document_types_invalid", "Keep between 1 and 60 document types, each with a name.");
  if (!types.some(type => !type.archived)) throw badRequest("document_types_invalid", "At least one document type must stay in use.");
  const ids = new Set(types.map(type => type.id));
  const assignments = Object.fromEntries(Object.entries(normalizeAssignments(input.assignments)).filter(([, type]) => ids.has(type)));
  await saveBranchModule(orgId, "default", DOCUMENT_TYPES_MODULE, { data: { types, assignments } }, { replace: true });
  return { types, assignments, customized: true };
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
