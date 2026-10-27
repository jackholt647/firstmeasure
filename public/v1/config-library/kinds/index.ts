import { registerLibraryKind } from "../kinds.js";
import { materialLibraryKind } from "./material_library.js";
import { measurementDefinitionKind } from "./measurement_definition.js";
import { measurementEquivalenceKind } from "./measurement_equivalence.js";
import { measurementPartitionKind } from "./measurement_partition.js";
import { measurementSchemaKind } from "./measurement_schema.js";
import { pricebookSetupKind } from "./pricebook_setup.js";
import { pricebookTemplateKind } from "./pricebook_template.js";
import { workItemKind } from "./work_item.js";
import { workSchemaKind } from "./work_schema.js";

/**
 * Every config library kind, registered once. One import and one call per kind file; a kind's file belongs to the
 * domain that reads its entries.
 */
let registered = false;
export function registerAllLibraryKinds() {
  if (registered) return;
  registered = true;
  registerLibraryKind(measurementDefinitionKind);
  registerLibraryKind(measurementPartitionKind);
  registerLibraryKind(measurementSchemaKind);
  registerLibraryKind(measurementEquivalenceKind);
  registerLibraryKind(workItemKind);
  registerLibraryKind(workSchemaKind);
  registerLibraryKind(pricebookTemplateKind);
  registerLibraryKind(materialLibraryKind);
  registerLibraryKind(pricebookSetupKind);
}
