import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { userPublicationContext } from "../platform/publication/context.js";
import { readPublishedData } from "../platform/publication/providers.js";
import { copySchema, setupStepModuleSchema } from "./contracts.js";

/**
 * Setup steps (docs/architecture/setup-steps.md): a question asked once and answered as data, declared once and
 * required by any setup that needs its answer.
 *
 * A step says what it asks (its widget or its own browser module), what writes its answer (a published action, run
 * as the person) and what says it is answered (a published data read, so "is this answered" is a data-layer read and
 * never a configuration check). Global steps live in `guided-experiences/steps/`; an app may register its own beside
 * its definitions. An experience, or one of its steps, names the steps it `requires`; when the experience is resolved
 * for a person, each required step that is not answered yet, and that the person may answer, is injected just
 * before the step that needs it (its own requirements first). A step that is answered is never asked again,
 * wherever it was answered (signup, another app's setup, an agent).
 *
 * Each step is also registered as an experience, `setup_step.<id>`, with no steps of its own and the step as its
 * requirement: playing it (FirstMateGuides.require) asks only what is missing and does nothing when it is answered.
 */
const id = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, "A setup step id is dotted, such as company.type.");
export const setupStepDefinitionSchema = z.object({
  id,
  version: z.number().int().positive(),
  /** Whose answer it is: the organization's (asked once for the company) or each person's. */
  scope: z.enum(["organization", "person"]).default("organization"),
  title: copySchema,
  subtitle: copySchema.optional(),
  /** What it is for, in the step catalog. */
  description: copySchema,
  /** The browser side: a registered widget, or `module` with its own code (setup-step module contract). */
  ui: setupStepModuleSchema,
  /** Data for the UI, fixed here. Anything that changes is read by the module through the publication layer. */
  options: z.record(z.unknown()).default({}),
  /** Steps that must be answered before this one; they are injected before it when they are not. */
  requires: z.array(id).max(8).default([]),
  /** Who may answer it. Someone who may not is never asked: the setup plays without it. */
  eligibility: z.object({ capabilities: z.array(z.string().max(120)).max(12).default([]), permissions: z.array(z.string().max(200)).max(8).default([]) }).strict().default({}),
  /** What says it is answered: a published export (and a JSON pointer in it) whose value is truthy. */
  satisfied: z.object({ provider: z.string().max(120), export: z.string().max(120), path: z.string().max(200).optional() }).strict(),
  /** What saves the answer: a published action run as the person with the module's answer as input. */
  writes: z.object({ action: z.string().max(160), target: z.enum(["organization"]).default("organization") }).strict()
}).strict();
export type SetupStepDefinition = z.infer<typeof setupStepDefinitionSchema>;
export type SetupStepInput = z.input<typeof setupStepDefinitionSchema>;

const steps = new Map<string, SetupStepDefinition>();

export function registerSetupStep(input: SetupStepInput) {
  const parsed = setupStepDefinitionSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Setup step ${String((input as { id?: unknown }).id)} is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  const step = parsed.data;
  if (steps.has(step.id)) throw new Error(`Setup step ${step.id} is registered twice.`);
  steps.set(step.id, step);
  return step;
}
export function setupStep(stepId: string) { return steps.get(stepId) || null; }
export function listSetupSteps() { return [...steps.values()]; }

/** Every requirement names a registered step and none requires itself, however far down. Run once all are registered. */
export function checkSetupStepGraph(extraRoots: { from: string; requires: string[] }[] = []) {
  const visit = (stepId: string, trail: string[]) => {
    const step = steps.get(stepId);
    if (!step) throw new Error(`${trail.at(-1) || "A setup"} requires ${stepId}, which is not a registered setup step.`);
    if (trail.includes(stepId)) throw new Error(`Setup steps require each other in a circle: ${[...trail, stepId].join(" -> ")}.`);
    for (const next of step.requires) visit(next, [...trail, stepId]);
  };
  for (const step of steps.values()) visit(step.id, []);
  for (const root of extraRoots) for (const stepId of root.requires) visit(stepId, [root.from]);
}

export type SatisfactionCache = Map<string, Promise<boolean>>;
/** Whether a step is answered, read through the published data layer as the person. A read that fails counts as not answered. */
export function stepSatisfied(ctx: PlatformAuthContext, step: SetupStepDefinition, cache: SatisfactionCache = new Map()) {
  const key = `${step.id}|${step.scope === "person" ? ctx.userId : ""}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const result = await readPublishedData(userPublicationContext(ctx, { mode: "evaluate" }), {
      provider: step.satisfied.provider, export: step.satisfied.export,
      target: { scope: "organization", organizationId: ctx.orgId },
      ...(step.satisfied.path ? { path: step.satisfied.path } : {})
    });
    if (result.status !== "ready") return false;
    const value = result.value;
    return Array.isArray(value) ? value.length > 0 : value && typeof value === "object" ? Object.keys(value).length > 0 : !!value;
  })().catch(() => false));
  return cache.get(key)!;
}

/**
 * The steps to ask before something that requires `required`: each unanswered step the person may answer, its own
 * unanswered requirements first, each once (`seen` is shared across one experience).
 */
export async function missingSetupSteps(ctx: PlatformAuthContext, required: string[], allowed: (rules: SetupStepDefinition["eligibility"]) => Promise<boolean>, seen: Set<string>, cache: SatisfactionCache) {
  const out: SetupStepDefinition[] = [];
  const walk = async (stepId: string) => {
    if (seen.has(stepId)) return;
    seen.add(stepId);
    const step = steps.get(stepId);
    if (!step || !(await allowed(step.eligibility))) return;
    if (await stepSatisfied(ctx, step, cache)) return;
    for (const before of step.requires) await walk(before);
    out.push(step);
  };
  for (const stepId of required) await walk(stepId);
  return out;
}

/** The step as a setup step in a resolved experience: the player draws it in the standard frame and saves it with `writes`. */
export function injectedStep(step: SetupStepDefinition, forStep: string) {
  return {
    id: step.id, title: step.title, ...(step.subtitle ? { subtitle: step.subtitle } : {}),
    widget: step.ui.widget, ...(step.ui.module ? { module: step.ui.module } : {}),
    options: { ...step.options }, say: [], selects: [], required: true, next: null,
    setup_step: { id: step.id, version: step.version, writes: step.writes, injected_for: forStep }
  };
}

/** The catalog as published (setup-steps provider): what each step asks, needs, writes and reads. */
export function describeSetupSteps() {
  return listSetupSteps().map((step) => ({
    id: step.id, version: step.version, scope: step.scope, title: step.title, description: step.description,
    requires: [...step.requires], satisfied: { ...step.satisfied }, writes: { ...step.writes },
    ui: { widget: step.ui.widget, ...(step.ui.module ? { module: step.ui.module } : {}) },
    experience: `setup_step.${step.id}`
  }));
}
