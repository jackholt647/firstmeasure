import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { definitionForKey, listMeasurementDefinitions, listMeasurementSchemas } from "../platform/publication/measurement-schemas.js";

/**
 * A pay sheet is how one crew, person or subcontractor is paid, written as data that can be evaluated.
 *
 * It declares the inputs it reads (a measurement, a quantity of material, a production field, or a number someone
 * types) and whether each is required. Its entries turn those inputs into pay lines. Nothing about a job is
 * assumed: two subs priced on the same roof produce different lines because their sheets differ, and a sheet that
 * reads no measurement (hourly, salary) names no kind of work at all.
 */
export const PAY_SHEET_COLLECTION = "labor_pay_sheets";
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const name = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/, "Use a short lowercase name such as roof_squares.");
const cents = z.number().int().min(0).max(1_000_000_000);
const amount = z.number().finite().min(0).max(1e9);

const inputSchema = z.object({
  name,
  label: z.string().trim().max(200).optional(),
  source: z.discriminatedUnion("kind", [
    // One dictionary measurement. per_structure asks for one value per structure where the project has them.
    z.object({ kind: z.literal("measurement"), definition: z.string().trim().min(1).max(120), per_structure: z.boolean().optional() }).strict(),
    // The quantity of material on the project's lists, for one price book item or for every item of a type.
    z.object({ kind: z.literal("material"), item_id: id.optional(), item_type: z.string().trim().min(1).max(200).optional() }).strict(),
    // A numeric project field that production fills in, such as pack-out distance.
    z.object({ kind: z.literal("field"), key: z.string().trim().min(1).max(200) }).strict(),
    // A number entered for this job, such as hours.
    z.object({ kind: z.literal("manual") }).strict()
  ]),
  /** A required input that is missing leaves its lines unresolved. An optional one falls back to `default`, or to nothing. */
  required: z.boolean().default(true),
  default: amount.optional()
}).strict();
const entrySchema = z.object({
  id: id.optional(),
  label: z.string().trim().min(1).max(300),
  /** piece_rate and hourly multiply an input by the rate. flat is one amount. salary is recorded but never charged to a job. */
  kind: z.enum(["piece_rate", "hourly", "flat", "salary"]),
  unit: z.string().trim().max(60).optional(),
  rate_cents: cents,
  input: name.optional(),
  multiplier: amount.optional(),
  minimum_cents: cents.optional(),
  /** Charge this entry only when the named input is above zero. */
  when: name.optional()
}).strict();
const equipmentSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  equipment_type_id: id.optional(),
  /** Included equipment comes with the crew at no charge; otherwise rate_cents is charged once per job. */
  included: z.boolean().default(true),
  rate_cents: cents.optional()
}).strict();
export const paySheetInputSchema = z.object({
  id: id.optional(),
  subject: z.object({ type: z.enum(["organization_user", "resource_group", "organization_connection"]), id }).strict(),
  name: z.string().trim().min(1).max(200),
  /** Measurement schemas (kinds of work) this sheet prices. Required as soon as any input reads a measurement. */
  schema_ids: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  inputs: z.array(inputSchema).max(100).default([]),
  entries: z.array(entrySchema).max(300).default([]),
  equipment: z.array(equipmentSchema).max(100).default([]),
  /** How long the work takes, for scheduling: an input divided by what the crew gets through in a day. */
  duration: z.object({ input: name, units_per_day: z.number().finite().positive().max(1e9) }).strict().nullable().optional(),
  expected_revision: z.number().int().nonnegative().optional()
}).strict().superRefine((sheet, context) => {
  const issue = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
  const inputs = new Map<string, z.infer<typeof inputSchema>>();
  for (const input of sheet.inputs) { if (inputs.has(input.name)) issue(`Input ${input.name} is declared twice.`); inputs.set(input.name, input); }
  const schemas = listMeasurementSchemas().filter((schema) => sheet.schema_ids.includes(schema.id));
  for (const schemaId of sheet.schema_ids) if (!schemas.some((schema) => schema.id === schemaId)) issue(`There is no measurement schema called ${schemaId}.`);
  const allowed = new Set(schemas.flatMap((schema) => schema.measurements.map((entry) => entry.definition)));
  const known = new Set(listMeasurementDefinitions().map((definition) => definition.id));
  for (const input of sheet.inputs) {
    if (input.source.kind === "material" && !!input.source.item_id === !!input.source.item_type) issue(`Input ${input.name} names one price book item or one item type.`);
    if (input.source.kind !== "measurement") continue;
    if (!known.has(input.source.definition)) issue(`${input.source.definition} is not in the measurement dictionary.`);
    // Labor terms mean different things in different trades, so a measurement is only read through a declared kind of work.
    else if (!sheet.schema_ids.length) issue(`Input ${input.name} reads a measurement, so the sheet must name the kind of work it prices.`);
    else if (!allowed.has(input.source.definition)) issue(`${input.source.definition} is not part of ${sheet.schema_ids.join(" or ")}.`);
  }
  for (const entry of sheet.entries) {
    for (const reference of [entry.input, entry.when]) if (reference && !inputs.has(reference)) issue(`Entry ${entry.label} reads ${reference}, which is not a declared input.`);
    if (entry.kind === "piece_rate" && !entry.input) issue(`Piece rate ${entry.label} needs the input it is paid on.`);
  }
  if (sheet.duration && !inputs.has(sheet.duration.input)) issue(`Duration reads ${sheet.duration.input}, which is not a declared input.`);
});
export const paySheetArchiveSchema = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict();
export type PaySheetInput = z.infer<typeof inputSchema>;
export type PaySheet = Omit<z.infer<typeof paySheetInputSchema>, "expected_revision" | "id"> & { id: string; revision: number };

