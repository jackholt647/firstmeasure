import type { PayrollPayeeRef } from "./schemas.js";
import { asArray, asObject, cleanText, listPayrollEarningsRecords, readPayrollSchedule, type JsonObject } from "./storage.js";
import { payrollOccurrences } from "./schedule.js";

type EarningsTotals = {
  projected_cents: number;
  accrued_cents: number;
  in_payroll_cents: number;
  owed_cents: number;
  paid_cents: number;
  earned_cents: number;
};

function emptyTotals(): EarningsTotals {
  return {
    projected_cents: 0,
    accrued_cents: 0,
    in_payroll_cents: 0,
    owed_cents: 0,
    paid_cents: 0,
    earned_cents: 0
  };
}

function finishTotals(totals: EarningsTotals) {
  totals.projected_cents = Math.max(0, totals.projected_cents);
  totals.owed_cents = Math.max(0, totals.accrued_cents + totals.in_payroll_cents);
  totals.earned_cents = totals.owed_cents + totals.paid_cents;
  return totals;
}

function payeeKey(value: unknown) {
  const payee = asObject(value);
  return `${cleanText(payee.type)}:${cleanText(payee.id)}`;
}

function projectKey(projectId: string) {
  return projectId || "__unassigned__";
}

/** A payment recorded as made outside a pay run (off-cycle.ts). */
function offCyclePaymentOf(entry: JsonObject) {
  const payment = asObject(asObject(entry.metadata).off_cycle_payment);
  return cleanText(entry.subgroup) === "off_cycle" && Object.keys(payment).length ? payment : null;
}

function publicEntry(value: unknown) {
  const entry = asObject(value);
  const offCycle = offCyclePaymentOf(entry);
  return {
    off_cycle_payment: offCycle ? { paid_on: cleanText(offCycle.paid_on), reference: cleanText(offCycle.reference) } : null,
    id: cleanText(entry.id),
    state: cleanText(entry.state),
    kind: cleanText(entry.kind),
    subgroup: cleanText(entry.subgroup),
    amount_cents: Number(entry.amount_cents || 0),
    applied_cents: Number(entry.applied_cents || 0),
    remaining_cents: Number(entry.remaining_cents || 0),
    currency: cleanText(entry.currency || "USD"),
    project_id: cleanText(entry.project_id),
    project_title: cleanText(entry.project_title),
    worked_at: cleanText(entry.worked_at),
    completed_at: cleanText(entry.completed_at),
    eligible_at: cleanText(entry.eligible_at),
    description: cleanText(entry.description),
    created_at: cleanText(entry.created_at)
  };
}

function effectivePaymentStatus(payment: JsonObject) {
  const itemStatus = cleanText(payment.status);
  const batchStatus = cleanText(payment.batch_status);
  if (itemStatus === "paid" || batchStatus === "paid") return "paid";
  if (itemStatus === "run" || batchStatus === "run") return "run";
  return "draft";
}

function publicPayment(value: unknown) {
  const payment = asObject(value);
  const allocations = asArray(payment.allocations).map(asObject).map((allocation) => ({
    ledger_entry_id: cleanText(allocation.ledger_entry_id),
    amount_cents: Number(allocation.amount_cents || 0),
    project_id: cleanText(allocation.project_id),
    project_title: cleanText(allocation.project_title),
    kind: cleanText(allocation.kind),
    subgroup: cleanText(allocation.subgroup),
    description: cleanText(allocation.description),
    eligible_at: cleanText(allocation.eligible_at)
  }));
  const allocatedCents = allocations.reduce((sum, allocation) => sum + allocation.amount_cents, 0);
  return {
    id: cleanText(payment.id),
    batch_id: cleanText(payment.batch_id),
    status: effectivePaymentStatus(payment),
    pay_date: cleanText(payment.pay_date),
    period_start: cleanText(payment.period_start),
    period_end: cleanText(payment.period_end),
    currency: cleanText(payment.currency || "USD"),
    gross_cents: Number(payment.gross_cents || 0),
    deduction_cents: Number(payment.deduction_cents || 0),
    net_cents: Number(payment.net_cents || 0),
    amount_cents: allocatedCents || Number(payment.net_cents || 0),
    payment_reference: cleanText(payment.payment_reference),
    schedule: {
      id: cleanText(asObject(payment.schedule).id),
      name: cleanText(asObject(payment.schedule).name)
    },
    allocations,
    // Paid through payables: a bill due on the payee's terms, paid when payables pays it (payables.ts).
    paid_through: cleanText(asObject(payment.metadata).paid_through) || "payroll",
    due_date: cleanText(asObject(payment.metadata).due_date),
    run_at: cleanText(payment.run_at),
    paid_at: cleanText(payment.paid_at)
  };
}

