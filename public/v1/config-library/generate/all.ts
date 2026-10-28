import type { Generator } from "./index.js";
import { guidedExperienceGenerator } from "./guided_experience.js";
import { guidedTabFaqsGenerator } from "./guided_tab_faqs.js";
import { setupStepGenerator } from "./setup_step.js";
import { tabPromoGenerator } from "./tab_promo.js";
import { appWelcomeGenerator } from "./app_welcome.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    guidedExperienceGenerator,
    guidedTabFaqsGenerator,
    setupStepGenerator,
    tabPromoGenerator,
    appWelcomeGenerator
  ];
}
