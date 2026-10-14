/**
 * What a document amounts to, at a glance: its progress status, its total,
 * what has been paid and when it moved. Lists and tiles show this, and the
 * project value sums the totals of the documents a customer accepted.
 *
 * The total is the authoritative pricing evaluation (documentCheckoutPricing)
 * over the parameters the customer was sent (the current snapshot), or the
 * draft's own parameters before it is sent. Reads only; nothing is written.
 */
import type { JsonObject } from "../platform/storage.js";
import { FMDocModel } from "./schemas.js";
import { readDocumentSnapshot } from "./storage.js";
import { documentCheckoutPricing } from "./service.js";

export type DocumentSummary = {
  status: string;
  accepted: boolean;
  total_cents: number | null;
  paid_cents: number;
  sent_at: string;
  first_viewed_at: string;
  signed_at: string;
  updated_at: string;
};

const ACCEPTED = new Set(["signed", "completed"]);

const text = (value: unknown) => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());
const object = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});

/** Parameters that price the document: what was sent, else the draft. */
async function pricedParams(orgId: string, doc: JsonObject) {
  const snapshotId = text(object(doc.delivery).current_snapshot_id);
  if (snapshotId) {
    const snapshot = await readDocumentSnapshot(orgId, snapshotId).catch(() => null);
    if (snapshot && Object.keys(object(snapshot.params)).length) return object(snapshot.params);
  }
  return object(doc.params);
}

function paidCents(doc: JsonObject) {
  const defs = object(doc.output_defs);
  const outputs = object(doc.outputs);
  let total = 0;
  for (const [key, def] of Object.entries(defs)) {
    if (text(object(def).type) !== "payment") continue;
    const value = object(outputs[key]);
    if (text(value.status) === "pending") continue;
    if (!text(value.payment_id) && !text(value.payment_method) && !text(value.method)) continue;
    const cents = Math.round(Number(value.amount_cents));
    if (Number.isFinite(cents) && cents > 0) total += cents;
  }
  return total;
}

export async function documentSummary(orgId: string, docValue: JsonObject): Promise<DocumentSummary> {
  const doc = object(docValue);
  const delivery = object(doc.delivery);
  const status = text(FMDocModel.documentProgress(doc)) || text(doc.status) || "draft";
  let total: number | null = null;
  const params = await pricedParams(orgId, doc);
  if (Array.isArray(params.scope_items) && params.scope_items.length) {
    try {
      const priced = await documentCheckoutPricing(orgId, doc, params, {});
      const cents = Math.round(Number(priced.totals.total_cents));
      total = Number.isFinite(cents) ? cents : null;
    } catch {
      total = null;
    }
  }
  return {
    status,
    accepted: ACCEPTED.has(status) || ACCEPTED.has(text(doc.status)),
    total_cents: total,
    paid_cents: paidCents(doc),
    sent_at: text(delivery.sent_at),
    first_viewed_at: text(delivery.first_viewed_at),
    signed_at: text(delivery.signed_at || object(doc.signing).completed_at),
    updated_at: text(doc.updated_at)
  };
}

/**
 * The value of a project: the totals of every document its customer accepted
 * (signed or completed), added together. Null when nothing is accepted yet,
 * so a caller can fall back to another source; zero is a real value.
 */
export async function acceptedDocumentsValueCents(orgId: string, documents: JsonObject[]) {
  let accepted = 0;
  let sum = 0;
  for (const doc of documents) {
    const status = text(object(doc).status);
    if (!ACCEPTED.has(status)) continue;
    const summary = await documentSummary(orgId, doc);
    if (summary.total_cents === null) continue;
    accepted += 1;
    sum += summary.total_cents;
  }
  return accepted ? sum : null;
}