function reportForPayee(payee: PayrollPayeeRef, entriesValue: unknown[], paymentsValue: unknown[], filters: JsonObject) {
  const key = `${payee.type}:${payee.id}`;
  const sourceEntries = entriesValue.map(asObject).filter((entry) => payeeKey(entry.payee) === key);
  const sourcePayments = paymentsValue.map(asObject).filter((payment) => payeeKey(payment.payee) === key);
  const entries = sourceEntries.map(publicEntry);
  const payments = sourcePayments.map(publicPayment);
  const projects = new Map<string, JsonObject>();

  const ensureProject = (idValue: unknown, titleValue: unknown) => {
    const id = cleanText(idValue);
    const keyValue = projectKey(id);
    const current = projects.get(keyValue);
    if (current) {
      if (!cleanText(current.title) && cleanText(titleValue)) current.title = cleanText(titleValue);
      return current;
    }
    const project = {
      project_id: id,
      title: cleanText(titleValue) || (id ? id : "Other earnings"),
      currency: "USD",
      totals: emptyTotals(),
      entry_count: 0,
      payment_count: 0
    };
    projects.set(keyValue, project);
    return project;
  };

  for (const entry of entries) {
    const project = ensureProject(entry.project_id, entry.project_title);
    const totals = project.totals as EarningsTotals;
    if (entry.state === "projected") totals.projected_cents += entry.remaining_cents;
    if (entry.state === "accrued") totals.accrued_cents += entry.remaining_cents;
    // Paid outside a pay run: it is paid, and the open negative entry takes it off what is still owed until a run takes it off.
    if (entry.state === "accrued" && entry.off_cycle_payment) totals.paid_cents += -entry.amount_cents;
    project.currency = entry.currency || project.currency;
    project.entry_count = Number(project.entry_count || 0) + 1;
  }

  for (const payment of payments) {
    const allocations = payment.allocations.length ? payment.allocations : [{
      project_id: "",
      project_title: "Other earnings",
      amount_cents: payment.net_cents
    }];
    const touched = new Set<string>();
    for (const allocation of allocations) {
      const project = ensureProject(allocation.project_id, allocation.project_title);
      const totals = project.totals as EarningsTotals;
      if (payment.status === "paid") totals.paid_cents += allocation.amount_cents;
      else totals.in_payroll_cents += allocation.amount_cents;
      project.currency = payment.currency || project.currency;
      const touchedKey = projectKey(cleanText(allocation.project_id));
      if (!touched.has(touchedKey)) {
        project.payment_count = Number(project.payment_count || 0) + 1;
        touched.add(touchedKey);
      }
    }
  }

  const projectReports = [...projects.values()].map((project) => ({
    ...project,
    totals: finishTotals(project.totals as EarningsTotals)
  }) as JsonObject & { totals: EarningsTotals });
  projectReports.sort((left, right) => {
    const leftTotals = left.totals as EarningsTotals;
    const rightTotals = right.totals as EarningsTotals;
    return rightTotals.owed_cents - leftTotals.owed_cents
      || rightTotals.paid_cents - leftTotals.paid_cents
      || cleanText(left.title).localeCompare(cleanText(right.title));
  });
  const totals = projectReports.reduce<EarningsTotals>((result, project) => {
    const projectTotals = project.totals as EarningsTotals;
    result.projected_cents += projectTotals.projected_cents;
    result.accrued_cents += projectTotals.accrued_cents;
    result.in_payroll_cents += projectTotals.in_payroll_cents;
    result.paid_cents += projectTotals.paid_cents;
    return result;
  }, emptyTotals());
  finishTotals(totals);
  const storedPayee = asObject(sourceEntries[0]?.payee || sourcePayments[0]?.payee);

  return {
    subject: {
      type: payee.type,
      id: payee.id,
      name: cleanText(payee.name || storedPayee.name),
      worker_type: cleanText(payee.worker_type || storedPayee.worker_type || (payee.type === "organization_connection" ? "subcontractor" : "employee"))
    },
    currency: cleanText(entries[0]?.currency || payments[0]?.currency || "USD"),
    totals,
    projects: projectReports,
    entries,
    payments,
    off_cycle_payments: entries.filter((entry) => entry.state === "accrued" && entry.off_cycle_payment).map((entry) => ({
      id: entry.id, kind: entry.kind, amount_cents: -entry.amount_cents, currency: entry.currency, paid_on: entry.off_cycle_payment!.paid_on,
      reference: entry.off_cycle_payment!.reference, waiting_cents: -entry.remaining_cents
    })),
    counts: { projects: projectReports.length, entries: entries.length, payments: payments.length },
    filters
  };
}

/**
 * What only the payee's own view adds: the next day they are paid (the schedule their pay layers choose for
 * everything, and its next pay date) and anything of theirs a pay rule could not work out, which is never zero.
 */
export async function myPayExtras(orgId: string, userId: string) {
  const payee = { type: "organization_user" as const, id: userId };
  const { resolvePaySchedule, listPayRules } = await import("./pay-rules.js");
  const { listUnresolvedPay } = await import("./pay-refresh.js");
  let next_payment: JsonObject | null = null;
  const chosen = await resolvePaySchedule(orgId, payee, "*").catch(() => null);
  const scheduleId = cleanText(chosen?.schedule_id);
  const schedule = scheduleId ? await readPayrollSchedule(orgId, scheduleId).catch(() => null) : null;
  if (schedule) {
    const today = new Date().toISOString().slice(0, 10);
    const through = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
    const occurrence = payrollOccurrences(schedule, today, through)[0];
    if (occurrence) next_payment = { pay_date: occurrence.pay_date, schedule_name: cleanText(schedule.name) };
  }
  const names = new Map((await listPayRules(orgId).catch(() => [])).map((rule) => [rule.id, rule.name]));
  const unresolved = (await listUnresolvedPay(orgId).catch(() => []))
    .filter((item) => item.payee.type === "organization_user" && item.payee.id === userId)
    .map((item) => ({ rule_name: cleanText(names.get(item.rule_id)) || item.rule_id, reason: item.reason, earned_at: item.earned_at, whole_rule: item.whole_rule }));
  return { next_payment, unresolved };
}

export async function payrollEarnings(orgId: string, payees: PayrollPayeeRef[], options: JsonObject = {}) {
  const records = (await listPayrollEarningsRecords(orgId, payees, options));
  const earnings = records.payees.map((payee) => reportForPayee(payee, records.entries, records.payments, records.filters));
  return {
    earnings,
    count: earnings.length,
    filters: records.filters,
    truncated: records.truncated,
    entries_truncated: records.entries_truncated,
    payments_truncated: records.payments_truncated
  };
}
