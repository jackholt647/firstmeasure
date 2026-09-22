import { createHash } from "node:crypto";

import {
  loadExpenseSummarySources,
  projectExpenseSummaryFromSources,
  type ExpenseSummarySources
} from "../payments/expenses.js";
import {
  PAYMENT_OBLIGATION_COLLECTION,
  PAYMENT_PAYABLE_COLLECTION,
  PAYMENT_SCHEDULE_COLLECTION,
  PAYMENT_TRANSACTION_COLLECTION
} from "../payments/storage.js";
import { listPayrollBatches, listPayrollLedgerEntries } from "../payroll/storage.js";
import { upcomingPayroll } from "../payroll/service.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";

const CLOSED_STAGE = /^(?:complete|completed|closed|closed_won|won|cancelled|canceled|archived|lost)$/i;
const DAY_MS = 86_400_000;

export type FinancialReadOptions = {
  branchId?: string;
  from: string;
  through: string;
  limit?: number;
  cursor?: string;
  clearingHours?: number;
  openingBalance?: number;
  includePayroll?: boolean;
};

type CashTransaction = {
  id: string;
  amount: number;
  direction: "in" | "out";
  kind: string;
  label: string;
  project_id: string;
  project_title: string;
  known_at: string;
  accrued_at: string;
  initiated_at: string;
  expected_clear_at: string;
  cleared_at: string;
  confidence: string;
  source: string;
  metadata: JsonObject;
};

type ProjectSnapshot = {
  expiresAt: number;
  orgId: string;
  scope: string;
  asOf: string;
  period: JsonObject;
  totals: JsonObject;
  cycles: JsonObject[];
  items: JsonObject[];
};

type CashSnapshot = {
  expiresAt: number;
  orgId: string;
  scope: string;
  asOf: string;
  period: JsonObject;
  payrollIncluded: boolean;
  totals: JsonObject;
  series: JsonObject[];
  items: CashTransaction[];
};

const SNAPSHOT_TTL_MS = 2 * 60_000;
const MAX_SNAPSHOTS = 24;
const projectSnapshots = new Map<string, ProjectSnapshot>();
const cashSnapshots = new Map<string, CashSnapshot>();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function cents(value: unknown) {
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) : 0;
}

function documentView(doc: unknown): JsonObject {
  const source = asObject(doc);
  const data = asObject(source.data);
  return {
    ...data,
    id: cleanText(data.id || source.id),
    revision: Number(source.revision || data.revision || 0),
    created_at: cleanText(source.created_at || data.created_at),
    updated_at: cleanText(source.updated_at || data.updated_at)
  };
}

function date(value: unknown) {
  const text = cleanText(value);
  if (!text) return null;
  const plain = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const result = plain
    ? new Date(Date.UTC(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3]), 12))
    : new Date(text);
  return Number.isFinite(result.getTime()) ? result : null;
}

function dayStart(value: unknown) {
  const source = date(value) || new Date();
  return new Date(Date.UTC(source.getUTCFullYear(), source.getUTCMonth(), source.getUTCDate()));
}

function addDays(value: unknown, amount: number) {
  return new Date(dayStart(value).getTime() + amount * DAY_MS);
}

function dateKey(value: unknown) {
  const result = date(value);
  return result ? result.toISOString().slice(0, 10) : "";
}

function iso(value: Date | null) {
  return value ? value.toISOString() : "";
}

function asObjectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isActiveProject(project: JsonObject) {
  // Lifecycle facts derived from scope-instance state replace the old
  // stage-string heuristics. Projects without any scope instances yet count
  // as active; explicit workflow/status closures still close them.
  const lifecycle = cleanText(asObjectValue(project.lifecycle).status).toLowerCase();
  if (lifecycle) return lifecycle === "open";
  const state = cleanText(project.status || project.workflow_state).toLowerCase();
  return !CLOSED_STAGE.test(state) && !/(?:complete|closed|cancel|archive|lost)/i.test(state);
}

function eventStart(event: JsonObject) {
  return date(event.start_at || event.start || event.starts_at || event.start_date);
}

function eventEnd(event: JsonObject) {
  return date(event.end_at || event.end || event.ends_at || event.end_date) || eventStart(event);
}

function eventKind(event: JsonObject) {
  return cleanText(event.schedule_item_kind || event.kind || event.type || event.event_type_default_id).toLowerCase();
}

function isMaterialEvent(event: JsonObject) {
  return /material|deliver/.test(eventKind(event)) || /material|deliver/i.test(cleanText(event.title));
}

function isWorkEvent(event: JsonObject) {
  return !isMaterialEvent(event) && !/sales|appointment|inspection|estimate/.test(eventKind(event));
}

