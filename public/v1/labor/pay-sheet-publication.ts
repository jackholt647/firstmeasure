import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { listProjectMaterialLists } from "../materials/storage.js";
import { readOrganizationPricebook } from "../pricebook/storage.js";
import { archiveCrew, commitInputSchema, commitLaborList, crewInputSchema, deliverySettingSchema, listCommitments, listCrews, listDeliverySettings, providerAvailability, releaseCommitment, saveCrew, saveDeliverySetting } from "./commitments.js";
import { archivePaySheet, evaluatePaySheet, listPaySheets, paySheetArchiveSchema, paySheetInputSchema, paySheetRequirements, savePaySheet, type PayContext } from "./pay-sheets.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});

/**
 * A project's numeric field values, as the data layer publishes them: stored values, defaults, formulas and published
 * calculations, all resolved on the server. Yes/no fields count as 1 and 0. Each is offered under its field path and
 * under the `custom_<path>` name the Project tab's formulas use.
 */
export async function projectFieldNumbers(orgId: string, projectId: string): Promise<Record<string, number>> {
  const { readFields } = await import("../custom_fields/records.js");
  const numbers: Record<string, number> = {};
  try {
    const read = await readFields(systemPublicationContext({ kind: "work", organizationId: orgId, projectId, operations: ["custom-fields-project.values"] }), { scope: "project", organizationId: orgId, projectId }, "project");
    const walk = (value: unknown, path: string) => {
      if (typeof value === "number" && Number.isFinite(value)) numbers[path] = value;
      else if (typeof value === "boolean") numbers[path] = value ? 1 : 0;
      else if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) numbers[path] = Number(value);
      else if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    };
    walk(read.values, "");
    for (const [path, value] of Object.entries({ ...numbers })) numbers[`custom_${path.replace(/\./g, "_")}`] = value;
  } catch { /* a project with no readable fields offers none; a sheet that requires one reports it missing */ }
  return numbers;
}
/** What a project offers a pay sheet: its selected measurements, the material on its lists and its field values. Reads only. */
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
  return { measurements: measured.status === "ready" ? measured.value : {}, materials, fields: { ...(await projectFieldNumbers(orgId, projectId)), ...(supplied.fields || {}) }, manual: supplied.manual || {} };
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
  const commitmentSchema = { type: "object", required: ["id", "list_id", "project_id", "revision", "status", "provider", "lines", "total_cents", "delivery"], properties: { id: { type: "string" }, list_id: { type: "string" }, project_id: { type: "string" }, project_title: { type: "string" }, title: { type: "string" }, revision: { type: "integer" }, status: { enum: ["committed", "superseded", "released"] }, crew: { type: ["object", "null"] }, released_at: { type: "string" }, released_by_user_id: { type: "string" }, release_reason: { type: "string" }, provider: { type: "object" }, lines: { type: "array", items: { type: "object" } }, total_cents: { type: "integer" }, pay_sheet: { type: ["object", "null"] }, schedule: { type: ["object", "null"] }, note: { type: "string" }, committed_by_user_id: { type: "string" }, committed_at: { type: "string" }, superseded_by: { type: "string" }, delivery: { type: "object" } }, additionalProperties: false };
  const settingSchema = { type: "object", required: ["subject", "method"], properties: { subject: { type: "object" }, method: { enum: ["share", "work_order_email", "custom"] }, email: { type: "string" }, source: { type: "string" }, revision: { type: "integer" }, updated_by_user_id: { type: "string" } }, additionalProperties: false };
  registerDataProvider({ id: "labor-commitments", version: "1", apps: ["materials", "crew"], exports: {
    project: { description: "Labor lists committed on this project: the frozen lines and totals sent to each crew, person or subcontractor, the revision, whether it was superseded, and how delivery went. A crew is committed to work while one of its commitments is not superseded.", schema: { type: "array", items: commitmentSchema }, schemaVersion: "1", access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await listCommitments(ctx.organizationId, { project_id: ref.target.projectId! }); return { value, revision: revision(value.map((entry) => [entry.id, entry.status, entry.delivery.status])) }; } },
    settings: { description: "How each crew, person and subcontractor receives committed work: shared inside FirstMate, emailed a work order, or their own delivery code.", schema: { type: "array", items: settingSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listDeliverySettings(ctx.organizationId); return { value, revision: revision(value) }; } }
  } });
  const crewSchema = { type: "object", required: ["id", "provider", "name", "revision"], properties: { id: { type: "string" }, provider: { type: "object" }, parent_crew_id: { type: "string" }, name: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false };
  registerDataProvider({ id: "labor-providers", version: "1", apps: ["materials", "crew", "scheduling"], exports: {
    crews: { description: "Crews inside each labor provider (a person, an in-house crew or a subcontractor). A crew may sit under another crew of the same provider.", schema: { type: "array", items: crewSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listCrews(ctx.organizationId); return { value, revision: revision(value) }; } },
    availability: { description: "How much one labor provider can take on, from what it is committed to and nothing else: one job at a time for each crew that has no crews under it, the commitments each holds, and whether the provider is over-committed. Pass the provider as arguments.", schema: { type: "object", required: ["provider", "capacity", "committed", "available", "over_committed", "units", "unplaced"], properties: { provider: { type: "object" }, capacity: { type: "integer" }, committed: { type: "integer" }, available: { type: "integer" }, over_committed: { type: "boolean" }, units: { type: "array", items: { type: "object" } }, unplaced: { type: "array", items: { type: "object" } } }, additionalProperties: false }, schemaVersion: "1", argsSchema: { type: "object", required: ["type", "id"], properties: { type: { enum: ["organization_user", "resource_group", "organization_connection"] }, id: { type: "string" } }, additionalProperties: false }, access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await providerAvailability(ctx.organizationId, { type: String(ref.args?.type) as "organization_user", id: String(ref.args?.id || "") }); return { value, revision: revision(value) }; } }
  } });
  registerAction({ id: "labor.commitment.release", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "release a committed labor list because the work is finished or was taken back, freeing the provider's capacity.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, reason: { type: "string" } }, additionalProperties: false }, outputSchema: commitmentSchema as Obj, policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => releaseCommitment(ctx.organizationId, input, ctx.auth!) });
  registerAction({ id: "labor.crew.save", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "create or rename a crew inside a labor provider, or move it under another crew.", inputSchema: zodToJsonSchema(crewInputSchema, { $refStrategy: "none" }) as Obj, outputSchema: crewSchema as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => saveCrew(ctx.organizationId, input, ctx.auth!) });
  registerAction({ id: "labor.crew.archive", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "remove a crew that has no crews under it.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }, outputSchema: archived as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => archiveCrew(ctx.organizationId, input, ctx.auth!) });
  registerAction({ id: "labor.list.commit", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "freeze a labor list as it stands and hand it to the crew, person or subcontractor it is assigned to. Committing again makes a new revision.", inputSchema: zodToJsonSchema(commitInputSchema, { $refStrategy: "none" }) as Obj, outputSchema: commitmentSchema as Obj, policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => commitLaborList(ctx.organizationId, input, ctx.auth!) });
  registerAction({ id: "labor.delivery-setting.save", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "choose how a crew, person or subcontractor receives committed work.", inputSchema: zodToJsonSchema(deliverySettingSchema, { $refStrategy: "none" }) as Obj, outputSchema: settingSchema as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => saveDeliverySetting(ctx.organizationId, input, ctx.auth!) });
  for (const [operation, description, schema, output, execute] of [
    ["sheet.save", "create a pay sheet or replace its inputs, pay entries, equipment and duration.", paySheetInputSchema, sheetSchema, savePaySheet],
    ["sheet.archive", "remove a pay sheet.", paySheetArchiveSchema, archived, archivePaySheet]
  ] as const) registerAction({ id: "pay-sheets." + operation, version: "1", domain: "materials", implementation: backendImplementationDigest(), description, inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Obj, outputSchema: output as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => execute(ctx.organizationId, input, ctx.auth!) });
}
