import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/);
const quantity = z.number().finite().nonnegative().max(1e12);
export const requirementSchema = z.object({
  key, product_id: key, name: z.string().min(1).max(300), quantity,
  unit: z.string().min(1).max(40), variant: z.string().max(160).default(""),
  structure: z.string().max(160).default(""), group: z.string().max(160).default(""),
  explanation: z.string().max(4000).default(""),
  packaging: z.object({ unit: z.string().min(1).max(40), coverage: z.number().finite().positive().max(1e12) }).strict().optional(),
  unit_cost: quantity.optional(), currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  replaces: key.optional(),
  presentation: z.record(z.unknown()).optional()
}).strict();
export type Requirement = z.infer<typeof requirementSchema>;
export const calculationOutputSchema = z.object({
  lines: z.array(requirementSchema).max(1000),
  warnings: z.array(z.string().max(2000)).max(100).default([])
}).strict();
export const calculusDefinitionSchema = z.object({
  type: z.literal("materials_calculus"), key, title: z.string().min(1).max(200),
  source: z.string().min(1).max(128000), bindings: z.record(z.unknown()).default({}),
  inputSchema: z.record(z.unknown()).default({ type: "object", additionalProperties: false }),
  defaults: z.record(z.unknown()).default({}),
  amendment: z.object({ set_id: key, revision: z.number().int().positive(), remove: z.array(key).max(1000), replace_all: z.boolean().default(false) }).strict().optional()
}).strict();
export type CalculusDefinition = z.infer<typeof calculusDefinitionSchema>;
export const deliverablesSchema = z.array(calculusDefinitionSchema).max(40).default([]);
export const commandSchema = z.object({
  key: z.string().min(8).max(120), expected_revision: z.number().int().nonnegative(),
  operation: z.enum(["create", "evaluate", "apply", "amend", "order", "cancel", "return", "delivery", "receive", "price", "reschedule", "configure"]),
  input: z.record(z.unknown())
}).strict();
export type CalculusCommand = z.infer<typeof commandSchema>;