function projectWindow(project: JsonObject) {
  const scheduled = asArray(project.events).map(asObject).filter((event) => !/cancel|void/i.test(cleanText(event.status)));
  const work = scheduled.filter(isWorkEvent);
  const relevant = work.length ? work : scheduled.filter((event) => !isMaterialEvent(event));
  const starts = relevant.map(eventStart).filter((item): item is Date => !!item).sort((a, b) => a.getTime() - b.getTime());
  const ends = relevant.map(eventEnd).filter((item): item is Date => !!item).sort((a, b) => a.getTime() - b.getTime());
  const start = starts[0] || date(project.start_at || project.start_date || project.scheduled_start_at || project.created_at);
  const end = ends.at(-1) || date(project.end_at || project.end_date || project.scheduled_end_at || project.completed_at) || start;
  const deliveries = scheduled.filter(isMaterialEvent).map(eventStart).filter((item): item is Date => !!item).sort((a, b) => a.getTime() - b.getTime());
  return { start, end, deliveries };
}

function publicWindow(window: ReturnType<typeof projectWindow>) {
  return { start: iso(window.start), end: iso(window.end), deliveries: window.deliveries.map(iso) };
}

function dueDate(obligation: JsonObject, window: ReturnType<typeof projectWindow>) {
  const direct = date(obligation.due_at || obligation.due_date || obligation.scheduled_at || obligation.expected_at);
  if (direct) return direct;
  const label = cleanText(obligation.label || obligation.title || obligation.kind);
  if (/deposit|initial|start/i.test(label)) return window.start;
  return window.end || window.start;
}

function paymentInitiatedDate(payment: JsonObject) {
  return date(payment.received_at || payment.processed_at || payment.authorized_at || payment.created_at);
}

function paymentClearedDate(payment: JsonObject, clearingHours: number) {
  const explicit = date(payment.cleared_at || payment.available_at || payment.settled_at || payment.paid_at);
  if (explicit) return { at: explicit, confidence: "actual" };
  const initiated = paymentInitiatedDate(payment);
  if (!initiated) return { at: null, confidence: "undated" };
  const inbound = cleanText(payment.direction).toLowerCase() !== "outbound";
  return {
    at: new Date(initiated.getTime() + (inbound ? Math.max(0, clearingHours) * 3_600_000 : 0)),
    confidence: cleanText(payment.status).toLowerCase() === "settled" ? "actual" : "estimated"
  };
}

function titleForProject(project: JsonObject) {
  return cleanText(project.title || project.project_title || project.project_name || project.address || project.customer_name) || "Untitled project";
}

function groupByProject(values: JsonObject[]) {
  const grouped = new Map<string, JsonObject[]>();
  for (const value of values) {
    const projectId = cleanText(value.project_id);
    if (!projectId) continue;
    grouped.set(projectId, [...(grouped.get(projectId) || []), value]);
  }
  return grouped;
}

function expenseSourcesForProject(sources: ExpenseSummarySources, projectId: string): ExpenseSummarySources {
  return {
    materialLists: sources.materialLists.filter((item) => cleanText(item.project_id) === projectId),
    supplementalExpenses: sources.supplementalExpenses.filter((item) => cleanText(item.project_id) === projectId),
    overrides: sources.overrides.filter((item) => cleanText(item.project_id) === projectId),
    receipts: sources.receipts.filter((item) => cleanText(item.project_id) === projectId),
    payrollLedgerEntries: sources.payrollLedgerEntries?.filter((item) => cleanText(item.project_id) === projectId)
  };
}

function moneyCents(input: JsonObject) {
  if (Number.isFinite(Number(input.amount_cents))) return Math.round(Number(input.amount_cents));
  if (Number.isFinite(Number(input.cents))) return Math.round(Number(input.cents));
  if (Number.isFinite(Number(input.amount))) return Math.round(Number(input.amount) * 100);
  return 0;
}

function materialTotals(lists: JsonObject[], orders: JsonObject[]) {
  const materialLists = lists.filter((list) => cleanText(list.status) !== "archived"
    && !["labor", "equipment"].includes(cleanText(list.resource_type).toLowerCase()));
  const sumItems = (key: string) => materialLists.reduce((total, list) => total + asArray(list.current_items).map(asObject).reduce((sum, item) => {
    const value = Number(item[key]);
    return sum + (Number.isFinite(value) ? Math.round(value * 100) : 0);
  }, 0), 0);
  const paidOrders = orders.reduce((total, order) => {
    const paidPrice = moneyCents(asObject(order.paid_price));
    const paidTotal = Math.round(Number(asObject(order.totals).paid_total || 0) * 100);
    return total + Math.max(paidPrice, paidTotal, 0);
  }, 0);
  return {
    projected_cents: sumItems("projected_total"),
    quoted_cents: sumItems("quoted_total"),
    paid_cents: Math.max(sumItems("paid_total"), paidOrders)
  };
}

