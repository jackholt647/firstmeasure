import type { JsonObject } from "../platform/storage.js";
import { compileScopeCommissionBindings } from "../payroll/commission_rules.js";
import { listWorkEventDefinitions } from "../work/events.js";
import { listWorkAutomationDefinitions } from "../work/registry.js";
import { defaultInstantiationBindings } from "./service.js";

const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const array = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => String(value ?? "").trim();
export const eventWords = (value: unknown) => text(value).replace(/^work\.plan\./, "scope.").replace(/^work\.node\./, "work_item.").replace(/\.v\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").replace(/^./, (letter) => letter.toUpperCase());
const eventForHook = (hook: string, plan: boolean) => hook.startsWith("on")
  ? `work.${plan ? "plan" : "node"}.${hook.slice(2).replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()}` : hook;
const hookTiming: Record<string, string> = { onCreated:"is created", onReady:"becomes ready", onStarted:"starts", onCompleted:"completes", onSkipped:"is skipped", onCanceled:"is canceled", onBlocked:"becomes blocked", onDue:"becomes due", onTimer:"reaches its timer" };

// A read-only projection of definitions. No handlers are executed and no
// agent-visible explainer/visibility filter is applied here.
export function buildScopeEventMap(definition: JsonObject, organizationRules: JsonObject[] = []) {
  const catalog = listWorkEventDefinitions();
  const actions = listWorkAutomationDefinitions().map((action) => ({ ...action, label: eventWords(action.id) }));
  const actionById = new Map(actions.map((action) => [action.id, action]));
  const events = new Map(catalog.map((event) => [event.name, { ...event, label: eventWords(event.name), connections: [] as JsonObject[] }]));
  const add = (event: string, connection: JsonObject) => {
    if (!event) return;
    if (!events.has(event)) events.set(event, { name:event, label:eventWords(event), description:"Custom event referenced by this scope.", visibility:"system", connections:[] });
    connection.canonical_id = connection.id;
    events.get(event)!.connections.push(connection);
    // Lifecycle aliases also match non-work events with the same suffix,
    // but only when the emitter explicitly supplies this plan/node target.
    if (connection.kind === "action" && text(connection.hook).startsWith("on")) {
      for (const candidate of catalog) {
        if (candidate.name.startsWith("work.") || candidate.name.split(".").pop() !== event.split(".").pop()) continue;
        events.get(candidate.name)!.connections.push({ ...connection, id:`${connection.id}:${candidate.name}`, potential:true,
          when:`Only when this event explicitly targets ${connection.location}`,
          note:`Matches the ${connection.hook} lifecycle alias. An event on the same project alone does not run this binding. ${connection.note || ""}` });
      }
    }
  };
  const commissions = compileScopeCommissionBindings(definition);
  const visit = (container: JsonObject, path: string[], isPlan: boolean, pointer: (string | number)[]) => {
    const title = text(container.title || definition.name || "Scope");
    const nodeId = isPlan ? "plan" : text(container.id);
    const location = [...path, title].join(" / ");
    const configured = object(container.automation_bindings);
    const generated = isPlan ? commissions.plan : commissions.nodes[nodeId] || {};
    const defaults = isPlan ? defaultInstantiationBindings(definition) : {};
    const hooks = new Set([...Object.keys(configured), ...Object.keys(generated), ...Object.keys(defaults)]);
    for (const hook of hooks) {
      const seen = new Set<string>();
      const groups: [string, JsonObject[]][] = [["Scope", array(configured[hook])], ["Commission rule", array(generated[hook])], ["Automatic setup", array(object(defaults)[hook])]];
      for (const [source, bindings] of groups) for (const [index, binding] of bindings.entries()) {
        const id = text(binding.id);
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const automation = text(binding.automation);
        const meta = actionById.get(automation);
        // The engine prefers a lifecycle alias over a raw event binding.
        const event = eventForHook(hook, isPlan);
        const alias = `on${event.split(".").pop()!.replace(/(^|_)([a-z])/g, (_m, _p, c) => c.toUpperCase())}`;
        const shadowed = !hook.startsWith("on") && [configured, generated, defaults].some((group) => Array.isArray(object(group)[alias]));
        add(event, {
          id:`${location}:${hook}:${source}:${id || index}`, kind:"action", source, node_id:nodeId, location,
          label:text(binding.explainer) || meta?.label || eventWords(automation),
          description:meta?.description || (meta ? "No description is registered. Inspect its parameters for the configured behavior." : "This action is referenced by the scope but has no registered handler."),
          when:hook.startsWith("on") ? `When ${isPlan ? "the scope" : `“${title}”`} ${hookTiming[hook] || eventWords(hook.replace(/^on/, "")).toLowerCase()}` : `When this event targets ${isPlan ? "this scope instance" : `“${title}”`}`,
          automation, hook, registered:!!meta, enabled:binding.enabled !== false && !shadowed,
          conditions:object(binding.conditions), input:object(binding.input), input_help:meta?.input || {},
          continue_on_error:binding.continue_on_error === true,
          note:shadowed ? "The lifecycle hook takes precedence over this raw event binding." : source === "Commission rule" ? "Compiled from commission settings; attached for signed-proposal scopes and during commission reconciliation." : "",
          source_path:source === "Scope" ? [...pointer, "automation_bindings", hook, index] : null,
          raw:binding
        });
      }
    }
    if (!isPlan) {
      for (const [index, trigger] of array(container.external_triggers).entries()) {
        const event = text(trigger.event);
        add(event, { id:`${location}:trigger:${text(trigger.id) || index}`, kind:"transition", source:"Scope", node_id:nodeId, location,
          label:`Mark “${title}” ${text(trigger.transition || "completed")}`, description:text(trigger.explainer) || "Changes this work item's state when the event and all conditions match.",
          when:"When this event occurs on an eligible open work item", enabled:!event.startsWith("work."), conditions:object(trigger.conditions), input:{},
          next_event:`work.node.${trigger.transition === "active" ? "started" : text(trigger.transition || "completed")}`,
          source_path:[...pointer, "external_triggers", index],
          note:event.startsWith("work.") ? "Work events are excluded from external triggers by the engine." : "Only open work items with matching project, plan and scope targeting are eligible. The engine does not check an enabled flag on external triggers.", raw:trigger });
      }
      for (const [index, timer] of array(container.timers).entries()) add("work.node.timer", {
        id:`${location}:timer:${text(timer.id) || index}`, kind:"timer", source:"Scope", node_id:nodeId, location,
        label:`Timer for “${title}”`, description:text(timer.explainer) || `Fires once, ${Math.max(0, Number(timer.offset_minutes) || 0)} minutes after ${text(timer.anchor || "ready")}.`,
        when:"When the timer's anchor time and offset are reached", enabled:true, conditions:{}, input:timer, raw:timer,
        note:"Produces this event; actions run through this item's timer hook."
      });
    }
    const childKey = isPlan ? "root_nodes" : "children";
    array(container[childKey]).forEach((child, index) => visit(child, [...path, title], false, [...pointer, childKey, index]));
  };
  visit(object(definition.work_plan), [], true, ["work_plan"]);
  for (const [index, rule] of organizationRules.entries()) {
    const automation = text(rule.automation);
    const meta = actionById.get(automation);
    add(text(rule.event) || (object(rule.schedule).cron ? "time.cron" : ""), {
      id:`organization:${text(rule.id) || index}`, kind:"action", source:"Organization rule", location:"All scopes · organization policy", node_id:"",
      label:text(rule.title || rule.explainer) || meta?.label || eventWords(automation), description:meta?.description || text(rule.explainer),
      when:object(rule.schedule).cron ? "When this rule's schedule runs" : "When the event and all conditions match",
      automation, registered:!!meta, enabled:rule.enabled !== false, conditions:object(rule.conditions), input:object(rule.input), input_help:meta?.input || {},
      continue_on_error:rule.continue_on_error === true, note:"Evaluated before scope triggers and bindings; conditions determine whether it applies to a project.", raw:rule
    });
  }
  const priority = (entry: JsonObject) => entry.source === "Organization rule" ? 0 : entry.kind === "transition" ? 1 : 2;
  for (const event of events.values()) event.connections.sort((a, b) => priority(a) - priority(b));
  return { events:[...events.values()], actions };
}
