import type { PlatformAuthContext } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import { normalizeScheduleRows, resolveScheduleItems } from "../payments/schedule_terms.js";
import { listProjectDocuments, readDocumentInstance, saveDocumentInstance } from "./storage.js";

/**
 * The project's account, for the production documents that speak about money
 * already agreed: a change order adds to the contract, an invoice bills what
 * is owed, a completion certificate collects what is left.
 *
 * A template opts in by declaring `account: { type: "object", source:
 * "project_account" }`. The account then rides on params.account, read from
 * the project's receivables (what signed documents minted and what payments
 * were applied), together with the few figures each document type derives
 * from it. It is refreshed until the document is sent and frozen from then
 * on, so a sent document keeps the numbers the customer was shown.
 */
export const PROJECT_ACCOUNT_SOURCE = "project_account";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function stableId(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 150);
}

/** The receivable an invoice's own charges (not in the contract) become when it is sent. */
export function invoiceChargesObligationId(documentId: string) {
  return `payment_obligation_${stableId(documentId)}`;
}

type AccountRow = { id: string; label: string; kind: string; amount_cents: number; paid_cents: number; balance_cents: number; due_rule: string; due_at: string; status: string; due_text: string };

function dueText(row: Omit<AccountRow, "due_text">) {
  if (cleanText(row.status) === "paid") return "Paid";
  const dueAt = cleanText(row.due_at).slice(0, 10);
  if (dueAt) return `Due ${dueAt}`;
  const rule = cleanText(row.due_rule);
  if (rule === "on_signature") return "Due at signing";
  if (rule === "project_completion") return "Due on completion";
  if (rule === "on_invoice" || rule === "invoice") return "Due when invoiced";
  return "Not yet scheduled";
}

type AccountOptions = { documentId?: string; sourceDocumentId?: string };

/** A signed proposal or contract on the project, for projects whose receivables were never minted. */
async function signedAgreement(orgId: string, projectId: string, options: AccountOptions) {
  const signed = (await listProjectDocuments(orgId, projectId).catch(() => [] as JsonObject[]))
    .filter((document) => ["signed", "completed"].includes(cleanText(document.status)))
    .filter((document) => ["proposal", "contract"].includes(cleanText(document.document_type)));
  return signed.find((document) => cleanText(document.id) === cleanText(options.sourceDocumentId)) || signed[0] || null;
}

async function agreementTotalCents(orgId: string, document: JsonObject) {
  const { documentCheckoutPricing } = await import("./service.js");
  const params = asObject(document.params);
  const pricing = await documentCheckoutPricing(orgId, document, params, {}).catch(() => null);
  if (!pricing) return cents(params.amount_cents);
  const subtotal = cents(pricing.totals.subtotal_cents) - Math.round(Number(pricing.totals.adjustments_cents || 0));
  return Math.max(0, subtotal + Math.round(subtotal * (Number(params.tax_percent) || 0) / 100)) || cents(params.amount_cents);
}

const OWN_CHARGES_OPTION = { value: "custom", label: "Other charges only", description: "Bill only the charges you add below." };

