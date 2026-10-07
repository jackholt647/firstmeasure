import type { PlatformAuthContext } from "../../platform/auth.js";
import { userPublicationContext } from "../../platform/publication/context.js";
import { jsonClone } from "../../platform/publication/validation.js";
import { badRequest } from "../../platform/errors.js";
import type { JsonObject } from "../../platform/storage.js";
import { publishModule } from "./service.js";
import { validateModuleDefinition } from "./schemas.js";
import { validateDeliverables } from "../../materials/calculus.js";
import { workflowCompletionSchema } from "./presentation-schema.js";
import { getRecord, MODULES } from "./storage.js";

/** Both existing visual builders author this same program contract. Their layout
 * stays in its native format and is included in the immutable module version. */
/** A workflow names what its final step offers. Publishing checks the named
 * presentation exists, so a broken reference is caught by its author. */
async function validateCompletion(orgId: string, definition: JsonObject) {
  if (definition.completion === undefined || definition.completion === null) return;
  const parsed = workflowCompletionSchema.safeParse(definition.completion);
  if (!parsed.success) throw badRequest("workflow_completion_invalid", "The workflow completion is not valid.", parsed.error.issues);
  if (!parsed.data.presentation) return;
  const module = await getRecord(orgId, MODULES, parsed.data.presentation.module_id).catch(() => null);
  if (module?.kind !== "presentation") throw badRequest("workflow_completion_presentation", "The workflow names a presentation module that is not published.");
}

export async function publishAssetProgram(orgId: string, assetId: string, name: string, kind: "document" | "workflow" | "presentation", definition: JsonObject, auth: PlatformAuthContext | null, tags: unknown = []) {
  if (kind === "workflow") await validateCompletion(orgId, definition);
  const program = definition.program as JsonObject | undefined;
  // A view template whose program carries a presentation contract publishes as one.
  if (kind === "document" && program?.presentation) kind = "presentation";
  if (program?.deliverables) validateDeliverables(program.deliverables);
  if (!program || program.enabled !== true) return definition;
  if (!auth) throw badRequest("module_author_required", "A signed-in author must publish programmable documents.");
  const layout = jsonClone(definition);
  delete layout.program;
  const moduleDefinition = validateModuleDefinition({ name, kind, tags, inputSchema: program.inputSchema || { type: "object" }, outputSchema: program.outputSchema || { type: "object" },
    privateStateSchema: program.privateStateSchema || { type: "object" }, exports: program.exports || {}, bindings: program.bindings || {}, source: program.source || "", deliverables: program.deliverables || [],
    ...(kind === "workflow" ? { workflow: layout } : { renderer: layout }), ...(kind === "presentation" ? { presentation: program.presentation } : {}) });
  const module = await publishModule(userPublicationContext(auth, { executionKind: "module" }), moduleDefinition, `builder_${kind}_${assetId}`);
  return { ...definition, program: { ...program, moduleId: module.id, moduleVersion: module.version } };
}
