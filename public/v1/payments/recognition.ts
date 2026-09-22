import type { JsonObject } from "../platform/storage.js";
import { listNodeRecords, listPlanRecords } from "../work/storage.js";
import { FMDocModel } from "../documents/schemas.js";
import {
  deriveObligationStatus,
  listProjectObligations,
  patchProjectFinancialRefs,
  projectMoneySummary,
  recordPaymentEvent,
  saveObligation
} from "./storage.js";

/**
 * Obligation recognition — the engine that makes due_rule mean something.
 *
 * Obligations minted with due_rule "project_completion" or "node" (a
 * recognition binding {node_id, hook}, same vocabulary as scope commission
 * installments) have no due date until the work actually happens. This
 * reconciler runs off work events (work.node.completed, work.plan.completed,
 * project.completion.signed — see work/rules.ts defaults), stamps due_at when
 * the bound milestone is reached, and resolves expression-priced obligations
 * (T&M / cost-plus rows) against the project's actual money summary at the
 * moment of recognition.
 */

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cents(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

// Mirrors scopes/service.ts automationTriggerReached — the commission
// recognition semantics, applied to payment obligations.
function recognitionReached(plan: JsonObject, nodes: JsonObject[], nodeId: string, hook: string) {
  const source = nodeId ? nodes.find((node) => cleanText(node.template_node_id) === nodeId) : plan;
  if (!source) return false;
  const status = cleanText(source.status);
  const effectiveHook = hook || "onCompleted";
  if (effectiveHook === "onCompleted") return status === "completed";
  if (effectiveHook === "onStarted") return !!cleanText(source.started_at) || ["active", "in_progress", "completed"].includes(status);
  if (effectiveHook === "onReady") return !!cleanText(source.ready_at) || ["ready", "active", "in_progress", "completed"].includes(status);
  return effectiveHook === "onCreated";
}

function projectWorkComplete(plans: JsonObject[]) {
  const production = plans.filter((plan) => cleanText(plan.source_type) === "signed_proposal_scope")
    .filter((plan) => cleanText(plan.status) !== "canceled");
  return production.length > 0 && production.every((plan) => cleanText(plan.status) === "completed");
}

/**
 * The expression scope for variable-price obligations. Everything is in
 * cents, sourced from the same money summary the Money tab renders, so
 * "cost-plus 20%" is `round(expenses_to_date_cents * 1.2)` and a T&M labor
 * draw is `round(labor.paid_cents * 1.15)`.
 */
function expressionScope(summary: JsonObject, obligation: JsonObject): JsonObject {
  return {
    contract_total_cents: cents(summary.project_total_cents),
    collected_cents: cents(summary.total_collected_cents),
    projected_expenses_cents: cents(summary.projected_expenses_cents),
    expenses_to_date_cents: cents(summary.expenses_to_date_cents),
    actual_expenses_cents: cents(summary.actual_expenses_cents),
    forecast_expenses_cents: cents(summary.forecast_expenses_cents),
    accrued_commissions_cents: cents(summary.accrued_commissions_cents),
    labor: asObject(summary.labor),
    materials: asObject(summary.materials),
    equipment: asObject(summary.equipment),
    obligation: {
      amount_cents: cents(obligation.amount_cents),
      allocated_cents: cents(obligation.allocated_cents),
      label: cleanText(obligation.label)
    }
  };
}

export function resolveObligationExpression(expression: string, summary: JsonObject, obligation: JsonObject) {
  const raw = FMDocModel.evaluateSafe(expression, expressionScope(summary, obligation), 0);
  return Math.max(0, cents(raw));
}

export type RecognitionOptions = {
  /** project.completion.signed carries customer sign-off — completion-due obligations recognize regardless of plan state. */
  completion_signed?: boolean;
};

export async function reconcileObligationRecognition(orgId: string, projectId: string, options: RecognitionOptions = {}) {
  const obligations = await listProjectObligations(orgId, projectId);
  const candidates = obligations
    .filter((obligation) => !["paid", "void"].includes(cleanText(obligation.status)))
    .filter((obligation) => !cleanText(obligation.due_at))
    .filter((obligation) => {
      const rule = cleanText(obligation.due_rule);
      return rule === "project_completion" || rule === "node" || !!cleanText(obligation.amount_expression);
    });
  if (!candidates.length) return { recognized: [], checked: 0 };

  const plans = (await listPlanRecords(orgId, { project_id: projectId }));
  const nodesByPlan = new Map<string, JsonObject[]>();
  for (const plan of plans) {
    nodesByPlan.set(cleanText(plan.id), (await listNodeRecords(orgId, { plan_id: cleanText(plan.id) })));
  }
  const workComplete = options.completion_signed === true || projectWorkComplete(plans);
  const now = new Date().toISOString();
  const recognized: JsonObject[] = [];
  let summary: JsonObject | null = null;

  for (const obligation of candidates) {
    const rule = cleanText(obligation.due_rule);
    const recognition = asObject(obligation.recognition);
    const nodeId = cleanText(recognition.node_id);
    let reached = false;
    if (rule === "node" || nodeId) {
      reached = plans.some((plan) => recognitionReached(plan, nodesByPlan.get(cleanText(plan.id)) || [], nodeId, cleanText(recognition.hook)));
    } else if (rule === "project_completion") {
      reached = workComplete;
    }
    if (!reached) continue;

    const expression = cleanText(obligation.amount_expression);
    let amountCents = cents(obligation.amount_cents);
    if (expression) {
      if (!summary) summary = await projectMoneySummary(orgId, projectId);
      amountCents = resolveObligationExpression(expression, summary, obligation);
      if (amountCents <= 0) continue;
    }
    const next = await saveObligation(orgId, {
      ...obligation,
      amount_cents: amountCents,
      due_at: now,
      status: deriveObligationStatus({ ...obligation, amount_cents: amountCents, due_at: now }),
      metadata: {
        ...asObject(obligation.metadata),
        recognized_at: now,
        ...(expression ? { resolved_amount_expression: expression } : {})
      }
    });
    recognized.push(next);
    await recordPaymentEvent(orgId, "payment_obligation.recognized", {
      project_id: projectId,
      obligation_id: cleanText(obligation.id),
      schedule_id: cleanText(obligation.schedule_id),
      due_rule: rule,
      recognition_node_id: nodeId,
      amount_cents: amountCents,
      ...(expression ? { amount_expression: expression } : {})
    });
  }
  if (recognized.length) await patchProjectFinancialRefs(orgId, projectId);
  return { recognized, checked: candidates.length };
}
