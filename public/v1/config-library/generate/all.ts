import type { Generator } from "./index.js";
import { documentTemplateGenerator } from "./document-template.js";
import { documentThemeGenerator } from "./document-theme.js";
import { documentWorkflowGenerator } from "./document-workflow.js";
import { presentationDeckGenerator } from "./presentation-deck.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    documentTemplateGenerator,
    documentThemeGenerator,
    documentWorkflowGenerator,
    presentationDeckGenerator
  ];
}
