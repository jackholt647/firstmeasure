// One condition contract for every automation surface: scope bindings,
// external triggers, organization rules, sequence steps and intake routing.
//
// Two spellings are accepted and may be nested inside each other:
//
//   Map (the original form) — every entry must match:
//     { "payload.payment_kind": "deposit", "project.claims.welcome_call": "" }
//     A list means "any of"; an empty string means "missing or empty".
//
//   Group — explicit operators, any/all, and nesting:
//     { match: "all" | "any", rules: [
//         { field: "project.proposal.total_cents", operator: "greater_than", value: 1000000 },
//         { field: "payload.received_at", operator: "before", value: "now-3d" },
//         { match: "any", rules: [ ... ] }
//     ] }
//     `conditions` is read as an alias of `rules` (the intake-routing spelling).
//
// Fields are dot paths into the evaluation context. A path that does not
// resolve from the root is retried under `payload.` so event fields can be
// written without the prefix.

export type ConditionContext = Record<string, unknown>;
export type ConditionOptions = {
  now?: Date | string | number;
  // Intake routing historically compared case-insensitively and treated a
  // comma-separated value as a list. Engine conditions compare exactly.
  caseInsensitive?: boolean;
  commaLists?: boolean;
  payloadFallback?: boolean;
};
export type ConditionTrace = {
  matched: boolean;
  kind: "group" | "rule";
  match?: "all" | "any";
  field?: string;
  operator?: string;
  expected?: unknown;
  actual?: unknown;
  rules?: ConditionTrace[];
};

type OperatorDefinition = { id: string; label: string; value: "none" | "one" | "list" | "number" | "time"; description: string };

export const CONDITION_OPERATORS: readonly OperatorDefinition[] = Object.freeze([
  { id: "equals", label: "is", value: "one", description: "The field equals the value (a list means any of them)." },
  { id: "not_equals", label: "is not", value: "one", description: "The field equals none of the values." },
  { id: "in", label: "is any of", value: "list", description: "The field equals one of the listed values." },
  { id: "not_in", label: "is none of", value: "list", description: "The field equals none of the listed values." },
  { id: "contains", label: "contains", value: "one", description: "Text contains the value, or a list field includes it." },
  { id: "not_contains", label: "does not contain", value: "one", description: "Text does not contain the value, and a list field does not include it." },
  { id: "starts_with", label: "starts with", value: "one", description: "Text starts with the value." },
  { id: "ends_with", label: "ends with", value: "one", description: "Text ends with the value." },
  { id: "is_present", label: "has a value", value: "none", description: "The field is set and not empty." },
  { id: "is_missing", label: "is empty", value: "none", description: "The field is missing or empty." },
  { id: "greater_than", label: "is greater than", value: "number", description: "Numeric comparison." },
  { id: "greater_or_equal", label: "is at least", value: "number", description: "Numeric comparison." },
  { id: "less_than", label: "is less than", value: "number", description: "Numeric comparison." },
  { id: "less_or_equal", label: "is at most", value: "number", description: "Numeric comparison." },
  { id: "before", label: "is before", value: "time", description: "The field's date is earlier than the value: an ISO date, `now`, or a relative time such as `now-3d` or `now+2h`." },
  { id: "after", label: "is after", value: "time", description: "The field's date is later than the value: an ISO date, `now`, or a relative time such as `now-3d` or `now+2h`." }
]);

const OPERATOR_IDS = new Set(CONDITION_OPERATORS.map((operator) => operator.id));
const RELATIVE_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

const text = (value: unknown) => String(value ?? "").trim();
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isEmpty = (value: unknown) => value === undefined || value === null || (Array.isArray(value) ? value.length === 0 : text(value) === "");

type Group = { match?: unknown; rules?: unknown; conditions?: unknown };
type Rule = { field?: unknown; path?: unknown; operator?: unknown; value?: unknown };

export function isConditionGroup(value: unknown): value is Group {
  return isObject(value) && (Array.isArray(value.rules) || Array.isArray(value.conditions));
}