async function moneySummary(
  orgId: string,
  project: JsonObject,
  facts: {
    schedules: JsonObject[];
    obligations: JsonObject[];
    payments: JsonObject[];
    payables: JsonObject[];
    materialLists: JsonObject[];
    materialOrders: JsonObject[];
    expenseSources: ExpenseSummarySources;
  }
) {
  const projectId = cleanText(project.id);
  const expenseSummary = await projectExpenseSummaryFromSources(orgId, projectId, facts.expenseSources);
  const materials = materialTotals(facts.materialLists, facts.materialOrders);
  const activeObligations = facts.obligations.filter((item) => cleanText(item.status) !== "void");
  const totalObligations = activeObligations.reduce((sum, item) => sum + Math.max(0, cents(item.amount_cents)), 0);
  const totalAllocated = activeObligations.reduce((sum, item) => sum + Math.max(0, cents(item.allocated_cents)), 0);
  const outboundRefunds = facts.payments
    .filter((payment) => cleanText(payment.direction) === "outbound" && cleanText(payment.kind) === "customer_refund")
    .reduce((sum, payment) => sum + Math.max(0, cents(payment.amount_cents)), 0);
  const inboundCollected = facts.payments
    .filter((payment) => cleanText(payment.direction) === "inbound" && ["settled", "partially_refunded", "refunded"].includes(cleanText(payment.status)))
    .reduce((sum, payment) => sum + Math.max(0, cents(payment.amount_cents)), 0) - outboundRefunds;
  const payableProjected = facts.payables.filter((payable) => !asArray(payable.expense_target_keys).length)
    .reduce((sum, payable) => sum + Math.max(0, cents(payable.amount_cents)), 0);
  const payablePaid = facts.payables.reduce((sum, payable) => sum + Math.max(0, cents(payable.paid_cents)), 0);
  const trackedProjected = Math.max(0, cents(asObject(expenseSummary.totals).projected_cents));
  const trackedActual = Math.max(0, cents(asObject(expenseSummary.totals).actual_cents));
  const trackedCurrentValue = asObject(expenseSummary.totals).current_cents;
  const trackedCurrent = trackedCurrentValue != null && Number.isFinite(Number(trackedCurrentValue))
    ? Math.max(0, cents(trackedCurrentValue))
    : trackedProjected;
  const resourceTotals = asObject(expenseSummary.by_resource);
  const accruedCommissions = Math.max(0, cents(asObject(resourceTotals.commission).actual_cents));
  // Mirrors payments/storage projectMoneySummary: accrued payroll labor is
  // incurred cost, so org-level profitability moves with payroll accruals too.
  const accruedPayrollLabor = Math.max(0, cents(asObject(
    asArray(expenseSummary.targets).map(asObject).find((target) => cleanText(target.target_key) === "payroll_labor:accrued") || {}
  ).actual_cents));
  const projectedExpenses = trackedProjected + payableProjected;
  const expensesToDate = materials.paid_cents + payablePaid + accruedCommissions + accruedPayrollLabor;
  return {
    project_total_cents: totalObligations,
    total_collected_cents: inboundCollected,
    total_remaining_cents: Math.max(0, totalObligations - totalAllocated),
    projected_revenue_cents: totalObligations,
    revenue_to_date_cents: inboundCollected,
    projected_expenses_cents: projectedExpenses,
    expenses_to_date_cents: expensesToDate,
    actual_expenses_cents: trackedActual,
    forecast_expenses_cents: trackedCurrent + payableProjected,
    projected_profit_cents: totalObligations - projectedExpenses,
    profit_to_date_cents: inboundCollected - expensesToDate,
    forecast_profit_cents: totalObligations - trackedCurrent - payableProjected,
    materials,
    schedules: facts.schedules,
    obligations: facts.obligations,
    payments: facts.payments,
    payables: facts.payables
  };
}

function transactionId(...parts: unknown[]) {
  const value = parts.map((part) => cleanText(part).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean).join("-");
  return `cash-${value || createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)}`;
}

function cashTransaction(input: JsonObject): CashTransaction {
  const amount = cents(input.amount);
  const clearedAt = date(input.cleared_at);
  const expectedClearAt = clearedAt || date(input.expected_clear_at);
  const knownAt = date(input.known_at || input.initiated_at || input.accrued_at);
  return {
    id: cleanText(input.id) || transactionId(input.kind, input.project_id, input.label, amount, dateKey(expectedClearAt || knownAt)),
    amount,
    direction: amount >= 0 ? "in" : "out",
    kind: cleanText(input.kind || "other"),
    label: cleanText(input.label || "Financial movement"),
    project_id: cleanText(input.project_id),
    project_title: cleanText(input.project_title),
    known_at: iso(knownAt),
    accrued_at: iso(date(input.accrued_at)),
    initiated_at: iso(date(input.initiated_at)),
    expected_clear_at: iso(expectedClearAt),
    cleared_at: iso(clearedAt),
    confidence: cleanText(input.confidence || (clearedAt ? "actual" : expectedClearAt ? "scheduled" : "undated")),
    source: cleanText(input.source),
    metadata: asObject(input.metadata)
  };
}

