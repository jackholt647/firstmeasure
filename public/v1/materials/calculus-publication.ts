import { zodToJsonSchema } from "zod-to-json-schema";
import { registerDataProvider } from "../platform/publication/providers.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { commandSchema } from "./calculus-contract.js";
import { materialsCommand, readMaterialsLedger } from "./calculus.js";

export function registerMaterialsCalculusPublication() {
  registerDataProvider({ id: "materials-calculus", version: "1", apps: ["materials", "documents"], exports: {
    ledger: { description: "Independent material sets, revisions, commitments and deliveries for this project.", schema: { type: "object", required: ["project_id", "revision", "sets", "orders", "deliveries"], properties: { project_id: { type: "string" }, revision: { type: "integer" }, sets: { type: "array", items: { type: "object" } }, orders: { type: "array", items: { type: "object" } }, deliveries: { type: "array", items: { type: "object" } } } }, schemaVersion: "1", access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"] },
      // Reauthorize retained evidence as well as the project on frozen consumer reads.
      authorizeSnapshot: async (ctx, ref) => { await readMaterialsLedger(ctx, ref.target.projectId!); },
      read: async (ctx, ref) => { const value = await readMaterialsLedger(ctx, ref.target.projectId!); return { value, revision: String(value.revision) }; }
    }
  } });
  registerAction({ id: "materials.calculus.command", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "Create, evaluate, amend, order or record deliveries against an exact materials ledger revision. Orders are internal commitments, not supplier API submissions.", inputSchema: zodToJsonSchema(commandSchema, { $refStrategy: "none" }) as Record<string, unknown>, outputSchema: { type: "object" }, policy: { scopes: ["project"], permissions: ["manage_projects"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, target, input) => materialsCommand(ctx, target.projectId!, input) });
}
