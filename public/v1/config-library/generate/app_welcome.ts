import type { Generator } from "./index.js";

/** One-shot: today's APP_WELCOMES advertisements (platform/app-experience/offers.ts), one entry per offered app. */
export const appWelcomeGenerator: Generator = {
  kind: "app_welcome",
  async run() {
    const { APP_WELCOMES } = await import("../../platform/app-experience/offers.js");
    return Object.entries(APP_WELCOMES).map(([id, welcome]) => ({ id, data: JSON.parse(JSON.stringify(welcome)) }));
  }
};
