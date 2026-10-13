import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden } from "../platform/errors.js";
import type { PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { readMaterialList } from "../materials/storage.js";
import { systemPublicationContext } from "../platform/publication/context.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { definitionForKey } from "../platform/publication/measurement-schemas.js";
import { listProjectMaterialLists } from "../materials/storage.js";
import { readOrganizationPricebook } from "../pricebook/storage.js";
import { archiveUnit, commitInputSchema, commitLaborList, confirmDelivery, unitInputSchema, deliverySettingSchema, listCommitments, listUnits, listDeliverySettings, assigneeAvailability, redeliverCommitment, releaseCommitment, saveUnit, saveDeliverySetting, type Actor } from "./commitments.js";
import { generateInputSchema, generateLaborList } from "./generation.js";
import { archivePaySheet, evaluatePaySheet, listPaySheets, paySheetArchiveSchema, paySheetInputSchema, paySheetRequirements, savePaySheet, type PayContext } from "./pay-sheets.js";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {});

/** The same switch the published views check, for the HTTP routes. */
export async function requireLaborEnabled(orgId: string) {
  if (!await isAppFlagEnabled(orgId, "platform", "materials")) throw forbidden("app_flag_disabled", "Materials are not enabled for this organization.");
}
/**
 * A project's numeric field values, as the data layer publishes them: stored values, defaults, formulas and published
 * calculations, all resolved on the server. Yes/no fields count as 1 and 0; text is never read as a number. Each is
 * offered under its field path, and under the `custom_<path>` name the Project tab's formulas use unless a field
 * already has that path. A failed read is reported, not turned into "no fields".
 */
export async function projectFieldNumbers(orgId: string, projectId: string): Promise<{ numbers: Record<string, number>; error: string }> {
  const { readFields } = await import("../custom_fields/records.js");
  const numbers: Record<string, number> = {};
  try {
    const read = await readFields(systemPublicationContext({ kind: "work", organizationId: orgId, projectId, operations: ["custom-fields-project.values"] }), { scope: "project", organizationId: orgId, projectId }, "project");
    const walk = (value: unknown, path: string) => {
      if (typeof value === "number" && Number.isFinite(value)) numbers[path] = value;
      else if (typeof value === "boolean") numbers[path] = value ? 1 : 0;
      else if (value && typeof value === "object" && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) walk(child, path ? `${path}.${key}` : key);
    };
    walk(read.values, "");
    for (const [path, value] of Object.entries({ ...numbers })) { const alias = `custom_${path.replace(/\./g, "_")}`; if (!(alias in numbers)) numbers[alias] = value; }
    return { numbers, error: "" };
  } catch (error) {
    return { numbers: {}, error: `Project fields could not be read${error instanceof Error && error.message ? `: ${error.message}` : "."}` };
  }
}
/** What a project offers a pay sheet: its selected measurements, the material on its live lists and its field values. Reads only. */
/**
 * Measurements a caller supplies for a project that has no measurement dataset selected yet. Most projects still keep
 * their measurements where the Project tab reads them, not in a dataset, and the dataset layer says a missing dataset
 * enables that older path. Only dictionary keys in the dictionary's own unit are accepted, and they are never used
 * once the project has a selected dataset.
 */
