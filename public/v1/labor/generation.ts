import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { measurementSchemaIdsForScope } from "../platform/publication/measurement-schemas.js";
import { createMaterialVersion, patchMaterialList, readMaterialList } from "../materials/storage.js";
import { ASSIGNEE_TYPE_BY_KIND, requireActor, requireAssignee, type Actor, type Assignee } from "./assignees.js";
import { evaluatePaySheet, listPaySheets, type PaySheet } from "./pay-sheets.js";
import { projectPayContext } from "./pay-sheet-publication.js";

/**
 * A labor list's lines come from its assignee's pay sheet. Generating prices the project on that sheet and writes the
 * result as the list's lines: pay lines, the equipment the assignee brings, and a line for anything that could not be
 * priced yet, so nothing is silently left out. Lines someone added by hand are kept. Generating again replaces only
 * what generation wrote. Nothing here is committed: committing the list is a separate step.
 */
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const numbers = z.record(z.string().max(200), z.number().finite());
/** `legacy_measurements` is what the Project tab holds for a project with no measurement dataset; see legacyMeasurements. */
const legacy = z.record(z.string().max(120), z.object({ value: z.number().finite().nonnegative(), unit: z.string().max(40) }).strict());
export const generateInputSchema = z.object({ list_id: id, sheet_id: id.optional(), manual: numbers.optional(), fields: numbers.optional(), legacy_measurements: legacy.optional() }).strict();

const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const GENERATED = "generated_from_pay_sheet";

/** The assignee a list is assigned to, in assignee terms, or null when it is not assigned. */
export function listAssignee(list: JsonObject): (Assignee & { name: string }) | null {
  const reference = obj(obj(list.assignment).work_resource_ref), type = ASSIGNEE_TYPE_BY_KIND[text(reference.kind)];
  return type && text(reference.id) ? { type, id: text(reference.id), name: text(reference.name) } : null;
}
/**
 * The one pay sheet that applies to this list: the sheet asked for, else the assignee's sheet for the list's kind of
 * work, else the assignee's only sheet. More than one candidate and no way to tell is an error, never a guess.
 */
export async function paySheetForList(orgId: string, list: JsonObject, assignee: Assignee, sheetId = ""): Promise<PaySheet> {
  const sheets = (await listPaySheets(orgId)).filter((sheet) => sheet.subject.type === assignee.type && sheet.subject.id === assignee.id);
  if (!sheets.length) throw badRequest("labor_generate_no_sheet", "This assignee has no pay sheet yet, so there is nothing to generate from.");
  if (sheetId) { const chosen = sheets.find((sheet) => sheet.id === sheetId); if (!chosen) throw badRequest("pay_sheet_unknown", "That pay sheet does not belong to this list's assignee."); return chosen; }
  if (sheets.length === 1) return sheets[0]!;
  let schemas: string[] = [];
  const templateId = text(list.scope_template_id);
  if (templateId) {
    const { readScopeTemplateVersion } = await import("../scopes/storage.js");
    schemas = measurementSchemaIdsForScope(obj((await readScopeTemplateVersion(orgId, text(list.branch_id) || "default", templateId).catch(() => null))?.definition));
  }
  const matching = sheets.filter((sheet) => (schemas.length ? sheet.schema_ids.some((schema) => schemas.includes(schema)) : !sheet.schema_ids.length));
  if (matching.length === 1) return matching[0]!;
  throw badRequest("labor_generate_sheet_ambiguous", "This assignee has more than one pay sheet that could apply. Choose which to use.");
}

