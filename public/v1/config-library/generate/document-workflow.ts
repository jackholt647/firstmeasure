import type { GeneratedEntry, Generator } from "./index.js";
import { DOCUMENT_WORKFLOW_KIND } from "../kinds/document-workflow.js";
import { operationsDocuments, roofingPack } from "./document-template.js";

/** One-shot: every workflow documents/seeds.ts, the roofing pack and Operations made. */
export const documentWorkflowGenerator: Generator = {
  kind: DOCUMENT_WORKFLOW_KIND,
  async run() {
    const { WORKFLOW_SEEDS, SCOPE_WORKFLOW_SEEDS } = await import("../../documents/seeds.js");
    const entries: GeneratedEntry[] = [];
    for (const seed of WORKFLOW_SEEDS) entries.push({ id: seed.id, data: { name: seed.name, description: seed.description, status: "active", seeding: "every_organization", definition: seed.definition() } });
    // The scope-owned templates' workflows arrive with their template, archived like it.
    for (const seed of SCOPE_WORKFLOW_SEEDS) entries.push({ id: seed.id, data: { name: seed.name, description: seed.description, status: "archived", seeding: "with_template", definition: seed.definition() } });
    for (const item of await roofingPack()) entries.push(item.workflow);
    for (const item of await operationsDocuments()) entries.push(item.workflow);
    return entries;
  }
};
