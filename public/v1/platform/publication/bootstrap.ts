import { registerBuiltinDataProviders } from "./provider-adapters.js";
import { registerDomainActions } from "./action-adapters.js";
import { registerDatasetActions } from "./dataset-actions.js";
import { registerModuleDataProvider } from "../../documents/modules/provider.js";

import { registerCustomFieldPublication } from "../../custom_fields/publication.js";

let initialized = false;
/** All execution hosts use this same catalog. No browser can register server handlers. */
export function initializePublication() {
  if (initialized) return;
  registerBuiltinDataProviders();
  registerCustomFieldPublication();
  registerDomainActions();
  registerDatasetActions();
  registerModuleDataProvider();
  initialized = true;
}
