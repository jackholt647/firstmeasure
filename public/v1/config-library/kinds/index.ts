import { registerLibraryKind } from "../kinds.js";
import { guidedExperienceKind } from "./guided_experience.js";
import { guidedTabFaqsKind } from "./guided_tab_faqs.js";
import { setupStepKind } from "./setup_step.js";
import { guidedCopyKind } from "./guided_copy.js";
import { tabPromoKind } from "./tab_promo.js";
import { appWelcomeKind } from "./app_welcome.js";

/**
 * Every config library kind, registered once. One import and one call per kind file; a kind's file belongs to the
 * domain that reads its entries.
 */
let registered = false;
export function registerAllLibraryKinds() {
  if (registered) return;
  registered = true;
  registerLibraryKind(guidedExperienceKind);
  registerLibraryKind(guidedTabFaqsKind);
  registerLibraryKind(setupStepKind);
  registerLibraryKind(guidedCopyKind);
  registerLibraryKind(tabPromoKind);
  registerLibraryKind(appWelcomeKind);
}
