import type { PlatformAuthContext } from "../platform/auth.js";
import { explainConditions, type ConditionTrace } from "../work/conditions.js";
import { COMPANY_TYPES, INDUSTRY_SETS, OTHER_COMPANY_TYPE, companyType, industrySetsFor } from "../company-profile/catalog.js";
import type { ChooserContext } from "../guided-experiences/chooser.js";
import type { ExperienceDefinition } from "../guided-experiences/contracts.js";
import { listExperiences } from "../guided-experiences/registry.js";
import { allowed, chooserContext } from "../guided-experiences/service.js";
import { listSetupSteps, stepSatisfied, type SatisfactionCache, type SetupStepDefinition } from "../guided-experiences/setup-steps.js";
import { SETUP_STEP_EXPERIENCE_PREFIX } from "../guided-experiences/library-checks.js";

/**
 * What drives what in setup (GP-16), for the dev console's Setup diagram (docs/architecture/dev-console.md): every
 * setup step and guided experience as data, with what decides each one (the questions it asks first, the conditions on
 * its eligibility, its variants and its triggers, the follow-ups it plays), evaluated for a company type picked in the
 * console: this organization as it is, a type from the company-profile catalog, Other, or not answered yet. The
 * simulation replaces only the company facts in this organization's chooser context; whether its apps are on and the
 * caller's permissions stay real. A matrix answers the same for every company type at once. Reads only.
 */

/** The company facts conditions read, and the part of the company profile (a setup step's `satisfied.path`) each comes from. */
const COMPANY_FACTS: Record<string, string> = {
  "organization.company_type": "/answered/type",
  "organization.industry": "/answered/type",
  "organization.industry_sets": "/answered/type",
  "organization.services": "/answered/services"
};
/** The pseudo company types the console offers beside the catalog's. */
export const SHOWN_ACTUAL = "actual", SHOWN_NONE = "none";

type Rule = { field: string; operator: string; expected: unknown; actual: unknown; matched: boolean };
type Trace = { matched: boolean; match: "all" | "any"; rules: Rule[] };

/** A condition as the console draws it: its rules flattened (nested groups keep their own match in `rules`). */
function traceOf(conditions: unknown, context: ChooserContext): Trace | null {
  if (!conditions) return null;
  const trace = explainConditions(conditions, context as unknown as Record<string, unknown>);
  const rules: Rule[] = [];
  const walk = (node: ConditionTrace) => {
    if (node.kind === "rule") rules.push({ field: String(node.field || ""), operator: String(node.operator || "equals"), expected: node.expected ?? null, actual: node.actual ?? null, matched: node.matched });
    else for (const child of node.rules || []) walk(child);
  };
  walk(trace);
  return { matched: trace.matched, match: trace.match === "any" ? "any" : "all", rules };
}

/** The chooser context of this organization with its company facts replaced by a picked company type. */
export function simulatedContext(base: ChooserContext, shown: string): ChooserContext {
  if (!shown || shown === SHOWN_ACTUAL) return base;
  const type = companyType(shown);
  const facts = type
    ? { company_type: type.id, industry: type.industry, industry_sets: industrySetsFor(type.industry), services: [...type.services] }
    : { company_type: shown === OTHER_COMPANY_TYPE ? OTHER_COMPANY_TYPE : "", industry: "", industry_sets: [], services: [] };
  return { ...base, organization: { ...base.organization, ...facts } };
}

const companyOf = (context: ChooserContext) => {
  const org = context.organization;
  return { company_type: org.company_type || "", label: companyType(org.company_type || "")?.label.text || (org.company_type === OTHER_COMPANY_TYPE ? "Other" : ""), industry: org.industry || "", industry_sets: [...(org.industry_sets || [])], services: [...(org.services || [])] };
};

/** One experience as it plays for a context: offered or not (and why), its variants, pages and what it plays next. */
function evaluate(definition: ExperienceDefinition, context: ChooserContext, appsOn: boolean) {
  const when = traceOf(definition.eligibility.when, context);
  const variants = definition.variants.map((variant) => ({ variant, when: traceOf(variant.when, context) }));
  const eligible = variants.filter((entry) => entry.variant.weight > 0 && (!entry.when || entry.when.matched));
  const total = eligible.reduce((sum, entry) => sum + entry.variant.weight, 0);
  return {
    offered: appsOn && (!when || when.matched), apps_on: appsOn, fits: !when || when.matched, when,
    variants: variants.map(({ variant, when: trace }) => {
      const picked = eligible.some((entry) => entry.variant.id === variant.id);
      return {
        id: variant.id, weight: variant.weight, ...(variant.kind ? { kind: variant.kind } : {}), when: trace,
        chosen: picked, share: picked && total ? variant.weight / total : 0,
        steps: variant.steps?.length ? [...variant.steps] : definition.steps.map((step) => step.id),
        content: Object.keys(variant.content || {})
      };
    })
  };
}

const triggerLabel = (trigger: ExperienceDefinition["triggers"][number]) =>
  trigger.kind === "tab_opened" ? trigger.tab : trigger.kind === "before_action" ? trigger.action : trigger.kind === "after_experience" ? trigger.experience
    : trigger.kind === "workflow_opened" ? trigger.document_type : trigger.kind === "panel_opened" || trigger.kind === "panel_closed" ? trigger.panel : "";

/**
 * The setups a page opens: the Operations setup's cards name theirs (`options.setups[].experience`). With
 * `options.card` the page opens that one card at once and nothing else, so a setup made only of such pages is a
 * launcher, not a setup of its own: the Setup tag on a project's Operations tab turns the Equipment app on and plays
 * the equipment setup (operations.equipment.setup, FM-619). The diagram shows it on the setup it opens (GP-59).
 */
