import type { PlatformAuthContext } from "../../platform/auth.js";
import { userPublicationContext } from "../../platform/publication/context.js";
import { jsonClone } from "../../platform/publication/validation.js";
import { badRequest } from "../../platform/errors.js";
import type { JsonObject } from "../../platform/storage.js";
import { publishModule } from "./service.js";
import { validateModuleDefinition } from "./schemas.js";

/** Both existing visual builders author this same program contract. Their layout
 * stays in its native format and is included in the immutable module version. */
export async function publishAssetProgram(orgId: string, assetId: string, name: string, kind: "document" | "workflow", definition: JsonObject, auth: PlatformAuthContext | null) {
  const program = definition.program as JsonObject | undefined;
  if (!program || program.enabled !== true) return definition;
  if (!auth) throw badRequest("module_author_required", "A signed-in author must publish programmable documents.");
  const layout = jsonClone(definition);
  delete layout.program;
  const moduleDefinition = validateModuleDefinition({ name, kind, inputSchema: program.inputSchema || { type: "object" }, outputSchema: program.outputSchema || { type: "object" },
    privateStateSchema: program.privateStateSchema || { type: "object" }, exports: program.exports || {}, bindings: program.bindings || {}, source: program.source,
    ...(kind === "document" ? { renderer: layout } : { workflow: layout }) });
  const module = await publishModule(userPublicationContext(auth, { executionKind: "module" }), moduleDefinition, `builder_${kind}_${assetId}`);
  return { ...definition, program: { ...program, moduleId: module.id, moduleVersion: module.version } };
}