function projectTransactions(row: JsonObject, clearingHours: number) {
  const project = asObject(row.project);
  const summary = asObject(row.summary);
  const rawWindow = asObject(row.window);
  const window = {
    start: date(rawWindow.start),
    end: date(rawWindow.end),
    deliveries: asArray(rawWindow.deliveries).map(date).filter((item): item is Date => !!item)
  };
  const projectId = cleanText(project.id);
  const projectTitle = titleForProject(project);
  const transactions: CashTransaction[] = [];
  const add = (input: JsonObject) => {
    const transaction = cashTransaction({ project_id: projectId, project_title: projectTitle, ...input });
    if (transaction.amount) transactions.push(transaction);
  };

  asArray(summary.obligations).map(asObject).filter((item) => cleanText(item.status) !== "void").forEach((item, index) => {
    const remaining = Math.max(0, cents(item.amount_cents) - cents(item.allocated_cents));
    if (!remaining) return;
    const due = dueDate(item, window);
    add({
      id: transactionId("obligation", projectId, item.id || index), amount: remaining, kind: "customer",
      label: cleanText(item.label || item.title || "Customer payment"), known_at: item.created_at || project.created_at || iso(due),
      accrued_at: iso(due), expected_clear_at: due ? new Date(due.getTime() + Math.max(0, clearingHours) * 3_600_000).toISOString() : "",
      confidence: date(item.due_at || item.due_date || item.scheduled_at || item.expected_at) ? "scheduled" : due ? "estimated" : "undated",
      source: "payment_obligation"
    });
  });

  asArray(summary.payments).map(asObject).forEach((item, index) => {
    const outbound = cleanText(item.direction).toLowerCase() === "outbound";
    const status = cleanText(item.status).toLowerCase();
    if (!["settled", "paid", "partially_refunded", "refunded", "completed"].includes(status)) return;
    const initiated = paymentInitiatedDate(item);
    const cleared = paymentClearedDate(item, clearingHours);
    add({
      id: transactionId("payment", projectId, item.id || index),
      amount: outbound ? -Math.abs(cents(item.amount_cents)) : Math.abs(cents(item.amount_cents)),
      kind: outbound ? "expense" : "customer",
      label: cleanText(item.label || item.description || item.kind || (outbound ? "Payment out" : "Customer payment")),
      known_at: iso(initiated || cleared.at), initiated_at: iso(initiated),
      cleared_at: cleared.confidence === "actual" ? iso(cleared.at) : "", expected_clear_at: iso(cleared.at),
      confidence: cleared.confidence, source: "payment"
    });
  });

  const materials = asObject(summary.materials);
  const materialProjected = Math.max(0, cents(materials.projected_cents) - cents(materials.paid_cents));
  if (materialProjected > 0) {
    const deliveries = window.deliveries.length ? window.deliveries : [window.start].filter((item): item is Date => !!item);
    if (!deliveries.length) {
      add({ id: transactionId("materials", projectId, "undated"), amount: -materialProjected, kind: "material", label: "Materials commitment", known_at: project.created_at, confidence: "undated", source: "material_projection" });
    } else {
      const base = Math.floor(materialProjected / deliveries.length);
      deliveries.forEach((delivery, index) => add({
        id: transactionId("materials", projectId, index), amount: -(index === deliveries.length - 1 ? materialProjected - base * index : base),
        kind: "material", label: "Material payment", known_at: project.created_at || iso(window.start) || iso(delivery), accrued_at: iso(delivery),
        expected_clear_at: iso(delivery), confidence: window.deliveries.length ? "scheduled" : "estimated", source: "material_projection"
      }));
    }
  }
  const materialPaid = cents(materials.paid_cents);
  const hasMaterialPayment = asArray(summary.payments).map(asObject).some((item) => /material/.test(cleanText(item.kind || item.label || item.description).toLowerCase()));
  if (materialPaid && !hasMaterialPayment) {
    const paidAt = window.deliveries[0] || window.start;
    add({ id: transactionId("materials-paid", projectId), amount: -materialPaid, kind: "material", label: "Material payment cleared", known_at: project.created_at || iso(paidAt), cleared_at: iso(paidAt), confidence: paidAt ? "estimated" : "undated", source: "material_paid_total" });
  }

  asArray(summary.payables).map(asObject).forEach((item, index) => {
    const kind = cleanText(item.kind).toLowerCase();
    if (/material/.test(kind)) return;
    const remaining = Math.max(0, cents(item.amount_cents) - cents(item.paid_cents));
    if (!remaining) return;
    const due = date(item.due_at);
    add({
      id: transactionId("payable", projectId, item.id || index), amount: -remaining,
      kind: /crew|labor|payroll|commission/.test(kind) ? "payroll" : "expense",
      label: cleanText(item.notes || asObject(item.payee_ref).name || asObject(item.vendor_ref).name || item.kind || "Project expense"),
      known_at: item.created_at || project.created_at || iso(window.start), accrued_at: item.created_at || iso(window.start),
      expected_clear_at: iso(due), confidence: due ? "scheduled" : "undated", source: "payable", metadata: { payable_kind: kind }
    });
  });
  return transactions;
}

