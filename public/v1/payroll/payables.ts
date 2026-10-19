/*
 * Payees paid through payables (docs/architecture/pay-rules.md#paid-with-payroll-or-through-payables).
 *
 * The payroll ledger stays the one record of what is owed. Whether a payee is paid with payroll or through payables
 * is read from settings that already exist: an outside company is always paid through payables, and an independent
 * contractor whose payment terms are net days is too; everyone else is paid with payroll. A pay run keeps that answer
 * on each item when it is drafted (`metadata.paid_through`, `payment_terms`, `due_date`).
 *
 * A payables item of a pay run becomes a bill (a payable of kind `contractor_payroll`) when the run is entered. Its id
 * is fixed by the run and the item, and it names the ledger entries the item pays. The bill is paid wherever payables
 * are paid (`createDisbursement` in payments/storage.ts calls `settlePaidPayrollBills`): the item is then marked paid
 * once (`recordBillPaid`), so its entries count as paid in Payroll and My pay and no later run includes them. Marking
 * the item paid in Payroll records the payment against the bill instead, once. Reopening or voiding a run removes its
 * unpaid bills; a run whose bill has a payment cannot be reopened.
 */
import type { PlatformAuthContext } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest } from "../platform/errors.js";
import { listDocuments, readDocument } from "../platform/storage.js";
import { listOrganizationConnections } from "../connections/storage.js";
import { createDisbursement, createPayable, listPayables, PAYMENT_PAYABLE_COLLECTION, voidPayable } from "../payments/storage.js";
import { billAmountCents, billDueDate, holdItemsForReimbursementPaidElsewhere, isBillItem, recordBillPaid, type PayeeRoute, type PayeeRoutes } from "./service.js";
import type { PayeeScope } from "./payee-scope.js";
import { asArray, asObject, cleanText, listPayrollLedgerEntries, readPayrollBatch, voidPayrollLedgerEntry, type JsonObject } from "./storage.js";

type Payee = { type?: unknown; id?: unknown };
export const PAYROLL_BILL_KIND = "contractor_payroll";
const keyOf = (payee: Payee) => `${cleanText(payee.type)}:${cleanText(payee.id)}`;
export const billPayableId = (batchId: string, itemId: string) => `payment_payable_payroll_${batchId}_${itemId}`;
const billDisbursementId = (batchId: string, itemId: string) => `payment_disbursement_payroll_${batchId}_${itemId}`;

function termsOf(value: unknown): PayeeRoute["payment_terms"] {
  const terms = asObject(value);
  return cleanText(terms.basis) === "net_days"
    ? { basis: "net_days", net_days: Math.max(0, Math.min(365, Math.floor(Number(terms.net_days || 0)))) }
    : { basis: "payroll_schedule", net_days: 0 };
}

/**
 * How each payee is paid. Outside companies: through payables, due on their terms (on the pay date when they are paid
 * on the pay schedule). Independent contractors on net days: through payables. Everyone else, and everyone while the
 * organization has Money off (there are no payables then): with payroll.
 */
export async function paymentRoutes(orgId: string, payees: Payee[]): Promise<PayeeRoutes> {
  const routes: PayeeRoutes = new Map();
  const wanted = [...new Map(payees.map((payee) => [keyOf(payee), payee])).values()];
  if (!wanted.length) return routes;
  const payroll = (): PayeeRoute => ({ paid_through: "payroll", payment_terms: { basis: "payroll_schedule", net_days: 0 } });
  if (!(await isAppFlagEnabled(orgId, "platform", "money").catch(() => false))) {
    for (const payee of wanted) routes.set(keyOf(payee), payroll());
    return routes;
  }
  const needUsers = wanted.some((payee) => cleanText(payee.type) === "organization_user");
  const needCompanies = wanted.some((payee) => cleanText(payee.type) === "organization_connection");
  const users = needUsers ? new Map((await listDocuments(orgId, "users")).map((row) => [cleanText(row.id), asObject(row.data)])) : new Map<string, JsonObject>();
  const companies = needCompanies ? new Map((await listOrganizationConnections(orgId).catch(() => [])).map((row) => [cleanText(row.id), asObject(row)])) : new Map<string, JsonObject>();
  for (const payee of wanted) {
    const type = cleanText(payee.type), id = cleanText(payee.id);
    if (type === "organization_connection") routes.set(keyOf(payee), { paid_through: "payables", payment_terms: termsOf(companies.get(id)?.payment_terms) });
    else if (type === "organization_user") {
      const user = users.get(id) || {};
      const terms = termsOf(user.payment_terms);
      routes.set(keyOf(payee), cleanText(user.worker_classification) === "independent_contractor" && terms.basis === "net_days" ? { paid_through: "payables", payment_terms: terms } : payroll());
    } else routes.set(keyOf(payee), payroll());
  }
  return routes;
}

