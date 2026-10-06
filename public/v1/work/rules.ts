// Organization automation rules: the always-on automation layer above scope
// sets. Rules live in the per-branch `automation_rules` module and are
// evaluated by the engine on EVERY event — before any scope instance's
// bindings — using the same automations, conditions, idempotency, and
// execution records as scope bindings. This layer is deliberately lean: it
// exists as infrastructure, and ships with only the platform defaults below.
//
// Rule shape:
//   {
//     id, enabled, title,
//     event: "payment.received"            // event type to match, OR
//     schedule: { cron: "0 8 * * 1" },     // a cron schedule (fires `time.cron`)
//     conditions: { "payload.payment_kind": "deposit", "project.lifecycle.status": "open" },
//     automation: "notification.create.v1",
//     input: { ... }                        // template-interpolated like any binding
//     actions: [                            // further actions, run in order
//       { id: "text_customer", automation: "communications.sendSms.v1", input: { ... }, conditions: { ... } }
//     ]
//   }
//
// A rule runs its single `automation` (when set) and then each of `actions`.
// Every action is its own idempotent execution; an action's `conditions` are
// checked in addition to the rule's, against project state as left by the
// actions before it.

import { PlatformError } from "../platform/errors.js";
import { allConditions, validateConditions } from "./conditions.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";

export const AUTOMATION_RULES_MODULE_ID = "automation_rules";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

// Platform defaults — present for every org unless explicitly disabled by an
// org rule with the same id. Receivables generation is org billing policy,
// not scope-of-work behavior, so it lives here rather than in any template.
export const DEFAULT_AUTOMATION_RULES: JsonObject[] = [
  {
    id: "platform_queue_new_lead_calls",
    enabled: true,
    title: "Queue a call when a new lead arrives",
    explainer: "When a new lead comes in, we add them to the New Leads call queue so someone reaches out right away.",
    customer_visible: true,
    event: "project.created",
    conditions: {},
    automation: "crm.callLists.add.v1",
    input: {
      list: {
        key: "new_leads",
        title: "New Leads",
        description: "Fresh leads that need a first call.",
        kind: "lead",
        icon: "fa-user-plus",
        tone: "lead",
        sort_order: 10,
        metadata: { purpose: "new_lead_contact", managed_by: "automation" }
      },
      title: "Contact lead"
    }
  },
  {
    id: "platform_ensure_receivables_on_signature",
    enabled: true,
    title: "Create payment schedule when a proposal is signed",
    customer_visible: false,
    event: "document.signed",
    conditions: { "payload.document_source": "proposals" },
    automation: "payments.ensureReceivables.v1",
    input: {}
  },
  {
    id: "platform_document_signed_behaviors",
    enabled: true,
    title: "Run a signed document's declared behaviors",
    customer_visible: false,
    event: "document.signed",
    conditions: {},
    automation: "documents.dispatchOnSigned.v1",
    input: {}
  },
  {
    id: "platform_reconcile_obligation_recognition",
    enabled: true,
    title: "Recognize milestone-due payments when work completes",
    customer_visible: false,
    event: "work.node.completed",
    conditions: {},
    automation: "payments.reconcileRecognition.v1",
    input: {}
  },
  {
    id: "platform_reconcile_obligation_recognition_plan",
    enabled: true,
    title: "Recognize completion-due payments when a scope finishes",
    customer_visible: false,
    event: "work.plan.completed",
    conditions: {},
    automation: "payments.reconcileRecognition.v1",
    input: {}
  },
  {
    id: "platform_reconcile_obligation_recognition_signoff",
    enabled: true,
    title: "Recognize completion-due payments on customer sign-off",
    customer_visible: false,
    event: "project.completion.signed",
    conditions: {},
    automation: "payments.reconcileRecognition.v1",
    input: {}
  }
];

// Same visibility contract as the template inventory: no explainer (title
// counts) = hidden; customer_visible false always hides.
export function ruleIsCustomerVisible(rule: JsonObject) {
  if (rule.customer_visible === false) return false;
  if (rule.customer_visible === true) return true;
  return !!cleanText(rule.explainer || rule.title);
}

function normalizeAction(value: unknown, index: number): JsonObject {
  const action = asObject(value);
  return {
    id: cleanText(action.id) || `action_${index + 1}`,
    enabled: action.enabled !== false,
    ...(cleanText(action.title) ? { title: cleanText(action.title) } : {}),
    ...(cleanText(action.explainer) ? { explainer: cleanText(action.explainer) } : {}),
    automation: cleanText(action.automation),
    input: asObject(action.input),
    conditions: asObject(action.conditions),
    continue_on_error: action.continue_on_error === true
  };
}

/**
 * One executable entry per action. A rule's single `automation` keeps the
 * rule's own id as its execution identity; listed actions use `<rule>:<action>`.
 */
