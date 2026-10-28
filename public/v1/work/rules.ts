// Organization automation rules: the always-on automation layer above scope
// sets. Rules live in the per-branch `automation_rules` module and are
// evaluated by the engine on EVERY event — before any scope instance's
// bindings — using the same automations, conditions, idempotency, and
// execution records as scope bindings. This layer is deliberately lean: it
// exists as infrastructure, and ships with only the platform defaults (config
// library kind `automation_rule_default`, read below).
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
import { libraryEntries, libraryVersion } from "../config-library/library.js";
import { contentHash } from "../config-library/canonical.js";

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
  const raw = asObject(rule.schedule);
  // A date on each contact (a birthday, a yearly service date): the cron is the time of day it is checked,
  // and every contact whose date falls on that day gets its own contact.date event.
  const contactDate = asObject(raw.contact_date);
  const schedule = cleanText(contactDate.field)
    ? { ...raw, cron: cleanText(raw.cron) || "0 9 * * *", contact_date: { field: cleanText(contactDate.field), offset_days: Math.max(-365, Math.min(365, Math.round(Number(contactDate.offset_days) || 0))), yearly: contactDate.yearly !== false } }
    : raw;
  const hasCron = !!cleanText(schedule.cron);
  const explicitEvent = cleanText(rule.event) || (cleanText(contactDate.field) ? "contact.date" : "");
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
    conditions: hasCron && (!explicitEvent || explicitEvent === "contact.date")
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
    const dateField = cleanText(asObject(asObject(rule.schedule).contact_date).field);
    if (dateField && dateField !== "birthday" && !/^cf\.[A-Za-z0-9_.-]+$/.test(dateField)) issues.push(`Rule "${id}" can only follow a contact's birthday or a date field (cf.<field>).`);
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

// Platform defaults are config library entries of the kind `automation_rule_default`
// (config-library/kinds/automation_rule_default.ts), present for every org unless it
// stores a rule with the same id (to switch it off or change it). They are read live and
// never copied into an organization's rules: a default the organization has not changed
// follows the library. Receivables generation is org billing policy, not scope-of-work
// behavior, so it lives here rather than in any template.
export const AUTOMATION_RULE_DEFAULT_KIND = "automation_rule_default";
/**
 * Set on every default `readAutomationRules` returns: the hash of the rule as returned. A
 * read-modify-save caller (routing, contact rules, the rules editor, an agent) sends it back;
 * a rule whose content still matches it was not changed, so the save leaves it out and the
 * library default keeps applying instead of being frozen as an organization rule.
 */
export const LIBRARY_DEFAULT_MARKER = "library_default";

let defaultsCache: { version: number; rules: JsonObject[]; hashes: Map<string, string> } | null = null;
function libraryDefaults() {
  const version = libraryVersion();
  if (defaultsCache?.version !== version) {
    const rules = libraryEntries<JsonObject>(AUTOMATION_RULE_DEFAULT_KIND)
      .sort((a, b) => Number(a.data.sort_order) - Number(b.data.sort_order) || (a.id < b.id ? -1 : 1))
      .map((entry, index) => normalizeRule(structuredClone(entry.data), index));
    defaultsCache = { version, rules, hashes: new Map(rules.map((rule) => [cleanText(rule.id), contentHash(rule)])) };
  }
  return defaultsCache;
}

/** The platform default rules, normalized, in order (fresh copies). */
export function defaultAutomationRules(): JsonObject[] {
  return libraryDefaults().rules.map((rule) => ({ ...structuredClone(rule), [LIBRARY_DEFAULT_MARKER]: contentHash(rule) }));
}

/** The organization's stored rules with every default it has not stored before them. */
function withDefaults(stored: JsonObject[]) {
  const { hashes } = libraryDefaults();
  const storedIds = new Set(stored.map((rule) => cleanText(rule.id)));
  return [
    ...defaultAutomationRules().filter((rule) => !storedIds.has(cleanText(rule.id))),
    // A stored copy identical to its default (saved before defaults were left out of saves) is marked too, so the
    // next save drops it and the default is live again.
    ...stored.map((rule) => {
      const hash = contentHash(rule);
      return hashes.get(cleanText(rule.id)) === hash ? { ...rule, [LIBRARY_DEFAULT_MARKER]: hash } : rule;
    })
  ];
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
  return { rules: withDefaults(stored), revision };
}

/**
 * A rule a save leaves out: a default sent back unchanged (its content still matches the marker it was read with,
 * or equals the current library default). Anything changed, including switching a default off, is stored.
 */
function unchangedDefault(raw: unknown, normalized: JsonObject) {
  const hash = contentHash(normalized);
  const marker = cleanText(asObject(raw)[LIBRARY_DEFAULT_MARKER]);
  return (!!marker && marker === hash) || libraryDefaults().hashes.get(cleanText(normalized.id)) === hash;
}

/** Who saved the organization's rules last: custom code in a rule runs with that person's permissions. */
export async function automationRulesAuthor(orgId: string, branchId = "default") {
  const module = await readBranchModule(orgId, branchId || "default", AUTOMATION_RULES_MODULE_ID).catch(() => null);
  return cleanText(asObject(module?.metadata).author_user_id);
}

export async function saveAutomationRules(orgId: string, branchId: string, value: unknown, options: { authorUserId?: string } = {}) {
  const input = asObject(value);
  const raw = asArray(asObject(input.data || input).rules);
  const normalized = raw.map(normalizeRule);
  assertRulesValid(normalized);
  const rules = normalized.filter((rule, index) => !unchangedDefault(raw[index], rule));
  // Custom code in a rule reads and writes with the permissions of whoever saved the rules last
  // (work/automations/code.ts), the way a scope's code runs as its publisher.
  const module = await saveBranchModule(orgId, branchId || "default", AUTOMATION_RULES_MODULE_ID, {
    expected_revision: input.expected_revision,
    data: { schema_version: 1, rules },
    metadata: { kind: "branch_automation_rules", ...(options.authorUserId ? { author_user_id: options.authorUserId } : {}) }
  }, { replace: true });
  await (await import('../integrations/usage.js')).indexConnectionUses(orgId,`organization-rules:${branchId}`,{rules});
  // What the organization now runs, the same view readAutomationRules gives.
  return { rules: withDefaults(asArray(asObject(module.data).rules).map(normalizeRule)), revision: Number(module.revision || 0) };
}
