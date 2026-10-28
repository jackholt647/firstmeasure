import type { Generator } from "./index.js";
import { guidedExperienceGenerator } from "./guided_experience.js";
import { guidedTabFaqsGenerator } from "./guided_tab_faqs.js";
import { setupStepGenerator } from "./setup_step.js";
import { tabPromoGenerator } from "./tab_promo.js";
import { appWelcomeGenerator } from "./app_welcome.js";
import { scopeTemplateGenerator } from "./scope_template.js";
import { formTemplateGenerator } from "./form_template.js";
import { automationRuleDefaultGenerator } from "./automation_rule_default.js";
import { terminologyNamespaceGenerator } from "./terminology_namespace.js";
import { appFlagDefaultsGenerator } from "./app_flag_defaults.js";
import { capabilityDefaultsGenerator } from "./capability_defaults.js";
import { capabilityPresetGenerator } from "./capability_preset.js";
import { capabilitySignupPresetGenerator } from "./capability_signup_preset.js";
import { sandboxConfigurationGenerator } from "./sandbox_configuration.js";
import { materialLibraryGenerator } from "./material_library.js";
import { measurementDefinitionGenerator } from "./measurement_definition.js";
import { measurementEquivalenceGenerator } from "./measurement_equivalence.js";
import { measurementPartitionGenerator } from "./measurement_partition.js";
import { measurementSchemaGenerator } from "./measurement_schema.js";
import { pricebookSetupGenerator } from "./pricebook_setup.js";
import { pricebookTemplateGenerator } from "./pricebook_template.js";
import { workItemGenerator } from "./work_item.js";
import { workSchemaGenerator } from "./work_schema.js";
import { documentTemplateGenerator } from "./document-template.js";
import { documentThemeGenerator } from "./document-theme.js";
import { documentWorkflowGenerator } from "./document-workflow.js";
import { presentationDeckGenerator } from "./presentation-deck.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    guidedExperienceGenerator,
    guidedTabFaqsGenerator,
    setupStepGenerator,
    tabPromoGenerator,
    appWelcomeGenerator,
    scopeTemplateGenerator,
    formTemplateGenerator,
    automationRuleDefaultGenerator,
    terminologyNamespaceGenerator,
    appFlagDefaultsGenerator,
    capabilityDefaultsGenerator,
    capabilityPresetGenerator,
    capabilitySignupPresetGenerator,
    sandboxConfigurationGenerator,
    measurementDefinitionGenerator,
    measurementPartitionGenerator,
    measurementSchemaGenerator,
    measurementEquivalenceGenerator,
    workItemGenerator,
    workSchemaGenerator,
    pricebookTemplateGenerator,
    materialLibraryGenerator,
    pricebookSetupGenerator,
    documentThemeGenerator,
    documentTemplateGenerator,
    documentWorkflowGenerator,
    presentationDeckGenerator
  ];
}
