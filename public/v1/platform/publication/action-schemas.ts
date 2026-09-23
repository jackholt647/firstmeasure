import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import * as equipment from "../../equipment/schemas.js";
import * as work from "../../work/schemas.js";
import * as payments from "../../payments/schemas.js";
import * as proposals from "../../proposals/schemas.js";
import { issueDocumentSchema } from "../../documents/schemas.js";
import { badRequest } from "../errors.js";
import type { JsonSchema } from "./contracts.js";

// Reuse the very same schemas as the domain services/routes. This is deliberately
// not a second handwritten list of fields, defaults or validation constraints.
const valuesSchemas: Record<string, ZodTypeAny> = {
  "equipment.meter.record": equipment.meterEntrySchema,
  "equipment.maintenance.open": equipment.createWorkOrderSchema,
  "equipment.maintenance.complete": equipment.completeWorkOrderSchema,
  "work.node.transition": work.transitionWorkNodeSchema,
  "work.node.patch": work.patchWorkNodeSchema,
  "payments.invoice.create": payments.createInvoiceSchema,
  "payments.invoice.due": payments.markInvoiceDueSchema,
  "payments.invoice.void": payments.voidInvoiceSchema,
  "payments.payment.clear": payments.clearPaymentSchema,
  "payments.payment.refund": payments.refundPaymentSchema,
  "proposals.create": proposals.createProposalSchema,
  "proposals.patch": proposals.patchProposalSchema,
  "proposals.snapshot": proposals.createSnapshotSchema,
  "proposals.send": proposals.sendProposalSchema,
  "documents.instance.issue": issueDocumentSchema
};
export function actionInputContract(action: string, required: boolean) {
  const values = valuesSchemas[action];
  if (!values) return undefined;
  const schema = z.object({ values: required ? values : values.optional() }).strict();
  const jsonSchema = zodToJsonSchema(schema, { target: "jsonSchema7", $refStrategy: "root", effectStrategy: "input", removeAdditionalStrategy: "strict" }) as JsonSchema;
  return { inputSchema: jsonSchema, validateInput(input: Record<string, unknown>) {
    // Run the original refinements/transforms without applying them twice. The
    // handler parses again to obtain normalized domain input after authorization.
    const result = values.safeParse(input.values ?? {});
    if (!result.success) throw badRequest("action_input_invalid", "Action input failed domain validation.", { issues: result.error.issues });
  } };
}