/** What a sheet needs in order to price a job, in the same terms the data layer publishes. */
export function paySheetRequirements(sheet: Pick<PaySheet, "id" | "name" | "subject" | "schema_ids" | "inputs">) {
  return {
    consumer: { kind: "pay_sheet", id: sheet.id, name: sheet.name, subject: sheet.subject },
    schema_ids: sheet.schema_ids,
    inputs: sheet.inputs.map((input) => ({ name: input.name, label: input.label || input.name, required: input.required, ...(input.default !== undefined ? { default: input.default } : {}), source: input.source }))
  };
}

export type PayContext = {
  /** A measurement dataset value: `{ measurements, structures? }`. */
  measurements?: unknown;
  /** Material on the project's lists. */
  materials?: { item_id: string; item_type: string; quantity: number }[];
  fields?: Record<string, number>;
  manual?: Record<string, number>;
};
type Resolved = { value: number | null; structures: { id: string; name: string; value: number }[]; missing: boolean };
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function measured(source: unknown, definitionId: string, unit: string) {
  let total: number | null = null;
  for (const [key, entry] of Object.entries(obj(source))) {
    if (definitionForKey(key)?.id !== definitionId) continue;
    const value = finite(obj(entry).value);
    // A value in another unit is not this measurement; it is never converted by guesswork.
    if (value === null || obj(entry).unit !== unit || obj(entry).status === "missing" || obj(entry).status === "pending") continue;
    total = (total || 0) + value;
  }
  return total;
}
function resolveInput(input: PaySheetInput, context: PayContext): Resolved {
  const source = input.source;
  let value: number | null = null;
  let structures: Resolved["structures"] = [];
  if (source.kind === "measurement") {
    const unit = listMeasurementDefinitions().find((definition) => definition.id === source.definition)?.unit || "";
    value = measured(obj(context.measurements).measurements, source.definition, unit);
    if (source.per_structure) {
      structures = (Array.isArray(obj(context.measurements).structures) ? obj(context.measurements).structures as unknown[] : []).map((structure) => ({ id: String(obj(structure).id || ""), name: String(obj(structure).name || ""), value: measured(obj(structure).measurements, source.definition, unit) })).filter((structure): structure is { id: string; name: string; value: number } => structure.value !== null);
      if (value === null && structures.length) value = structures.reduce((sum, structure) => sum + structure.value, 0);
    }
  } else if (source.kind === "material") {
    const matching = (context.materials || []).filter((line) => (source.item_id ? line.item_id === source.item_id : line.item_type.toLowerCase() === source.item_type!.toLowerCase()));
    value = matching.length ? matching.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0) : null;
  } else if (source.kind === "field") value = finite(context.fields?.[source.key]);
  else value = finite(context.manual?.[input.name]);
  if (value === null && !input.required && input.default !== undefined) value = input.default;
  return { value, structures, missing: value === null };
}

