// Centralized agent settings. By default every agent's settings live in one
// branch module (`agent_settings`, keyed by agent id). Agents whose settings
// historically live elsewhere (comms, live chat) plug in load/save adapters
// on their definition instead — the generic API and settings UI don't care.

import { readBranchModule, saveBranchModule } from "../platform/storage.js";
import { requireAgentDefinition } from "./registry.js";
import { asObject, cleanText, type JsonObject } from "./util.js";

const AGENT_SETTINGS_MODULE_ID = "agent_settings";

/**
 * The common core every agent's normalized settings must include. Adapters
 * may extend freely; normalize() should fold these in via normalizeCommonCore.
 */
export type AgentCommonSettings = {
  enabled: boolean;
  display_name: string;
  custom_instructions: string;
};

export function normalizeCommonCore(raw: unknown, defaults: { enabled?: boolean; display_name?: string; custom_instructions?: string } = {}): AgentCommonSettings {
  const value = asObject(raw);
  const enabled = value.enabled === true || value.enabled === false ? value.enabled : defaults.enabled !== false;
  return {
    enabled,
    display_name: cleanText(value.display_name ?? value.assistant_name ?? value.agent_name).slice(0, 80) || cleanText(defaults.display_name) || "Assistant",
    custom_instructions: String(value.custom_instructions ?? "").slice(0, 8_000) || String(defaults.custom_instructions ?? "")
  };
}

async function readSharedModule(orgId: string, branchId: string): Promise<JsonObject> {
  try {
    const doc = await readBranchModule(orgId, branchId || "default", AGENT_SETTINGS_MODULE_ID);
    return asObject(asObject(doc).data);
  } catch {
    return {};
  }
}

export async function loadAgentSettings(agentId: string, orgId: string, branchId: string): Promise<JsonObject> {
  const definition = requireAgentDefinition(agentId);
  if (definition.settings.load) {
    const loaded = await definition.settings.load(orgId, branchId).catch(() => null);
    return definition.settings.normalize(loaded ?? definition.settings.defaults());
  }
  const all = await readSharedModule(orgId, branchId);
  return definition.settings.normalize(asObject(all[agentId]));
}

export async function saveAgentSettings(agentId: string, orgId: string, branchId: string, value: unknown): Promise<JsonObject> {
  const definition = requireAgentDefinition(agentId);
  const normalized = definition.settings.normalize(value);
  if (definition.settings.save) {
    return await definition.settings.save(orgId, branchId, normalized);
  }
  const all = await readSharedModule(orgId, branchId);
  await saveBranchModule(orgId, branchId || "default", AGENT_SETTINGS_MODULE_ID, {
    data: { ...all, [agentId]: normalized },
    metadata: { kind: "agent_settings", source: "agents_api" }
  }, { replace: true });
  return normalized;
}
