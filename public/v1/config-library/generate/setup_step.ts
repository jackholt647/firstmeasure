import type { Generator } from "./index.js";
import { guidedDefinitions, plain } from "./guided_experience.js";

/** One-shot: today's global setup steps (guided-experiences/steps/index.ts). */
export const setupStepGenerator: Generator = {
  kind: "setup_step",
  async run() {
    const { steps } = await guidedDefinitions();
    return steps.listSetupSteps().map((step) => ({ id: step.id, data: plain(step) }));
  }
};