/** What generating would write, without writing it: the evaluation and the lines it becomes. Reads only. */
export async function previewLaborList(orgId: string, input: unknown) {
  const parsed = generateInputSchema.parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_generate_not_labor", "Only a labor list is generated from a pay sheet.");
  if (text(list.status) === "archived") throw badRequest("labor_generate_archived", "This list is archived.");
  const assignee = listAssignee(list);
  if (!assignee) throw badRequest("labor_generate_unassigned", "Assign this list before generating it.");
  await requireAssignee(orgId, assignee);
  const sheet = await paySheetForList(orgId, list, assignee, parsed.sheet_id);
  // A number only a person can supply, paid directly at a rate (hours at an hourly rate, extra layers at a price each),
  // is typed into the list as that line's quantity. What is already typed there is what the job is priced on.
  const current = (Array.isArray(list.current_items) ? list.current_items : []).map(obj);
  const typedInList = sheet.entries.flatMap((entry) => { const source = sheet.inputs.find((candidate) => candidate.name === entry.input); return entry.id && source?.source.kind === "manual" && (entry.kind === "hourly" || entry.kind === "piece_rate" || entry.kind === "cost_rate") ? [{ entry, input: source }] : []; });
  const typed: Record<string, number> = {};
  for (const { entry, input: source } of typedInList) {
    const line = current.find((item) => obj(item.metadata)[GENERATED] === true && obj(item.metadata).pay_entry_id === entry.id && obj(item.metadata).pay_sheet_id === sheet.id);
    const quantity = Number(line?.quantity);
    if (quantity > 0) typed[source.name] = quantity / (entry.multiplier ?? 1);
  }
  const context = await projectPayContext(orgId, text(list.project_id), { fields: parsed.fields, manual: { ...typed, ...(parsed.manual || {}) }, legacy_measurements: parsed.legacy_measurements });
  const evaluation = evaluatePaySheet(sheet, context);
  const stamp = (extra: JsonObject = {}) => ({ [GENERATED]: true, pay_sheet_id: sheet.id, pay_sheet_revision: sheet.revision, ...extra });
  const items: JsonObject[] = [];
  evaluation.lines.forEach((line, index) => {
    // Salary is recorded on the sheet and paid through payroll; it is not a cost of this job.
    if (line.kind === "salary") return;
    const quantity = Number(line.quantity) || 0, total = (line.total_cents || 0) / 100;
    items.push({
      id: `ps_${line.entry_id}${line.structure_id ? `_${line.structure_id}` : ""}${line.kind === "minimum" ? "_min" : ""}_${index}`, section: "labor",
      name: line.structure_name ? `${line.label} - ${line.structure_name}` : line.label, quantity, unit: line.unit || "ea",
      // The list multiplies quantity by unit price; the line total is stated too so rounding never moves it.
      projected_unit_price: quantity ? total / quantity : total, projected_total: total,
      ...(line.structure_id ? { structure_id: line.structure_id, structure_name: line.structure_name } : {}),
      metadata: stamp({ pay_entry_id: line.entry_id, compensation_kind: line.kind === "hourly" || line.kind === "cost_rate" ? line.kind : "piece_rate", ...(line.kind === "cost_rate" ? { projection_only: true } : {}) })
    });
  });
  // A typed line that has no quantity yet is on the list at its rate, waiting for the number. Nothing is asked up front.
  const written = new Set(evaluation.lines.map((line) => line.entry_id));
  for (const { entry, input: source } of typedInList) {
    if (written.has(entry.id!)) continue;
    items.push({ id: `ps_${entry.id}_typed`, section: "labor", name: entry.label, quantity: 0, unit: entry.unit || (entry.kind === "piece_rate" ? "ea" : "hour"), projected_unit_price: entry.rate_cents / 100, projected_total: 0, metadata: stamp({ pay_entry_id: entry.id, compensation_kind: entry.kind, ...(entry.kind === "cost_rate" ? { projection_only: true } : {}), quantity_needed: source.required, quantity_label: source.label || source.name }) });
  }
  const typedIds = new Set(typedInList.map(({ entry }) => entry.id));
  // Anything else that could not be priced is on the list as a line with no price, saying what it is waiting for.
  evaluation.unresolved.filter((entry) => !typedIds.has(entry.entry_id)).forEach((entry, index) => items.push({ id: `ps_unresolved_${entry.entry_id}_${index}`, section: "labor", name: entry.label, quantity: 0, unit: "", description: entry.reason, metadata: stamp({ pay_entry_id: entry.entry_id, unresolved: true, unresolved_reason: entry.reason, unresolved_input: entry.input }) }));
  evaluation.equipment.forEach((entry, index) => items.push({ id: `ps_equipment_${index}`, section: "labor", name: entry.name, quantity: 1, unit: "job", projected_unit_price: entry.total_cents / 100, projected_total: entry.total_cents / 100, metadata: stamp({ equipment: true, equipment_included: entry.included, ...(entry.equipment_type_id ? { equipment_type_id: entry.equipment_type_id } : {}) }) }));
  const kept = current.filter((item) => obj(item.metadata)[GENERATED] !== true);
  // Numbers a person must supply that are not a line's quantity (a gate, a duration) still have to be asked for.
  const typedInputs = new Set(typedInList.map(({ input: source }) => source.name));
  const ask = sheet.inputs.filter((candidate) => candidate.source.kind === "manual" && !typedInputs.has(candidate.name)).map((candidate) => ({ name: candidate.name, label: candidate.label || candidate.name, required: candidate.required }));
  return { list, assignee, sheet, evaluation, items: [...items, ...kept], kept: kept.length, ask, measurement_source: context.measurement_source };
}