/** Routes for everyone a run on this schedule could pay: the payees with open earnings on it, and those already in it. */
export async function routesForSchedule(orgId: string, scheduleId: string, also: Payee[] = []) {
  const entries = await listPayrollLedgerEntries(orgId, { schedule_id: scheduleId, open_only: true, limit: 5000 });
  return paymentRoutes(orgId, [...entries.map((entry) => asObject(entry.payee)), ...also]);
}

/** The upcoming preview says how each payee would be paid and, for a bill, when it would be due. A read; nothing is written. */
export async function withPaymentRoutes<T extends JsonObject>(orgId: string, result: T): Promise<T> {
  const occurrences = asArray(result.upcoming).map(asObject);
  const payees = occurrences.flatMap((occurrence) => [...asArray(occurrence.employees), ...asArray(occurrence.subcontractors)].map((item) => asObject(asObject(item).payee)));
  const routes = await paymentRoutes(orgId, payees);
  const decorate = (occurrence: JsonObject) => (rows: unknown) => asArray(rows).map(asObject).map((item) => {
    const route = routes.get(keyOf(asObject(item.payee)));
    if (!route) return item;
    return { ...item, paid_through: route.paid_through, ...(route.paid_through === "payables" ? { payment_terms: route.payment_terms, due_date: billDueDate(cleanText(occurrence.pay_date), route) } : {}) };
  });
  return { ...result, upcoming: occurrences.map((occurrence) => ({ ...occurrence, employees: decorate(occurrence)(occurrence.employees), subcontractors: decorate(occurrence)(occurrence.subcontractors) })) };
}

async function readPayable(orgId: string, id: string): Promise<JsonObject | null> {
  const doc = await readDocument(orgId, PAYMENT_PAYABLE_COLLECTION, id).catch(() => null);
  return doc ? { ...asObject(doc.data), id: cleanText(doc.id) || id } : null;
}

function billBreakdown(item: JsonObject) {
  const totals = asObject(item.subgroup_totals);
  const reimbursement = Number(totals.reimbursement || 0);
  return {
    earnings_cents: Object.entries(totals).filter(([key, value]) => !["reimbursement", "off_cycle", "clawback"].includes(key) && Number(value) > 0).reduce((sum, [, value]) => sum + Number(value), 0),
    reimbursement_cents: reimbursement,
    off_cycle_cents: Number(totals.off_cycle || 0),
    clawback_cents: Number(totals.clawback || 0),
    net_cents: Number(item.net_cents || 0),
    reimbursement_payable_ids: asArray(item.entries).map(asObject).filter((entry) => cleanText(entry.kind) === "reimbursement" && cleanText(asObject(entry.metadata).payable_id) && Number(entry.allocation_cents || 0) > 0).map((entry) => cleanText(asObject(entry.metadata).payable_id))
  };
}

async function ensureBill(orgId: string, batch: JsonObject, item: JsonObject, ctx: PlatformAuthContext) {
  const id = billPayableId(cleanText(batch.id), cleanText(item.id));
  const existing = await readPayable(orgId, id);
  // One bill per item, ever: a voided bill is not brought back (reopening a run makes new items, and new bills).
  if (existing) return existing;
  const payee = asObject(item.payee), metadata = asObject(item.metadata);
  const projectIds = [...new Set(asArray(item.entries).map(asObject).map((entry) => cleanText(entry.project_id)).filter(Boolean))];
  const dueDate = cleanText(metadata.due_date) || cleanText(batch.pay_date);
  return createPayable(orgId, {
    id, project_id: projectIds.length === 1 ? projectIds[0] : "", kind: PAYROLL_BILL_KIND,
    source: { type: "payroll_batch_item", id: cleanText(item.id), batch_id: cleanText(batch.id) },
    payee_ref: { kind: cleanText(payee.type), id: cleanText(payee.id), name: cleanText(payee.name), worker_classification: cleanText(payee.worker_type) },
    amount_cents: billAmountCents(item), currency: cleanText(batch.currency || "USD"),
    due_at: `${dueDate}T12:00:00.000Z`,
    notes: `Pay run of ${cleanText(batch.pay_date)}: ${cleanText(payee.name || payee.id)}`,
    metadata: {
      payroll_batch_id: cleanText(batch.id), payroll_batch_item_id: cleanText(item.id), pay_date: cleanText(batch.pay_date), due_date: dueDate,
      payment_terms: asObject(metadata.payment_terms), project_ids: projectIds, breakdown: billBreakdown(item),
      // The stable link to what the bill pays: every ledger entry allocated to the item and how much of it.
      payroll_ledger_entries: asArray(item.entries).map(asObject).map((entry) => ({ ledger_entry_id: cleanText(entry.id), kind: cleanText(entry.kind), applied_cents: Number(entry.allocation_cents || 0) }))
    }
  }, ctx);
}