function isConditionRule(value: unknown): value is Rule {
  return isObject(value) && !Array.isArray(value.rules) && !Array.isArray(value.conditions)
    && (typeof value.field === "string" || typeof value.path === "string") && ("operator" in value || "value" in value);
}

const groupMembers = (group: Group) => (Array.isArray(group.rules) ? group.rules : group.conditions) as unknown[];

function readPath(context: ConditionContext, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (
    isObject(value) ? value[key] : Array.isArray(value) && /^\d+$/.test(key) ? value[Number(key)] : undefined
  ), context);
}

export function conditionFieldValue(context: ConditionContext, field: string, options: ConditionOptions = {}) {
  const direct = readPath(context, field);
  return direct !== undefined || options.payloadFallback === false ? direct : readPath(context, `payload.${field}`);
}

/** `now`, `now-3d`, `now+90m`, an ISO date, or epoch milliseconds. NaN when unreadable. */
export function resolveConditionTime(value: unknown, now: Date | string | number = new Date()): number {
  if (typeof value === "number") return value;
  const raw = text(value);
  const base = now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.parse(now);
  const relative = /^now(?:\s*([+-])\s*(\d+(?:\.\d+)?)\s*([mhdw]))?$/i.exec(raw);
  if (relative) return base + (relative[1] === "-" ? -1 : 1) * Number(relative[2] || 0) * (RELATIVE_UNITS[(relative[3] || "m").toLowerCase()] || 0);
  return Date.parse(raw);
}

function expectedList(value: unknown, options: ConditionOptions) {
  const list = Array.isArray(value) ? value : options.commaLists && typeof value === "string" ? value.split(",") : [value];
  return list.map(text).filter((entry, _index, all) => entry !== "" || all.length === 1);
}

function evaluateRule(rule: Rule, context: ConditionContext, options: ConditionOptions): ConditionTrace {
  const field = text(rule.field || rule.path);
  const operator = OPERATOR_IDS.has(text(rule.operator)) ? text(rule.operator) : "equals";
  const expected = rule.value ?? "";
  const actual = conditionFieldValue(context, field, options);
  const fold = (value: string) => options.caseInsensitive ? value.toLowerCase() : value;
  const actualText = fold(text(actual));
  const actualList = Array.isArray(actual) ? actual.map((entry) => fold(text(entry))) : null;
  const expectedValues = expectedList(expected, options).map(fold);
  const equalsAny = () => actualList ? actualList.some((entry) => expectedValues.includes(entry)) : expectedValues.includes(actualText);
  const containsAny = () => actualList ? actualList.some((entry) => expectedValues.includes(entry)) : expectedValues.some((entry) => entry !== "" && actualText.includes(entry));
  const numeric = (compare: (left: number, right: number) => boolean) => {
    const left = typeof actual === "number" ? actual : text(actual) === "" ? NaN : Number(actual);
    const right = typeof expected === "number" ? expected : text(expected) === "" ? NaN : Number(expected);
    return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
  };
  const temporal = (compare: (left: number, right: number) => boolean) => {
    const left = typeof actual === "number" ? actual : Date.parse(text(actual));
    const right = resolveConditionTime(expected, options.now);
    return Number.isFinite(left) && Number.isFinite(right) && compare(left, right);
  };
  let matched: boolean;
  switch (operator) {
    case "not_equals": case "not_in": matched = !equalsAny(); break;
    case "contains": matched = containsAny(); break;
    case "not_contains": matched = !containsAny(); break;
    case "starts_with": matched = expectedValues.some((entry) => entry !== "" && actualText.startsWith(entry)); break;
    case "ends_with": matched = expectedValues.some((entry) => entry !== "" && actualText.endsWith(entry)); break;
    case "is_present": matched = !isEmpty(actual); break;
    case "is_missing": matched = isEmpty(actual); break;
    case "greater_than": matched = numeric((left, right) => left > right); break;
    case "greater_or_equal": matched = numeric((left, right) => left >= right); break;
    case "less_than": matched = numeric((left, right) => left < right); break;
    case "less_or_equal": matched = numeric((left, right) => left <= right); break;
    case "before": matched = temporal((left, right) => left < right); break;
    case "after": matched = temporal((left, right) => left > right); break;
    default: matched = equalsAny();
  }
  return { matched, kind: "rule", field, operator, expected, actual };
}