async function payrollTransactions(orgId: string, from: string, through: string) {
  const forecast = (await upcomingPayroll(orgId, { from, through, include_projected: true }));
  const history = (await listPayrollBatches(orgId, { from, through, limit: 500 }));
  const ledger = (await listPayrollLedgerEntries(orgId, { eligible_from: `${from}T00:00:00.000Z`, eligible_through: `${through}T23:59:59.999Z`, limit: 5000 }));
  const transactions: CashTransaction[] = [];
  const coveredScheduleIds = new Set<string>();
  for (const [index, batch] of history.entries()) {
    if (cleanText(batch.status) === "void") continue;
    coveredScheduleIds.add(cleanText(batch.schedule_id));
    transactions.push(cashTransaction({
      id: transactionId("payroll-history", batch.id || index), amount: -Math.abs(cents(batch.total_cents)), kind: "payroll",
      label: "Payroll paid", known_at: batch.created_at || batch.period_start || batch.paid_at || batch.pay_date,
      accrued_at: batch.period_end, initiated_at: batch.run_at, cleared_at: batch.paid_at || batch.pay_date,
      confidence: batch.paid_at ? "actual" : "estimated", source: "payroll_batch"
    }));
  }
  for (const [index, occurrence] of asArray(forecast.upcoming).map(asObject).entries()) {
    const batch = asObject(occurrence.batch);
    if (cleanText(batch.id) && history.some((item) => cleanText(item.id) === cleanText(batch.id))) continue;
    const amount = cleanText(batch.id) ? cents(batch.total_cents) : cents(occurrence.accrued_total_cents) + cents(occurrence.projected_additional_cents);
    if (!amount) continue;
    coveredScheduleIds.add(cleanText(occurrence.schedule_id || asObject(occurrence.schedule).id));
    transactions.push(cashTransaction({
      id: transactionId("payroll-upcoming", occurrence.schedule_id || asObject(occurrence.schedule).id, occurrence.pay_date || index),
      amount: -Math.abs(amount), kind: "payroll", label: `${cleanText(asObject(occurrence.schedule).name) || "Payroll"} expected`,
      known_at: occurrence.period_start || occurrence.cutoff_at, accrued_at: occurrence.cutoff_at || occurrence.period_end,
      expected_clear_at: occurrence.pay_date, confidence: "scheduled", source: "payroll_forecast"
    }));
  }
  for (const [index, entry] of ledger.entries()) {
    if (cleanText(entry.state) === "void") continue;
    const scheduleId = cleanText(entry.schedule_id);
    if (scheduleId && coveredScheduleIds.has(scheduleId)) continue;
    transactions.push(cashTransaction({
      id: transactionId("payroll-undated", entry.id || index), amount: -cents(entry.remaining_cents ?? entry.amount_cents), kind: "payroll",
      label: cleanText(entry.description || entry.kind || "Labor accrued"), project_id: entry.project_id, project_title: entry.project_title,
      known_at: entry.eligible_at || entry.created_at, accrued_at: entry.eligible_at || entry.completed_at || entry.worked_at,
      confidence: "undated", source: "payroll_ledger"
    }));
  }
  return transactions.filter((item) => item.amount);
}

function removeDuplicatedPayables(project: CashTransaction[], payroll: CashTransaction[]) {
  const hasForwardPayroll = payroll.some((item) => item.source === "payroll_forecast" || item.source === "payroll_ledger");
  const payrollProjects = new Set(payroll.filter((item) => item.project_id).map((item) => item.project_id));
  if (!hasForwardPayroll && !payrollProjects.size) return project;
  return project.filter((item) => item.source !== "payable" || item.kind !== "payroll" || (!hasForwardPayroll && !payrollProjects.has(item.project_id)));
}

function transactionAt(item: CashTransaction) {
  return date(item.cleared_at || item.expected_clear_at || item.initiated_at || item.accrued_at || item.known_at);
}

function actualCashEvents(transactions: CashTransaction[]) {
  return transactions.flatMap((item) => {
    const at = date(item.cleared_at);
    return at ? [{ ...item, at }] : [];
  });
}

function sumTransactions(items: CashTransaction[]) {
  return items.reduce((sum, item) => sum + cents(item.amount), 0);
}

function projectPoint(row: JsonObject, transactions: CashTransaction[], end: Date) {
  const project = asObject(row.project);
  const summary = asObject(row.summary);
  const windowValue = asObject(row.window);
  const window = { start: date(windowValue.start), end: date(windowValue.end), deliveries: [] as Date[] };
  const actual = actualCashEvents(transactions).filter((event) => event.at < end && event.project_id === cleanText(project.id));
  const actualRevenue = sumTransactions(actual.filter((item) => item.amount > 0));
  const actualOut = Math.abs(sumTransactions(actual.filter((item) => item.amount < 0)));
  const due = asArray(summary.obligations).map(asObject).filter((item) => {
    const when = dueDate(item, window);
    return when && when < end && cleanText(item.status) !== "void";
  }).reduce((sum, item) => sum + Math.max(0, cents(item.amount_cents)), 0);
  return { revenue_cents: actualRevenue, expenses_cents: actualOut, profit_cents: actualRevenue - actualOut, owed_cents: Math.max(0, due - actualRevenue) };
}

