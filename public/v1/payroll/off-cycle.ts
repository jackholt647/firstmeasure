/**
 * Payments made outside a pay run. "We paid Sam $500 on the 10th" is recorded against the payee and the kind of
 * earning it was for, as one negative accrued ledger entry (subgroup `off_cycle`, `metadata.off_cycle_payment`). It
 * changes nothing already posted. The next pay run that pays the payee on the schedule of that kind takes it off
 * what they are paid (service.ts `planDeductions`), in full up to what that run pays them; what is left waits for
 * the run after. The earnings report counts it as paid (earnings.ts), so a payee's earned total is unchanged.
 *
 * A recorded payment that no pay run has taken off yet can be removed (the entry is voided, as any unused ledger
 * entry can be). Once a run has taken any of it off, it stays: correct it with an adjustment.
 */
import { z } from "zod";

import { readAssignee } from "../labor/assignees.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { PAY_RULE_KINDS } from "./pay-rules.js";
import { isOffCyclePayment, recordPayrollLedgerEntries } from "./service.js";
import { PAYROLL_PAYEE_TYPES, isoDateSchema } from "./schemas.js";
import {
  asObject, cleanText, generatedId, getPayrollDatabase, listPayrollLedgerEntries, nowIso, readPayrollLedgerEntry, voidPayrollLedgerEntry,
  type JsonObject
} from "./storage.js";

export const offCyclePaymentInputSchema = z.object({
  payee: z.object({ type: z.enum(PAYROLL_PAYEE_TYPES), id: z.string().trim().min(1).max(200) }).strict(),
  /** The kind of earning the payment was for. Its pay schedule is the run that takes it off. */
  kind: z.enum(PAY_RULE_KINDS),
  amount_cents: z.number().int().positive().max(100_000_000_00),
  /** The day it was paid. Not in the future. */
  paid_on: isoDateSchema,
  reference: z.string().trim().max(300).optional(),
  note: z.string().trim().max(1000).optional()
}).strict();
export type OffCyclePaymentInput = z.infer<typeof offCyclePaymentInputSchema>;

type Actor = { userId: string; name?: string };

export async function recordOffCyclePayment(orgId: string, value: unknown, actor: Actor) {
  const input = offCyclePaymentInputSchema.parse(value);
  const today = nowIso().slice(0, 10);
  if (input.paid_on > today) throw badRequest("off_cycle_payment_future", "Record a payment once it has been made: the day it was paid cannot be in the future.");
  const found = await readAssignee(orgId, input.payee);
  if (!found) throw notFound("off_cycle_payee_not_found", "That payee was not found.");
  const classification = cleanText(asObject(found.record).worker_classification);
  const workerType = input.payee.type === "organization_connection" ? "subcontractor"
    : classification === "independent_contractor" || classification === "subcontractor" ? classification : "employee";
  const id = generatedId("offcycle");
  const recordedAt = nowIso();
  const [entry] = await recordPayrollLedgerEntries(orgId, [{
    payee: { type: input.payee.type, id: input.payee.id, name: found.name, worker_type: workerType as "employee" },
    kind: input.kind,
    subgroup: "off_cycle",
    state: "accrued",
    amount_cents: -input.amount_cents,
    worked_at: `${input.paid_on}T12:00:00.000Z`,
    completed_at: `${input.paid_on}T12:00:00.000Z`,
    eligible_at: `${input.paid_on}T00:00:00.000Z`,
    source_event_id: `off_cycle_payment:${id}`,
    source_trigger_id: "paid",
    description: `Paid outside a pay run on ${input.paid_on}${input.reference ? ` (${input.reference})` : ""}`,
    metadata: {
      off_cycle_payment: {
        id, paid_on: input.paid_on, amount_cents: input.amount_cents, kind: input.kind,
        reference: input.reference || "", note: input.note || "",
        recorded_by_user_id: actor.userId, recorded_by_name: cleanText(actor.name), recorded_at: recordedAt
      }
    }
  } as never]);
  return offCycleView(entry as JsonObject, []);
}

type Use = { batch_id: string; pay_date: string; status: string; applied_cents: number };

