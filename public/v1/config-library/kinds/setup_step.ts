import type { LibraryKind } from "../contracts.js";
import { libraryEntries } from "../library.js";
import { setupStepDefinitionSchema, type SetupStepDefinition } from "../../guided-experiences/setup-steps.js";
import { capabilityErrors, entryMissing, SETUP_STEP_KIND } from "../../guided-experiences/library-checks.js";

/**
 * Setup steps (docs/architecture/setup-steps.md): a question asked once for the organization ("What kind of company
 * are you?"), one entry each, id = the dotted step id. What says it is answered (a published export) and what saves
 * the answer (a published action) are code, named here. Each step is also played as the experience
 * `setup_step.<id>`, derived from this entry.
 */
export const SETUP_STEP = SETUP_STEP_KIND;

export const setupStepKind: LibraryKind<SetupStepDefinition> = {
  kind: SETUP_STEP,
  title: "Setup steps",
  description: "Questions asked once and answered as data, required by any setup that needs the answer.",
  schema: setupStepDefinitionSchema as unknown as LibraryKind<SetupStepDefinition>["schema"],
  titleOf: (data) => data.title.text,
  validate(data, ctx) {
    const errors: string[] = [];
    const registries = ctx.registries;
    if (data.id !== ctx.id) errors.push(`The step's id ${data.id} is not the entry's id ${ctx.id}.`);
    if (!registries.providerExport(data.satisfied.provider, data.satisfied.export)) errors.push(`satisfied: ${data.satisfied.provider}.${data.satisfied.export} is not a published export.`);
    if (!registries.action(data.writes.action)) errors.push(`writes: ${data.writes.action} is not a published action.`);
    errors.push(...capabilityErrors(data.eligibility.capabilities, registries, "eligibility.capabilities"));
    for (const required of data.requires) {
      if (required === ctx.id) errors.push("A step cannot require itself.");
      else if (entryMissing(registries, SETUP_STEP, required)) errors.push(`requires ${required}, which is not a setup step.`);
    }
    // No circle, however far down: walk the library's steps with this one as saved.
    const requiresOf = (id: string) => id === ctx.id ? data.requires : (libraryEntries<SetupStepDefinition>(SETUP_STEP).find((entry) => entry.id === id)?.data.requires || []);
    const walk = (id: string, trail: string[]): string | null => {
      if (trail.includes(id)) return [...trail, id].join(" -> ");
      for (const next of requiresOf(id)) { const circle = walk(next, [...trail, id]); if (circle) return circle; }
      return null;
    };
    const circle = walk(ctx.id, []);
    if (circle) errors.push(`Setup steps require each other in a circle: ${circle}.`);
    return errors;
  }
};
