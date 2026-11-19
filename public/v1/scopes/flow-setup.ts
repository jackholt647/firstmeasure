import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { JsonSchema } from "../platform/publication/contracts.js";
import { badRequest, forbidden } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { INTAKE_CATEGORY, SALES_CATEGORY, readScopeCategories, saveScopeCategories, templateCategoryIds } from "./categories.js";
import { readIntakeRouting, saveIntakeRouting } from "./router.js";
import { readScopeTemplate, saveScopeTemplate } from "./storage.js";

/**
 * The Automations Hub setup (GP-110, docs/architecture/automations-hub.md): where new leads go, and whether that board
 * is the whole job (sales and production on one board) or the sales part with production after it. It writes what the
 * flowchart draws: the intake routing default (rules are kept) and the board's categories (the lanes it sits in).
 */
export const PRODUCTION_CATEGORY = "production";

const inputSchema = z.object({
  entry_template_id: z.string().trim().min(1).max(200),
  // true: the board spans the Sales and Production lanes; false: it is a sales board (production comes after it).
  one_board: z.boolean(),
  branch_id: z.string().trim().max(120).optional()
}).strict();
const outputSchema = z.object({
  entry_template_id: z.string(), category_ids: z.array(z.string()), routing_revision: z.number().int(), template_changed: z.boolean()
}).strict();
const json = (schema: z.ZodTypeAny) => zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as JsonSchema;
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** The lanes a board sits in after the setup: the lane categories it had are replaced, other categories stay. */
export function setupCategoryIds(current: string[], oneBoard: boolean) {
  const kept = current.filter((id) => id !== SALES_CATEGORY && id !== PRODUCTION_CATEGORY && id !== INTAKE_CATEGORY);
  return [SALES_CATEGORY, ...(oneBoard ? [PRODUCTION_CATEGORY] : []), ...kept];
}

export async function applyAutomationsSetup(orgId: string, input: z.infer<typeof inputSchema>, authorUserId: string) {
  const branchId = text(input.branch_id) || "default";
  const template: JsonObject = await readScopeTemplate(orgId, branchId, input.entry_template_id).catch(() => ({} as JsonObject));
  if (!text(template.id) || template.enabled === false || text(template.status) === "archived") throw badRequest("automations_setup_board_unavailable", "Choose a board that is turned on.");
  const definition = { ...object(template.definition), id: text(template.id), name: text(template.name) || text(object(template.definition).name) };
  const current = templateCategoryIds(definition);
  const next = setupCategoryIds(current, input.one_board);
  const changed = JSON.stringify([...current].sort()) !== JSON.stringify([...next].sort());
  if (changed) {
    // Production is an ordinary category: an organization that turned it off gets it back for the lane.
    if (input.one_board) {
      const catalog = await readScopeCategories(orgId);
      const production = catalog.categories.find((category) => category.id === PRODUCTION_CATEGORY);
      if (!production || !production.enabled) {
        await saveScopeCategories(orgId, { categories: [...catalog.categories.filter((category) => category.id !== PRODUCTION_CATEGORY), { id: PRODUCTION_CATEGORY, label: production?.label || "Production", enabled: true }] });
      }
    }
    await saveScopeTemplate(orgId, branchId, { ...definition, category_ids: next, expected_version: Number(template.version || template.current_version || 0) || undefined } as JsonObject, { publicationAuthorId: authorUserId });
  }
  const routing = await readIntakeRouting(orgId, branchId);
  const { revision, updated_at: _updatedAt, ...data } = routing;
  const saved = await saveIntakeRouting(orgId, branchId, { expected_revision: revision, data: { ...data, default_entry: "scope", default_template_id: text(template.id) } });
  return { entry_template_id: text(template.id), category_ids: next, routing_revision: saved.revision, template_changed: changed };
}

let registered = false;
export function registerAutomationsSetupPublication() {
  if (registered) return;
  registered = true;
  registerAction({ id: "automations.setup.apply", version: "1", domain: "work", implementation: backendImplementationDigest(),
    description: "The Automations Hub setup: send every new lead that no intake routing rule catches to one board (scope template), and say whether that board is the whole job (one_board: it spans the Sales and Production lanes, its categories become sales and production) or the sales part (sales only; production starts after it). Routing rules are kept.",
    inputSchema: json(inputSchema) as Record<string, unknown>, outputSchema: json(outputSchema) as Record<string, unknown>,
    effect: "write", idempotency: "required", executionKinds: ["api", "agent", "module"],
    policy: { scopes: ["organization"], permissions: ["manage_company_settings"] },
    validateInput: (value) => { inputSchema.parse(value); },
    execute: async (ctx, _target, value) => {
      if (!ctx.auth) throw forbidden("automations_setup_person", "The automations setup is saved by a person.");
      return applyAutomationsSetup(ctx.organizationId, inputSchema.parse(value), ctx.auth.userId);
    } });
}
