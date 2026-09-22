import type { WorkAutomationContext } from "../work/registry.js";
import { registerWorkAutomation } from "../work/registry.js";
import { projectMoneySummary } from "../payments/storage.js";
import { evaluateScopeCommissionRule } from "./commission_rules.js";
import { accruePayrollProjection, triggerCommissionEvent } from "./service.js";
import { asArray, asObject, cleanText, listPayrollLedgerEntries, listProjectPayees, saveProjectPayeeRole, type JsonObject } from "./storage.js";

let registered = false;

function contextValue(context: WorkAutomationContext, pathValue: unknown) {
  const path = cleanText(pathValue);
  const source: JsonObject = {
    event: context.event,
    payload: asObject(context.event.payload),
    plan: context.plan,
    node: context.node,
    project: context.project,
    scope: context.scope,
    proposal: context.proposal
  };
  return path.split(".").filter(Boolean).reduce<unknown>((value, key) => (
    value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject)[key] : undefined
  ), source);
}

function numberValue(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

async function recordCommission(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id || context.event.project_id);
  const amount = asObject(input.amount);
  const amountKind = cleanText(amount.kind || (amount.basis_path ? "percentage_pool" : "fixed"));
  const basisValue = amount.basis_path ? contextValue(context, amount.basis_path) : amount.basis_cents;
  const state = cleanText(input.entry_state || input.state || "accrued");
  return (await triggerCommissionEvent(orgId, projectId, {
    source_event_id: cleanText(input.source_event_id || context.event.idempotency_key || context.event.id),
    trigger_id: cleanText(input.rule_id || input.trigger_id || `payroll.commission.post.v1:${context.idempotencyKey}`),
    state,
    reverses_source_event_id: cleanText(input.reverses_source_event_id),
    reverses_trigger_id: cleanText(input.reverses_trigger_id),
    payee_role: cleanText(input.payee_role),
    payees: asArray(input.payees),
    ...(amountKind === "fixed" ? { amount_cents: Math.round(numberValue(amount.amount_cents ?? input.amount_cents)) } : {
      basis_cents: Math.round(numberValue(basisValue)),
      rate_bps: Math.round(numberValue(amount.rate_bps ?? input.rate_bps))
    }),
    allocation: cleanText(input.allocation || "split_evenly") === "each" ? "each" : "split_evenly",
    currency: cleanText(input.currency || amount.currency || "USD"),
    occurred_at: cleanText(asObject(context.event.payload).occurred_at || context.event.created_at || context.now),
    completed_at: cleanText(input.completed_at_path ? contextValue(context, input.completed_at_path) : input.completed_at),
    project_title: cleanText(context.project.title || context.project.project_title || context.plan.title),
    description: cleanText(input.reason || input.description || "Project commission"),
    metadata: {
      work_event_id: cleanText(context.event.id),
      work_plan_id: cleanText(context.plan.id),
      work_node_id: cleanText(context.node.id),
      work_idempotency_key: context.idempotencyKey,
      scope_template_id: cleanText(context.plan.template_id),
      ...asObject(input.metadata)
    }
  }));
}

async function setProjectPayees(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id || context.event.project_id);
  const roleKey = cleanText(input.role_key || input.payee_role);
  const existing = (await listProjectPayees(orgId, projectId)).find((role) => cleanText(role.role_key) === roleKey);
  return (await saveProjectPayeeRole(orgId, projectId, roleKey, {
    label: cleanText(input.label || roleKey.replace(/[_-]+/g, " ")),
    payees: asArray(input.payees),
    metadata: {
      source: "work_automation",
      work_event_id: cleanText(context.event.id),
      work_idempotency_key: context.idempotencyKey,
      payees_explicitly_set: true,
      ...asObject(input.metadata)
    },
    ...(existing ? { expected_revision: Number(existing.revision || 0) } : {})
  }));
}