export async function projectAccount(orgId: string, projectId: string, options: AccountOptions = {}): Promise<JsonObject> {
  const empty: JsonObject = {
    has_contract: false, contract_title: "", contract_document_id: "", contract_cents: 0, change_orders_cents: 0,
    total_cents: 0, paid_cents: 0, balance_cents: 0, schedule: [], bill_options: [OWN_CHARGES_OPTION]
  };
  if (!projectId) return empty;
  const payments = await import("../payments/storage.js");
  const [obligations, schedules] = await Promise.all([
    payments.listProjectObligations(orgId, projectId, { skipFlag: true }).catch(() => [] as JsonObject[]),
    payments.listProjectPaymentSchedules(orgId, projectId, { skipFlag: true }).catch(() => [] as JsonObject[])
  ]);
  const liveSchedules = new Set(schedules.map((schedule) => cleanText(schedule.id)));
  // The document's own receivables are what it adds to the account, never part of it.
  const rows = obligations
    .filter((item) => cleanText(item.direction || "inbound") !== "outbound" && cleanText(item.status) !== "void")
    .filter((item) => !cleanText(item.schedule_id) || liveSchedules.has(cleanText(item.schedule_id)))
    .filter((item) => !options.documentId || (cleanText(asObject(item.source).id) !== options.documentId && cleanText(item.id) !== invoiceChargesObligationId(options.documentId)))
    // Dated payments first, then the order they were agreed in.
    .sort((a, b) => (cleanText(a.due_at) || "9999").localeCompare(cleanText(b.due_at) || "9999") || cleanText(a.created_at).localeCompare(cleanText(b.created_at)) || Number(a.sequence || 0) - Number(b.sequence || 0))
    .map((item): AccountRow => {
      const amount = cents(item.amount_cents);
      const paid = Math.min(amount, cents(item.allocated_cents));
      const row = {
        id: cleanText(item.id), label: cleanText(item.label || "Payment"), kind: cleanText(item.kind),
        amount_cents: amount, paid_cents: paid, balance_cents: amount - paid,
        due_rule: cleanText(item.due_rule), due_at: cleanText(item.due_at), status: cleanText(item.status)
      };
      return { ...row, due_text: dueText(row) };
    });
  if (!rows.length) {
    const agreement = await signedAgreement(orgId, projectId, options);
    if (!agreement) return empty;
    const total = await agreementTotalCents(orgId, agreement);
    return { ...empty, has_contract: true, contract_title: cleanText(agreement.title), contract_document_id: cleanText(agreement.id), contract_cents: total, total_cents: total, balance_cents: total };
  }
  const sum = (list: AccountRow[], key: "amount_cents" | "paid_cents") => list.reduce((total, row) => total + row[key], 0);
  const total = sum(rows, "amount_cents");
  const paid = sum(rows, "paid_cents");
  const changeOrders = sum(rows.filter((row) => row.kind === "change_order"), "amount_cents");
  const base = schedules.find((schedule) => cleanText(schedule.schedule_mode) !== "append" && cleanText(asObject(schedule.source).type) !== "invoice") || schedules[0] || {};
  const open = rows.filter((row) => row.balance_cents > 0);
  return {
    has_contract: true,
    contract_title: cleanText(base.title),
    contract_document_id: cleanText(asObject(base.source).id),
    contract_cents: total - changeOrders,
    change_orders_cents: changeOrders,
    total_cents: total,
    paid_cents: paid,
    balance_cents: total - paid,
    schedule: rows,
    // What an invoice can bill: each open payment, everything that is open, or only its own charges.
    bill_options: [
      ...open.map((row) => ({ value: row.id, label: row.label, description: row.due_text, price_cents: row.balance_cents })),
      ...(open.length > 1 ? [{ value: "balance", label: "Remaining balance", description: `All ${open.length} open payments`, price_cents: total - paid }] : []),
      OWN_CHARGES_OPTION
    ]
  };
}

function usesAccount(document: JsonObject) {
  return cleanText(asObject(asObject(document.param_defs).account).source) === PROJECT_ACCOUNT_SOURCE;
}

/** Sent documents keep the account they were sent with. */
function accountFrozen(document: JsonObject) {
  return !["", "draft", "issued"].includes(cleanText(document.status));
}

function lineAmountCents(line: JsonObject) {
  const price = Number(line.unit_price ?? line.unitPrice);
  if (Number.isFinite(price)) return Math.round((Number(line.quantity ?? 1) || 0) * price * 100);
  return Math.round(Number(line.amount_cents) || 0);
}

async function changeOrderFigures(orgId: string, document: JsonObject, params: JsonObject, account: JsonObject) {
  const change = await agreementTotalCents(orgId, { ...document, params });
  const schedule = resolveScheduleItems(normalizeScheduleRows(params.payment_schedule), { total_cents: change });
  return {
    change_cents: change,
    new_total_cents: cents(account.total_cents) + change,
    due_now_cents: schedule.filter((item) => item.due_rule === "on_signature").reduce((total, item) => total + item.amount_cents, 0)
  };
}

