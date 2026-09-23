import { registerDataProvider, describeDataProvider } from "../../platform/publication/providers.js";
import { badRequest } from "../../platform/errors.js";
import { registerAction } from "../../platform/publication/actions.js";
import { getModuleExportDescriptor, getModuleExports, writeModuleExport, createModuleInstance, evaluateModuleInstance, readModuleInstance, moduleInstanceView, freezeModuleInstance, materializeModuleDocument, generateModuleDocument } from "./service.js";
import { authorizeModuleEvidence } from "./dependencies.js";
import { refreshModuleGraph } from "./dependencies.js";
import { getRecord, EXECUTIONS } from "./storage.js";
import { backendImplementationDigest } from "../../platform/publication/implementation.js";
import type { PublicationContext, TargetRef, JsonSchema } from "../../platform/publication/contracts.js";

function instanceId(target: TargetRef) { if (!target.id) throw badRequest("module_instance_required", "Select a module instance."); return target.id; }
async function publicResult(ctx: PublicationContext, id: string) {
  const value = await moduleInstanceView(ctx, await readModuleInstance(ctx, id));
  return { id: value.id, revision: value.revision, exports: value.exports };
}
let lifecycleRegistered = false;
function registerModuleActions() {
  if (lifecycleRegistered) return;
  lifecycleRegistered = true;
  const string = { type: "string", minLength: 1 }, revision = { type: "integer", minimum: 1 }, object = { type: "object" };
  const register = (name: string, description: string, properties: Record<string, JsonSchema>, required: string[], execute: import("../../platform/publication/actions.js").ActionDefinition["execute"]) => registerAction({
    id: `document-modules.${name}`, version: "1", implementation: backendImplementationDigest(), domain: "documents", description,
    inputSchema: { type: "object", properties, required, additionalProperties: false }, outputSchema: { type: "object" },
    effect: "write", executionKinds: ["api", "module", "work", "agent"], idempotency: "required",
    policy: { scopes: ["project"], permissions: ["manage_projects|manage_company_settings"], capabilities: ["platform.documents"] }, execute: (ctx, target, input, execution) => execute({ ...ctx, projectId: target.projectId }, target, input, execution)
  });
  register("instance.create", "Create an independent project document or workflow instance.", { moduleId: string, version: string, codePolicy: { enum: ["live", "frozen"] }, inputs: object }, ["moduleId"], async (ctx, target, input) => {
    const instance = await createModuleInstance(ctx, { moduleId: String(input.moduleId), ...(input.version ? { version: String(input.version) } : {}), codePolicy: input.codePolicy as "live" | "frozen" | undefined, projectId: target.projectId!, inputs: input.inputs as Record<string, unknown> });
    return publicResult(ctx, instance.id);
  });
  register("instance.refresh", "Recalculate live dependencies in order without executing effects.", { expectedRevision: revision }, ["expectedRevision"], async (ctx, target, input) => {
    await refreshModuleGraph(ctx, instanceId(target), Number(input.expectedRevision)); return publicResult(ctx, target.id!);
  });
  register("instance.command", "Run explicit declared commands on a module instance.", { expectedRevision: revision }, ["expectedRevision"], async (ctx, target, input, execution) => {
    await evaluateModuleInstance(ctx, instanceId(target), { expectedRevision: Number(input.expectedRevision), mode: "command", idempotencyKey: execution.receiptId }); return publicResult(ctx, target.id!);
  });
  register("instance.freeze", "Retain the evaluated result of a document or workflow instance.", { expectedRevision: revision }, ["expectedRevision"], async (ctx, target, input) => {
    await freezeModuleInstance(ctx, instanceId(target), Number(input.expectedRevision)); return publicResult(ctx, target.id!);
  });
  register("document.materialize", "Create a portal document or attach an evaluated render to an existing draft.", { documentId: string, expectedDocumentRevision: revision, title: string }, [], async (ctx, target, input) => {
    const result = await materializeModuleDocument(ctx, instanceId(target), input); return { id: result.document.id, revision: result.document.revision };
  });
  register("document.generate", "Create an independent document from an explicit workflow export binding.", { moduleId: string, bindingName: string, exportName: string, policy: { enum: ["live", "frozen"] }, inputs: object }, ["moduleId", "bindingName", "exportName", "policy"], async (ctx, target, input) => {
    const instance = await generateModuleDocument(ctx, instanceId(target), input as Parameters<typeof generateModuleDocument>[2]); return publicResult(ctx, instance.id);
  });
}

