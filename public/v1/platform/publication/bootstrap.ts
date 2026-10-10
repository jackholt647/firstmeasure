import { registerPayrollPublication } from '../../payroll/publication.js';
import { registerTodoPublication } from "../../work/publication.js";
import { registerDepartmentPublication } from '../../workforce/department-publication.js';
import { registerWidgetProviders } from '../widgets/catalog.js';
import { registerMaterialsCalculusPublication } from '../../materials/calculus-publication.js';
import { registerMaterialsInputs } from '../../materials/calculus-inputs.js';
import { registerNotificationProvider } from "../notifications/provider.js";
import { registerBuiltinDataProviders } from "./provider-adapters.js";
import { registerDomainActions } from "./action-adapters.js";
import { registerDatasetActions } from "./dataset-actions.js";
import { registerModuleDataProvider } from "../../documents/modules/provider.js";

import { registerCustomFieldPublication } from "../../custom_fields/publication.js";

import { registerContactPublication } from "../../contacts/publication.js";
import { registerCollaborationPublication } from "../../collaboration/publication.js";
import { registerFormsPublication } from "../../forms/publication.js";
import { registerLeadPublication } from "../../leads/publication.js";
import { registerGroupMmsPublication } from "../../messaging/publication.js";

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
  registerFormsPublication();
  registerLeadPublication();
  registerGroupMmsPublication();
  registerDomainActions();
  registerPayrollPublication();
  registerTodoPublication();
  registerDepartmentPublication();
  registerDatasetActions();
  registerModuleDataProvider();
  registerMaterialsCalculusPublication();
  registerMaterialsInputs();
  initialized = true;
}
