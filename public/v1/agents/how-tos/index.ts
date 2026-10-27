// The agent how-to index. One file per entry under ./entries; list each one
// here. Bodies are served by platform_how_to_search / platform_how_to_read in
// ../platform_tools.ts and never placed in a system prompt.

import type { HowToEntry, HowToStep } from "./types.js";
import { payForProjectRole } from "./entries/pay_for_project_role.js";
import { improveGenerationFromHistory } from "./entries/improve_generation_from_history.js";
import { setCompanyProfile } from "./entries/set_company_profile.js";

export type { HowToEntry, HowToRefs, HowToStep } from "./types.js";

export const HOW_TO_ENTRIES: HowToEntry[] = [
  payForProjectRole,
  improveGenerationFromHistory,
  setCompanyProfile
];

const PLANNED_WARNING = "NOT BUILT YET. Do not attempt this step, do not substitute another feature for it, and tell the user it is not available yet.";

const searchText = (entry: HowToEntry) => [entry.id, entry.title, entry.use_when, ...(entry.keywords || []), ...entry.steps.map((step) => step.title)].join(" ").toLowerCase();

/** Entries whose id, title, use-when line, keywords or step titles contain every word of the query. */
export function searchHowTos(query = "", entries: HowToEntry[] = HOW_TO_ENTRIES) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  return entries.filter((entry) => words.every((word) => searchText(entry).includes(word)));
}

export function howToEntry(id: string, entries: HowToEntry[] = HOW_TO_ENTRIES) {
  return entries.find((entry) => entry.id === String(id || "").trim()) || null;
}

export function howToSummary(entry: HowToEntry) {
  const planned = entry.steps.filter((step) => step.planned).length;
  return { id: entry.id, title: entry.title, use_when: entry.use_when, steps: entry.steps.length, ...(planned ? { planned_steps: planned } : {}) };
}

/** A step as an agent sees it: numbered, with a planned step labelled unavailable ahead of its text. */
export function presentHowToStep(step: HowToStep, index: number) {
  return {
    step: index + 1,
    title: step.title,
    ...(step.planned ? { status: "planned", unavailable: true, warning: PLANNED_WARNING, missing: step.planned } : { status: "available" }),
    detail: step.detail,
    ...(step.refs ? { refs: step.refs } : {})
  };
}

/** The only how-to text that belongs in a system prompt: one instruction and a line per entry. */
export function howToPromptIndex(entries: HowToEntry[] = HOW_TO_ENTRIES) {
  if (!entries.length) return "";
  return [
    "## How-to index",
    "These business tasks have a checked recipe. Before attempting one, call platform_how_to_read with its id and follow the steps; call platform_how_to_search when a request might match one. A step marked planned is not built: say so instead of improvising.",
    ...entries.map((entry) => `- ${entry.id}: ${entry.title}`)
  ].join("\n");
}