/**
 * After a pay run changes: every payables item that is entered or paid has its bill, an item marked paid in Payroll
 * has that payment recorded against its bill once, and bills of items the run no longer has (reopened, voided) are
 * removed while nothing has been paid on them.
 */
export async function syncPayRunBills(orgId: string, batchValue: JsonObject, ctx: PlatformAuthContext) {
  const batch = asObject(batchValue);
  const items = asArray(batch.items).map(asObject);
  const bills: JsonObject[] = [];
  const live = new Set<string>();
  if (cleanText(batch.status) !== "void") {
    for (const item of items.filter((row) => isBillItem(row) && ["run", "paid"].includes(cleanText(row.status)))) {
      live.add(billPayableId(cleanText(batch.id), cleanText(item.id)));
      let bill = await ensureBill(orgId, batch, item, ctx);
      const settlement = asObject(asObject(item.metadata).settlement);
      const open = Math.max(0, Number(bill.amount_cents || 0) - Number(bill.paid_cents || 0));
      if (cleanText(item.status) === "paid" && cleanText(settlement.source) !== "payables" && cleanText(bill.status) !== "paid" && cleanText(bill.status) !== "void" && open > 0) {
        await createDisbursement(orgId, {
          id: billDisbursementId(cleanText(batch.id), cleanText(item.id)), kind: PAYROLL_BILL_KIND, payable_ids: [cleanText(bill.id)], amount_cents: open,
          currency: cleanText(batch.currency || "USD"), paid_at: cleanText(item.paid_at), method: { type: "recorded_in_payroll", label: "Marked paid in Payroll" },
          notes: cleanText(item.payment_reference), metadata: { payroll_batch_id: cleanText(batch.id), payroll_batch_item_id: cleanText(item.id), payee: asObject(item.payee) }
        }, ctx);
        bill = (await readPayable(orgId, cleanText(bill.id))) || bill;
      }
      bills.push(bill);
    }
  }
  for (const stale of (await payrollBillPayables(orgId)).filter((row) => cleanText(asObject(row.source).batch_id) === cleanText(batch.id) && !live.has(cleanText(row.id)))) {
    if (cleanText(stale.status) === "void" || Number(stale.paid_cents || 0) > 0) continue;
    if (items.some((item) => cleanText(item.id) === cleanText(asObject(stale.source).id) && cleanText(item.status) === "paid")) continue;
    await voidPayable(orgId, cleanText(stale.id), ctx);
  }
  return bills;
}

/** Refuses to reopen or void a pay run when one of its bills already has a payment in payables. */
export async function assertBillsUnpaid(orgId: string, batchId: string) {
  const paid = (await payrollBillPayables(orgId)).filter((row) => cleanText(asObject(row.source).batch_id) === batchId && cleanText(row.status) !== "void" && Number(row.paid_cents || 0) > 0);
  if (paid.length) throw badRequest("payroll_bill_paid", `A bill in this pay run already has a payment in payables (${paid.map((row) => cleanText(asObject(row.payee_ref).name)).filter(Boolean).join(", ") || "a bill"}). Correct it on a later pay run instead.`);
}

async function payrollBillPayables(orgId: string) {
  return (await listPayables(orgId, { include_void: true }).catch(() => [] as JsonObject[])).filter((row) => cleanText(row.kind) === PAYROLL_BILL_KIND && cleanText(asObject(row.source).type) === "payroll_batch_item");
}

/**
 * Called by `createDisbursement` (payments/storage.ts) with the payables a payment went to. A payroll bill that is now
 * paid marks its pay run item paid, once; its approved reimbursements are then marked paid as they are for anyone
 * paid with payroll. A failure here never undoes the payment; `reconcilePayrollBills` finishes it later.
 */