export function expandAutomationRules(rules: JsonObject[]): JsonObject[] {
  return rules.flatMap((rule) => {
    // Rule-level settings this module does not interpret ride along on every entry.
    const { actions: _actions, automation: _automation, input: _input, conditions: _conditions, ...shared } = rule;
    const single = cleanText(rule.automation)
      ? [{ ...shared, id: cleanText(rule.id), rule_id: cleanText(rule.id), enabled: rule.enabled !== false, conditions: asObject(rule.conditions),
          automation: rule.automation, input: asObject(rule.input), continue_on_error: rule.continue_on_error === true }]
      : [];
    const listed = asArray(rule.actions).map(asObject).filter((action) => cleanText(action.automation)).map((action) => ({
      ...shared, ...action, id: `${cleanText(rule.id)}:${cleanText(action.id)}`, rule_id: cleanText(rule.id), action_id: cleanText(action.id),
      enabled: rule.enabled !== false && action.enabled !== false,
      conditions: allConditions(rule.conditions, action.conditions),
      input: asObject(action.input), continue_on_error: action.continue_on_error === true,
      title: cleanText(rule.title), explainer: cleanText(action.explainer || rule.explainer)
    }));
    return [...single, ...listed];
  });
}

function normalizeRule(value: unknown, index: number): JsonObject {
  const rule = asObject(value);
  const id = cleanText(rule.id) || `automation_rule_${index + 1}`;
  const schedule = asObject(rule.schedule);
  const hasCron = !!cleanText(schedule.cron);
  const explicitEvent = cleanText(rule.event);
  return {
    id,
    enabled: rule.enabled !== false,
    title: cleanText(rule.title),
    explainer: cleanText(rule.explainer || rule.title),
    ...(rule.customer_visible !== undefined ? { customer_visible: rule.customer_visible === true } : {}),
    // A scheduled rule listens for its own cron firings: the scheduler emits
    // `time.cron` with the rule id, and the implicit condition scopes it.
    event: explicitEvent || (hasCron ? "time.cron" : ""),
    schedule,
    conditions: hasCron && !explicitEvent
      ? { "payload.rule_id": id, ...asObject(rule.conditions) }
      : asObject(rule.conditions),
    automation: cleanText(rule.automation),
    input: asObject(rule.input),
    ...(asArray(rule.actions).length ? { actions: asArray(rule.actions).map(normalizeAction) } : {}),
    continue_on_error: rule.continue_on_error === true
  };
}

function assertRulesValid(rules: JsonObject[]) {
  const issues: string[] = [];
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    const id = cleanText(rule.id);
    if (ruleIds.has(id)) issues.push(`Rule id "${id}" is used more than once.`);
    ruleIds.add(id);
    issues.push(...validateConditions(rule.conditions, `rule "${id}" conditions`));
    const actionIds = new Set<string>();
    for (const action of asArray(rule.actions).map(asObject)) {
      const actionId = cleanText(action.id);
      if (actionIds.has(actionId)) issues.push(`Rule "${id}" uses action id "${actionId}" more than once.`);
      actionIds.add(actionId);
      if (!cleanText(action.automation)) issues.push(`Rule "${id}" action "${actionId}" needs an automation.`);
      issues.push(...validateConditions(action.conditions, `rule "${id}" action "${actionId}" conditions`));
    }
  }
  if (issues.length) throw new PlatformError("automation_rules_invalid", 400, issues[0]!, { issues });
}

export async function readAutomationRules(orgId: string, branchId = "default") {
  let stored: JsonObject[] = [];
  let revision = 0;
  try {
    const module = await readBranchModule(orgId, branchId || "default", AUTOMATION_RULES_MODULE_ID);
    stored = asArray(asObject(module.data).rules).map(normalizeRule);
    revision = Number(module.revision || 0);
  } catch (error) {
    if (!(error instanceof PlatformError && error.statusCode === 404)) throw error;
  }
  const storedIds = new Set(stored.map((rule) => cleanText(rule.id)));
  const rules = [
    ...DEFAULT_AUTOMATION_RULES.filter((rule) => !storedIds.has(cleanText(rule.id))).map(normalizeRule),
    ...stored
  ];
  return { rules, revision };
}

export async function saveAutomationRules(orgId: string, branchId: string, value: unknown) {
  const input = asObject(value);
  const rules = asArray(asObject(input.data || input).rules).map(normalizeRule);
  assertRulesValid(rules);
  const module = await saveBranchModule(orgId, branchId || "default", AUTOMATION_RULES_MODULE_ID, {
    expected_revision: input.expected_revision,
    data: { schema_version: 1, rules },
    metadata: { kind: "branch_automation_rules" }
  }, { replace: true });
  await (await import('../integrations/usage.js')).indexConnectionUses(orgId,`organization-rules:${branchId}`,{rules});
  return { rules: asArray(asObject(module.data).rules).map(normalizeRule), revision: Number(module.revision || 0) };
}
