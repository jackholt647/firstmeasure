import type { Generator } from "./index.js";

/** Today's registered guided definitions (guided-experiences/definitions/*, steps/), as the server loads them. */
export async function guidedDefinitions() {
  const { ensureGuidedDefinitions } = await import("../../guided-experiences/service.js");
  ensureGuidedDefinitions();
  return { registry: await import("../../guided-experiences/registry.js"), steps: await import("../../guided-experiences/setup-steps.js") };
}
export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** One-shot: today's guided experiences, one entry each. */
export const guidedExperienceGenerator: Generator = {
  kind: "guided_experience",
  async run() {
    const { registry } = await guidedDefinitions();
    // The `setup_step.<id>` experiences are derived from the setup steps when read; they are not entries.
    return registry.listExperiences().filter((definition) => !definition.id.startsWith("setup_step.")).map((definition) => ({ id: definition.id, data: plain(definition) }));
  }
};
