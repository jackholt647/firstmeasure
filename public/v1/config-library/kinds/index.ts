import { registerLibraryKind } from "../kinds.js";
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
  registerLibraryKind(documentThemeKind);
  registerLibraryKind(documentTemplateKind);
  registerLibraryKind(documentWorkflowKind);
  registerLibraryKind(presentationDeckKind);
}
