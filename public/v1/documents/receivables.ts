import { badRequest } from "../platform/errors.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import {
  ensureReceivablesFromSchedule,
  type EnsureScheduleInput
} from "../payments/storage.js";
import {
  normalizeScheduleRows,
  resolveScheduleItems,
  type NormalizedScheduleRow
} from "../payments/schedule_terms.js";
import { documentCheckoutPricing } from "./service.js";
import { readDocumentInstance, readDocumentSnapshot } from "./storage.js";
import { documentType } from "./types/registry.js";

/**
 * Document-engine receivables: the generalization the document-engine spec
 * (§11) calls for. Reads params.payment_schedule from the signed document
 * (snapshot params preferred — they are what the customer saw and signed),
 * resolves percent rows against the authoritative checkout pricing total, and
 * mints schedules/obligations through the same source-agnostic core the
 * legacy proposal path uses. Change orders APPEND to the project's
 * receivables instead of superseding the base contract schedule.
 */

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function centsNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

async function projectContactRef(orgId: string, projectId: string): Promise<JsonObject> {
  const projectDoc = await readDocument(orgId, "projects", projectId).catch(() => null);
  const project = asObject(asObject(projectDoc).data);
  const contacts = asArray(project.contacts).map(asObject);
  const customer = asObject(project.customer);
  const primary = contacts.find((contact) => contact.primary === true || cleanText(contact.role).toLowerCase() === "primary") || contacts[0] || {};
  const id = cleanText(primary.id || primary.contact_id || customer.id || customer.contact_id || project.contact_id || project.primary_contact_id);
  return {
    ...(id ? { id, contact_id: id } : {}),
    name: cleanText(primary.name || customer.name || project.customer_name || project.primary_contact_name),
    email: cleanText(primary.email || customer.email || project.customer_email || project.primary_contact_email).toLowerCase(),
    phone: cleanText(primary.phone || customer.phone || project.customer_phone || project.primary_contact_phone)
  };
}

/**
 * When a change order declares no schedule of its own, the whole amount
 * becomes one manual obligation — visible in the Money tab, invoiceable, and
 * payable, but not on a clock until someone dates or invoices it.
 */
function fallbackRows(typeId: string, totalCents: number, depositCents: number, documentTitle: string): NormalizedScheduleRow[] {
  const rows: NormalizedScheduleRow[] = [];
  const base = {
    kind: "fixed" as const,
    percent_bps: 0,
    expression: "",
    due_at: "",
    grace_days: 1,
    recognition: { node_id: "", hook: "onCompleted" },
    metadata: {}
  };
  if (typeId === "change_order") {
    if (totalCents > 0) {
      rows.push({
        ...base,
        id: "change_order_total",
        label: documentTitle || "Change order",
        payment_kind: "change_order",
        amount_cents: totalCents,
        due_rule: "manual"
      });
    }
    return rows;
  }
  if (depositCents > 0) {
    rows.push({
      ...base,
      id: "deposit",
      label: "Deposit",
      payment_kind: "deposit",
      amount_cents: depositCents,
      due_rule: "on_signature"
    });
  }
  const remainder = Math.max(0, totalCents - depositCents);
  if (remainder > 0) {
    rows.push({
      ...base,
      id: "final",
      label: "Final Payment",
      payment_kind: "final",
      amount_cents: remainder,
      due_rule: "project_completion"
    });
  }
  return rows;
}

export async function ensureReceivablesForSignedDocument(
  orgId: string,
  documentId: string,
  snapshotId = "",
  options: JsonObject = {}
) {
  const document = await readDocumentInstance(orgId, documentId);
  const typeId = cleanText(document.document_type);
  const projectId = cleanText(document.project_id);
  if (!projectId) throw badRequest("missing_project_id", "Signed document is missing a project id.");
  const type = documentType(typeId);
  const snapshot = snapshotId
    ? await readDocumentSnapshot(orgId, snapshotId).catch(() => null)
    : null;
  const params = asObject(asObject(snapshot).params ?? document.params);
  const signedAt = cleanText(asObject(document.delivery).signed_at || options.signed_at) || new Date().toISOString();

  // The checkout pricing engine is the authoritative money basis — it retotals
  // conditional scope rows exactly like the portal checkout does. Payment-
  // method adjustments (ACH discount / card fee) are excluded: they belong to
  // each payment capture, not to the contract total the schedule divides.
  let basisTotalCents = 0;
  try {
    const pricing = await documentCheckoutPricing(orgId, document, params, {});
    const totals = asObject(pricing.totals);
    const scopeSubtotal = centsNumber(totals.subtotal_cents) - Math.round(Number(totals.adjustments_cents || 0));
    const taxPercent = Number(params.tax_percent) || 0;
    basisTotalCents = Math.max(0, scopeSubtotal + Math.round(scopeSubtotal * taxPercent / 100));
  } catch {
    basisTotalCents = 0;
  }
  if (!basisTotalCents) basisTotalCents = centsNumber(params.amount_cents);

  let rows = normalizeScheduleRows(params.payment_schedule);
  if (!rows.length) {
    rows = fallbackRows(typeId, basisTotalCents, centsNumber(params.deposit_cents), cleanText(document.title));
  }
  // Rows on a change order that carry no explicit classification are change
  // orders — profitability and scope triggers count them as contract additions.
  if (typeId === "change_order") {
    rows = rows.map((row) => row.payment_kind === "other" ? { ...row, payment_kind: "change_order" } : row);
  }
  const items = resolveScheduleItems(rows, { total_cents: basisTotalCents, signed_at: signedAt });
  if (!items.length) return { skipped: true, reason: "no_schedule_items" };

  const input: EnsureScheduleInput = {
    project_id: projectId,
    branch_id: cleanText(document.branch_id || "default") || "default",
    title: cleanText(document.title) || (type ? type.label : "Document"),
    contact_ref: await projectContactRef(orgId, projectId),
    source: {
      type: "document",
      id: documentId,
      snapshot_id: cleanText(snapshotId),
      event_key: `document_signed:${documentId}:${cleanText(snapshotId)}`
    },
    items,
    total_cents: basisTotalCents || undefined,
    mode: typeId === "change_order" ? "append" : "replace",
    event_type: typeId === "change_order"
      ? "payment_schedule.created_from_change_order"
      : "payment_schedule.created_from_signed_document"
  };
  return ensureReceivablesFromSchedule(orgId, input);
}
