import { z } from "zod";

import type { JsonObject } from "../platform/storage.js";
import { jsonObjectSchema } from "./schemas.js";

/**
 * Payment schedule terms — the single normalized vocabulary for "how a
 * contract's total splits into obligations". Every producer (legacy proposal
 * signature pages, org proposal defaults, document-engine payment_schedule
 * params, change orders) and every consumer (receivables minting, the
 * doc.payment_schedule widget, recognition) goes through normalizeScheduleRows
 * so the historical three-way vocabulary drift cannot recur.
 */

export const PAYMENT_KINDS = ["deposit", "progress", "final", "change_order", "other"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export const DUE_RULES = ["on_signature", "on_date", "on_invoice", "project_completion", "node", "manual"] as const;
export type DueRule = (typeof DUE_RULES)[number];

export const scheduleRecognitionSchema = jsonObjectSchema.extend({
  node_id: z.string().trim().max(160).optional(),
  hook: z.enum(["onCreated", "onStarted", "onReady", "onCompleted", "onCanceled"]).optional()
}).passthrough();

export const paymentScheduleRowSchema = jsonObjectSchema.extend({
  id: z.string().trim().max(160).optional(),
  label: z.string().trim().max(300).optional(),
  kind: z.enum(["fixed", "percent", "expression"]).optional(),
  payment_kind: z.enum(PAYMENT_KINDS).optional(),
  amount_cents: z.number().int().min(0).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  percent: z.union([z.number(), z.string()]).optional(),
  percent_bps: z.number().int().min(0).max(1_000_000).optional(),
  expression: z.string().trim().max(4000).optional(),
  due_rule: z.string().trim().max(80).optional(),
  due_at: z.string().trim().max(80).optional(),
  due_date: z.string().trim().max(80).optional(),
  grace_days: z.number().int().min(0).max(365).optional(),
  recognition: scheduleRecognitionSchema.optional(),
  metadata: jsonObjectSchema.optional()
}).passthrough();

export const paymentScheduleSchema = z.union([
  z.array(paymentScheduleRowSchema),
  jsonObjectSchema.extend({
    schedule: z.array(paymentScheduleRowSchema).optional(),
    items: z.array(paymentScheduleRowSchema).optional(),
    payments: z.array(paymentScheduleRowSchema).optional()
  }).passthrough()
]);

export type NormalizedScheduleRow = {
  id: string;
  label: string;
  kind: "fixed" | "percent" | "expression";
  payment_kind: PaymentKind;
  amount_cents: number;
  percent_bps: number;
  expression: string;
  due_rule: DueRule;
  due_at: string;
  grace_days: number;
  recognition: { node_id: string; hook: string };
  metadata: JsonObject;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function moneyToCents(value: unknown): number {
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function centsValue(row: JsonObject): number {
  if (Number.isFinite(Number(row.amount_cents))) return Math.max(0, Math.round(Number(row.amount_cents)));
  if (Number.isFinite(Number(row.cents))) return Math.max(0, Math.round(Number(row.cents)));
  if (row.amount !== undefined && row.amount !== null && cleanText(row.amount) !== "") {
    return Math.max(0, moneyToCents(row.amount));
  }
  return 0;
}

function percentBps(row: JsonObject): number {
  if (Number.isFinite(Number(row.percent_bps))) return Math.max(0, Math.round(Number(row.percent_bps)));
  const raw = row.percent ?? row.percentage ?? asObject(row.metadata).percent;
  if (raw === undefined || raw === null || cleanText(raw) === "") return 0;
  const parsed = Number(cleanText(raw).replace(/[%\s]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed * 100)) : 0;
}

/**
 * The one place label-based payment-kind inference is allowed to live.
 * Explicit payment_kind / kind_tag / slot keys always win; the regex only
 * classifies legacy rows that never carried a typed kind.
 */
export function inferPaymentKind(row: JsonObject, label: string): PaymentKind {
  const explicit = cleanText(row.payment_kind || row.kind_tag || row.key).toLowerCase();
  if ((PAYMENT_KINDS as readonly string[]).includes(explicit)) return explicit as PaymentKind;
  if (/change[\s_-]?order|upsell|supplemental/i.test(label)) return "change_order";
  if (/deposit|down[\s_-]?payment/i.test(label)) return "deposit";
  if (/final|completion|balance/i.test(label)) return "final";
  if (/progress|milestone|draw|installment/i.test(label)) return "progress";
  return "other";
}

const DUE_RULE_ALIASES: Record<string, DueRule> = {
  on_signature: "on_signature",
  on_acceptance: "on_signature",
  on_signing: "on_signature",
  signature: "on_signature",
  on_date: "on_date",
  date: "on_date",
  fixed_date: "on_date",
  on_invoice: "on_invoice",
  invoice: "on_invoice",
  project_completion: "project_completion",
  on_completion: "project_completion",
  completion: "project_completion",
  node: "node",
  work_node: "node",
  milestone: "node",
  manual: "manual"
};

function normalizeDueRule(row: JsonObject, hasRecognitionNode: boolean): DueRule {
  const raw = cleanText(row.due_rule || row.dueRule || row.due || row.when).toLowerCase();
  const mapped = DUE_RULE_ALIASES[raw];
  if (mapped) return mapped;
  if (hasRecognitionNode) return "node";
  if (cleanText(row.due_at || row.due_date)) return "on_date";
  return "manual";
}

/**
 * Accepts every historical shape: a bare array, or an object wrapping the rows
 * under schedule/items/payments. Rows may use amount_cents | amount (number or
 * "$1,234.00" string) | percent | percent_bps | expression, and any of the
 * due-rule spellings that grew across the proposals app, org settings, the
 * documents param editor, and the studio sample data.
 */
export function normalizeScheduleRows(value: unknown): NormalizedScheduleRow[] {
  const source = Array.isArray(value)
    ? value
    : asArray(asObject(value).schedule || asObject(value).items || asObject(value).payments);
  return source.map(asObject).map((row, index) => {
    const label = cleanText(row.label || row.name || `Payment ${index + 1}`);
    const recognitionSource = asObject(row.recognition);
    const recognition = {
      node_id: cleanText(recognitionSource.node_id || row.node_id),
      hook: cleanText(recognitionSource.hook) || "onCompleted"
    };
    const expression = cleanText(row.expression || asObject(row.pricing).formula);
    const amountCents = centsValue(row);
    const bps = percentBps(row);
    const explicitKind = cleanText(row.kind).toLowerCase();
    let kind: NormalizedScheduleRow["kind"];
    if (expression) kind = "expression";
    else if (explicitKind === "percent" && bps > 0) kind = "percent";
    else if (explicitKind === "fixed" || amountCents > 0) kind = "fixed";
    else if (bps > 0) kind = "percent";
    else kind = "fixed";
    const dueRule = normalizeDueRule(row, !!recognition.node_id);
    return {
      id: cleanText(row.id) || `schedule_row_${index + 1}`,
      label,
      kind,
      payment_kind: inferPaymentKind(row, label),
      amount_cents: kind === "fixed" ? amountCents : 0,
      percent_bps: kind === "percent" ? bps : 0,
      expression: kind === "expression" ? expression : "",
      due_rule: dueRule,
      due_at: cleanText(row.due_at || row.dueAt || row.due_date || row.dueDate),
      grace_days: Number.isFinite(Number(row.grace_days ?? row.graceDays))
        ? Math.max(0, Math.round(Number(row.grace_days ?? row.graceDays)))
        : 1,
      recognition,
      metadata: asObject(row.metadata)
    };
  }).filter((row) => row.label || row.amount_cents > 0 || row.percent_bps > 0 || row.expression);
}

export type ScheduleResolutionBasis = {
  total_cents: number;
  signed_at?: string;
};

export type ResolvedScheduleItem = {
  id?: string;
  label: string;
  amount_cents: number;
  payment_kind: PaymentKind;
  due_rule: DueRule;
  due_at: string;
  grace_days: number;
  recognition: { node_id: string; hook: string };
  amount_expression: string;
  metadata: JsonObject;
};

/**
 * Resolves normalized rows into mintable schedule items against a money basis.
 * Percent rows resolve to cents here (rounding remainder folds into the last
 * percent row when the shares total exactly 100%, so the schedule sums to the
 * basis). Expression rows stay unresolved — their amount is computed at
 * recognition time from actual costs — and survive with amount_cents 0.
 */
export function resolveScheduleItems(rows: NormalizedScheduleRow[], basis: ScheduleResolutionBasis): ResolvedScheduleItem[] {
  const totalCents = Math.max(0, Math.round(Number(basis.total_cents || 0)));
  const signedAt = cleanText(basis.signed_at);
  const percentRows = rows.filter((row) => row.kind === "percent");
  const percentTotalBps = percentRows.reduce((sum, row) => sum + row.percent_bps, 0);
  const percentAmounts = new Map<NormalizedScheduleRow, number>();
  let percentAllocated = 0;
  for (const row of percentRows) {
    const amount = Math.round(totalCents * row.percent_bps / 10_000);
    percentAmounts.set(row, amount);
    percentAllocated += amount;
  }
  const lastPercentRow = percentRows[percentRows.length - 1];
  if (percentTotalBps === 10_000 && lastPercentRow && totalCents > 0) {
    percentAmounts.set(lastPercentRow, (percentAmounts.get(lastPercentRow) || 0) + (totalCents - percentAllocated));
  }
  return rows.map((row) => {
    const amountCents = row.kind === "percent" ? Math.max(0, percentAmounts.get(row) || 0) : row.amount_cents;
    const dueAt = row.due_rule === "on_signature" ? (row.due_at || signedAt) : row.due_at;
    return {
      id: row.id,
      label: row.label,
      amount_cents: amountCents,
      payment_kind: row.payment_kind,
      due_rule: row.due_rule,
      due_at: dueAt,
      grace_days: row.grace_days,
      recognition: row.recognition,
      amount_expression: row.expression,
      metadata: row.metadata
    };
  }).filter((item) => item.amount_cents > 0 || item.amount_expression);
}