function encodeCursor(offset: number, snapshot: string) {
  return Buffer.from(JSON.stringify({ offset, snapshot }), "utf8").toString("base64url");
}

function decodeCursor(value: string) {
  if (!value) return { offset: 0, snapshot: "" };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return { offset: Math.max(0, Math.floor(Number(parsed.offset || 0))), snapshot: cleanText(parsed.snapshot) };
  } catch {
    return { offset: 0, snapshot: "" };
  }
}

function snapshotId(orgId: string, scope: string) {
  return createHash("sha256").update(`${orgId}:${scope}:${Date.now()}:${Math.random()}`).digest("base64url").slice(0, 24);
}

function snapshotScope(options: FinancialReadOptions, kind: string) {
  return JSON.stringify({ kind, branchId: cleanText(options.branchId), from: options.from, through: options.through, clearingHours: options.clearingHours || 0, openingBalance: options.openingBalance || 0, includePayroll: options.includePayroll !== false });
}

function storeSnapshot<T extends ProjectSnapshot | CashSnapshot>(cache: Map<string, T>, id: string, snapshot: T) {
  const now = Date.now();
  for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key);
  while (cache.size >= MAX_SNAPSHOTS) cache.delete(cache.keys().next().value as string);
  cache.set(id, snapshot);
}

function publicProject(project: JsonObject) {
  return {
    id: cleanText(project.id),
    title: cleanText(project.title || project.project_title || project.project_name),
    address: cleanText(project.address),
    customer_name: cleanText(project.customer_name),
    lifecycle_status: cleanText(asObjectValue(project.lifecycle).status),
    status: cleanText(project.status),
    branch_id: cleanText(project.branch_id || "default")
  };
}

function projectSnapshotPage(snapshotIdValue: string, snapshot: ProjectSnapshot, offset: number, limit: number) {
  const page = snapshot.items.slice(offset, offset + limit);
  return {
    as_of: snapshot.asOf,
    snapshot_id: snapshotIdValue,
    period: snapshot.period,
    totals: snapshot.totals,
    cycles: snapshot.cycles,
    projects: {
      items: page,
      count: snapshot.items.length,
      limit,
      has_more: offset + page.length < snapshot.items.length,
      next_cursor: offset + page.length < snapshot.items.length ? encodeCursor(offset + page.length, snapshotIdValue) : ""
    }
  };
}

async function loadRows(orgId: string, options: FinancialReadOptions) {
  const [projectDocs, scheduleDocs, obligationDocs, paymentDocs, payableDocs, materialOrderDocs, expenseSources] = await Promise.all([
    listDocuments(orgId, "projects"),
    listDocuments(orgId, PAYMENT_SCHEDULE_COLLECTION),
    listDocuments(orgId, PAYMENT_OBLIGATION_COLLECTION),
    listDocuments(orgId, PAYMENT_TRANSACTION_COLLECTION),
    listDocuments(orgId, PAYMENT_PAYABLE_COLLECTION),
    listDocuments(orgId, "material_orders"),
    loadExpenseSummarySources(orgId)
  ]);
  expenseSources.payrollLedgerEntries = (await listPayrollLedgerEntries(orgId, { limit: 5000 }));
  const projects = projectDocs.map(documentView).filter((project) => !options.branchId || cleanText(project.branch_id || "default") === options.branchId);
  const schedules = groupByProject(scheduleDocs.map(documentView).filter((item) => !["superseded", "void", "archived"].includes(cleanText(item.status))));
  const obligations = groupByProject(obligationDocs.map(documentView));
  const payments = groupByProject(paymentDocs.map(documentView));
  const payables = groupByProject(payableDocs.map(documentView).filter((item) => cleanText(item.status) !== "void"));
  const materialLists = groupByProject(expenseSources.materialLists);
  const materialOrders = groupByProject(materialOrderDocs.map(documentView));
  const rows = await Promise.all(projects.map(async (project) => {
    const projectId = cleanText(project.id);
    const summary = await moneySummary(orgId, project, {
      schedules: schedules.get(projectId) || [],
      obligations: obligations.get(projectId) || [],
      payments: payments.get(projectId) || [],
      payables: payables.get(projectId) || [],
      materialLists: materialLists.get(projectId) || [],
      materialOrders: materialOrders.get(projectId) || [],
      expenseSources: expenseSourcesForProject(expenseSources, projectId)
    });
    return { project, summary, window: publicWindow(projectWindow(project)) };
  }));
  return rows;
}

function cycleRanges(from: Date, through: Date) {
  const span = through.getTime() - from.getTime();
  const grain = span <= 2 * DAY_MS ? "day" : span <= 9 * DAY_MS ? "week" : "month";
  const ranges: Array<{ start: Date; end: Date }> = [];
  if (grain === "month") {
    let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 5, 1));
    for (let index = 0; index < 6; index += 1) {
      const end = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
      ranges.push({ start: cursor, end });
      cursor = end;
    }
  } else {
    const size = grain === "week" ? 7 : 1;
    let cursor = addDays(from, -(5 * size));
    for (let index = 0; index < 6; index += 1) {
      const end = addDays(cursor, size);
      ranges.push({ start: cursor, end });
      cursor = end;
    }
  }
  return ranges;
}