export type PayLine = { entry_id: string; label: string; kind: string; quantity: number | null; unit: string; rate_cents: number; total_cents: number | null; structure_id?: string; structure_name?: string };
/**
 * Prices one job on one sheet. A line whose required input is missing comes back unresolved, never as zero, and the
 * result says which inputs are missing. An optional input that is absent contributes nothing.
 */
export function evaluatePaySheet(sheet: PaySheet, context: PayContext) {
  const inputs = new Map(sheet.inputs.map((input) => [input.name, { input, ...resolveInput(input, context) }]));
  const lines: PayLine[] = [], unresolved: { entry_id: string; label: string; input: string; reason: string }[] = [];
  sheet.entries.forEach((entry, index) => {
    const entryId = entry.id || `entry_${index + 1}`, unit = entry.unit || (entry.kind === "hourly" ? "hour" : entry.kind === "flat" ? "job" : "");
    const gate = entry.when ? inputs.get(entry.when)! : null;
    if (gate && !(Number(gate.value) > 0)) return;
    if (entry.kind === "salary") { lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: null, unit: unit || "period", rate_cents: entry.rate_cents, total_cents: null }); return; }
    if (entry.kind === "flat" && !entry.input) { lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: 1, unit, rate_cents: entry.rate_cents, total_cents: entry.rate_cents }); return; }
    const resolved = entry.input ? inputs.get(entry.input)! : null;
    if (!resolved || resolved.missing) {
      // An optional input with nothing recorded and no default simply does not apply to this job.
      if (resolved && !resolved.input.required) return;
      unresolved.push({ entry_id: entryId, label: entry.label, input: entry.input || "", reason: entry.input ? `${resolved?.input.label || entry.input} is not available for this job.` : "Enter the hours for this job." });
      return;
    }
    const price = (quantity: number) => Math.max(entry.minimum_cents || 0, Math.round(quantity * (entry.multiplier ?? 1) * entry.rate_cents));
    const perStructure = resolved.input.source.kind === "measurement" && resolved.input.source.per_structure && resolved.structures.length > 1;
    if (perStructure) for (const structure of resolved.structures) { const quantity = structure.value * (entry.multiplier ?? 1); if (quantity > 0) lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity, unit, rate_cents: entry.rate_cents, total_cents: price(structure.value), structure_id: structure.id, structure_name: structure.name }); }
    else { const quantity = Number(resolved.value) * (entry.multiplier ?? 1); if (quantity > 0 || entry.kind === "flat") lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: entry.kind === "flat" ? 1 : quantity, unit, rate_cents: entry.rate_cents, total_cents: entry.kind === "flat" ? entry.rate_cents : price(Number(resolved.value)) }); }
  });
  const basis = sheet.duration ? inputs.get(sheet.duration.input)! : null;
  // Scheduling works in half days; anything measurable rounds up to the next half.
  const duration_days = sheet.duration && basis && !basis.missing ? Math.ceil((Number(basis.value) / sheet.duration.units_per_day) * 2) / 2 : null;
  return {
    sheet: { id: sheet.id, name: sheet.name, subject: sheet.subject, revision: sheet.revision },
    lines,
    equipment: sheet.equipment.map((item, index) => ({ id: item.id || `equipment_${index + 1}`, name: item.name, ...(item.equipment_type_id ? { equipment_type_id: item.equipment_type_id } : {}), included: item.included, total_cents: item.included ? 0 : item.rate_cents || 0 })),
    unresolved,
    missing_inputs: [...inputs.values()].filter((entry) => entry.missing).map((entry) => ({ name: entry.input.name, label: entry.input.label || entry.input.name, required: entry.input.required, source: entry.input.source })),
    duration_days,
    total_cents: lines.reduce((sum, line) => sum + (line.total_cents || 0), 0) + sheet.equipment.reduce((sum, item) => sum + (item.included ? 0 : item.rate_cents || 0), 0),
    complete: unresolved.length === 0
  };
}