function offCycleView(entry: JsonObject, uses: Use[]) {
  const payment = asObject(asObject(entry.metadata).off_cycle_payment);
  const amount = Math.abs(Number(entry.amount_cents || 0));
  const removed = cleanText(entry.state) === "void";
  const subtracted = removed ? 0 : Math.abs(Number(entry.applied_cents || 0));
  return {
    id: cleanText(entry.id),
    payment_id: cleanText(payment.id),
    payee: asObject(entry.payee),
    kind: cleanText(entry.kind),
    schedule_id: cleanText(entry.schedule_id),
    currency: cleanText(entry.currency || "USD"),
    amount_cents: amount,
    /** Already taken off a pay run (draft or later). */
    subtracted_cents: subtracted,
    /** Still to be taken off the next run. */
    waiting_cents: removed ? 0 : amount - subtracted,
    status: removed ? "removed" : !subtracted ? "waiting" : subtracted < amount ? "partly_subtracted" : "subtracted",
    paid_on: cleanText(payment.paid_on),
    reference: cleanText(payment.reference),
    note: cleanText(payment.note),
    recorded_by_name: cleanText(payment.recorded_by_name),
    recorded_by_user_id: cleanText(payment.recorded_by_user_id),
    recorded_at: cleanText(payment.recorded_at),
    removed_at: cleanText(entry.voided_at),
    runs: uses.map((use) => ({ ...use, applied_cents: Math.abs(use.applied_cents) }))
  };
}

/** Every recorded off-cycle payment, newest first, with how much of it pay runs have taken off and which runs. */
export async function listOffCyclePayments(orgId: string, options: { payee_type?: string; payee_id?: string; include_removed?: boolean } = {}) {
  const entries = (await listPayrollLedgerEntries(orgId, {
    subgroup: "off_cycle", limit: 5000,
    ...(options.payee_id ? { payee_id: options.payee_id, payee_type: options.payee_type || "organization_user" } : {})
  })).filter((entry) => Object.keys(asObject(asObject(entry.metadata).off_cycle_payment)).length && (options.include_removed || cleanText(entry.state) !== "void"));
  const uses = new Map<string, Use[]>();
  if (entries.length) {
    const ids = entries.map((entry) => cleanText(entry.id));
    const rows = await getPayrollDatabase().prepare(`SELECT a.ledger_entry_id, a.batch_id, a.applied_cents, b.pay_date, b.status
      FROM payroll_allocations a JOIN payroll_batches b ON b.id=a.batch_id
      WHERE a.organization_id=? AND b.status<>'void' AND a.ledger_entry_id IN (${ids.map(() => "?").join(",")}) ORDER BY b.pay_date`).all(orgId, ...ids);
    for (const row of rows.map(asObject)) {
      const key = cleanText(row.ledger_entry_id);
      uses.set(key, [...(uses.get(key) || []), { batch_id: cleanText(row.batch_id), pay_date: cleanText(row.pay_date), status: cleanText(row.status), applied_cents: Number(row.applied_cents || 0) }]);
    }
  }
  return entries.map((entry) => offCycleView(entry, uses.get(cleanText(entry.id)) || []))
    .sort((left, right) => right.paid_on.localeCompare(left.paid_on) || right.recorded_at.localeCompare(left.recorded_at));
}

export async function readOffCyclePayment(orgId: string, entryId: string) {
  const entry = await readPayrollLedgerEntry(orgId, entryId);
  if (!isOffCyclePayment(entry)) throw notFound("off_cycle_payment_not_found", "That off-cycle payment was not found.");
  return entry;
}

/** Removes a recorded payment no pay run has taken off yet. */
export async function removeOffCyclePayment(orgId: string, entryId: string, actor: Actor) {
  const entry = await readOffCyclePayment(orgId, entryId);
  if (cleanText(entry.state) === "void") return offCycleView(entry, []);
  if (Number(entry.applied_cents || 0) !== 0) {
    throw conflict("off_cycle_payment_used", "A pay run has already taken this payment off. It cannot be removed; record an adjustment instead.");
  }
  const removed = await voidPayrollLedgerEntry(orgId, entryId, { off_cycle_payment_removed: { by_user_id: actor.userId, by_name: cleanText(actor.name), at: nowIso() } });
  return offCycleView(removed, []);
}
