import { z } from "zod";

/**
 * Workflow item kind registry (contract §8). Kinds are code registered under
 * stable ids and referenced from workflow definitions — exactly like widget
 * resolvers and document types. Each kind supplies:
 *  - `schema`: a zod schema validating the ITEM object (kind-specific config
 *    fields live directly on the item, matching the contract examples);
 *  - `validate_write(path)`: whether a `writes` path is acceptable for the
 *    kind (signature/payment/choice_group write outputs, review writes
 *    nothing, everything else may write params or outputs).
 *
 * The client runtime (doc-workflow library) registers one renderer per kind;
 * the server side here only validates and normalizes definitions at publish.
 */

export type WorkflowWriteTarget = "params" | "outputs" | "any" | "none";

export type WorkflowItemKindDefinition = {
  id: string;
  /** Zod schema for the item object (config fields included). */
  schema: z.ZodTypeAny;
  /** Which contract side the kind is allowed to write. */
  writes: WorkflowWriteTarget;
  validate_write: (path: string) => { ok: boolean; reason?: string };
};

export type WorkflowItemKindInput = {
  schema?: z.ZodTypeAny;
  writes?: WorkflowWriteTarget;
  validate_write?: (path: string) => { ok: boolean; reason?: string };
};

/** `writes` paths address the document contract: params.* or outputs.* */
export const WORKFLOW_WRITE_PATH_PATTERN = /^(params|outputs)\.[A-Za-z0-9_]+(?:[.[][^\s]*)?$/;

const registry = new Map<string, WorkflowItemKindDefinition>();

function defaultValidateWrite(id: string, target: WorkflowWriteTarget) {
  return (path: string): { ok: boolean; reason?: string } => {
    const cleaned = String(path || "").trim();
    if (target === "none") {
      return cleaned
        ? { ok: false, reason: `'${id}' items do not write the contract; remove writes.` }
        : { ok: true };
    }
    if (!cleaned) return { ok: false, reason: `'${id}' items require a writes path.` };
    if (!WORKFLOW_WRITE_PATH_PATTERN.test(cleaned)) {
      return { ok: false, reason: `writes must be a params.* or outputs.* path (got '${cleaned}').` };
    }
    if (target === "params" && !cleaned.startsWith("params.")) {
      return { ok: false, reason: `'${id}' items may only write params.* paths.` };
    }
    if (target === "outputs" && !cleaned.startsWith("outputs.")) {
      return { ok: false, reason: `'${id}' items may only write outputs.* paths.` };
    }
    return { ok: true };
  };
}

export function registerWorkflowItemKind(id: string, input: WorkflowItemKindInput = {}) {
  const cleaned = String(id || "").trim().toLowerCase();
  if (!cleaned) throw new Error("registerWorkflowItemKind requires an id.");
  const writes = input.writes || "any";
  registry.set(cleaned, {
    id: cleaned,
    schema: input.schema || baseItemSchema,
    writes,
    validate_write: input.validate_write || defaultValidateWrite(cleaned, writes)
  });
}

export function workflowItemKind(id: string): WorkflowItemKindDefinition | null {
  return registry.get(String(id || "").trim().toLowerCase()) || null;
}

export function listWorkflowItemKinds(): Array<{ id: string; writes: WorkflowWriteTarget }> {
  return [...registry.values()].map((kind) => ({ id: kind.id, writes: kind.writes }));
}

// ---------------------------------------------------------------------------
// Built-in kinds (contract §8 list)
// ---------------------------------------------------------------------------

const jsonObject = z.object({}).passthrough();

/** Shared item envelope; kind-specific schemas extend this. */
const baseItemSchema = z.object({
  kind: z.string().trim().min(1),
  writes: z.string().trim().optional(),
  label: z.string().trim().max(300).optional(),
  description: z.string().trim().max(1200).optional(),
  when: z.string().trim().optional(),
  source: z.string().trim().optional(),
  options_from: z.union([z.string(), z.array(jsonObject)]).optional(),
  prefill: z.string().trim().optional(),
  required: z.boolean().optional(),
  presentation: jsonObject.optional(),
  config: jsonObject.optional()
}).passthrough();

const selectItemSchema = baseItemSchema.extend({
  options: z.array(z.union([z.string(), jsonObject])).optional()
}).passthrough();

const measurementsItemSchema = baseItemSchema.extend({
  fields_from: z.string().trim().optional(),
  fields: z.array(jsonObject).optional()
}).passthrough();

const reviewItemSchema = baseItemSchema.extend({
  preview: jsonObject.optional()
}).passthrough();

registerWorkflowItemKind("text", { schema: baseItemSchema });
registerWorkflowItemKind("currency", { schema: baseItemSchema });
registerWorkflowItemKind("number", { schema: baseItemSchema });
registerWorkflowItemKind("select", { schema: selectItemSchema });
registerWorkflowItemKind("multi_select", { schema: selectItemSchema });
registerWorkflowItemKind("boolean", { schema: baseItemSchema });
registerWorkflowItemKind("date", { schema: baseItemSchema });
registerWorkflowItemKind("measurements", { schema: measurementsItemSchema, writes: "params" });
registerWorkflowItemKind("media_picker", { schema: baseItemSchema });
// The piece picker wraps the legacy scope configurator bridge on the client;
// server-side it is plain data that writes a params list.
registerWorkflowItemKind("piece_picker", { schema: baseItemSchema, writes: "params" });
// Native piece-type selection (scope-template vocabulary cards). Client-side
// the renderer sources cards from services.pieceCatalog(); server-side it is
// plain data writing the selected pieces list (params.scope_pieces).
registerWorkflowItemKind("piece_select", { schema: baseItemSchema, writes: "params" });
// Native generated-line-items review list (selection + measurements →
// pricebook-driven root_items). Writes params.scope_items.
registerWorkflowItemKind("line_items_review", { schema: baseItemSchema, writes: "params" });
registerWorkflowItemKind("choice_group", { schema: selectItemSchema, writes: "outputs" });
// Content-blocks editor (spec 10.1): add/remove/reorder rows of text + media/
// video with layout + display toggles. Params-only (writes a params list such
// as params.content_blocks); the permissive base schema carries the per-row
// config so wave-2 seeds can publish workflows containing it.
registerWorkflowItemKind("content_blocks", { schema: baseItemSchema, writes: "params" });
registerWorkflowItemKind("line_item_editor", { schema: baseItemSchema, writes: "params" });
registerWorkflowItemKind("review", { schema: reviewItemSchema, writes: "none" });
// Server-executed on step completion: mints a document from config
// ({template_id?/document_type?, title?, copy_params?, workflow_id?})
// and records {document_id, title, ...} at the item's outputs.* path.
registerWorkflowItemKind("generate_document", { schema: baseItemSchema, writes: "outputs" });
registerWorkflowItemKind("signature", { schema: baseItemSchema, writes: "outputs" });
registerWorkflowItemKind("payment", { schema: baseItemSchema, writes: "outputs" });

/** Importing this module registers every built-in kind. */
export function registerBuiltinWorkflowItemKinds() {
  // Registration happens at module load; the export makes the dependency
  // explicit for callers instead of relying on import side effects.
}