function invoiceFigures(params: JsonObject, account: JsonObject) {
  const schedule = asArray(account.schedule).map(asObject);
  const bill = cleanText(params.bill);
  const billed = bill === "balance" ? schedule.filter((row) => cents(row.balance_cents) > 0) : schedule.filter((row) => row.id === bill);
  const charges = asArray(params.line_items).map(asObject)
    .map((line) => ({ label: cleanText(line.display_name || line.name || line.description) || "Charge", detail: cleanText(line.name || line.display_name) ? cleanText(line.description) : "", amount_cents: lineAmountCents(line) }))
    .filter((line) => line.amount_cents > 0);
  const chargesCents = charges.reduce((total, line) => total + line.amount_cents, 0);
  const tax = Math.round(chargesCents * (Number(params.tax_percent) || 0) / 100);
  const lines = [
    ...billed.map((row) => ({ label: row.label, detail: cents(row.paid_cents) > 0 ? `Balance of ${cleanText(row.label).toLowerCase()}` : "", amount_cents: cents(row.balance_cents) })),
    ...charges,
    ...(tax > 0 ? [{ label: `Sales tax (${Number(params.tax_percent)}%)`, detail: "", amount_cents: tax }] : [])
  ];
  const due = lines.reduce((total, line) => total + line.amount_cents, 0);
  // An invoice rendered for the Money app arrives with its amount already settled there.
  const explicit = !bill && params.amount_due_cents !== undefined && params.amount_due_cents !== null && params.amount_due_cents !== "";
  return {
    billing: { lines, obligation_ids: billed.map((row) => row.id), charges_cents: chargesCents + tax, total_cents: due },
    amount_due_cents: explicit ? cents(params.amount_due_cents) : due
  };
}

/**
 * Params with the project account and the figures the document type derives
 * from it. Also fills the dates and numbers a new document starts with.
 */
