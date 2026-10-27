import type { LibraryKind } from "../contracts.js";
import { experienceSchema, type ExperienceDefinition } from "../../guided-experiences/contracts.js";
import { guidedSource } from "../../guided-experiences/registry.js";
import { ensureGuidedDefinitions } from "../../guided-experiences/service.js";
import { capabilityErrors, entryMissing, experienceMissing, GUIDED_EXPERIENCE_KIND, SETUP_STEP_EXPERIENCE_PREFIX, SETUP_STEP_KIND } from "../../guided-experiences/library-checks.js";

/**
 * Guided experiences (docs/architecture/guided-experiences.md): in-app setups and tours, each one entry whose data is
 * the experience definition (`experienceSchema`). The runtime (guided-experiences/service.ts) plays them for everyone,
 * read live; organizations keep no copies. What a step's options are filled from (a guided source) and what finishing
 * runs (a published action) stay code, registered by id, and an entry names them.
 */
export const GUIDED_EXPERIENCE = GUIDED_EXPERIENCE_KIND;

export const guidedExperienceKind: LibraryKind<ExperienceDefinition> = {
  kind: GUIDED_EXPERIENCE,
  title: "Guided experiences",
  description: "In-app setups and tours: steps, triggers, variants, eligibility and their copy ({ key, text }).",
  schema: experienceSchema as unknown as LibraryKind<ExperienceDefinition>["schema"],
  titleOf: (data) => data.title.text,
  validate(data, ctx) {
    const errors: string[] = [];
    const registries = ctx.registries;
    if (data.id !== ctx.id) errors.push(`The experience's id ${data.id} is not the entry's id ${ctx.id}.`);
    if (ctx.id.startsWith(SETUP_STEP_EXPERIENCE_PREFIX)) errors.push(`${SETUP_STEP_EXPERIENCE_PREFIX}* experiences are played from setup steps; edit the setup_step entry.`);
    errors.push(...capabilityErrors(data.eligibility.capabilities, registries, "eligibility.capabilities"));
    ensureGuidedDefinitions();
    const own = new Set(data.steps.map((step) => step.id));
    for (const step of data.steps) {
      const at = `steps.${step.id}`;
      errors.push(...capabilityErrors(step.eligibility?.capabilities, registries, `${at}.eligibility.capabilities`));
      const source = (step as { source?: string }).source;
      if (source && !guidedSource(source)) errors.push(`${at}: guided source ${source} is not registered.`);
      for (const required of (step as { requires?: string[] }).requires || []) {
        if (own.has(required)) errors.push(`${at} requires ${required}, which is also one of this experience's steps.`);
        if (entryMissing(registries, SETUP_STEP_KIND, required)) errors.push(`${at} requires ${required}, which is not a setup step.`);
      }
    }
    for (const required of data.requires) {
      if (own.has(required)) errors.push(`requires ${required}, which is also one of this experience's steps.`);
      if (entryMissing(registries, SETUP_STEP_KIND, required)) errors.push(`requires ${required}, which is not a setup step.`);
    }
    for (const trigger of data.triggers) {
      if (trigger.kind === "after_experience" && experienceMissing(registries, trigger.experience, ctx.id)) errors.push(`A trigger follows ${trigger.experience}, which is not an experience.`);
    }
    const action = data.completion.action;
    if (action && !registries.action(action.id)) errors.push(`completion.action: ${action.id} is not a published action.`);
    for (const then of data.completion.then) {
      if ("play" in then && experienceMissing(registries, then.play, ctx.id)) errors.push(`completion.then plays ${then.play}, which is not an experience.`);
    }
    return errors;
  }
};