export function legacyMeasurements(value: unknown) {
  const accepted: Record<string, { value: number; unit: string; source: string }> = {};
  for (const [key, raw] of Object.entries(obj(value))) {
    const definition = definitionForKey(key), amount = Number(obj(raw).value);
    if (!definition || !Number.isFinite(amount) || amount < 0 || String(obj(raw).unit || "") !== definition.unit) continue;
    accepted[key] = { value: amount, unit: definition.unit, source: "project" };
  }
  return accepted;
}
export async function projectPayContext(orgId: string, projectId: string, supplied: Pick<PayContext, "fields" | "manual"> & { legacy_measurements?: unknown } = {}): Promise<PayContext & { measurement_source: "dataset" | "project" | "none" }> {
  const unavailable: NonNullable<PayContext["unavailable"]> = {};
  const { effectiveProjectMeasurements } = await import("../platform/publication/firstmeasure-datasets.js");
  let measurements: unknown = {};
  let measurementSource: "dataset" | "project" | "none" = "none";
  try {
    const measured = await effectiveProjectMeasurements(systemPublicationContext({ kind: "work", organizationId: orgId, projectId, operations: ["datasets.value"] }), projectId);
    if (measured.status === "ready") { measurements = measured.value; measurementSource = "dataset"; }
    else { const legacy = legacyMeasurements(supplied.legacy_measurements); if (Object.keys(legacy).length) { measurements = { measurements: legacy }; measurementSource = "project"; } }
  }
  catch (error) { unavailable.measurement = `Project measurements could not be read${error instanceof Error && error.message ? `: ${error.message}` : "."}`; }
  const types = new Map<string, string>();
  try { for (const item of (await readOrganizationPricebook(orgId)).catalog.items) types.set(String(item.id), String(item.type || item.category || "")); } catch { /* an organization without a price book has no item types to match */ }
  const materials = (await listProjectMaterialLists(orgId, projectId))
    // Archived lists are history. Counting one beside its replacement would pay for the same material twice.
    .filter((list) => (!list.resource_type || list.resource_type === "material") && String(list.status || "") !== "archived")
    .flatMap((list) => (Array.isArray(list.current_items) ? list.current_items : []).map(obj))
    .filter((item) => obj(item.metadata).delivery_fee !== true)
    .map((item) => { const itemId = String(obj(item.pricebook_ref).item_id || ""); return { item_id: itemId, item_type: types.get(itemId) || "", quantity: Number(item.quantity) || 0, unit: String(item.unit || "") }; });
  const fields = await projectFieldNumbers(orgId, projectId);
  // A value the caller passes for a field stands even when the project's own fields could not be read.
  if (fields.error && !Object.keys(supplied.fields || {}).length) unavailable.field = fields.error;
  return { measurements, materials, fields: { ...fields.numbers, ...(supplied.fields || {}) }, manual: supplied.manual || {}, unavailable, measurement_source: measurementSource };
}
/** Every pay sheet, or one, priced against the same project so assignees can be compared on the same job. */
export async function evaluateProjectPaySheets(orgId: string, projectId: string, options: { sheet_id?: string; fields?: Record<string, number>; manual?: Record<string, number>; legacy_measurements?: unknown } = {}) {
  const context = await projectPayContext(orgId, projectId, options);
  const sheets = (await listPaySheets(orgId)).filter((sheet) => !options.sheet_id || sheet.id === options.sheet_id);
  return sheets.map((sheet) => evaluatePaySheet(sheet, context));
}