export async function deriveAccountParams(orgId: string, document: JsonObject, paramsValue: JsonObject): Promise<JsonObject> {
  if (!usesAccount(document) || accountFrozen(document)) return paramsValue;
  const params = { ...paramsValue };
  const documentId = cleanText(document.id);
  const projectId = cleanText(document.project_id);
  const account = await projectAccount(orgId, projectId, { documentId, sourceDocumentId: cleanText(params.source_document_id) });
  params.account = account;
  const type = cleanText(document.document_type);
  if (type === "change_order") {
    if (!cleanText(params.source_document_id) && cleanText(account.contract_document_id)) params.source_document_id = account.contract_document_id;
    if (!cleanText(params.change_date)) params.change_date = today();
    Object.assign(params, await changeOrderFigures(orgId, document, params, account));
  } else if (type === "invoice") {
    if (!cleanText(params.issue_date)) params.issue_date = today();
    if (!cleanText(params.invoice_number)) params.invoice_number = `INV-${cleanText(params.issue_date).replace(/-/g, "").slice(2, 8)}-${documentId.slice(-5).toUpperCase()}`;
    if (!cleanText(params.due_date)) {
      const { invoicePaymentSettingsForProject } = await import("../payments/invoices.js");
      const days = Number(asObject(await invoicePaymentSettingsForProject(orgId, projectId).catch(() => ({}))).default_due_days) || 0;
      params.due_date = new Date(Date.parse(`${cleanText(params.issue_date)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    }
    Object.assign(params, invoiceFigures(params, account));
  } else if (type === "completion_certificate") {
    if (!cleanText(params.completed_at)) params.completed_at = today();
    if (!cleanText(params.warranty_start)) params.warranty_start = params.completed_at;
    params.amount_due_cents = params.collect_final_payment === false ? 0 : cents(account.balance_cents);
  }
  return params;
}

/** Freeze the account onto the document as it goes out. */
export async function persistAccountParams(orgId: string, document: JsonObject): Promise<JsonObject> {
  if (!usesAccount(document) || accountFrozen(document)) return document;
  const params = await deriveAccountParams(orgId, document, asObject(document.params));
  if (JSON.stringify(params) === JSON.stringify(document.params)) return document;
  return saveDocumentInstance(orgId, cleanText(document.id), { ...document, params });
}

/**
 * Sending an invoice makes what it bills due: the contract payments it names
 * get the invoice's due date, and its own charges become a receivable.
 */
export async function applyInvoiceOnSend(orgId: string, document: JsonObject, ctx: PlatformAuthContext) {
  if (cleanText(document.document_type) !== "invoice" || !usesAccount(document)) return;
  const params = asObject(document.params);
  const billing = asObject(params.billing);
  const documentId = cleanText(document.id);
  const projectId = cleanText(document.project_id);
  const dueAt = cleanText(params.due_date) ? `${cleanText(params.due_date).slice(0, 10)}T00:00:00.000Z` : "";
  const payments = await import("../payments/storage.js");
  try {
    for (const id of asArray(billing.obligation_ids).map(cleanText).filter(Boolean)) {
      await payments.markPaymentObligationDue(orgId, id, dueAt, documentId, ctx).catch(() => null);
    }
    if (cents(billing.charges_cents) > 0) {
      await payments.ensureInvoiceReceivable(orgId, {
        invoice_id: documentId, project_id: projectId, branch_id: cleanText(document.branch_id), amount_cents: cents(billing.charges_cents),
        due_at: dueAt, label: `Invoice ${cleanText(params.invoice_number)}`.trim(), source: { type: "document", id: documentId }
      }, ctx);
    }
  } catch (error) {
    // Money app off: the invoice still goes out, with nothing behind it to mark due.
    if (cleanText(asObject(error).code) !== "app_flag_disabled") throw error;
  }
}

/**
 * What a payment made from the document pays. `amount_cents` is the open
 * balance of the receivables it bills (null when the document prices its own
 * payment, as a change order does from its schedule); `obligation_ids` are
 * the receivables the payment is applied to; `hold` keeps a payment for
 * receivables that signing has not minted yet.
 */
export async function documentPaymentTarget(orgId: string, documentId: string): Promise<{ amount_cents: number | null; obligation_ids: string[]; hold?: boolean } | null> {
  const document = await readDocumentInstance(orgId, documentId);
  if (!usesAccount(document)) return null;
  const type = cleanText(document.document_type);
  const params = asObject(document.params);
  const projectId = cleanText(document.project_id);
  const payments = await import("../payments/storage.js");
  const receivables = (await payments.listProjectObligations(orgId, projectId, { skipFlag: true }).catch(() => [] as JsonObject[]))
    .filter((item) => cleanText(item.direction || "inbound") !== "outbound" && cleanText(item.status) !== "void");
  const open = receivables.filter((item) => cleanText(item.status) !== "paid");
  const balance = (list: JsonObject[]) => list.reduce((total, item) => total + Math.max(0, cents(item.amount_cents) - cents(item.allocated_cents)), 0);
  if (type === "change_order") {
    const own = open.filter((item) => cleanText(asObject(item.source).id) === documentId);
    return { amount_cents: null, obligation_ids: own.map((item) => cleanText(item.id)), hold: !own.length };
  }
  if (type === "invoice") {
    const ids = new Set([...asArray(asObject(params.billing).obligation_ids).map(cleanText), invoiceChargesObligationId(documentId)]);
    const billed = open.filter((item) => ids.has(cleanText(item.id)));
    // Nothing behind the invoice (Money app off): the amount it was sent with stands.
    const tracked = receivables.some((item) => ids.has(cleanText(item.id)));
    return { amount_cents: tracked ? balance(billed) : cents(params.amount_due_cents), obligation_ids: billed.map((item) => cleanText(item.id)) };
  }
  if (type === "completion_certificate") {
    return { amount_cents: receivables.length ? balance(open) : cents(params.amount_due_cents), obligation_ids: open.map((item) => cleanText(item.id)) };
  }
  return null;
}
