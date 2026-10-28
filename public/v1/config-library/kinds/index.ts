import { registerLibraryKind } from "../kinds.js";
import { guidedExperienceKind } from "./guided_experience.js";
import { guidedTabFaqsKind } from "./guided_tab_faqs.js";
import { setupStepKind } from "./setup_step.js";
import { guidedCopyKind } from "./guided_copy.js";
import { tabPromoKind } from "./tab_promo.js";
import { appWelcomeKind } from "./app_welcome.js";
import { scopeTemplateKind } from "./scope_template.js";
import { formTemplateKind } from "./form_template.js";
import { automationRuleDefaultKind } from "./automation_rule_default.js";
import { terminologyNamespaceKind } from "./terminology_namespace.js";
import { appFlagDefaultsKind } from "./app_flag_defaults.js";
import { capabilityDefaultsKind } from "./capability_defaults.js";
import { capabilityPresetKind } from "./capability_preset.js";
import { capabilitySignupPresetKind } from "./capability_signup_preset.js";
import { sandboxConfigurationKind } from "./sandbox_configuration.js";
import { materialLibraryKind } from "./material_library.js";
import { measurementDefinitionKind } from "./measurement_definition.js";
import { measurementEquivalenceKind } from "./measurement_equivalence.js";
import { measurementPartitionKind } from "./measurement_partition.js";
import { measurementSchemaKind } from "./measurement_schema.js";
import { pricebookSetupKind } from "./pricebook_setup.js";
import { pricebookTemplateKind } from "./pricebook_template.js";
import { workItemKind } from "./work_item.js";
import { workSchemaKind } from "./work_schema.js";
import { documentTemplateKind } from "./document-template.js";
import { documentThemeKind } from "./document-theme.js";
import { documentWorkflowKind } from "./document-workflow.js";
import { presentationDeckKind } from "./presentation-deck.js";

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
  registerLibraryKind(scopeTemplateKind);
  registerLibraryKind(formTemplateKind);
  registerLibraryKind(automationRuleDefaultKind);
  registerLibraryKind(terminologyNamespaceKind);
  registerLibraryKind(appFlagDefaultsKind);
  registerLibraryKind(capabilityDefaultsKind);
  registerLibraryKind(capabilityPresetKind);
  registerLibraryKind(capabilitySignupPresetKind);
  registerLibraryKind(sandboxConfigurationKind);
  registerLibraryKind(measurementDefinitionKind);
  registerLibraryKind(measurementPartitionKind);
  registerLibraryKind(measurementSchemaKind);
  registerLibraryKind(measurementEquivalenceKind);
  registerLibraryKind(workItemKind);
  registerLibraryKind(workSchemaKind);
  registerLibraryKind(pricebookTemplateKind);
  registerLibraryKind(materialLibraryKind);
  registerLibraryKind(pricebookSetupKind);
  registerLibraryKind(documentThemeKind);
  registerLibraryKind(documentTemplateKind);
  registerLibraryKind(documentWorkflowKind);
  registerLibraryKind(presentationDeckKind);
}
