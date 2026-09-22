// Agents that participate in the channels system as pseudo-users: they can
// be @-mentioned, DMed, and post as themselves. The channels user directory
// merges these profiles in, so agent authors and DM titles resolve like any
// teammate. Kept in its own module (registry/settings only) so both the
// channels service and the agents API can import it without cycles.

import { agentDefinition } from "./registry.js";
import { loadAgentSettings } from "./settings.js";
import { cleanText } from "./util.js";

/** The assistant's channels identity. Ids are stable: `agent_<agent id>`. */
export const CHANNEL_AGENT_IDS = ["assistant"] as const;

export function channelUserIdForAgent(agentId: string) {
  return `agent_${cleanText(agentId)}`;
}

export function agentIdForChannelUser(channelUserId: string): string | null {
  const id = cleanText(channelUserId);
  if (!id.startsWith("agent_")) return null;
  const agentId = id.slice("agent_".length);
  return agentDefinition(agentId) ? agentId : null;
}

export function isAgentChannelUser(channelUserId: string) {
  return agentIdForChannelUser(channelUserId) !== null;
}

export type AgentChannelParticipant = {
  id: string;        // channels user id (agent_assistant)
  agent_id: string;  // framework agent id (assistant)
  name: string;
  email: string;
  avatar: string;
  kind: "agent";
  enabled: boolean;
};

/**
 * The channel-participant profiles for an org (name comes from the agent's
 * settings). Disabled agents are excluded so they drop out of pickers and
 * stop responding, but historical messages still render via the directory
 * fallback in listAllParticipants.
 */
export async function agentChannelParticipants(orgId: string, branchId = "default", options: { includeDisabled?: boolean } = {}): Promise<AgentChannelParticipant[]> {
  const participants: AgentChannelParticipant[] = [];
  for (const agentId of CHANNEL_AGENT_IDS) {
    const definition = agentDefinition(agentId);
    if (!definition) continue;
    const settings = await loadAgentSettings(agentId, orgId, branchId).catch(() => null);
    const enabled = settings ? settings.enabled !== false : true;
    if (!enabled && !options.includeDisabled) continue;
    participants.push({
      id: channelUserIdForAgent(agentId),
      agent_id: agentId,
      name: cleanText((settings as Record<string, unknown> | null)?.assistant_name || (settings as Record<string, unknown> | null)?.display_name) || definition.title,
      email: "",
      avatar: "",
      kind: "agent",
      enabled
    });
  }
  return participants;
}