function requireWrite(orgId: string, auth: PlatformAuthContext) {
  if (!auth || auth.orgId !== orgId || !hasPermission(auth, "manage_company_settings")) throw forbidden("pay_sheet_write_denied", "Pay sheet editing requires company settings access.");
}
function row(document: { id: string; revision?: number; data: JsonObject }): PaySheet {
  const data = document.data as unknown as Omit<PaySheet, "id" | "revision">;
  return { id: document.id, subject: data.subject, name: data.name, schema_ids: data.schema_ids || [], inputs: data.inputs || [], entries: data.entries || [], equipment: data.equipment || [], duration: data.duration ?? null, revision: Number(document.revision || 0) };
}
export async function listPaySheets(orgId: string): Promise<PaySheet[]> {
  return (await listDocuments(orgId, PAY_SHEET_COLLECTION)).filter((document) => !document.data.archived_at).map(row).sort((a, b) => a.name.localeCompare(b.name));
}
export async function readPaySheet(orgId: string, sheetId: string) {
  const sheet = (await listPaySheets(orgId)).find((entry) => entry.id === sheetId);
  if (!sheet) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  return sheet;
}
export async function savePaySheet(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireWrite(orgId, auth);
  const parsed = paySheetInputSchema.parse(input);
  const existing = parsed.id ? (await listPaySheets(orgId)).find((entry) => entry.id === parsed.id) || null : null;
  if (parsed.id && !existing) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  const { id: _id, expected_revision: _revision, ...data } = parsed;
  const document = await upsertDocument(orgId, PAY_SHEET_COLLECTION, {
    ...(existing ? { id: existing.id, expected_revision: parsed.expected_revision ?? existing.revision } : {}),
    data: { ...data, duration: data.duration ?? null, entries: data.entries.map((entry, index) => ({ ...entry, id: entry.id || `entry_${index + 1}` })), updated_by_user_id: auth.userId } as unknown as JsonObject,
    metadata: { kind: "labor_pay_sheet", subject_type: parsed.subject.type, subject_id: parsed.subject.id }
  }, { replace: true });
  return row(document as { id: string; revision?: number; data: JsonObject });
}
export async function archivePaySheet(orgId: string, input: unknown, auth: PlatformAuthContext) {
  requireWrite(orgId, auth);
  const parsed = paySheetArchiveSchema.parse(input);
  const document = (await listDocuments(orgId, PAY_SHEET_COLLECTION)).find((entry) => entry.id === parsed.id && !entry.data.archived_at);
  if (!document) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  await upsertDocument(orgId, PAY_SHEET_COLLECTION, { id: parsed.id, expected_revision: parsed.expected_revision ?? Number(document.revision || 0), data: { ...document.data, archived_at: new Date().toISOString(), archived_by_user_id: auth.userId }, metadata: { kind: "labor_pay_sheet" } }, { replace: true });
  return { id: parsed.id, archived: true };
}
