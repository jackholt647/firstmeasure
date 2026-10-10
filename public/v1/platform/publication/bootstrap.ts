import {registerResourceTypePublication} from '../../materials/resource-types-publication.js';
import { registerSupervisionPublication } from '../../comms/calls/supervision-publication.js';
import { registerCallAnalysisPublication } from '../../comms/calls/analysis-publication.js';
import { registerCallPublication } from '../../comms/calls/publication.js';
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
import { registerPriorityFieldsPublication } from '../../priority_fields/publication.js';

import { registerContactPublication } from "../../contacts/publication.js";
import { registerCollaborationPublication } from "../../collaboration/publication.js";
import { registerFormsPublication } from "../../forms/publication.js";
import { registerLeadPublication } from "../../leads/publication.js";

let initialized = false;
/** All execution hosts use this same catalog. No browser can register server handlers. */
export function initializePublication() {
  registerCallPublication();
  registerCallAnalysisPublication();
  registerSupervisionPublication();
  if (initialized) return;
  registerBuiltinDataProviders();
  registerWidgetProviders();
  registerNotificationProvider();
  registerCustomFieldPublication();
  registerPriorityFieldsPublication();
  registerContactPublication();
  registerCollaborationPublication();
  registerFormsPublication();
  registerLeadPublication();
  registerDomainActions();
  registerPayrollPublication();
  registerTodoPublication();
  registerDepartmentPublication();
  registerDatasetActions();
  registerModuleDataProvider();
  registerMaterialsCalculusPublication();
  registerResourceTypePublication();
  registerMaterialsInputs();
  initialized = true;
}