export function opensOf(step: unknown) {
  const options = ((step as { options?: Record<string, unknown> }).options || {}) as { setups?: unknown; card?: unknown };
  const named = (Array.isArray(options.setups) ? options.setups : []) as { id?: unknown; experience?: unknown }[];
  const card = typeof options.card === "string" ? options.card : "";
  const opens = named.filter((entry) => typeof entry?.experience === "string" && (!card || entry.id === card)).map((entry) => entry.experience as string);
  return { opens, only: !!card && opens.length === 1 };
}

/** The questions (setup steps) with how deep each sits in what requires what, so the diagram draws them left to right. */
function questionDepths(steps: SetupStepDefinition[]) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const of = (id: string, trail: string[]): number => {
    if (depth.has(id)) return depth.get(id)!;
    const step = byId.get(id);
    if (!step || trail.includes(id)) return 0;
    const value = step.requires.length ? 1 + Math.max(...step.requires.map((before) => of(before, [...trail, id]))) : 0;
    depth.set(id, value);
    return value;
  };
  for (const step of steps) of(step.id, []);
  return depth;
}

export async function setupDrivers(ctx: PlatformAuthContext, shownInput = "") {
  const shown = shownInput === OTHER_COMPANY_TYPE || shownInput === SHOWN_NONE || companyType(shownInput) ? shownInput : SHOWN_ACTUAL;
  const base = await chooserContext(ctx);
  const context = simulatedContext(base, shown);
  const steps = listSetupSteps();
  const experiences = listExperiences().filter((definition) => !definition.id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX));
  const depth = questionDepths(steps);
  const cache: SatisfactionCache = new Map();

  const questions = [];
  for (const step of steps) questions.push({
    id: step.id, title: step.title.text, scope: step.scope, requires: [...step.requires], depth: depth.get(step.id) || 0,
    answered: await stepSatisfied(ctx, step, cache), may_answer: await allowed(ctx, step.eligibility),
    sets: Object.entries(COMPANY_FACTS).filter(([, part]) => step.satisfied.provider === "company-profile" && step.satisfied.path === part).map(([field]) => field)
  });

  const appsOn = new Map<string, boolean>();
  for (const definition of experiences) appsOn.set(definition.id, await allowed(ctx, definition.eligibility));
  const setups = [];
  for (const definition of experiences) {
    const pages = [];
    for (const step of definition.steps) {
      const next = step.next as string | { branches: { when: unknown; to: string }[]; otherwise?: string } | undefined;
      pages.push({
        id: step.id, title: step.title.text,
        requires: [...((step as { requires?: string[] }).requires || [])],
        apps: [...(step.eligibility?.capabilities || [])], apps_on: await allowed(ctx, step.eligibility),
        next: typeof next === "string" ? next : null,
        branches: next && typeof next === "object" ? [
          ...next.branches.map((branch) => ({ to: branch.to, when: traceOf(branch.when, { ...context, selections: {} } as ChooserContext) })),
          ...(next.otherwise ? [{ to: next.otherwise, when: null }] : [])
        ] : []
      });
    }
    setups.push({
      id: definition.id, title: definition.title.text, kind: definition.kind, scope: definition.scope,
      group: definition.kind === "modal" || definition.kind === "agentic" ? "setup" : "tour",
      apps: { capabilities: [...definition.eligibility.capabilities], permissions: [...definition.eligibility.permissions] },
      requires: [...definition.requires],
      triggers: definition.triggers.map((trigger) => ({ kind: trigger.kind, on: triggerLabel(trigger), when: traceOf((trigger as { when?: unknown }).when, context) })),
      then: definition.completion.then.flatMap((entry) => "play" in entry ? [entry.play] : []),
      opens: [...new Set(definition.steps.flatMap((step) => opensOf(step).opens))],
      launcher: definition.steps.length > 0 && definition.steps.every((step) => opensOf(step).only),
      pages,
      ...evaluate(definition, context, appsOn.get(definition.id) || false)
    });
  }

  // Every company type at once: which setups each gets, and with which variant. `fits` is the company's part alone, so a
  // setup whose app is off here still shows how it would differ by trade (the row says the app is off).
  const columns = [
    ...COMPANY_TYPES.map((type) => ({ key: type.id, label: type.label.text, industry: type.industry, industry_sets: industrySetsFor(type.industry) })),
    { key: OTHER_COMPANY_TYPE, label: "Other", industry: "", industry_sets: [] as string[] },
    { key: SHOWN_NONE, label: "Not answered", industry: "", industry_sets: [] as string[] }
  ];
  const contexts = columns.map((column) => simulatedContext(base, column.key));
  const matrix = experiences.map((definition) => ({
    id: definition.id,
    cells: contexts.map((each) => {
      const result = evaluate(definition, each, appsOn.get(definition.id) || false);
      return { offered: result.offered, fits: result.fits, variants: result.variants.filter((variant) => variant.chosen).map((variant) => variant.id) };
    })
  }));

  return {
    company: {
      shown, actual: companyOf(base), as_shown: companyOf(context),
      types: columns.slice(0, COMPANY_TYPES.length).map(({ key, label, industry, industry_sets }) => ({ id: key, label, industry, industry_sets })),
      sets: INDUSTRY_SETS.map((entry) => ({ id: entry.id, label: entry.label.text, industries: [...entry.industries] })),
      facts: Object.keys(COMPANY_FACTS)
    },
    context: { assistant: !!context.organization.capabilities?.assistant, finished: [...((context.organization as { finished?: string[] }).finished || [])] },
    questions, setups,
    matrix: { columns, rows: matrix }
  };
}