/** Prices the project on the list's assignee's pay sheet and writes the result as the list's lines. */
export async function generateLaborList(orgId: string, input: unknown, actor: Actor) {
  requireActor(orgId, actor, "manage_projects", "labor_generate_denied", "Generating labor requires project management access.");
  const parsed = generateInputSchema.parse(input);
  const preview = await previewLaborList(orgId, parsed);
  const auth = actor as PlatformAuthContext;
  const version = await createMaterialVersion(orgId, parsed.list_id, { expected_revision: Number(preview.list.revision), reason: "revision", notes: `Generated from ${preview.sheet.name}`, items: preview.items }, auth);
  const current = await readMaterialList(orgId, parsed.list_id);
  // What it was generated from, so the list can say when its sheet or its inputs have moved on.
  const generation = { pay_sheet_id: preview.sheet.id, pay_sheet_revision: preview.sheet.revision, pay_sheet_name: preview.sheet.name, generated_at: new Date().toISOString(), generated_by_user_id: text(actor.userId), duration_days: preview.evaluation.duration_days, measurement_source: preview.measurement_source, complete: preview.evaluation.complete, total_cents: preview.evaluation.total_cents, manual: parsed.manual || {}, missing_inputs: preview.evaluation.missing_inputs.map((entry) => ({ name: entry.name, label: entry.label, required: entry.required, kind: entry.source.kind, reason: entry.reason })) };
  const list = await patchMaterialList(orgId, parsed.list_id, { expected_revision: Number(current.revision), metadata: { ...obj(current.metadata), labor_generation: generation } }, auth);
  return { list, version, evaluation: preview.evaluation, kept: preview.kept, measurement_source: preview.measurement_source };
}

/**
 * What each assignee would be paid for this list's project, so one can be chosen: every assignee that has a pay sheet,
 * priced on the same job. An assignee with several sheets is priced on the one that applies to this list.
 */
export async function compareAssigneesForList(orgId: string, input: unknown) {
  const parsed = z.object({ list_id: id, manual: numbers.optional(), fields: numbers.optional(), legacy_measurements: legacy.optional() }).strict().parse(input);
  const list = await readMaterialList(orgId, parsed.list_id);
  if (text(list.resource_type) !== "labor") throw badRequest("labor_generate_not_labor", "Only a labor list is priced from pay sheets.");
  const context = await projectPayContext(orgId, text(list.project_id), { fields: parsed.fields, manual: parsed.manual, legacy_measurements: parsed.legacy_measurements });
  const sheets = await listPaySheets(orgId);
  const assignees = new Map<string, Assignee>();
  for (const sheet of sheets) assignees.set(`${sheet.subject.type}:${sheet.subject.id}`, sheet.subject);
  const rows = [];
  for (const assignee of assignees.values()) {
    const found = await requireAssignee(orgId, assignee).catch(() => null);
    if (!found) continue;
    const sheet = await paySheetForList(orgId, list, assignee).catch(() => null);
    if (!sheet) { rows.push({ assignee: { ...assignee, name: found.name }, sheet: null, total_cents: null, complete: false, hourly_rate_cents: null, cost_rate_cents: null, awaiting_hours: false, duration_days: null, duration_basis: null, unresolved: [], missing_inputs: [], equipment: [], reason: "More than one pay sheet could apply." }); continue; }
    const evaluation = evaluatePaySheet(sheet, context);
    const hourly = sheet.entries.find((entry) => entry.kind === "hourly"), costed = sheet.entries.find((entry) => entry.kind === "cost_rate");
    // An assignee priced on time has no job price until hours are typed into its list; it is described by its rate instead.
    const timed = (entryId: string) => { const kind = sheet.entries.find((candidate) => candidate.id === entryId)?.kind; return kind === "hourly" || kind === "cost_rate"; };
    const awaitingHours = !evaluation.complete && !!(hourly || costed) && evaluation.unresolved.every((entry) => timed(entry.entry_id));
    rows.push({ assignee: { ...assignee, name: found.name }, sheet: { id: sheet.id, name: sheet.name, revision: sheet.revision }, total_cents: evaluation.total_cents, complete: evaluation.complete, hourly_rate_cents: hourly ? hourly.rate_cents : null, cost_rate_cents: costed ? costed.rate_cents : null, awaiting_hours: awaitingHours, duration_days: evaluation.duration_days, duration_basis: evaluation.duration_basis, unresolved: evaluation.unresolved, missing_inputs: evaluation.missing_inputs, equipment: evaluation.equipment, reason: "" });
  }
  return rows.sort((a, b) => Number(b.complete) - Number(a.complete) || (a.total_cents ?? Infinity) - (b.total_cents ?? Infinity) || a.assignee.name.localeCompare(b.assignee.name));
}
