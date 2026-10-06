import type { JsonObject } from "./storage.js";
import type { WorkDataResolver } from "./context.js";
import { publishWorkAutomation } from "../platform/publication/work-actions.js";
import type { Effect, JsonSchema } from "../platform/publication/contracts.js";
import { actionCatalogEntry } from "./automations/catalog.js";

export type WorkAutomationServices = {
  patchProject: (patch: JsonObject) => Promise<JsonObject>;
  createScheduleRequirement: (input: JsonObject) => Promise<JsonObject>;
  createNotification: (input: JsonObject) => Promise<JsonObject>;
  transitionNode: (nodeId: string, status: string, input?: JsonObject) => Promise<JsonObject>;
  emit: (type: string, payload?: JsonObject, context?: JsonObject) => Promise<JsonObject>;
};

export type WorkAutomationContext = {
  event: JsonObject;
  plan: JsonObject;
  node: JsonObject;
  project: JsonObject;
  scope: JsonObject;
  proposal: JsonObject;
  now: string;
  idempotencyKey: string;
  // Lazy read access to platform data (organization, users, pricebook,
  // scopes, branch modules, money, sibling work instances, ...). Namespaces
  // are provider-registered — see work/context.ts.
  data: WorkDataResolver;
  services: WorkAutomationServices;
};

export type WorkAutomationHandler = (context: WorkAutomationContext, input: JsonObject) => Promise<unknown> | unknown;

export type WorkAutomationMeta = {
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  version?: string;
  implementation?: string;
  effect?: Effect;
  // Human/agent-facing documentation: what the automation does and the input
  // fields it understands. Shown to the scope-manager agent and (eventually)
  // the automation editor UI.
  description?: string;
  input?: Record<string, string>;
};

const handlers = new Map<string, WorkAutomationHandler>();
const metadata = new Map<string, WorkAutomationMeta>();

export function registerWorkAutomation(id: string, handler: WorkAutomationHandler, meta: WorkAutomationMeta = {}) {
  const key = String(id || "").trim();
  if (!key) throw new Error("A work automation id is required.");
  if (handlers.has(key)) throw new Error(`Work automation '${key}' is already registered.`);
  handlers.set(key, publishWorkAutomation(key, handler, meta));
  metadata.set(key, meta);
}

export function workAutomation(id: string) {
  return handlers.get(String(id || "").trim()) || null;
}

export function hasWorkAutomation(id: string) {
  return handlers.has(String(id || "").trim());
}

export function listWorkAutomations() {
  return [...handlers.keys()].sort();
}

export function listWorkAutomationDefinitions() {
  // Each definition carries its authoring contract (title, category and a
  // typed input schema) from automations/catalog.ts alongside the handler's
  // own documentation.
  return [...handlers.keys()].sort().map((id) => {
    const meta = metadata.get(id) || {};
    const entry = actionCatalogEntry(id);
    return {
      id, ...meta,
      title: entry?.title || "",
      category: entry?.category || id.split(".")[0] || "",
      internal: entry?.internal === true,
      input_schema: entry?.input_schema || meta.inputSchema || { type: "object", additionalProperties: true }
    };
  });
}