export function registerModuleDataProvider() {
  registerModuleActions();
  registerAction({
    id: "document-modules.export.write", version: "1", implementation: "document-modules.export.write@1", domain: "documents",
    description: "Update a declared writable module input export at its current revision.",
    inputSchema: { type: "object", required: ["exportName", "value", "expectedRevision"], properties: { exportName: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,79}$" }, value: {}, expectedRevision: { type: "integer", minimum: 1 } }, additionalProperties: false },
    outputSchema: { type: "object", required: ["id", "revision"], properties: { id: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false },
    effect: "write", executionKinds: ["api", "module", "work", "agent"], idempotency: "required",
    policy: { scopes: ["project"], permissions: ["manage_projects|manage_company_settings"], capabilities: ["platform.documents"], systemKinds: ["module", "work", "agent"] },
    execute: async (ctx, target, input) => {
      if (!target.id) throw badRequest("module_export_ref", "Module instance is required.");
      const updated = await writeModuleExport({ ...ctx, projectId: target.projectId }, target.id, String(input.exportName), input.value, Number(input.expectedRevision));
      return { id: updated.id, revision: updated.revision };
    }
  });
  if (describeDataProvider("document-modules", "1")) return;
  registerDataProvider({ id: "document-modules", version: "1", apps: ["documents"], exports: {
    value: {
      schema: {}, schemaVersion: "1", description: "A declared document or workflow module export; private fields are unavailable.",
      argsSchema: { type: "object", required: ["exportName"], properties: { exportName: { type: "string", pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,79}$" } }, additionalProperties: false },
      access: { scopes: ["project"], permissions: ["view_projects"], capabilities: ["platform.documents"], systemKinds: ["work", "module", "agent"] },
      authorizeRef: async (ctx, ref) => {
        if (!ref.target.id || typeof ref.args?.exportName !== "string") throw badRequest("module_export_ref", "Module instance and export name are required.");
        const { instance } = await getModuleExportDescriptor(ctx, ref.target.id, ref.args.exportName, "document-modules.value");
        if (instance.projectId !== ref.target.projectId) throw badRequest("module_export_project", "Module instance does not belong to this project.");
      },
      authorizeSnapshot: async (ctx, ref, result) => {
        const { instance, field } = await getModuleExportDescriptor(ctx, ref.target.id!, String(ref.args?.exportName), "document-modules.value");
        if (!field.path.startsWith("/outputs")) return;
        const executionId = result.provenance.executionId;
        if (typeof executionId !== "string") throw badRequest("module_snapshot_evidence", "The retained module output lacks execution evidence.");
        const execution = await getRecord(ctx.organizationId, EXECUTIONS, executionId);
        if (execution.instanceId !== instance.id || execution.status !== "complete") throw badRequest("module_snapshot_evidence", "The retained execution does not belong to this module.");
        await authorizeModuleEvidence(ctx, { ...instance, bindingManifest: execution.bindingManifest }, new Set(ctx.dependencyPath));
      },
      read: async (ctx, ref) => {
        const result = await getModuleExports(ctx, ref.target.id!, String(ref.args?.exportName), "document-modules.value");
        return result.status === "ready" ? { value: result.value, revision: result.revision, provenance: { ...result.provenance, schema: result.schema } } : result;
      }
    }
  } });
}