export async function projectFinancials(orgId: string, options: FinancialReadOptions) {
  const from = dayStart(options.from);
  const through = dayStart(options.through);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit || 50))));
  const cursor = decodeCursor(cleanText(options.cursor));
  const scope = snapshotScope(options, "projects");
  const cached = cursor.snapshot ? projectSnapshots.get(cursor.snapshot) : null;
  if (cached && cached.expiresAt > Date.now() && cached.orgId === orgId && cached.scope === scope) {
    return projectSnapshotPage(cursor.snapshot, cached, cursor.offset, limit);
  }
  const rows = await loadRows(orgId, options);
  const allTransactions = rows.flatMap((row) => projectTransactions(row, Math.max(0, Number(options.clearingHours || 0))));
  const activeRows = rows.filter((row) => isActiveProject(asObject(row.project)));
  const points = activeRows.map((row) => ({ row, point: projectPoint(row, allTransactions, through) }));
  const actual = actualCashEvents(allTransactions);
  const periodActual = actual.filter((item) => item.at >= from && item.at < through);
  const totals = {
    matching_project_count: activeRows.length,
    projected_revenue_cents: activeRows.reduce((sum, row) => sum + cents(asObject(row.summary).projected_revenue_cents), 0),
    projected_profit_cents: activeRows.reduce((sum, row) => sum + cents(asObject(row.summary).projected_profit_cents), 0),
    profit_to_date_cents: activeRows.reduce((sum, row) => sum + cents(asObject(row.summary).profit_to_date_cents), 0),
    owed_by_period_end_cents: points.reduce((sum, item) => sum + cents(item.point.owed_cents), 0),
    revenue_in_period_cents: sumTransactions(periodActual.filter((item) => item.amount > 0))
  };
  const cycles = cycleRanges(from, through).map((range) => {
    const events = actual.filter((item) => item.at >= range.start && item.at < range.end);
    const revenue = sumTransactions(events.filter((item) => item.amount > 0));
    const expenses = Math.abs(sumTransactions(events.filter((item) => item.amount < 0)));
    return { from: dateKey(range.start), through: dateKey(range.end), revenue_cents: revenue, expenses_cents: expenses, profit_cents: revenue - expenses };
  });
  const sorted = points.sort((left, right) => cents(asObject(right.row.summary).projected_profit_cents) - cents(asObject(left.row.summary).projected_profit_cents) || cleanText(asObject(left.row.project).id).localeCompare(cleanText(asObject(right.row.project).id)));
  const items = sorted.map(({ row, point }) => ({
    project: publicProject(asObject(row.project)),
    window: row.window,
    projected_revenue_cents: cents(asObject(row.summary).projected_revenue_cents),
    projected_profit_cents: cents(asObject(row.summary).projected_profit_cents),
    profit_by_period_end_cents: point.profit_cents,
    customer_owed_cents: point.owed_cents
  }));
  const id = snapshotId(orgId, scope);
  const snapshot: ProjectSnapshot = {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    orgId,
    scope,
    asOf: new Date().toISOString(),
    period: { from: dateKey(from), through: dateKey(through) },
    totals,
    cycles,
    items
  };
  storeSnapshot(projectSnapshots, id, snapshot);
  return projectSnapshotPage(id, snapshot, 0, limit);
}

function dailySeries(transactions: CashTransaction[], from: Date, through: Date, openingBalance: number) {
  const days: JsonObject[] = [];
  for (let cursor = new Date(from); cursor < through; cursor = addDays(cursor, 1)) {
    const end = addDays(cursor, 1);
    const availableEvents = transactions.filter((item) => {
      const at = date(item.cleared_at);
      return at && at >= cursor && at < end;
    });
    const expectedEvents = transactions.filter((item) => {
      const at = date(item.cleared_at || item.expected_clear_at);
      return at && at >= cursor && at < end;
    });
    const pendingIncoming = transactions.filter((item) => {
      const initiated = date(item.initiated_at);
      const cleared = date(item.cleared_at);
      return item.amount > 0 && initiated && initiated < end && (!cleared || cleared >= end);
    });
    const datedExposure = transactions.filter((item) => {
      const clearAt = date(item.cleared_at || item.expected_clear_at);
      const knownAt = date(item.known_at);
      return item.amount < 0 && (!knownAt || knownAt < end) && clearAt && clearAt >= end;
    });
    const undatedExposure = transactions.filter((item) => {
      const knownAt = date(item.known_at);
      return item.amount < 0 && (!knownAt || knownAt < end) && !item.cleared_at && !item.expected_clear_at;
    });
    days.push({
      date: dateKey(cursor),
      available_events: availableEvents.slice(0, 6),
      available_transaction_ids: availableEvents.map((item) => item.id),
      expected_events: expectedEvents.slice(0, 6),
      expected_transaction_ids: expectedEvents.map((item) => item.id),
      available_delta_cents: sumTransactions(availableEvents),
      expected_delta_cents: sumTransactions(expectedEvents),
      pending_incoming_cents: sumTransactions(pendingIncoming),
      dated_exposure_cents: Math.abs(sumTransactions(datedExposure)),
      undated_exposure_cents: Math.abs(sumTransactions(undatedExposure)),
      exposure_transaction_ids: [...datedExposure, ...undatedExposure].map((item) => item.id)
    });
  }
  let available = openingBalance;
  let expected = openingBalance;
  let previousSafe: number | null = null;
  return days.map((item) => {
    available += cents(item.available_delta_cents);
    expected += cents(item.expected_delta_cents);
    const safe = expected - cents(item.dated_exposure_cents) - cents(item.undated_exposure_cents);
    const safeDelta = previousSafe == null ? safe - openingBalance : safe - previousSafe;
    previousSafe = safe;
    return { ...item, available_cents: available, expected_cents: expected, safe_cents: safe, safe_delta_cents: safeDelta };
  });
}

