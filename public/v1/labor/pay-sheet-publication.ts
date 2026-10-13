import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { listProjectMaterialLists } from "../materials/storage.js";
import { readOrganizationPricebook } from "../pricebook/storage.js";
import { archivePaySheet, evaluatePaySheet, listPaySheets, paySheetArchiveSchema, paySheetInputSchema, paySheetRequirements, savePaySheet, type PayContext } from "./pay-sheets.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});

/** What a project offers a pay sheet: its selected measurements and the material on its lists. Reads only. */
export async function projectPayContext(orgId: string, projectId: string, supplied: Pick<PayContext, "fields" | "manual"> = {}): Promise<PayContext> {
  const { effectiveProjectMeasurements } = await import("../platform/publication/firstmeasure-datasets.js");
  const measured = await effectiveProjectMeasurements(systemPublicationContext({ kind: "work", organizationId: orgId, projectId, operations: ["datasets.value"] }), projectId);
  const types = new Map<string, string>();
  try { for (const item of (await readOrganizationPricebook(orgId)).catalog.items) types.set(String(item.id), String(item.type || item.category || "")); } catch { /* an organization without a price book has no item types to match */ }
  const materials = (await listProjectMaterialLists(orgId, projectId))
    .filter((list) => !list.resource_type || list.resource_type === "material")
    .flatMap((list) => (Array.isArray(list.current_items) ? list.current_items : []).map(obj))
    .filter((item) => obj(item.metadata).delivery_fee !== true)
    .map((item) => { const itemId = String(obj(item.pricebook_ref).item_id || ""); return { item_id: itemId, item_type: types.get(itemId) || "", quantity: Number(item.quantity) || 0 }; });
  return { measurements: measured.status === "ready" ? measured.value : {}, materials, fields: supplied.fields || {}, manual: supplied.manual || {} };
}
/** Every pay sheet, or one, priced against the same project so crews can be compared on the same job. */
export async function evaluateProjectPaySheets(orgId: string, projectId: string, options: { sheet_id?: string; fields?: Record<string, number>; manual?: Record<string, number> } = {}) {
  const context = await projectPayContext(orgId, projectId, options);
  const sheets = (await listPaySheets(orgId)).filter((sheet) => !options.sheet_id || sheet.id === options.sheet_id);
  return sheets.map((sheet) => evaluatePaySheet(sheet, context));
}

const numbers = { type: "object", additionalProperties: { type: "number" } };
const sheetSchema = zodToJsonSchema(paySheetInputSchema.innerType().omit({ expected_revision: true }).extend({ id: paySheetArchiveSchema.shape.id, revision: paySheetArchiveSchema.shape.expected_revision.unwrap() }), { $refStrategy: "none" }) as Obj;
const requirementSchema = { type: "object", required: ["consumer", "schema_ids", "inputs"], properties: { consumer: { type: "object" }, schema_ids: { type: "array", items: { type: "string" } }, inputs: { type: "array", items: { type: "object", required: ["name", "label", "required", "source"], properties: { name: { type: "string" }, label: { type: "string" }, required: { type: "boolean" }, default: { type: "number" }, source: { type: "object" } }, additionalProperties: false } } }, additionalProperties: false };
const evaluationSchema = { type: "object", required: ["sheet", "lines", "equipment", "unresolved", "missing_inputs", "duration_days", "total_cents", "complete"], properties: { sheet: { type: "object" }, lines: { type: "array", items: { type: "object" } }, equipment: { type: "array", items: { type: "object" } }, unresolved: { type: "array", items: { type: "object" } }, missing_inputs: { type: "array", items: { type: "object" } }, duration_days: { type: ["number", "null"] }, total_cents: { type: "integer" }, complete: { type: "boolean" } }, additionalProperties: false };
let registered = false;
export function registerPaySheetPublication() {
  if (registered) return;
  registered = true;
  const revision = (value: unknown) => `sha256:${contentHash(value)}`;
  registerDataProvider({ id: "pay-sheets", version: "1", apps: ["materials", "crew"], exports: {
    catalog: { description: "How each crew, person and subcontractor is paid: the inputs their pay sheet reads, its pay entries, the equipment they bring and how long their work takes.", schema: { type: "array", items: sheetSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listPaySheets(ctx.organizationId); return { value, revision: revision(value.map((sheet) => [sheet.id, sheet.revision])) }; } },
    requirements: { description: "What every pay sheet needs before it can price a job: the kinds of work it covers and each declared input, required or optional, as a measurement, a material quantity, a project field or a number entered by hand. Compare with measurement-schemas and a project's data to see what is missing for a crew.", schema: { type: "array", items: requirementSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const sheets = await listPaySheets(ctx.organizationId); return { value: sheets.map(paySheetRequirements), revision: revision(sheets.map((sheet) => [sheet.id, sheet.revision])) }; } },
    evaluation: { description: "Each pay sheet priced against this project's measurements and material lists: pay lines, equipment, estimated days, and any line left unresolved because a required input is missing. Unresolved is never reported as zero. Pass project field values and hand-entered numbers as arguments.", schema: { type: "array", items: evaluationSchema }, schemaVersion: "1", argsSchema: { type: "object", properties: { sheet_id: { type: "string" }, fields: numbers, manual: numbers }, additionalProperties: false }, access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await evaluateProjectPaySheets(ctx.organizationId, ref.target.projectId!, obj(ref.args) as { sheet_id?: string; fields?: Record<string, number>; manual?: Record<string, number> }); return { value, revision: revision(value) }; } }
  } });
  const archived = { type: "object", required: ["id", "archived"], additionalProperties: false, properties: { id: { type: "string" }, archived: { type: "boolean" } } };
  for (const [operation, description, schema, output, execute] of [
    ["sheet.save", "create a pay sheet or replace its inputs, pay entries, equipment and duration.", paySheetInputSchema, sheetSchema, savePaySheet],
    ["sheet.archive", "remove a pay sheet.", paySheetArchiveSchema, archived, archivePaySheet]
  ] as const) registerAction({ id: "pay-sheets." + operation, version: "1", domain: "materials", implementation: backendImplementationDigest(), description, inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Obj, outputSchema: output as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => execute(ctx.organizationId, input, ctx.auth!) });
}
