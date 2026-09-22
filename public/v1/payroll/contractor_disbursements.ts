import type { PlatformAuthContext } from "../platform/auth.js";
import { readOrganizationConnection } from "../connections/storage.js";
import { listDocuments } from "../platform/storage.js";
import { hydratedWorkforceUser } from "../workforce/service.js";
import { createDisbursement, createPayable, listPayables, PAYMENT_DISBURSEMENT_COLLECTION } from "../payments/storage.js";
import { asArray, asObject, cleanText, type JsonObject } from "./storage.js";

function addDays(dateValue: string, days: number) {
  const date = new Date(`${dateValue}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + Math.max(0, Math.min(365, Math.floor(days))));
  return date.toISOString();
}

async function payeeTerms(orgId: string, payee: JsonObject) {
  try {
    if (cleanText(payee.type) === "organization_connection") {
      return asObject((await readOrganizationConnection(orgId, cleanText(payee.id))).payment_terms);
    }
    return asObject((await hydratedWorkforceUser(orgId, cleanText(payee.id))).payment_terms);
  } catch {
    return {};
  }
}

export async function syncContractorPayrollPayables(orgId: string, batch: JsonObject, ctx: PlatformAuthContext) {
  const existing = await listPayables(orgId, { include_void: true });
  const created: JsonObject[] = [];
  for (const item of asArray(batch.items).map(asObject)) {
    const payee = asObject(item.payee);
    if (cleanText(payee.worker_type || "employee") === "employee") continue;
    const payableId = `payment_payable_payroll_${cleanText(batch.id)}_${cleanText(item.id)}`;
    const current = existing.find((entry) => cleanText(entry.id) === payableId);
    if (current) { created.push(current); continue; }
    const terms = await payeeTerms(orgId, payee);
    const netDays = cleanText(terms.basis) === "net_days" ? Math.max(0, Number(terms.net_days || 0)) : 0;
    const projectIds = [...new Set(asArray(item.entries).map(asObject).map((entry) => cleanText(entry.project_id)).filter(Boolean))];
    const payable = await createPayable(orgId, {
      id: payableId,
      project_id: projectIds.length === 1 ? projectIds[0] : "",
      kind: "contractor_payroll",
      source: { type: "payroll_batch_item", id: cleanText(item.id), batch_id: cleanText(batch.id) },
      payee_ref: { kind: cleanText(payee.type), id: cleanText(payee.id), name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type) },
      amount_cents: Number(item.net_cents || 0), currency: cleanText(batch.currency || "USD"),
      due_at: addDays(cleanText(batch.pay_date), netDays),
      notes: `${cleanText(batch.run_type) === "off_cycle" ? "Off-cycle" : "Payroll"} contractor payout for ${cleanText(batch.pay_date)}`,
      metadata: { payroll_batch_id: cleanText(batch.id), payroll_batch_item_id: cleanText(item.id), project_ids: projectIds, payment_terms: terms }
    }, ctx);
    created.push(payable);
  }
  return created;
}

export async function syncPaidContractorPayrollDisbursements(orgId: string, batch: JsonObject, ctx: PlatformAuthContext) {
  const payables = await syncContractorPayrollPayables(orgId, batch, ctx);
  const disbursementDocs = await listDocuments(orgId, PAYMENT_DISBURSEMENT_COLLECTION);
  const existing = new Set(disbursementDocs.map((doc) => cleanText(doc.id)));
  const results: JsonObject[] = [];
  for (const item of asArray(batch.items).map(asObject)) {
    const payee = asObject(item.payee);
    if (cleanText(payee.worker_type || "employee") === "employee" || cleanText(item.status) !== "paid") continue;
    const payableId = `payment_payable_payroll_${cleanText(batch.id)}_${cleanText(item.id)}`;
    const payable = payables.find((entry) => cleanText(entry.id) === payableId);
    if (!payable || cleanText(payable.status) === "paid") continue;
    const id = `payment_disbursement_payroll_${cleanText(batch.id)}_${cleanText(item.id)}`;
    if (existing.has(id)) continue;
    const result = await createDisbursement(orgId, {
      id, kind: "contractor_payroll", payable_ids: [payableId], amount_cents: Number(item.net_cents || 0),
      currency: cleanText(batch.currency || "USD"), paid_at: cleanText(item.paid_at),
      method: { type: "third_party_payroll", label: "Third-party payroll/provider" },
      notes: cleanText(item.payment_reference),
      metadata: { payroll_batch_id: cleanText(batch.id), payroll_batch_item_id: cleanText(item.id), payee }
    }, ctx);
    results.push(asObject(result.disbursement));
  }
  return results;
}
