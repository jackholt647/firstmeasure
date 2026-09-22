/**
 * Which portal tabs are RELEVANT to a project.
 *
 * Contract: docs/customer-portal-v2-spec.md §2.
 *
 * THE PROBLEM. Showing a tab only when its data already exists is too late:
 * a roofing job whose scope will ask for a punch list next week should show the
 * Punch List tab now, so the customer knows it is coming. Showing every tab
 * always is too much: an HVAC maintenance package will NEVER have a punch list,
 * and a dead tab is worse than no tab.
 *
 * THE ANSWER. A tab is relevant when either:
 *   1. it has data right now (resources), or
 *   2. the project's SCOPE says it will (the scope template binds the
 *      automation that produces it, or names the tab outright).
 *
 * Both signals are data-driven. Nothing here hardcodes "roofing has punch
 * lists" — a scope set that binds `punchlist.request.v1` advertises the tab by
 * doing so, and one that does not, does not.
 *
 * A scope template can also be explicit, which wins over inference:
 *
 *   definition.portal_tabs = { show: ["punch_lists"], hide: ["proposals"] }
 */

import { listPlanRecords } from "../work/storage.js";
import type { JsonObject } from "./storage.js";

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

/**
 * Per-tab relevance signals.
 *
 * `resources` — payload resource keys that, when non-empty, prove the tab is
 *               live right now.
 * `automations` — work automations whose presence anywhere in the project's
 *               scope means this tab WILL become relevant.
 * `always`    — tabs that are part of the portal's basic shape and are not
 *               conditional on scope at all.
 */
const TAB_SIGNALS: Record<string, { resources?: string[]; automations?: string[]; always?: boolean }> = {
  // The spine of the portal. A customer always has a home, a schedule, photos,
  // and a way to see money — these are not scope-conditional.
  summary: { always: true },
  home: { always: true },
  schedule: { always: true },
  photos: { always: true },
  payments: { always: true },

  // Legacy-proposal retirement step 1 (the sweep this comment always promised):
  // the tab now appears only when legacy proposals actually exist or the scope
  // will produce them. Document-engine proposals render through their own
  // `documents` presentation groups, so orgs on the new engine no longer see a
  // dead legacy Proposals tab alongside them.
  proposals: { resources: ["proposals"], automations: ["scopes.activateFromProposal.v1"] },

  // Genuinely conditional surfaces.
  documents: { resources: ["documents"], automations: ["documents.issue.v1"] },
  checklists: { resources: ["checklists"] },
  punch_lists: { resources: ["punch_lists"], automations: ["punchlist.request.v1"] }
};

export type TabRelevance = {
  /** Tab ids the project's scope explicitly asked to show. */
  show: Set<string>;
  /** Tab ids the project's scope explicitly asked to hide — wins over everything. */
  hide: Set<string>;
  /** Automation ids bound anywhere in the project's scope. */
  automations: Set<string>;
};

/**
 * Collect the automation ids and explicit tab declarations from every scope
 * template driving this project.
 *
 * Never throws: a project whose scope cannot be read falls back to
 * resource-only relevance, which is the pre-scope behavior.
 */
export async function projectTabRelevance(orgId: string, projectId: string): Promise<TabRelevance> {
  const relevance: TabRelevance = { show: new Set(), hide: new Set(), automations: new Set() };
  if (!orgId || !projectId) return relevance;

  let plans: JsonObject[] = [];
  try {
    plans = (await listPlanRecords(orgId, { project_id: projectId })).map(asObject);
  } catch {
    return relevance;
  }
  if (!plans.length) return relevance;

  type TemplateReader = (orgId: string, branchId: string, templateId: string) => unknown;
  type VersionReader = (orgId: string, branchId: string, templateId: string, version?: number) => unknown;
  let readScopeTemplate: TemplateReader | null = null;
  let readScopeTemplateVersion: VersionReader | null = null;
  try {
    const storage = await import("../scopes/storage.js");
    readScopeTemplate = storage.readScopeTemplate as unknown as TemplateReader;
    readScopeTemplateVersion = storage.readScopeTemplateVersion as unknown as VersionReader;
  } catch {
    return relevance;
  }

  const seen = new Set<string>();
  for (const plan of plans) {
    const templateId = cleanText(plan.template_id);
    if (!templateId) continue;
    const branchId = cleanText(plan.branch_id) || "default";
    const version = Number(plan.template_version || 0);
    const key = `${branchId}:${templateId}:${version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let definition: JsonObject = {};
    try {
      const frozen = version ? asObject(readScopeTemplateVersion?.(orgId, branchId, templateId, version)) : {};
      definition = Object.keys(asObject(frozen.definition)).length
        ? asObject(frozen.definition)
        : asObject(asObject(readScopeTemplate?.(orgId, branchId, templateId)).definition);
    } catch {
      definition = {};
    }
    if (!Object.keys(definition).length) continue;

    collectFromDefinition(definition, relevance);
  }
  return relevance;
}

/** Walk a scope definition for automation bindings and explicit tab declarations. */
function collectFromDefinition(definition: JsonObject, relevance: TabRelevance) {
  const portalTabs = asObject(definition.portal_tabs);
  for (const id of asArray(portalTabs.show).map(cleanText).filter(Boolean)) relevance.show.add(id);
  for (const id of asArray(portalTabs.hide).map(cleanText).filter(Boolean)) relevance.hide.add(id);

  // Bindings live on the definition root and on every node, keyed by trigger.
  const visit = (value: unknown, depth = 0) => {
    if (depth > 8 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
      return;
    }
    const node = value as JsonObject;
    const bindings = asObject(node.automation_bindings);
    for (const list of Object.values(bindings)) {
      for (const bindingValue of asArray(list)) {
        const automation = cleanText(asObject(bindingValue).automation);
        if (automation) relevance.automations.add(automation);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "automation_bindings") continue;
      visit(child, depth + 1);
    }
  };
  visit(definition);
}

/**
 * Is this tab relevant to the project?
 *
 * Order: explicit hide > explicit show > data present > scope will produce it >
 * unknown tabs default to visible (a tab we have no signal for is not one we
 * should be silently swallowing).
 */
export function tabIsRelevant(tabId: string, resources: JsonObject, relevance: TabRelevance | null): boolean {
  const id = cleanText(tabId);
  if (relevance?.hide.has(id)) return false;
  if (relevance?.show.has(id)) return true;

  const signals = TAB_SIGNALS[id];
  if (!signals) return true;
  if (signals.always) return true;

  for (const key of signals.resources || []) {
    if (asArray(resources[key]).length) return true;
  }
  for (const automation of signals.automations || []) {
    if (relevance?.automations.has(automation)) return true;
  }
  return false;
}

/** Exposed for tests + the Web Editor's tab-config UI. */
export function portalTabSignals() {
  return TAB_SIGNALS;
}
