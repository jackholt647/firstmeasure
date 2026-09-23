import { registerDataProvider, describeDataProvider } from "../../platform/publication/providers.js";
import { badRequest } from "../../platform/errors.js";
import { registerAction } from "../../platform/publication/actions.js";
import { getModuleExportDescriptor, getModuleExports, writeModuleExport } from "./service.js";

export function registerModuleDataProvider() {
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
      read: async (ctx, ref) => {
        const result = await getModuleExports(ctx, ref.target.id!, String(ref.args?.exportName), "document-modules.value");
        return result.status === "ready" ? { value: result.value, revision: result.revision, provenance: { ...result.provenance, schema: result.schema } } : result;
      }
    }
  } });
}