/** Evaluates a condition and returns the per-rule results, for dry runs and explanations. */
export function explainConditions(conditions: unknown, context: ConditionContext, options: ConditionOptions = {}): ConditionTrace {
  if (isConditionGroup(conditions)) {
    const match = text(conditions.match).toLowerCase() === "any" ? "any" : "all";
    const rules = groupMembers(conditions).map((member) => explainConditions(member, context, options));
    return { matched: match === "any" ? rules.some((rule) => rule.matched) : rules.every((rule) => rule.matched), kind: "group", match, rules };
  }
  if (isConditionRule(conditions)) return evaluateRule(conditions, context, options);
  // Map form: exact equality, a list means any-of, "" means missing or empty.
  const rules = Object.entries(isObject(conditions) ? conditions : {}).map(([field, expected]): ConditionTrace => {
    if (isConditionGroup(expected)) return explainConditions(expected, context, options);
    const actual = conditionFieldValue(context, field, options);
    const matched = Array.isArray(expected) ? expected.map(text).includes(text(actual)) : text(actual) === text(expected);
    return { matched, kind: "rule", field, operator: Array.isArray(expected) ? "in" : text(expected) === "" ? "is_missing" : "equals", expected, actual };
  });
  return { matched: rules.every((rule) => rule.matched), kind: "group", match: "all", rules };
}

export function evaluateConditions(conditions: unknown, context: ConditionContext, options: ConditionOptions = {}) {
  return explainConditions(conditions, context, options).matched;
}

/** Combines conditions so that all of them must hold; empty members are dropped. */
export function allConditions(...members: unknown[]) {
  const present = members.filter((member) => isConditionGroup(member)
    ? groupMembers(member).length > 0
    : isObject(member) && Object.keys(member).length > 0);
  if (!present.length) return {};
  return present.length === 1 ? present[0] as Record<string, unknown> : { match: "all", rules: present };
}

/** Returns human-readable problems; an empty list means the condition is well formed. */
export function validateConditions(conditions: unknown, path = "conditions"): string[] {
  if (conditions === undefined || conditions === null) return [];
  if (!isObject(conditions)) return [`${path} must be an object.`];
  if (isConditionGroup(conditions)) {
    const issues: string[] = [];
    if (conditions.match !== undefined && !["all", "any"].includes(text(conditions.match).toLowerCase())) issues.push(`${path}.match must be "all" or "any".`);
    groupMembers(conditions).forEach((member, index) => issues.push(...validateConditions(member, `${path}.rules[${index}]`)));
    return issues;
  }
  if (isConditionRule(conditions)) {
    const issues: string[] = [];
    const operator = text(conditions.operator) || "equals";
    const definition = CONDITION_OPERATORS.find((entry) => entry.id === operator);
    if (!text(conditions.field || conditions.path)) issues.push(`${path}.field is required.`);
    if (!definition) issues.push(`${path}.operator "${operator}" is not supported. Use one of: ${[...OPERATOR_IDS].join(", ")}.`);
    else if (definition.value === "number" && !Number.isFinite(Number(conditions.value)) ) issues.push(`${path}.value must be a number for "${operator}".`);
    else if (definition.value === "time" && !Number.isFinite(resolveConditionTime(conditions.value))) issues.push(`${path}.value must be an ISO date, "now", or a relative time such as "now-3d" for "${operator}".`);
    else if (!["none"].includes(definition.value) && conditions.value === undefined) issues.push(`${path}.value is required for "${operator}".`);
    return issues;
  }
  return Object.entries(conditions).flatMap(([field, expected]) => isConditionGroup(expected)
    ? validateConditions(expected, `${path}.${field}`)
    : isObject(expected) ? [`${path}.${field} must be a value, a list of values, or a condition group.`] : []);
}
