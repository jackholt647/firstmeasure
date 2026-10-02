import { registerWidgetProviders } from '../widgets/catalog.js';
import { registerNotificationProvider } from "../notifications/provider.js";
import { registerBuiltinDataProviders } from "./provider-adapters.js";
import { registerDomainActions } from "./action-adapters.js";
import { registerDatasetActions } from "./dataset-actions.js";
import { registerModuleDataProvider } from "../../documents/modules/provider.js";

import { registerCustomFieldPublication } from "../../custom_fields/publication.js";

import { registerContactPublication } from "../../contacts/publication.js";
import { registerCollaborationPublication } from "../../collaboration/publication.js";

let initialized = false;
/** All execution hosts use this same catalog. No browser can register server handlers. */
export function initializePublication() {
  if (initialized) return;
  registerBuiltinDataProviders();
  registerWidgetProviders();
  registerNotificationProvider();
  registerCustomFieldPublication();
  registerContactPublication();
  registerCollaborationPublication();
  registerDomainActions();
  registerDatasetActions();
  registerModuleDataProvider();
  initialized = true;
}