const numbers = { type: "object", additionalProperties: { type: "number" } };
const sheetSchema = zodToJsonSchema(paySheetInputSchema.innerType().omit({ expected_revision: true }).extend({ id: paySheetArchiveSchema.shape.id, revision: paySheetArchiveSchema.shape.expected_revision.unwrap() }), { $refStrategy: "none" }) as Obj;
const requirementSchema = { type: "object", required: ["consumer", "schema_ids", "inputs"], properties: { consumer: { type: "object" }, schema_ids: { type: "array", items: { type: "string" } }, inputs: { type: "array", items: { type: "object", required: ["name", "label", "required", "source"], properties: { name: { type: "string" }, label: { type: "string" }, required: { type: "boolean" }, default: { type: "number" }, source: { type: "object" } }, additionalProperties: false } } }, additionalProperties: false };
const evaluationSchema = { type: "object", required: ["sheet", "lines", "equipment", "unresolved", "missing_inputs", "duration_days", "total_cents", "complete"], properties: { sheet: { type: "object" }, lines: { type: "array", items: { type: "object" } }, equipment: { type: "array", items: { type: "object" } }, unresolved: { type: "array", items: { type: "object" } }, missing_inputs: { type: "array", items: { type: "object" } }, duration_days: { type: ["number", "null"] }, total_cents: { type: "integer" }, complete: { type: "boolean" } }, additionalProperties: false };
/** A published action run by a person carries their session; one run by the platform itself has already been authorized by the publication layer. */
const actor = (ctx: PublicationContext): Actor => (ctx.auth ? ctx.auth : { orgId: ctx.organizationId, userId: "", branchId: ctx.branchId, system: true });
/** A call aimed at one project may only touch that project's lists and commitments. */
async function withinTarget(ctx: PublicationContext, target: TargetRef, projectId: string) {
  if (target.scope === "project" && target.projectId !== projectId) throw forbidden("labor_target_mismatch", "This belongs to a different project.");
}
async function listProject(ctx: PublicationContext, listId: unknown) { return String((await readMaterialList(ctx.organizationId, String(listId || ""))).project_id || ""); }
async function commitmentProject(ctx: PublicationContext, commitmentId: unknown) {
  const found = (await listCommitments(ctx.organizationId)).find((entry) => entry.id === String(commitmentId || ""));
  if (!found) throw badRequest("labor_commitment_unknown", "This commitment is unavailable.");
  return found.project_id;
}
let registered = false;
export function registerPaySheetPublication() {
  if (registered) return;
  registered = true;
  const revision = (value: unknown) => `sha256:${contentHash(value)}`;
  registerDataProvider({ id: "pay-sheets", version: "1", apps: ["materials", "crew"], exports: {
    catalog: { description: "How each assignee is paid: the inputs their pay sheet reads, its pay entries, the equipment they bring and how long their work takes.", schema: { type: "array", items: sheetSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listPaySheets(ctx.organizationId); return { value, revision: revision(value.map((sheet) => [sheet.id, sheet.revision])) }; } },
    requirements: { description: "What every pay sheet needs before it can price a job: the kinds of work it covers and each declared input, required or optional, as a measurement, a material quantity, a project field or a number entered by hand. Compare with measurement-schemas and a project's data to see what is missing for an assignee.", schema: { type: "array", items: requirementSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const sheets = await listPaySheets(ctx.organizationId); return { value: sheets.map(paySheetRequirements), revision: revision(sheets.map((sheet) => [sheet.id, sheet.revision])) }; } },
    evaluation: { description: "Each pay sheet priced against this project's measurements and material lists: pay lines, equipment, estimated days, and any line left unresolved because a required input is missing. Unresolved is never reported as zero. Pass project field values and hand-entered numbers as arguments.", schema: { type: "array", items: evaluationSchema }, schemaVersion: "1", argsSchema: { type: "object", properties: { sheet_id: { type: "string" }, fields: numbers, manual: numbers }, additionalProperties: false }, access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await evaluateProjectPaySheets(ctx.organizationId, ref.target.projectId!, obj(ref.args) as { sheet_id?: string; fields?: Record<string, number>; manual?: Record<string, number> }); return { value, revision: revision(value) }; } }
  } });
  const archived = { type: "object", required: ["id", "archived"], additionalProperties: false, properties: { id: { type: "string" }, archived: { type: "boolean" } } };
  const commitmentSchema = { type: "object", required: ["id", "list_id", "project_id", "revision", "status", "assignee", "lines", "total_cents", "delivery"], properties: { id: { type: "string" }, list_id: { type: "string" }, project_id: { type: "string" }, project_title: { type: "string" }, title: { type: "string" }, revision: { type: "integer" }, status: { enum: ["committed", "superseded", "released"] }, unit: { type: ["object", "null"] }, released_at: { type: "string" }, released_by_user_id: { type: "string" }, release_reason: { type: "string" }, assignee: { type: "object" }, lines: { type: "array", items: { type: "object" } }, total_cents: { type: "integer" }, unpriced_lines: { type: "integer" }, pay_sheets: { type: "array", items: { type: "object" } }, list_revision: { type: "integer" }, content_hash: { type: "string" }, idempotency_key: { type: "string" }, event_error: { type: "string" }, schedule: { type: ["object", "null"] }, note: { type: "string" }, committed_by_user_id: { type: "string" }, committed_at: { type: "string" }, superseded_by: { type: "string" }, delivery: { type: "object" } }, additionalProperties: false };
  const settingSchema = { type: "object", required: ["subject", "method"], properties: { subject: { type: "object" }, method: { enum: ["share", "work_order_email", "custom"] }, email: { type: "string" }, source: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false };
  registerDataProvider({ id: "labor-commitments", version: "1", apps: ["materials", "crew"], exports: {
    project: { description: "Labor lists committed on this project: the frozen lines and totals sent to each assignee, the revision, whether it was superseded or released, and how delivery went. An assignee holds work while one of its commitments is still committed.", schema: { type: "array", items: commitmentSchema }, schemaVersion: "1", access: { scopes: ["project"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await listCommitments(ctx.organizationId, { project_id: ref.target.projectId! }); return { value, revision: revision(value.map((entry) => [entry.id, entry.status, entry.delivery.status])) }; } },
    settings: { description: "How each assignee receives committed work: shared inside FirstMate, emailed a work order, or their own delivery code.", schema: { type: "array", items: settingSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listDeliverySettings(ctx.organizationId); return { value, revision: revision(value) }; } }
  } });
  const unitSchema = { type: "object", required: ["id", "assignee", "name", "revision"], properties: { id: { type: "string" }, assignee: { type: "object" }, parent_unit_id: { type: "string" }, name: { type: "string" }, kind_id: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false };
  registerDataProvider({ id: "assignees", version: "1", apps: ["materials", "crew", "scheduling", "sales"], exports: {
    units: { description: "Units inside each assignee (a person, a group of users or an outside company): the groups within it that each do one job at a time. A unit may sit under another unit of the same assignee. What a unit is called comes from terminology.", schema: { type: "array", items: unitSchema }, schemaVersion: "1", access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx) => { const value = await listUnits(ctx.organizationId); return { value, revision: revision(value) }; } },
    availability: { description: "How much one assignee can take on, from what it is committed to and nothing else: one job at a time for each unit that has no units under it, the commitments each holds, and whether the assignee is over-committed. Pass the assignee as arguments.", schema: { type: "object", required: ["assignee", "capacity", "committed", "available", "over_committed", "units", "unplaced"], properties: { assignee: { type: "object" }, capacity: { type: "integer" }, committed: { type: "integer" }, available: { type: "integer" }, over_committed: { type: "boolean" }, units: { type: "array", items: { type: "object" } }, unplaced: { type: "array", items: { type: "object" } } }, additionalProperties: false }, schemaVersion: "1", argsSchema: { type: "object", required: ["type", "id"], properties: { type: { enum: ["organization_user", "resource_group", "organization_connection"] }, id: { type: "string" } }, additionalProperties: false }, access: { scopes: ["organization"], permissions: ["view_materials"], capabilities: ["platform.materials"], systemKinds: ["work", "module", "agent"] },
      read: async (ctx, ref) => { const value = await assigneeAvailability(ctx.organizationId, { type: String(ref.args?.type) as "organization_user", id: String(ref.args?.id || "") }); return { value, revision: revision(value) }; } }
  } });
  for (const [operation, description, run] of [
    ["release", "release a committed labor list because the work is finished or was taken back, freeing the assignee's capacity.", releaseCommitment],
    ["deliver", "try again to deliver a commitment that is still held and has not reached its assignee.", redeliverCommitment],
    ["confirm-delivery", "record that a commitment was delivered by hand.", confirmDelivery]
  ] as const) registerAction({ id: "labor.commitment." + operation, version: "1", domain: "materials", implementation: backendImplementationDigest(), description, inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" }, reason: { type: "string" }, detail: { type: "string" } }, additionalProperties: false }, outputSchema: commitmentSchema as Obj, policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["platform.materials"], systemKinds: ["work", "module"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: async (ctx, target, input) => { await withinTarget(ctx, target, await commitmentProject(ctx, (input as Obj).id)); return run(ctx.organizationId, operation === "release" ? input : operation === "confirm-delivery" ? { id: (input as Obj).id, ...((input as Obj).detail ? { detail: (input as Obj).detail } : {}) } : { id: (input as Obj).id }, actor(ctx)); } });
  registerAction({ id: "assignees.unit.save", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "create or rename a unit inside an assignee, or move it under another unit.", inputSchema: zodToJsonSchema(unitInputSchema, { $refStrategy: "none" }) as Obj, outputSchema: unitSchema as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => saveUnit(ctx.organizationId, input, actor(ctx)) });
  registerAction({ id: "assignees.unit.archive", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "remove a unit that has no units under it.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }, outputSchema: archived as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => archiveUnit(ctx.organizationId, input, actor(ctx)) });
  registerAction({ id: "labor.list.generate", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "price a project on a labor list's assignee's pay sheet and write the result as the list's lines, keeping lines added by hand. Does not commit the list.", inputSchema: zodToJsonSchema(generateInputSchema, { $refStrategy: "none" }) as Obj, outputSchema: { type: "object", required: ["list", "evaluation", "kept"], properties: { list: { type: "object" }, version: { type: "object" }, evaluation: evaluationSchema, kept: { type: "integer" }, measurement_source: { type: "string" } }, additionalProperties: false }, policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "agent"], idempotency: "required", execute: async (ctx, target, input) => { await withinTarget(ctx, target, await listProject(ctx, (input as Obj).list_id)); return generateLaborList(ctx.organizationId, input, actor(ctx)); } });
  registerAction({ id: "labor.list.commit", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "freeze a labor list as it stands and hand it to its assignee. Committing again makes a new revision.", inputSchema: zodToJsonSchema(commitInputSchema, { $refStrategy: "none" }) as Obj, outputSchema: commitmentSchema as Obj, policy: { scopes: ["organization", "project"], permissions: ["manage_projects"], capabilities: ["platform.materials"], systemKinds: ["work", "module"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: async (ctx, target, input) => { await withinTarget(ctx, target, await listProject(ctx, (input as Obj).list_id)); return commitLaborList(ctx.organizationId, input, actor(ctx)); } });
  registerAction({ id: "labor.delivery-setting.save", version: "1", domain: "materials", implementation: backendImplementationDigest(), description: "choose how an assignee receives committed work.", inputSchema: zodToJsonSchema(deliverySettingSchema, { $refStrategy: "none" }) as Obj, outputSchema: settingSchema as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => saveDeliverySetting(ctx.organizationId, input, actor(ctx)) });
  for (const [operation, description, schema, output, execute] of [
    ["sheet.save", "create a pay sheet or replace its inputs, pay entries, equipment and duration.", paySheetInputSchema, sheetSchema, savePaySheet],
    ["sheet.archive", "remove a pay sheet.", paySheetArchiveSchema, archived, archivePaySheet]
  ] as const) registerAction({ id: "pay-sheets." + operation, version: "1", domain: "materials", implementation: backendImplementationDigest(), description, inputSchema: zodToJsonSchema(schema, { $refStrategy: "none" }) as Obj, outputSchema: output as Obj, policy: { scopes: ["organization"], permissions: ["manage_company_settings"], capabilities: ["platform.materials"] }, effect: "write", executionKinds: ["api", "module", "agent", "work"], idempotency: "required", execute: (ctx, _target, input) => execute(ctx.organizationId, input, actor(ctx)) });
}
