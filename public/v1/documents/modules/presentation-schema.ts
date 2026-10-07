import { z } from "zod";
import { badRequest } from "../../platform/errors.js";

/** Contract of a presentation module: the third document-module kind. Not the
 * per-document `customer_presentation` display setting in ../presentation.ts. */
const key = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/);
export const PRESENTATION_AUDIENCES = ["internal", "customer"] as const;
export type PresentationAudience = (typeof PRESENTATION_AUDIENCES)[number];
export const PRESENTATION_OFFERS = ["present", "send_estimate", "send_presentation"] as const;

export const presentationInputSchema = z.object({
  /** scope_selections: pick within a choice group / toggle an optional line.
   *  variant: choose one value of a line's variant dimension (color, finish).
   *  value: any other declared writable input, validated by its export schema. */
  kind: z.enum(["scope_selections", "variant", "value"]),
  audience: z.array(z.enum(PRESENTATION_AUDIENCES)).min(1).max(2).default(["internal"]),
  label: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  /** value inputs only: the contract document param that receives the value. */
  contract_param: key.optional()
}).strict();

export const presentationSpecSchema = z.object({
  schema_version: z.literal(1).default(1),
  /** scope: the host prices inputs.scope_items with the documents pricing code. */
  pricing: z.enum(["scope", "none"]).default("scope"),
  inputs: z.record(key, presentationInputSchema).default({}),
  customer: z.object({
    /** Read allowlist for token access; writable customer inputs are implied. */
    exports: z.array(key).max(50).default([]),
    /** review: a customer submits choices and staff produce the contract.
     *  direct: submitting produces and sends the contract for signature. */
    contract: z.enum(["review", "direct"]).default("direct")
  }).strict().default({}),
  contract: z.object({
    /** Used only when the presentation has no source document to update. */
    document_type: z.string().max(80).optional(),
    template_id: z.string().max(160).optional(),
    /** Chosen lines stop being customer-selectable on the contract. */
    lock_choices: z.boolean().default(true),
    /** Constant params written onto the contract when it is produced. */
    params: z.record(key, z.unknown()).default({})
  }).strict().default({})
}).strict();
export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

/** Workflow hook (data only): what the final step offers and which presentation it uses. */
export const workflowCompletionSchema = z.object({
  offers: z.array(z.enum(PRESENTATION_OFFERS)).min(1).max(3),
  default: z.enum(PRESENTATION_OFFERS).optional(),
  presentation: z.object({ module_id: z.string().min(1).max(200), version: z.string().max(80).optional() }).strict().optional(),
  /** When an estimate is sent after presenting: ask the sender, or decide for them. */
  share_presentation_with_estimate: z.enum(["ask", "always", "never"]).default("ask")
}).strict().superRefine((value, ctx) => {
  if (new Set(value.offers).size !== value.offers.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offers"], message: "Each offer may be listed once." });
  if (value.default && !value.offers.includes(value.default)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["default"], message: "The default must be one of the offers." });
  if (value.offers.some(offer => offer !== "send_estimate") && !value.presentation) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["presentation"], message: "Presenting or sending a presentation requires a presentation module." });
});
export type WorkflowCompletion = z.infer<typeof workflowCompletionSchema>;

type ExportField = { path: string; access: "read" | "write" | "private" };
/** Cross-field rules a presentation definition must satisfy before it is published. */
export function validatePresentationSpec(definition: { kind: string; presentation?: unknown; renderer?: Record<string, unknown>; bindings: Record<string, unknown>; exports: Record<string, ExportField> }): PresentationSpec | undefined {
  if (definition.kind !== "presentation") {
    if (definition.presentation) throw badRequest("module_presentation_kind", "Only presentation modules may define a presentation contract.");
    return undefined;
  }
  const spec = presentationSpecSchema.parse(definition.presentation || {});
  // Any valid DocModel: a paged slideshow on custom paper, or a fluid view. The shared
  // validator checks structure; slide transitions, steps, notes and parts pass through.
  if (!definition.renderer) throw badRequest("module_presentation_layout", "A presentation needs a DocModel layout.");
  // Token holders evaluate presentations; nothing they run may read or act.
  if (Object.keys(definition.bindings).length) throw badRequest("module_presentation_bindings", "Presentations take their data from the source they were created from and cannot declare bindings.");
  const kinds = new Map<string, string>();
  for (const [name, input] of Object.entries(spec.inputs)) {
    const field = definition.exports[name];
    if (!field || field.access !== "write") throw badRequest("module_presentation_input", `Interactive input '${name}' must name a writable export.`);
    if (input.kind !== "value" && kinds.has(input.kind)) throw badRequest("module_presentation_input", `Only one '${input.kind}' input may be declared.`);
    kinds.set(input.kind, name);
    if (input.kind !== "value" && spec.pricing !== "scope") throw badRequest("module_presentation_input", `Input '${name}' requires scope pricing.`);
    if (input.contract_param && input.kind !== "value") throw badRequest("module_presentation_input", "Only value inputs map to a contract param.");
  }
  for (const name of spec.customer.exports) {
    const field = definition.exports[name];
    if (!field || field.access === "private") throw badRequest("module_presentation_customer_export", `Customer export '${name}' must be a declared public export.`);
  }
  return spec;
}