export async function settlePaidPayrollBills(orgId: string, payableIds: string[], disbursement: JsonObject, ctx: PlatformAuthContext) {
  const settled: JsonObject[] = [];
  for (const id of payableIds.map(cleanText).filter((value) => value.startsWith("payment_payable_payroll_"))) {
    try {
      const payable = await readPayable(orgId, id);
      if (!payable || cleanText(payable.kind) !== PAYROLL_BILL_KIND || cleanText(payable.status) !== "paid") continue;
      const result = await settleBill(orgId, payable, { payable_id: id, disbursement_id: cleanText(disbursement.id), paid_at: cleanText(disbursement.paid_at), reference: cleanText(disbursement.notes) || cleanText(asObject(disbursement.method).label) }, ctx);
      if (result) settled.push(result);
    } catch (error) {
      console.error("payroll bill settlement failed", { orgId, payable_id: id, error: (error as Error)?.message });
    }
  }
  try { await settleReimbursementsPaidInPayables(orgId, { payableIds, disbursement }); }
  catch (error) { console.error("payroll reimbursement settlement failed", { orgId, error: (error as Error)?.message }); }
  return settled;
}

/*
 * A reimbursement approved to be paid with payroll has a payroll ledger entry and a payable of its own
 * (`payments/reimbursements.ts`, the entry's `metadata.payable_id`). Once payables records any payment on that payable,
 * payables owns it and payroll must not pay it as well:
 * - an entry no pay run holds yet is voided (an unused entry, as removing it from payroll always was), with what paid
 *   it under `metadata.settled_in_payables`, so no pay run includes it;
 * - an entry a pay run already holds, on an item not paid yet, is held: that item cannot be marked entered or paid
 *   until the run is reopened, which works the run out again without the entry, and the entry is then voided;
 * - an entry whose item is already paid was paid by payroll (payroll marks the payable paid itself); nothing changes.
 * Runs from the `createDisbursement` hook, before a pay run is drafted or reopened, and from `payroll.bills.reconcile`;
 * running it again changes nothing.
 */
async function reimbursementPayablesPaid(orgId: string, payableIds?: string[]) {
  const wanted = payableIds ? new Set(payableIds.map(cleanText)) : null;
  const rows = wanted
    ? (await Promise.all([...wanted].map((id) => readPayable(orgId, id)))).filter(Boolean) as JsonObject[]
    : await listPayables(orgId, { include_void: true }).catch(() => [] as JsonObject[]);
  return new Map(rows.filter((row) => cleanText(row.kind) === "reimbursement" && cleanText(row.status) !== "void" && Number(row.paid_cents || 0) > 0).map((row) => [cleanText(row.id), row]));
}
async function reimbursementEntriesFor(orgId: string, paid: Map<string, JsonObject>) {
  if (!paid.size) return [];
  return (await listPayrollLedgerEntries(orgId, { kind: "reimbursement", state: "accrued", limit: 5000 }))
    .filter((entry) => paid.has(cleanText(asObject(entry.metadata).payable_id)));
}
export async function settleReimbursementsPaidInPayables(orgId: string, options: { payableIds?: string[]; disbursement?: JsonObject } = {}) {
  const paid = await reimbursementPayablesPaid(orgId, options.payableIds);
  let voided = 0, held = 0;
  for (const entry of await reimbursementEntriesFor(orgId, paid)) {
    const payable = paid.get(cleanText(asObject(entry.metadata).payable_id))!;
    const note = { payable_id: cleanText(payable.id), paid_cents: Number(payable.paid_cents || 0), disbursement_id: cleanText(options.disbursement?.id), recorded_at: new Date().toISOString() };
    if (Number(entry.applied_cents || 0) === 0) { await voidPayrollLedgerEntry(orgId, cleanText(entry.id), { settled_in_payables: note }); voided++; continue; }
    held += await holdItemsForReimbursementPaidElsewhere(orgId, cleanText(entry.id), note);
  }
  return { voided_count: voided, held_count: held };
}
/** The reimbursement entries a run holds whose payable payables has paid: a reopened run is worked out without them. */
export async function reimbursementEntriesPaidElsewhere(orgId: string, batch: JsonObject) {
  const inRun = new Set(asArray(batch.items).flatMap((item) => asArray(asObject(item).entries)).map(asObject).filter((entry) => cleanText(entry.kind) === "reimbursement").map((entry) => cleanText(entry.id)));
  if (!inRun.size) return new Set<string>();
  return new Set((await reimbursementEntriesFor(orgId, await reimbursementPayablesPaid(orgId))).map((entry) => cleanText(entry.id)).filter((id) => inRun.has(id)));
}