export async function cashFlowFinancials(orgId: string, options: FinancialReadOptions) {
  const from = dayStart(options.from);
  const through = dayStart(options.through);
  const clearingHours = Math.max(0, Math.min(336, Math.floor(Number(options.clearingHours || 0))));
  const openingBalance = cents(options.openingBalance);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit || 100))));
  const cursor = decodeCursor(cleanText(options.cursor));
  const scope = snapshotScope(options, "cash-flow");
  const cached = cursor.snapshot ? cashSnapshots.get(cursor.snapshot) : null;
  if (cached && cached.expiresAt > Date.now() && cached.orgId === orgId && cached.scope === scope) {
    const page = cached.items.slice(cursor.offset, cursor.offset + limit);
    return {
      as_of: cached.asOf, snapshot_id: cursor.snapshot, period: cached.period, payroll_included: cached.payrollIncluded,
      totals: cached.totals, series: cached.series,
      transactions: { items: page, count: cached.items.length, limit, has_more: cursor.offset + page.length < cached.items.length, next_cursor: cursor.offset + page.length < cached.items.length ? encodeCursor(cursor.offset + page.length, cursor.snapshot) : "" }
    };
  }
  const rows = await loadRows(orgId, options);
  const projectCash = rows.flatMap((row) => projectTransactions(row, clearingHours));
  const payrollFrom = `${from.getUTCFullYear() - 1}-01-01`;
  const payrollThrough = `${through.getUTCFullYear() + 1}-12-31`;
  const payrollCash = options.includePayroll === false ? [] : (await payrollTransactions(orgId, payrollFrom, payrollThrough));
  const transactions = [...removeDuplicatedPayables(projectCash, payrollCash), ...payrollCash].sort((left, right) => {
    const a = transactionAt(left);
    const b = transactionAt(right);
    if (!a && !b) return left.label.localeCompare(right.label);
    if (!a) return 1;
    if (!b) return -1;
    return a.getTime() - b.getTime();
  });
  const series = dailySeries(transactions, from, through, openingBalance);
  const end = asObject(series.at(-1));
  const periodClearing = transactions.filter((item) => {
    const at = date(item.cleared_at || item.expected_clear_at);
    return at && at >= from && at < through;
  });
  const visible = transactions.filter((item) => {
    const at = transactionAt(item);
    const knownAt = date(item.known_at);
    const inRange = at && at >= from && at < through;
    const affectsExposure = item.amount < 0 && (!at || at >= from) && (!knownAt || knownAt < through);
    return inRange || affectsExposure;
  });
  const totals = {
    available_cents: cents(end.available_cents ?? openingBalance),
    expected_cents: cents(end.expected_cents ?? openingBalance),
    safe_cents: cents(end.safe_cents ?? openingBalance),
    pending_incoming_cents: cents(end.pending_incoming_cents),
    undated_exposure_cents: cents(end.undated_exposure_cents),
    expected_in_cents: sumTransactions(periodClearing.filter((item) => item.amount > 0)),
    expected_out_cents: Math.abs(sumTransactions(periodClearing.filter((item) => item.amount < 0)))
  };
  const id = snapshotId(orgId, scope);
  const snapshot: CashSnapshot = {
    expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    orgId,
    scope,
    asOf: new Date().toISOString(),
    period: { from: dateKey(from), through: dateKey(through) },
    payrollIncluded: options.includePayroll !== false,
    totals,
    series,
    items: visible
  };
  storeSnapshot(cashSnapshots, id, snapshot);
  const page = visible.slice(0, limit);
  return {
    as_of: snapshot.asOf,
    snapshot_id: id,
    period: snapshot.period,
    payroll_included: options.includePayroll !== false,
    totals,
    series,
    transactions: {
      items: page,
      count: visible.length,
      limit,
      has_more: page.length < visible.length,
      next_cursor: page.length < visible.length ? encodeCursor(page.length, id) : ""
    }
  };
}