async function recordScopeCommissionRule(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id || context.event.project_id);
  const rule = asObject(input.rule);
  const money = projectId ? await projectMoneySummary(orgId, projectId).catch(() => ({})) : {};
  const awards = evaluateScopeCommissionRule(rule, {
    project: context.project,
    scope: context.scope,
    proposal: context.proposal,
    money,
    event: context.event,
    plan: context.plan,
    node: context.node,
    now: context.now
  });
  const results = [];
  for (const [index, award] of awards.entries()) {
    const installmentId = cleanText(award.installment_id);
    const triggerId = `${cleanText(rule.id || input.rule_id || "scope_commission")}:${installmentId || index + 1}`;
    results.push((await triggerCommissionEvent(orgId, projectId, {
      source_event_id: cleanText(context.event.idempotency_key || context.event.id),
      trigger_id: triggerId,
      state: cleanText(award.entry_state) === "projected" ? "projected" : "accrued",
      payee_role: cleanText(award.payee_role || rule.payee_role),
      payees: asArray(award.payees),
      amount_cents: Math.round(Number(award.amount_cents || 0)),
      allocation: cleanText(award.allocation || rule.allocation) === "each" ? "each" : "split_evenly",
      currency: cleanText(award.currency || rule.currency || "USD"),
      occurred_at: cleanText(asObject(context.event.payload).occurred_at || context.event.created_at || context.now),
      completed_at: cleanText(award.completed_at || context.now),
      project_title: cleanText(context.project.title || context.project.project_title || context.plan.title),
      description: cleanText(award.description || rule.title || "Scope commission"),
      metadata: {
        work_event_id: cleanText(context.event.id),
        work_plan_id: cleanText(context.plan.id),
        work_node_id: cleanText(context.node.id),
        work_idempotency_key: context.idempotencyKey,
        scope_template_id: cleanText(context.plan.template_id),
        scope_template_version: Number(context.plan.template_version || 0),
        commission_rule_id: cleanText(rule.id),
        commission_installment_id: installmentId,
        commission_installment_title: cleanText(award.installment_title),
        commission_installment_share_bps: Number(award.installment_share_bps || 0),
        commission_recognition: asObject(award.recognition),
        commission_calculation_mode: cleanText(asObject(rule.calculation).mode || "preset"),
        commission_breakdown: asArray(award.breakdown),
        commission_basis_cents: Number(award.basis_cents || 0),
        commission_rate_bps: Number(award.rate_bps || 0),
        ...asObject(rule.metadata),
        ...asObject(award.metadata)
      }
    })));
  }
  return { awards, results };
}

async function accrueScopeCommissionProjection(context: WorkAutomationContext, input: JsonObject) {
  const orgId = cleanText(context.event.organization_id);
  const projectId = cleanText(context.project.id || context.plan.project_id || context.event.project_id);
  const ruleId = cleanText(input.rule_id);
  const installmentId = cleanText(input.installment_id);
  const planId = cleanText(context.plan.id);
  const entries = (await listPayrollLedgerEntries(orgId, { project_id: projectId, kind: "commission", limit: 5000 }))
    .filter((entry) => cleanText(entry.state) === "projected")
    .filter((entry) => cleanText(asObject(entry.metadata).commission_rule_id) === ruleId)
    .filter((entry) => cleanText(asObject(entry.metadata).commission_installment_id) === installmentId)
    .filter((entry) => !planId || cleanText(asObject(entry.metadata).work_plan_id) === planId);
  const occurredAt = cleanText(asObject(context.event.payload).occurred_at || context.event.created_at || context.now);
  return { entries: (await Promise.all(entries.map(async (entry) => (await accruePayrollProjection(orgId, cleanText(entry.id), { occurred_at: occurredAt }))))) };
}

export function registerPayrollAutomations() {
  if (registered) return;
  registered = true;
  registerWorkAutomation("payroll.commission.post.v1", recordCommission, {
    description:"Records a fixed or percentage-based commission for the project's recipients.",
    input:{ payee_role:"Recipient role.", payees:"Explicit recipients.", amount:"Fixed amount or percentage basis and rate.", allocation:"Split evenly or award to each recipient.", entry_state:"Ledger state, default accrued." }
  });
  registerWorkAutomation("payroll.projectPayees.set.v1", setProjectPayees, {
    description:"Assigns the recipients of a project commission role.",
    input:{ role_key:"The commission role to assign.", label:"Role display name.", payees:"Recipients for this role." }
  });
  registerWorkAutomation("payroll.commission.rule.v1", recordScopeCommissionRule, {
    description:"Evaluates a scope's commission calculation and records the resulting awards and installments.",
    input:{ rule:"The complete commission rule, including its calculation and installments." }
  });
  registerWorkAutomation("payroll.commission.accrue.v1", accrueScopeCommissionProjection, {
    description:"Recognizes projected commission installments when their milestone is reached.",
    input:{ rule_id:"The commission rule whose projections should be recognized.", installment_id:"The installment that reached its recognition milestone." }
  });
}
