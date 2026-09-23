import { z } from "zod";
import { Ajv } from "ajv";
import { FMDocModel } from "../schemas.js";
import { badRequest } from "../../platform/errors.js";
import { jsonClone, validateJson } from "../../platform/publication/validation.js";
import { assertSafeTenantSchema } from "../../platform/publication/tenant-schema.js";

const jsonSchema = z.record(z.unknown());
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
const target = z.object({ scope: z.enum(["global", "organization", "project"]), organizationId: z.string().optional(), projectId: z.string().optional(), branchId: z.string().optional(), id: z.string().optional() }).strict();
const source = z.object({ provider: z.string().min(1), export: z.string().min(1), version: z.string().optional(), revision: z.string().optional(), target, args: jsonSchema.optional(), path: z.string().optional() }).strict();
export const moduleBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("data"), policy: z.enum(["live", "frozen"]), source, required: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("action"), policy: z.enum(["live", "frozen"]), action: z.object({ action: z.string().min(1), version: z.string().optional(), target }).strict() }).strict()
]);
export const moduleDefinitionSchema = z.object({
  name: z.string().min(1).max(200), kind: z.enum(["document", "workflow"]),
  engine: z.literal("quickjs-emscripten@0.32.0").default("quickjs-emscripten@0.32.0"),
  inputSchema: jsonSchema, outputSchema: jsonSchema, privateStateSchema: jsonSchema.default({ type: "object" }),
  exports: z.record(key, z.object({ path: z.string().regex(/^\/(outputs|inputs)(\/|$)/), schema: jsonSchema, access: z.enum(["read", "write", "private"]), description: z.string().max(1000).optional() }).strict()),
  bindings: z.record(key, moduleBindingSchema).default({}),
  source: z.string().min(1).max(128_000), renderer: jsonSchema.optional()
}).strict();
export type ModuleDefinition = z.infer<typeof moduleDefinitionSchema>;

export function validateModuleDefinition(value: unknown): ModuleDefinition {
  const definition = moduleDefinitionSchema.parse(jsonClone(value));
  // Compile every declared schema now; no invalid schema may enter a published version.
  for (const schema of [definition.inputSchema, definition.outputSchema, definition.privateStateSchema, ...Object.values(definition.exports).map(x => x.schema)]) {
    assertSafeTenantSchema(schema);
    try { new Ajv({ strict: false }).compile(schema); } catch { throw badRequest("module_schema_invalid", "Invalid module schema."); }
  }
  for (const field of Object.values(definition.exports)) if (field.access === "write" && !field.path.startsWith("/inputs/")) throw badRequest("module_export_write_invalid", "Writable exports must address input fields; calculated outputs are read-only.");
  const privatePaths = Object.values(definition.exports).filter(field => field.access === "private").map(field => field.path);
  for (const field of Object.values(definition.exports).filter(field => field.access !== "private")) {
    if (privatePaths.some(privatePath => privatePath === field.path || privatePath.startsWith(`${field.path}/`) || field.path.startsWith(`${privatePath}/`))) throw badRequest("module_export_overlap", "Public exports cannot overlap private fields.");
  }
  if (definition.renderer) validateModuleView(definition.renderer);
  return definition;
}

/** Use shared DocModel validation, plus reject active content before renderer entry. */
export function validateModuleView(value: unknown): Record<string, unknown> {
  const view = jsonClone(value) as Record<string, unknown>;
  const checked = FMDocModel.validateDocument(view);
  if (!checked.ok) throw badRequest("module_view_invalid", "Module view is not a valid document model.", checked.errors);
  const inspect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    for (const [key, val] of Object.entries(node)) {
      if (/^(html|innerHTML|outerHTML|script|on[a-z]+)$/i.test(key)) throw badRequest("module_view_active_content", "Module views cannot contain executable content.");
      if (typeof val === "string" && /^(url|src|href)$/i.test(key) && !/^(https:\/\/|\/[^/]|#[\w-]*$)/i.test(val)) throw badRequest("module_view_url", "Module view URLs must use HTTPS or local paths.");
      inspect(val);
    }
  };
  inspect(view);
  return view;
}
