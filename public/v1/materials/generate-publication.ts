import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { forbidden } from "../platform/errors.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { generateFromMeasurementDefaults } from "./measurement-defaults.js";
import { initializeProjectMaterialListsFromScope } from "./storage.js";

/**
 * The Materials tab's Generate button as a published action, so an agent asked "generate the materials list for me"
 * presses the same button: the organization's measurement defaults are generated into the project's materials ledger
 * (unless a signed document defines its scope), then the project's lists are built again from its scope. A signed
 * document's own sets are generated with materials.calculus.command (evaluate, then apply), as the tab does.
 */
const inputSchema = z.object({
  /** Build only one kind of list from the scope (material, labor, equipment). */
  resource_type: z.string().max(60).optional()
}).strict();

const auth = (ctx: PublicationContext) => {
  if (!ctx.auth) throw forbidden("materials_generate_user", "Generating materials needs a signed-in person.");
  return ctx.auth;
};

export function registerMaterialsGeneratePublication() {
  registerAction({
    id: "materials.project.generate", version: "1", domain: "materials", implementation: backendImplementationDigest(),
    description: "Generate the project's materials, as the Materials tab's Generate button does: the organization's measurement defaults (price book products, quantities from the measurement report) become a materials set, then generated planning lists are rebuilt from the project scope. Ordered lists are protected. A signed document's material sets are generated with materials.calculus.command instead. Fails when the project has no roof measurements yet.",
    inputSchema: zodToJsonSchema(inputSchema, { $refStrategy: "none" }) as Record<string, unknown>,
    outputSchema: { type: "object" },
    policy: { scopes: ["project"], permissions: ["manage_projects"], capabilities: ["platform.materials"] },
    effect: "write", executionKinds: ["api", "agent", "module"], idempotency: "required",
    execute: async (ctx, target, input) => {
      const parsed = inputSchema.parse(input);
      const projectId = target.projectId!;
      const defaults = await generateFromMeasurementDefaults(ctx, projectId, {});
      const scope = await initializeProjectMaterialListsFromScope(ctx.organizationId, projectId, { force_regenerate: true, source: "agent", ...(parsed.resource_type ? { resource_type: parsed.resource_type } : {}) }, auth(ctx));
      const lists = (scope as { material_lists?: unknown[]; lists?: unknown[] } | null)?.material_lists || (scope as { lists?: unknown[] } | null)?.lists || [];
      return {
        defaults: defaults.status === "generated" ? { status: "generated", set_id: defaults.set_id, lines: defaults.lines, work: defaults.work, warnings: defaults.warnings, measurement_source: defaults.measurement_source } : { status: defaults.status },
        scope_lists: lists.length
      };
    }
  });
}