async function settleBill(orgId: string, payable: JsonObject, settlement: JsonObject, ctx: PlatformAuthContext) {
  const source = asObject(payable.source);
  const result = await recordBillPaid(orgId, cleanText(source.batch_id), cleanText(source.id), { source: "payables", ...settlement }).catch(() => null);
  if (!result?.changed) return null;
  const { syncPaidPayrollReimbursements } = await import("../payments/reimbursements.js");
  await syncPaidPayrollReimbursements(orgId, result.batch as JsonObject, ctx);
  return { payable_id: cleanText(payable.id), batch_id: cleanText(source.batch_id), item_id: cleanText(source.id) };
}

/** Bills as Payroll shows them: what each pays, for whom, when it is due and how much is paid. A read. */
export async function listPayrollBills(orgId: string, scope: PayeeScope, options: JsonObject = {}) {
  const payables = await payrollBillPayables(orgId);
  const runs = new Map<string, JsonObject>();
  const runOf = async (id: string) => {
    if (!runs.has(id)) runs.set(id, await readPayrollBatch(orgId, id).catch(() => ({}) as JsonObject));
    return runs.get(id)!;
  };
  const status = cleanText(options.status || "open");
  const rows: JsonObject[] = [];
  for (const payable of payables) {
    const source = asObject(payable.source), payeeRef = asObject(payable.payee_ref);
    const payee = { type: cleanText(payeeRef.kind), id: cleanText(payeeRef.id), name: cleanText(payeeRef.name), worker_type: cleanText(payeeRef.worker_classification) };
    if (!scope.visible(payee)) continue;
    const state = cleanText(payable.status);
    if (status === "open" && !["open", "partially_paid"].includes(state)) continue;
    if (status === "paid" && state !== "paid") continue;
    if (state === "void" && status !== "all") continue;
    const run = await runOf(cleanText(source.batch_id));
    const item = asArray(run.items).map(asObject).find((row) => cleanText(row.id) === cleanText(source.id)) || {};
    const metadata = asObject(payable.metadata);
    rows.push({
      id: cleanText(payable.id), payee, status: state, amount_cents: Number(payable.amount_cents || 0), paid_cents: Number(payable.paid_cents || 0),
      currency: cleanText(payable.currency || "USD"), due_date: cleanText(metadata.due_date) || cleanText(payable.due_at).slice(0, 10),
      pay_date: cleanText(metadata.pay_date || run.pay_date), batch_id: cleanText(source.batch_id), item_id: cleanText(source.id),
      payment_terms: asObject(metadata.payment_terms), item_status: cleanText(item.status),
      // Paid in payables but the pay run does not show it yet: `payroll.bills.reconcile` finishes it.
      needs_settlement: state === "paid" && !!cleanText(item.id) && cleanText(item.status) !== "paid",
      created_at: cleanText(payable.created_at)
    });
  }
  return rows.sort((a, b) => cleanText(a.due_date).localeCompare(cleanText(b.due_date)) || cleanText(asObject(a.payee).name).localeCompare(cleanText(asObject(b.payee).name)));
}

/**
 * Finishes what a payment in payables started: a paid bill whose item is not marked paid yet is marked paid, and an
 * unpaid bill whose pay run item is gone (reopened or voided) is removed. Changes nothing that already agrees.
 */
export async function reconcilePayrollBills(orgId: string, ctx: PlatformAuthContext, scope?: PayeeScope) {
  let settled = 0, removed = 0;
  await settleReimbursementsPaidInPayables(orgId);
  for (const payable of await payrollBillPayables(orgId)) {
    const source = asObject(payable.source), ref = asObject(payable.payee_ref);
    if (scope && !scope.manageable({ type: cleanText(ref.kind), id: cleanText(ref.id) })) continue;
    const run = await readPayrollBatch(orgId, cleanText(source.batch_id)).catch(() => null);
    const item = run ? asArray(run.items).map(asObject).find((row) => cleanText(row.id) === cleanText(source.id)) : null;
    if (cleanText(payable.status) === "paid") {
      if (item && cleanText(item.status) !== "paid" && await settleBill(orgId, payable, { payable_id: cleanText(payable.id), paid_at: cleanText(payable.updated_at), reference: "Paid in payables" }, ctx)) settled++;
    } else if (cleanText(payable.status) === "open" && Number(payable.paid_cents || 0) === 0 && (!run || cleanText(run.status) === "void" || !item)) {
      await voidPayable(orgId, cleanText(payable.id), ctx); removed++;
    }
  }
  return { settled_count: settled, removed_count: removed };
}
