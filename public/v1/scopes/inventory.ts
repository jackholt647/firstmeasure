// Automation inventory: the customer-facing, natural-language view of a scope
// template's automations. Every external trigger, automation binding, and
// timer in the template maps to one inventory entry with a stable key. The
// `explainer` field is the natural-language description customers see; an
// entry with no explainer is hidden unless `customer_visible: true` is set
// explicitly, and an entry with an explainer can be hidden with
// `customer_visible: false`. Raw event names, automation ids, and JSON never
// reach the customer — only explainers do.

import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export type AutomationInventoryEntry = {
  key: string;
  kind: "external_trigger" | "binding" | "timer";
  node_id: string;
  node_title: string;
  hook: string;
  event: string;
  automation: string;
  explainer: string;
  customer_visible: boolean;
  enabled: boolean;
};

function entryVisible(entry: { explainer: string; customer_visible?: unknown }) {
  if (entry.customer_visible === false) return false;
  if (entry.customer_visible === true) return true;
  return !!entry.explainer;
}

type Visit = {
  nodeId: string;
  nodeTitle: string;
  container: JsonObject;
};

function walkNodes(nodes: unknown, visit: (node: JsonObject) => void) {
  for (const value of asArray(nodes)) {
    const node = asObject(value);
    visit(node);
    walkNodes(node.children, visit);
  }
}

function collectFrom({ nodeId, nodeTitle, container }: Visit, entries: AutomationInventoryEntry[]) {
  asArray(container.external_triggers).forEach((value, index) => {
    const trigger = asObject(value);
    entries.push({
      key: `node:${nodeId}:trigger:${cleanText(trigger.id) || index}`,
      kind: "external_trigger",
      node_id: nodeId,
      node_title: nodeTitle,
      hook: cleanText(trigger.transition || "completed"),
      event: cleanText(trigger.event),
      automation: "",
      explainer: cleanText(trigger.explainer),
      customer_visible: entryVisible({ explainer: cleanText(trigger.explainer), customer_visible: trigger.customer_visible }),
      enabled: trigger.enabled !== false
    });
  });
  for (const [hook, bindings] of Object.entries(asObject(container.automation_bindings))) {
    asArray(bindings).forEach((value, index) => {
      const binding = asObject(value);
      entries.push({
        key: `node:${nodeId}:binding:${hook}:${cleanText(binding.id) || index}`,
        kind: "binding",
        node_id: nodeId,
        node_title: nodeTitle,
        hook,
        event: hook,
        automation: cleanText(binding.automation),
        explainer: cleanText(binding.explainer),
        customer_visible: entryVisible({ explainer: cleanText(binding.explainer), customer_visible: binding.customer_visible }),
        enabled: binding.enabled !== false
      });
    });
  }
  asArray(container.timers).forEach((value, index) => {
    const timer = asObject(value);
    entries.push({
      key: `node:${nodeId}:timer:${cleanText(timer.id) || index}`,
      kind: "timer",
      node_id: nodeId,
      node_title: nodeTitle,
      hook: "onTimer",
      event: "work.node.timer",
      automation: "",
      explainer: cleanText(timer.explainer),
      customer_visible: entryVisible({ explainer: cleanText(timer.explainer), customer_visible: timer.customer_visible }),
      enabled: timer.enabled !== false
    });
  });
}

// Extracts the full inventory from a template definition. Plan-level bindings
// use the pseudo node id "plan".
export function extractAutomationInventory(definitionValue: JsonObject, options: { include_hidden?: boolean } = {}) {
  const definition = asObject(definitionValue);
  const workPlan = asObject(definition.work_plan);
  const entries: AutomationInventoryEntry[] = [];
  collectFrom({ nodeId: "plan", nodeTitle: cleanText(workPlan.title || definition.name), container: workPlan }, entries);
  walkNodes(workPlan.root_nodes, (node) => {
    collectFrom({ nodeId: cleanText(node.id), nodeTitle: cleanText(node.title), container: node }, entries);
  });
  return options.include_hidden === true ? entries : entries.filter((entry) => entry.customer_visible);
}

// Applies an explainer/visibility patch to the entry addressed by `key`,
// returning a NEW definition (the caller saves it as a new template version).
export function applyExplainerPatch(definitionValue: JsonObject, key: string, patch: { explainer?: string; customer_visible?: boolean }) {
  const definition = JSON.parse(JSON.stringify(asObject(definitionValue))) as JsonObject;
  const workPlan = asObject(definition.work_plan);
  let applied = false;

  const applyTo = (nodeId: string, container: JsonObject) => {
    asArray(container.external_triggers).forEach((value, index) => {
      const trigger = asObject(value);
      if (`node:${nodeId}:trigger:${cleanText(trigger.id) || index}` !== key) return;
      if (patch.explainer !== undefined) trigger.explainer = cleanText(patch.explainer);
      if (patch.customer_visible !== undefined) trigger.customer_visible = patch.customer_visible === true;
      (container.external_triggers as unknown[])[index] = trigger;
      applied = true;
    });
    for (const [hook, bindings] of Object.entries(asObject(container.automation_bindings))) {
      asArray(bindings).forEach((value, index) => {
        const binding = asObject(value);
        if (`node:${nodeId}:binding:${hook}:${cleanText(binding.id) || index}` !== key) return;
        if (patch.explainer !== undefined) binding.explainer = cleanText(patch.explainer);
        if (patch.customer_visible !== undefined) binding.customer_visible = patch.customer_visible === true;
        (asObject(container.automation_bindings)[hook] as unknown[])[index] = binding;
        applied = true;
      });
    }
    asArray(container.timers).forEach((value, index) => {
      const timer = asObject(value);
      if (`node:${nodeId}:timer:${cleanText(timer.id) || index}` !== key) return;
      if (patch.explainer !== undefined) timer.explainer = cleanText(patch.explainer);
      if (patch.customer_visible !== undefined) timer.customer_visible = patch.customer_visible === true;
      (container.timers as unknown[])[index] = timer;
      applied = true;
    });
  };

  applyTo("plan", workPlan);
  walkNodes(workPlan.root_nodes, (node) => applyTo(cleanText(node.id), node));
  if (!applied) throw badRequest("automation_entry_not_found", `No automation entry matches key '${key}'.`);
  return definition;
}
