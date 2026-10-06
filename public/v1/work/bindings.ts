// Binding keys: how `automation_bindings` on a plan or node map to events.
//
// A key is either
//   - a lifecycle hook (`onCompleted`, `onReady`, `onTimer`, ...), which means
//     exactly one event on its own container: `work.node.<x>` on a work item,
//     `work.plan.<x>` on a scope; or
//   - a full event name (`payment.received`), which matches that event when it
//     explicitly targets the container.
//
// A hook never matches another domain's event that merely shares a suffix, and
// neither spelling hides the other. Templates are stored with the hook
// spelling for lifecycle events so every definition has one form.

export type BindingTarget = "plan" | "node";
type Json = Record<string, unknown>;

const text = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

/** `completed` -> `onCompleted`, `status_changed` -> `onStatusChanged`. */
export function hookName(suffix: string) {
  return `on${suffix.replace(/(^|_)([a-z])/g, (_match, _prefix, letter) => String(letter).toUpperCase())}`;
}

export function isHookKey(key: string) {
  return /^on[A-Z]/.test(key);
}

/** The single event a binding key listens for on the given container. */
export function eventForBindingKey(key: string, target: BindingTarget) {
  if (!isHookKey(key)) return key;
  return `work.${target}.${key.slice(2).replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}`;
}

/** The stored key for an event on the given container: a hook for its own lifecycle, otherwise the event name. */
export function bindingKeyForEvent(eventType: string, target: BindingTarget) {
  const prefix = `work.${target}.`;
  return eventType.startsWith(prefix) && !eventType.slice(prefix.length).includes(".") ? hookName(eventType.slice(prefix.length)) : eventType;
}

function dedupe(bindings: Json[]) {
  const seen = new Set<string>();
  return bindings.filter((binding) => {
    const id = text(binding.id);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Bindings on one container that respond to an event, in execution order. */
export function bindingsForEvent(bindingsValue: unknown, eventType: string, target: BindingTarget): Json[] {
  const bindings = asObject(bindingsValue);
  const key = bindingKeyForEvent(eventType, target);
  // Definitions saved before keys were canonical may still hold the raw
  // lifecycle event name next to (or instead of) the hook.
  const lists = key === eventType ? [bindings[eventType]] : [bindings[key], bindings[eventType]];
  return dedupe(lists.flatMap(asArray).map((binding) => ({ ...asObject(binding) })));
}

/** The execution identity of a binding when it has no stable id. */
export function bindingExecutionId(binding: Json, eventType: string, index: number) {
  return text(binding.id) || `${hookName(eventType.split(".").pop() || eventType)}:${index}:${text(binding.automation)}`;
}

/** Rewrites lifecycle event keys to their hook spelling and merges duplicates. */
export function normalizeBindingKeys(bindingsValue: unknown, target: BindingTarget): Json {
  const source = asObject(bindingsValue);
  const merged: Record<string, Json[]> = {};
  // Hook-spelled lists go first so they keep precedence when ids clash.
  const keys = [...Object.keys(source).filter(isHookKey), ...Object.keys(source).filter((key) => !isHookKey(key))];
  for (const key of keys) {
    const canonical = bindingKeyForEvent(eventForBindingKey(key, target), target);
    merged[canonical] = [...(merged[canonical] || []), ...asArray(source[key]).map(asObject)];
  }
  return Object.fromEntries(Object.entries(merged).map(([key, list]) => [key, dedupe(list)]));
}

/** Applies {@link normalizeBindingKeys} to a work-plan blueprint and every node in it. */
export function normalizeWorkPlanBindingKeys<T extends Json>(workPlan: T): T {
  const node = (value: unknown): Json => {
    const entry = asObject(value);
    return {
      ...entry,
      ...(entry.automation_bindings !== undefined ? { automation_bindings: normalizeBindingKeys(entry.automation_bindings, "node") } : {}),
      ...(Array.isArray(entry.children) ? { children: entry.children.map(node) } : {})
    };
  };
  return {
    ...workPlan,
    ...(workPlan.automation_bindings !== undefined ? { automation_bindings: normalizeBindingKeys(workPlan.automation_bindings, "plan") } : {}),
    ...(Array.isArray(workPlan.root_nodes) ? { root_nodes: workPlan.root_nodes.map(node) } : {})
  };
}
