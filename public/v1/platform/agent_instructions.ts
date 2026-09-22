// Agent instruction registry — apps publish natural-language usage guidance
// for AI agents instead of every agent hardcoding knowledge about every app.
//
// A module registers a section (optionally gated by a capability key and
// optionally data-driven via a function that derives org-specific guidance —
// e.g. scheduling publishes the branch's sales-appointment hours). Agents call
// buildAgentInstructions(orgId, branchId) and get the assembled context for
// whatever is enabled on that org. Adding a new app never requires touching an
// agent: register a section here from the app module and every consumer picks
// it up.

import { effectiveCapabilities } from "./capabilities.js";

export type AgentInstructionContext = {
  organizationId: string;
  branchId: string;
};

export type AgentInstructionSection = {
  /** Stable id, kebab or dot case (e.g. "scheduling", "comms.email"). */
  id: string;
  /** Section heading shown to the model. */
  title: string;
  /** Capability key that must be effective for the org (omit = always on). */
  capability?: string;
  /** Registration order tiebreaker; lower renders first. */
  order?: number;
  /** Static text, or a derivation from org/branch data. */
  instructions: string | ((ctx: AgentInstructionContext) => string | Promise<string>);
};

const sections = new Map<string, AgentInstructionSection>();

export function registerAgentInstructions(section: AgentInstructionSection) {
  if (!section.id || !section.title) {
    throw new Error("agent instruction sections require id and title");
  }
  sections.set(section.id, section);
}

export function listAgentInstructionSections() {
  return [...sections.values()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

/**
 * Assemble the instruction context for one org: capability-filtered, resolved,
 * markdown-headed sections. Failures in a single section never break the
 * assembly — agents should degrade, not crash, when one app misbehaves.
 */
export async function buildAgentInstructions(organizationId: string, branchId = "default") {
  let effective: Record<string, unknown> = {};
  try {
    const resolution = await effectiveCapabilities(organizationId);
    effective = resolution.effectiveByKey as Record<string, unknown>;
  } catch {
    // No capability data (fresh org, tests) — include only ungated sections.
  }
  const ctx: AgentInstructionContext = { organizationId, branchId: branchId || "default" };
  const parts: string[] = [];
  for (const section of listAgentInstructionSections()) {
    if (section.capability && effective[section.capability] !== true) continue;
    try {
      const text = typeof section.instructions === "function"
        ? String(await section.instructions(ctx) ?? "")
        : section.instructions;
      const trimmed = text.trim();
      if (trimmed) parts.push(`### ${section.title}\n${trimmed}`);
    } catch (error) {
      console.error(`agent instruction section ${section.id} failed`, error);
    }
  }
  if (!parts.length) return "";
  return `## App capabilities available to you\nEach section below is published by an app on this platform and explains how to use it correctly.\n\n${parts.join("\n\n")}`;
}
