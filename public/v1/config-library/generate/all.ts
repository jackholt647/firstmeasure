import type { Generator } from "./index.js";
import { appFlagDefaultsGenerator } from "./app_flag_defaults.js";
import { capabilityDefaultsGenerator } from "./capability_defaults.js";
import { capabilityPresetGenerator } from "./capability_preset.js";
import { capabilitySignupPresetGenerator } from "./capability_signup_preset.js";
import { documentTemplateGenerator } from "./document-template.js";
import { documentThemeGenerator } from "./document-theme.js";
import { documentWorkflowGenerator } from "./document-workflow.js";
import { materialLibraryGenerator } from "./material_library.js";
import { measurementDefinitionGenerator } from "./measurement_definition.js";
import { measurementEquivalenceGenerator } from "./measurement_equivalence.js";
import { measurementPartitionGenerator } from "./measurement_partition.js";
import { measurementSchemaGenerator } from "./measurement_schema.js";
import { presentationDeckGenerator } from "./presentation-deck.js";
import { pricebookSetupGenerator } from "./pricebook_setup.js";
import { pricebookTemplateGenerator } from "./pricebook_template.js";
import { sandboxConfigurationGenerator } from "./sandbox_configuration.js";
import { terminologyNamespaceGenerator } from "./terminology_namespace.js";
import { workItemGenerator } from "./work_item.js";
import { workSchemaGenerator } from "./work_schema.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    appFlagDefaultsGenerator,
    capabilityDefaultsGenerator,
    capabilityPresetGenerator,
    capabilitySignupPresetGenerator,
    documentTemplateGenerator,
    documentThemeGenerator,
    documentWorkflowGenerator,
    materialLibraryGenerator,
    measurementDefinitionGenerator,
    measurementEquivalenceGenerator,
    measurementPartitionGenerator,
    measurementSchemaGenerator,
    presentationDeckGenerator,
    pricebookSetupGenerator,
    pricebookTemplateGenerator,
    sandboxConfigurationGenerator,
    terminologyNamespaceGenerator,
    workItemGenerator,
    workSchemaGenerator
  ];
}
