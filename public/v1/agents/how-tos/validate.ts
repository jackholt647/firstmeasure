// Checks how-to entries against the live registries. Used by
// tests/agent-how-to-index.test.ts; callers must have loaded the modules that
// register agents (building the app does).

import { agentDefinition } from "../registry.js";
import { platformAgentTools } from "../platform_tools.js";
import type { AgentRun, AgentTool } from "../types.js";
import { types as customFieldTypes } from "../../custom_fields/contracts.js";
import { initializePublication } from "../../platform/publication/bootstrap.js";
import { describeAction } from "../../platform/publication/actions.js";
import { describeDataProvider } from "../../platform/publication/providers.js";
import { registerBuiltinWorkAutomations } from "../../work/automations/builtins.js";
import { ACTION_CATALOG } from "../../work/automations/catalog.js";
import { listWorkEventDefinitions } from "../../work/events.js";
import { hasWorkAutomation } from "../../work/registry.js";
import { HOW_TO_ENTRIES } from "./index.js";
import type { HowToEntry, HowToRefs } from "./types.js";

export const HOW_TO_LIMITS = { steps: 8, title: 90, useWhen: 220, stepTitle: 70, stepDetail: 900, note: 320, notes: 5 };

const REF_KINDS: (keyof HowToRefs)[] = ["automations", "events", "data", "actions", "field_types", "tools"];

function agentTools(agentId: string): AgentTool[] {
  const tools = agentDefinition(agentId)?.tools;
  if (!tools) return [];
  // A per-run tool builder is asked for the tools of an empty turn.
  return typeof tools === "function" ? tools({ agentId, settings: {}, input: {}, scratch: {} } as unknown as AgentRun) : tools;
}

function registered(kind: keyof HowToRefs, id: string): boolean {
  if (kind === "automations") return hasWorkAutomation(id) && !!ACTION_CATALOG[id];
  if (kind === "events") return listWorkEventDefinitions().some((event) => event.name === id);
  if (kind === "actions") return !!describeAction(id);
  if (kind === "field_types") return customFieldTypes.includes(id);
  if (kind === "data") {
    const dot = id.lastIndexOf(".");
    return dot > 0 && !!describeDataProvider(id.slice(0, dot))?.exports[id.slice(dot + 1)];
  }
  const dot = id.indexOf(".");
  return dot < 0 ? platformAgentTools.some((tool) => tool.name === id) : agentTools(id.slice(0, dot)).some((tool) => tool.name === id.slice(dot + 1));
}

/** Every reason an entry is malformed or names something that is not registered. Empty means sound. */
export function howToProblems(entries: HowToEntry[] = HOW_TO_ENTRIES): string[] {
  registerBuiltinWorkAutomations();
  initializePublication();
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const at = `how-to '${entry.id}'`;
    const copy: string[] = [entry.title, entry.use_when, ...(entry.notes || [])];
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(entry.id || "")) problems.push(`${at}: the id must be snake_case, 3 to 64 characters`);
    if (seen.has(entry.id)) problems.push(`${at}: the id is used twice`);
    seen.add(entry.id);
    if (!entry.title?.trim() || entry.title.length > HOW_TO_LIMITS.title) problems.push(`${at}: needs a title of at most ${HOW_TO_LIMITS.title} characters`);
    if (!entry.use_when?.trim() || entry.use_when.length > HOW_TO_LIMITS.useWhen) problems.push(`${at}: needs a use_when line of at most ${HOW_TO_LIMITS.useWhen} characters`);
    if (!entry.steps?.length || entry.steps.length > HOW_TO_LIMITS.steps) problems.push(`${at}: needs 1 to ${HOW_TO_LIMITS.steps} steps`);
    if ((entry.notes || []).length > HOW_TO_LIMITS.notes || (entry.notes || []).some((note) => !note.trim() || note.length > HOW_TO_LIMITS.note)) problems.push(`${at}: at most ${HOW_TO_LIMITS.notes} notes of at most ${HOW_TO_LIMITS.note} characters`);
    for (const [index, step] of (entry.steps || []).entries()) {
      const where = `${at} step ${index + 1}`;
      copy.push(step.title, step.detail, step.planned || "");
      if (!step.title?.trim() || step.title.length > HOW_TO_LIMITS.stepTitle) problems.push(`${where}: needs a title of at most ${HOW_TO_LIMITS.stepTitle} characters`);
      if (!step.detail?.trim() || step.detail.length > HOW_TO_LIMITS.stepDetail) problems.push(`${where}: needs detail of at most ${HOW_TO_LIMITS.stepDetail} characters`);
      if (step.planned !== undefined && !step.planned.trim()) problems.push(`${where}: a planned step must say what is missing`);
      for (const kind of Object.keys(step.refs || {}) as (keyof HowToRefs)[]) {
        if (!REF_KINDS.includes(kind)) { problems.push(`${where}: unknown reference kind '${kind}'`); continue; }
        // A planned step may name ids that do not exist yet.
        if (step.planned !== undefined) continue;
        for (const id of step.refs?.[kind] || []) if (!registered(kind, id)) problems.push(`${where}: ${kind} '${id}' is not registered`);
      }
    }
    // docs/architecture/assignees.md: what a group is called comes from terminology.
    if (copy.some((text) => /\bcrews?\b/i.test(text))) problems.push(`${at}: say "assignee", not "crew"`);
  }
  return problems;
}
