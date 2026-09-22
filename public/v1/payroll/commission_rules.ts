import { createContext, Script } from "node:vm";

import { badRequest } from "../platform/errors.js";
import { moneyCents, normalizeProposalScope, scopeItemPriceResult, walkScopeItems } from "../proposals/scope.js";
import type { JsonObject } from "./storage.js";

type CommissionAward = JsonObject & {
  amount_cents: number;
  payee_role?: string;
  allocation?: "split_evenly" | "each";
  entry_state?: "projected" | "accrued";
  installment_id?: string;
  recognition?: JsonObject;
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteInteger(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : fallback;
}

function explicitCents(value: unknown) {
  const source = asObject(value);
  for (const candidate of [source.total_cents, source.amount_cents, source.cents]) {
    if (Number.isFinite(Number(candidate))) return Math.round(Number(candidate));
  }
  return moneyCents(value);
}

function itemIsDiscount(item: JsonObject) {
  return item.is_discount === true || ["discount", "promotion", "coupon"].includes(cleanText(item.item_kind || item.kind || item.type).toLowerCase());
}

function itemCategory(item: JsonObject) {
  return cleanText(item.category || item.category_id || item.item_type_id || asObject(item.pricebook_ref).category);
}

function itemTags(item: JsonObject) {
  return asArray(item.tags || asObject(item.metadata).tags).map(cleanText).filter(Boolean);
}

function proposalContent(proposalValue: unknown) {
  const proposal = asObject(proposalValue);
  return Object.keys(asObject(proposal.content)).length ? asObject(proposal.content) : proposal;
}

function scopeForContext(context: JsonObject) {
  const content = proposalContent(context.proposal);
  const proposalScope = asObject(content.scope);
  if (asArray(proposalScope.root_items).length) return proposalScope;
  return asObject(context.scope);
}

function lineItemFacts(scopeValue: unknown) {
  const scope = normalizeProposalScope(scopeValue);
  const items: JsonObject[] = [];
  walkScopeItems(scope, (item, path) => {
    const result = scopeItemPriceResult(item);
    const discount = itemIsDiscount(item);
    const rawAmount = finiteInteger(result.own_amount_cents);
    const amount = discount ? -Math.abs(rawAmount) : rawAmount;
    items.push({
      id: cleanText(item.id),
      name: cleanText(item.display_name || item.name || item.label || item.id),
      amount_cents: amount,
      absolute_amount_cents: Math.abs(amount),
      selected: result.selected,
      included: item.included === true,
      discount,
      category: itemCategory(item),
      tags: itemTags(item),
      pricebook_item_id: cleanText(asObject(item.pricebook_ref).item_id || item.pricebook_item_id),
      path
    });
  });
  return items;
}

function directProposalTotal(content: JsonObject) {
  const pricing = asObject(content.pricing);
  for (const value of [pricing.total_cents, pricing.contract_total_cents]) {
    if (Number.isFinite(Number(value))) return Math.round(Number(value));
  }
  for (const value of [pricing.total, pricing.contract_total]) {
    const cents = explicitCents(value);
    if (cents) return cents;
  }
  return 0;
}

export function commissionContextFacts(contextValue: JsonObject) {
  const content = proposalContent(contextValue.proposal);
  const lineItems = lineItemFacts(scopeForContext(contextValue));
  const subtotal = lineItems.filter((item) => item.selected !== false && item.discount !== true)
    .reduce((sum, item) => sum + Math.max(0, finiteInteger(item.amount_cents)), 0);
  const discounts = lineItems.filter((item) => item.selected !== false && item.discount === true)
    .reduce((sum, item) => sum + Math.abs(finiteInteger(item.amount_cents)), 0);
  const computedTotal = Math.max(0, subtotal - discounts);
  const proposalTotal = Math.max(0, directProposalTotal(content) || computedTotal);
  const money = asObject(contextValue.money);
  return {
    proposal_total_cents: proposalTotal,
    proposal_subtotal_cents: subtotal,
    discount_cents: discounts,
    discount_bps: subtotal > 0 ? Math.round(discounts * 10_000 / subtotal) : 0,
    collected_revenue_cents: finiteInteger(money.total_collected_cents || money.revenue_to_date_cents),
    forecast_profit_cents: finiteInteger(money.forecast_profit_cents || money.projected_profit_cents),
    line_items: lineItems
  };
}

function stringSet(value: unknown) {
  return new Set(asArray(value).map((item) => cleanText(item).toLowerCase()).filter(Boolean));
}

function itemMatches(itemValue: unknown, selectorValue: unknown, exclusion = false) {
  const item = asObject(itemValue);
  const selector = asObject(selectorValue);
  const prefix = exclusion ? "exclude_" : "";
  const ids = stringSet(selector[`${prefix}item_ids`]);
  const categories = stringSet(selector[`${prefix}categories`]);
  const tags = stringSet(selector[`${prefix}tags`]);
  const configured = ids.size || categories.size || tags.size;
  if (!configured) return exclusion ? false : true;
  const candidates = [item.id, item.pricebook_item_id].map((value) => cleanText(value).toLowerCase());
  return candidates.some((value) => ids.has(value))
    || categories.has(cleanText(item.category).toLowerCase())
    || asArray(item.tags).some((tag) => tags.has(cleanText(tag).toLowerCase()));
}

function selectedItemBasis(facts: JsonObject, selector: JsonObject) {
  return asArray(facts.line_items).map(asObject)
    .filter((item) => item.selected !== false && item.discount !== true)
    .filter((item) => itemMatches(item, selector, false) && !itemMatches(item, selector, true))
    .reduce((sum, item) => sum + Math.max(0, finiteInteger(item.amount_cents)), 0);
}

function excludedItemTotal(facts: JsonObject, selector: JsonObject) {
  return asArray(facts.line_items).map(asObject)
    .filter((item) => item.selected !== false && item.discount !== true && itemMatches(item, selector, true))
    .reduce((sum, item) => sum + Math.max(0, finiteInteger(item.amount_cents)), 0);
}

function rateForCalculation(calculation: JsonObject, facts: JsonObject) {
  const discountBps = finiteInteger(facts.discount_bps);
  const tier = asArray(calculation.tiers).map(asObject).find((candidate) => {
    const minimum = finiteInteger(candidate.min_discount_bps, 0);
    const maximum = candidate.max_discount_bps === undefined ? Number.POSITIVE_INFINITY : finiteInteger(candidate.max_discount_bps);
    return discountBps >= minimum && discountBps <= maximum;
  });
  return finiteInteger(tier?.rate_bps ?? calculation.rate_bps);
}

function presetAward(rule: JsonObject, context: JsonObject): CommissionAward {
  const calculation = asObject(rule.calculation);
  const facts = asObject(context.facts);
  const preset = cleanText(calculation.preset || "percentage");
  const selector = asObject(calculation.selector);
  if (preset === "fixed") {
    const amount = Math.max(0, finiteInteger(calculation.fixed_amount_cents));
    return { amount_cents: amount, basis_cents: amount, rate_bps: 0, breakdown: [{ label: "Fixed commission", amount_cents: amount }] };
  }
  const basisKind = cleanText(calculation.basis || (preset === "selected_line_items" ? "selected_line_items" : preset === "percentage_after_discount" ? "proposal_subtotal" : "proposal_total"));
  let basis = basisKind === "proposal_subtotal" ? finiteInteger(facts.proposal_subtotal_cents)
    : basisKind === "collected_revenue" ? finiteInteger(facts.collected_revenue_cents)
      : basisKind === "forecast_profit" ? finiteInteger(facts.forecast_profit_cents)
        : basisKind === "selected_line_items" ? selectedItemBasis(facts, selector)
          : finiteInteger(facts.proposal_total_cents);
  const breakdown: JsonObject[] = [{ label: `Basis: ${basisKind.replace(/_/g, " ")}`, amount_cents: basis }];
  const exclusions = excludedItemTotal(facts, selector);
  if (exclusions && basisKind !== "selected_line_items") {
    basis = Math.max(0, basis - exclusions);
    breakdown.push({ label: "Excluded line items", amount_cents: -exclusions });
  }
  if (calculation.subtract_discounts === true && basisKind !== "proposal_total") {
    const discount = Math.min(basis, Math.max(0, finiteInteger(facts.discount_cents)));
    basis -= discount;
    if (discount) breakdown.push({ label: "Discounts", amount_cents: -discount });
  }
  const rateBps = rateForCalculation(calculation, facts);
  let amount = Math.max(0, Math.round(basis * rateBps / 10_000) + finiteInteger(calculation.fixed_adjustment_cents));
  if (calculation.minimum_cents !== undefined) amount = Math.max(amount, finiteInteger(calculation.minimum_cents));
  if (calculation.maximum_cents !== undefined) amount = Math.min(amount, finiteInteger(calculation.maximum_cents));
  breakdown.push({ label: "Commission", basis_cents: basis, rate_bps: rateBps, amount_cents: amount });
  return { amount_cents: amount, basis_cents: basis, rate_bps: rateBps, breakdown };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function customAwards(rule: JsonObject, contextValue: JsonObject): CommissionAward[] {
  const calculation = asObject(rule.calculation);
  const code = cleanText(calculation.code);
  if (!code) throw badRequest("commission_code_required", "Custom commission code is empty.");
  const sandbox = { context: jsonClone(contextValue), output: null as unknown };
  const vmContext = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  try {
    new Script(`"use strict"; output = (${code})(context);`, { filename: `commission-rule-${cleanText(rule.id) || "custom"}.js` })
      .runInContext(vmContext, { timeout: 75 });
  } catch (error) {
    throw badRequest("commission_code_failed", `Custom commission rule '${cleanText(rule.title || rule.id)}' failed: ${cleanText(asObject(error).message || error)}`);
  }
  if (sandbox.output === undefined || sandbox.output === null) {
    throw badRequest("commission_result_empty", "Commission code did not return an award.");
  }
  const output = jsonClone(sandbox.output);
  const container = asObject(output);
  const values = Array.isArray(output) ? output : Array.isArray(container.awards) ? asArray(container.awards) : [output];
  return values.map((value) => {
    if (typeof value === "number" && Number.isFinite(value)) return { amount_cents: finiteInteger(value) };
    const award = asObject(value);
    if (!Number.isFinite(Number(award.amount_cents))) {
      throw badRequest("commission_result_invalid", "Custom commission results require an integer amount_cents.");
    }
    return { ...award, amount_cents: Math.max(0, finiteInteger(award.amount_cents)) };
  });
}

function installmentAwards(rule: JsonObject, award: CommissionAward): CommissionAward[] {
  const installments = asArray(rule.installments).map(asObject);
  if (!installments.length) return [award];
  let allocated = 0;
  return installments.map((installment, index) => {
    const amount = index === installments.length - 1
      ? award.amount_cents - allocated
      : Math.round(award.amount_cents * finiteInteger(installment.share_bps) / 10_000);
    allocated += amount;
    const title = cleanText(installment.title || `Payment ${index + 1}`);
    const recognition = asObject(installment.recognition);
    return {
      ...award,
      amount_cents: Math.max(0, amount),
      installment_id: cleanText(installment.id || `installment_${index + 1}`),
      installment_title: title,
      installment_share_bps: finiteInteger(installment.share_bps),
      recognition,
      description: cleanText(installment.description || `${cleanText(rule.title || "Commission")} — ${title}`),
      metadata: {
        ...asObject(award.metadata),
        ...asObject(installment.metadata),
        commission_installment_id: cleanText(installment.id || `installment_${index + 1}`),
        commission_installment_title: title,
        commission_installment_share_bps: finiteInteger(installment.share_bps),
        commission_rule_total_cents: award.amount_cents,
        commission_recognition: recognition
      }
    };
  });
}

export function evaluateScopeCommissionRule(ruleValue: JsonObject, contextValue: JsonObject): CommissionAward[] {
  const rule = asObject(ruleValue);
  const context = jsonClone({ ...contextValue, facts: commissionContextFacts(contextValue) });
  const calculation = asObject(rule.calculation);
  const calculated = (cleanText(calculation.mode) === "code" ? customAwards(rule, context) : [presetAward(rule, context)])
    .flatMap((award) => installmentAwards(rule, award));
  if (!calculated.length) throw badRequest("commission_result_empty", "Commission code did not return an award.");
  return calculated.map((award) => {
    if (!Number.isSafeInteger(award.amount_cents) || award.amount_cents < 0) {
      throw badRequest("commission_result_invalid", "Commission results require a non-negative integer amount_cents.");
    }
    return {
      ...award,
      payee_role: cleanText(award.payee_role || rule.payee_role),
      allocation: cleanText(award.allocation || rule.allocation) === "each" ? "each" : "split_evenly",
      entry_state: cleanText(award.entry_state || rule.entry_state) === "projected" ? "projected" : "accrued"
    };
  });
}

export function compileScopeCommissionBindings(definitionValue: JsonObject) {
  const commissions = asObject(definitionValue.commissions);
  if (commissions.enabled === false) return { plan: {} as Record<string, JsonObject[]>, nodes: {} as Record<string, Record<string, JsonObject[]>> };
  const plan: Record<string, JsonObject[]> = {};
  const nodes: Record<string, Record<string, JsonObject[]>> = {};
  for (const rule of asArray(commissions.rules).map(asObject).filter((value) => value.enabled !== false)) {
    const trigger = asObject(rule.trigger);
    const hook = cleanText(trigger.hook || "onStarted") || "onStarted";
    const binding = {
      id: `scope-commission-${cleanText(rule.id)}`,
      automation: "payroll.commission.rule.v1",
      input: { rule },
      continue_on_error: true
    };
    const nodeId = cleanText(trigger.node_id);
    if (nodeId) {
      nodes[nodeId] ||= {};
      nodes[nodeId][hook] = [...(nodes[nodeId][hook] || []), binding];
    } else {
      plan[hook] = [...(plan[hook] || []), binding];
    }
    for (const installment of asArray(rule.installments).map(asObject)) {
      const recognition = asObject(installment.recognition);
      const recognitionHook = cleanText(recognition.hook || "onCompleted") || "onCompleted";
      const recognitionBinding = {
        id: `scope-commission-accrue-${cleanText(rule.id)}-${cleanText(installment.id)}`,
        automation: "payroll.commission.accrue.v1",
        input: { rule_id: cleanText(rule.id), installment_id: cleanText(installment.id) },
        continue_on_error: true
      };
      const recognitionNodeId = cleanText(recognition.node_id);
      if (recognitionNodeId) {
        nodes[recognitionNodeId] ||= {};
        nodes[recognitionNodeId][recognitionHook] = [...(nodes[recognitionNodeId][recognitionHook] || []), recognitionBinding];
      } else {
        plan[recognitionHook] = [...(plan[recognitionHook] || []), recognitionBinding];
      }
    }
  }
  return { plan, nodes };
}
