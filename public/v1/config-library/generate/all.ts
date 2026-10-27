import type { Generator } from "./index.js";
import { materialLibraryGenerator } from "./material_library.js";
import { measurementDefinitionGenerator } from "./measurement_definition.js";
import { measurementEquivalenceGenerator } from "./measurement_equivalence.js";
import { measurementPartitionGenerator } from "./measurement_partition.js";
import { measurementSchemaGenerator } from "./measurement_schema.js";
import { pricebookSetupGenerator } from "./pricebook_setup.js";
import { pricebookTemplateGenerator } from "./pricebook_template.js";
import { workItemGenerator } from "./work_item.js";
import { workSchemaGenerator } from "./work_schema.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    measurementDefinitionGenerator,
    measurementPartitionGenerator,
    measurementSchemaGenerator,
    measurementEquivalenceGenerator,
    workItemGenerator,
    workSchemaGenerator,
    pricebookTemplateGenerator,
    materialLibraryGenerator,
    pricebookSetupGenerator
  ];
}
