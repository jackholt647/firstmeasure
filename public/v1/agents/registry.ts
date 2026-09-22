// The agent registry: modules declare agents; the runtime and the generic
// /v1/agents API read them from here. Mirrors the capability registry idiom —
// definitions register at import time and are validated immediately.

import type { AgentDefinition } from "./types.js";
import { cleanText } from "./util.js";

const registryById = new Map<string, AgentDefinition>();

export function registerAgent(definition: AgentDefinition) {
  const id = cleanText(definition.id);
  if (!/^[a-z0-9_]+$/.test(id)) {
    throw new Error(`Agent id '${definition.id}' must be lowercase snake_case.`);
  }
  if (registryById.has(id)) {
    throw new Error(`Agent '${id}' is already registered.`);
  }
  if (!cleanText(definition.title)) throw new Error(`Agent '${id}' needs a title.`);
  if (typeof definition.model !== "function") throw new Error(`Agent '${id}' needs a model() resolver.`);
  if (typeof definition.systemPrompt !== "function") throw new Error(`Agent '${id}' needs a systemPrompt builder.`);
  if (!definition.tools || (Array.isArray(definition.tools) && !definition.tools.length)) {
    throw new Error(`Agent '${id}' needs at least one tool.`);
  }
  if (!definition.settings || typeof definition.settings.defaults !== "function" || typeof definition.settings.normalize !== "function") {
    throw new Error(`Agent '${id}' needs a settings adapter with defaults() and normalize().`);
  }
  registryById.set(id, { ...definition, id });
  return registryById.get(id) as AgentDefinition;
}

export function agentDefinition(agentId: string): AgentDefinition | null {
  return registryById.get(cleanText(agentId)) ?? null;
}

export function requireAgentDefinition(agentId: string): AgentDefinition {
  const definition = agentDefinition(agentId);
  if (!definition) throw new Error(`Unknown agent '${agentId}'.`);
  return definition;
}

export function listAgentDefinitions(): AgentDefinition[] {
  return [...registryById.values()];
}
