import { z } from "zod";
import { badRequest } from "../platform/errors.js";
import { listDocuments, upsertDocument, type JsonObject } from "../platform/storage.js";
import { listMeasurementDefinitions, listMeasurementSchemas, measurementAmounts, measurementBase, measurementWhole } from "../platform/publication/measurement-schemas.js";
import { workItem, workItemMeasure, workItemsForSchemas } from "../platform/publication/work-items.js";
import { assigneeSchema, requireActor, requireAssignee, type Actor } from "./assignees.js";

/**
 * A pay sheet is how one assignee (a person, a group of users or an outside company) is paid, written as data that can be evaluated.
 *
 * It declares the inputs it reads (a measurement, a quantity of material, a production field, or a number someone
 * types) and whether each is required. Its entries turn those inputs into pay lines. Nothing about a job is
 * assumed: two subs priced on the same roof produce different lines because their sheets differ, and a sheet that
 * reads no measurement (hourly, salary) names no kind of work at all.
 *
 * A sheet is also the mapping between how the assignee is paid and the work a job requires (see
 * platform/publication/work-items.ts). Each entry says which work items it pays for; `work` says which items are done
 * at no separate charge and roughly how long each takes. An item that is neither is not offered on this sheet.
 */
export const PAY_SHEET_COLLECTION = "labor_pay_sheets";
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
const name = z.string().trim().regex(/^[a-z][a-z0-9_]{0,59}$/, "Use a short lowercase name such as roof_squares.");
const cents = z.number().int().min(0).max(1_000_000_000);
const amount = z.number().finite().min(0).max(1e9);
const workItemId = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120);

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
    z.object({ kind: z.literal("manual") }).strict(),
    // Hours estimated from the work the job requires and the sheet's own hours for each item. A number typed for the
    // job replaces the estimate.
    z.object({ kind: z.literal("work_hours") }).strict()
  ]),
  /** A required input that is missing leaves its lines unresolved. An optional one falls back to `default`, or to nothing. */
  required: z.boolean().default(true),
  default: amount.optional()
}).strict();
const entrySchema = z.object({
  id: id.optional(),
  label: z.string().trim().min(1).max(300),
  /**
   * piece_rate and hourly multiply an input by the rate and are what the assignee is paid. flat is one amount.
   * cost_rate is for salaried people: hours at what their time costs the business. It projects the job's cost and is
   * never paid out; their pay is their salary. salary is recorded but never charged to a job.
   */
  kind: z.enum(["piece_rate", "hourly", "flat", "salary", "cost_rate"]),
  unit: z.string().trim().max(60).optional(),
  rate_cents: cents,
  input: name.optional(),
  multiplier: amount.optional(),
  minimum_cents: cents.optional(),
  /** Charge this entry only when the named input is above zero. */
  when: name.optional(),
  /** The work items and functions this entry pays for. An entry that covers none is always charged. */
  covers: z.array(workItemId).max(50).default([]),
  /**
   * counts: this entry is the pay for what it covers. adjusts: it only changes the price of work another entry pays
   * for, such as a steep charge. Left out, it is worked out from what the entry reads: a part of the measurement the
   * work is sized by adjusts, unless the sheet's parts add up to the whole.
   */
  role: z.enum(["counts", "adjusts"]).optional()
}).strict();
const equipmentSchema = z.object({
  id: id.optional(),
  name: z.string().trim().min(1).max(200),
  equipment_type_id: id.optional(),
  /** Included equipment comes with the assignee at no charge; otherwise rate_cents is charged once per job. */
  included: z.boolean().default(true),
  rate_cents: cents.optional(),
  /**
   * The functions this equipment fulfils, such as debris disposal. per_load means it can be emptied and used again, so
   * its capacity never limits the job; otherwise capacity is all it holds.
   */
  provides: z.array(z.object({ item: workItemId, capacity: amount.optional(), per_load: z.boolean().default(false) }).strict()).max(20).default([])
}).strict();
const workSchema = z.object({
  item: workItemId,
  /** Done as part of the job at no separate charge. */
  included: z.boolean().default(false),
  /** Roughly how many hours one unit of this item takes. An estimate that follows the shape of the work, not a promise. */
  hours_per_unit: amount.optional()
}).strict();
export const paySheetInputSchema = z.object({
  id: id.optional(),
  subject: assigneeSchema,
  name: z.string().trim().min(1).max(200),
  /** Measurement schemas (kinds of work) this sheet prices. Required as soon as any input reads a measurement. */
  schema_ids: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  inputs: z.array(inputSchema).max(100).default([]),
  entries: z.array(entrySchema).max(300).default([]),
  equipment: z.array(equipmentSchema).max(100).default([]),
  /** Work items done at no separate charge, and the hours each item takes. What an entry pays for is on the entry. */
  work: z.array(workSchema).max(200).default([]),
  /**
   * How long the work takes, for scheduling: an input divided by what the assignee gets through in a day, or the
   * hours estimated from the work divided by the hours worked in a day.
   */
  duration: z.union([z.object({ input: name, units_per_day: z.number().finite().positive().max(1e9) }).strict(), z.object({ hours_per_day: z.number().finite().positive().max(24) }).strict()]).nullable().optional(),
  expected_revision: z.number().int().nonnegative().optional()
}).strict().superRefine((sheet, context) => {
  // Each issue names the field it is about, so an editor can show it there.
  const issue = (message: string, path: (string | number)[] = []) => context.addIssue({ code: z.ZodIssueCode.custom, message, path });
  const inputs = new Map<string, z.infer<typeof inputSchema>>();
  sheet.inputs.forEach((input, index) => { if (inputs.has(input.name)) issue(`Input ${input.name} is declared twice.`, ["inputs", index, "name"]); inputs.set(input.name, input); });
  const schemas = listMeasurementSchemas().filter((schema) => sheet.schema_ids.includes(schema.id));
  for (const schemaId of sheet.schema_ids) if (!schemas.some((schema) => schema.id === schemaId)) issue(`There is no measurement schema called ${schemaId}.`, ["schema_ids"]);
  const allowed = new Set(schemas.flatMap((schema) => schema.measurements.map((entry) => entry.definition)));
  const known = new Set(listMeasurementDefinitions().map((definition) => definition.id));
  sheet.inputs.forEach((input, index) => {
    if (input.source.kind === "material" && !!input.source.item_id === !!input.source.item_type) issue(`Input ${input.name} names one price book item or one item type.`, ["inputs", index, "source"]);
    if (input.source.kind !== "measurement") return;
    const at = ["inputs", index, "source", "definition"];
    if (!known.has(input.source.definition)) issue(`${input.source.definition} is not in the measurement dictionary.`, at);
    // Labor terms mean different things in different trades, so a measurement is only read through a declared kind of work.
    else if (!sheet.schema_ids.length) issue(`Input ${input.name} reads a measurement, so the sheet must name the kind of work it prices.`, at);
    else if (!allowed.has(input.source.definition)) issue(`${input.source.definition} is not part of ${sheet.schema_ids.join(" or ")}.`, at);
  });
  sheet.entries.forEach((entry, index) => {
    for (const [field, reference] of [["input", entry.input], ["when", entry.when]] as const) if (reference && !inputs.has(reference)) issue(`Entry ${entry.label} reads ${reference}, which is not a declared input.`, ["entries", index, field]);
    if (entry.kind === "piece_rate" && !entry.input) issue(`Piece rate ${entry.label} needs the input it is paid on.`, ["entries", index, "input"]);
  });
  if (sheet.duration && "input" in sheet.duration && !inputs.has(sheet.duration.input)) issue(`Duration reads ${sheet.duration.input}, which is not a declared input.`, ["duration", "input"]);
  // Work means different things in different trades, so it is only named through a declared kind of work.
  const offered = new Set(workItemsForSchemas(sheet.schema_ids));
  const named: [string, (string | number)[]][] = [
    ...sheet.entries.flatMap((entry, index) => entry.covers.map((item, at): [string, (string | number)[]] => [item, ["entries", index, "covers", at]])),
    ...sheet.work.map((entry, index): [string, (string | number)[]] => [entry.item, ["work", index, "item"]]),
    ...sheet.equipment.flatMap((item, index) => item.provides.map((entry, at): [string, (string | number)[]] => [entry.item, ["equipment", index, "provides", at, "item"]]))
  ];
  const reported = new Set<string>();
  for (const [item, path] of named) {
    if (reported.has(item)) continue;
    reported.add(item);
    if (!workItem(item)) issue(`${item} is not in the work item dictionary.`, path);
    else if (!offered.has(item)) issue(sheet.schema_ids.length ? `${item} is not something ${sheet.schema_ids.join(" or ")} requires.` : `The sheet names ${item}, so it must name the kind of work it prices.`, path);
  }
  const listed = new Set<string>();
  sheet.work.forEach((entry, index) => { if (listed.has(entry.item)) issue(`${entry.item} is listed twice under work.`, ["work", index, "item"]); listed.add(entry.item); });
  sheet.equipment.forEach((item, index) => item.provides.forEach((entry, at) => { if (workItem(entry.item) && workItem(entry.item)!.kind !== "function") issue(`${item.name} can only provide a function, and ${entry.item} is work.`, ["equipment", index, "provides", at, "item"]); }));
  if (sheet.inputs.some((input) => input.source.kind === "work_hours") && !sheet.work.some((entry) => entry.hours_per_unit !== undefined)) issue("An input estimated from the work needs hours for at least one work item.", ["work"]);
  if (sheet.duration && "hours_per_day" in sheet.duration && !sheet.work.some((entry) => entry.hours_per_unit !== undefined)) issue("A duration in hours needs hours for at least one work item.", ["duration", "hours_per_day"]);
});
export const paySheetArchiveSchema = z.object({ id, expected_revision: z.number().int().nonnegative().optional() }).strict();
export type PaySheetInput = z.infer<typeof inputSchema>;
export type PaySheet = Omit<z.infer<typeof paySheetInputSchema>, "expected_revision" | "id"> & { id: string; revision: number };

/**
 * What each entry is to each work item it covers: the pay for it, or an adjustment to pay another entry carries. An
 * entry that says is taken at its word. Otherwise an entry that reads a part of the measurement the work is sized by
 * (steep squares, where the work is all the squares) adjusts, unless the sheet's entries for that item read parts
 * that add up to the whole, in which case those parts are the pay. Anything else that covers an item is its pay.
 */
export function paySheetCoverRoles(sheet: Pick<PaySheet, "schema_ids" | "inputs" | "entries">) {
  const reads = (entry: PaySheet["entries"][number]) => { const source = sheet.inputs.find((input) => input.name === entry.input)?.source; return source?.kind === "measurement" ? source.definition : ""; };
  const roles = new Map<PaySheet["entries"][number], Map<string, "counts" | "adjusts">>();
  for (const item of new Set(sheet.entries.flatMap((entry) => entry.covers || []))) {
    const measure = workItemMeasure(sheet.schema_ids, item), covering = sheet.entries.filter((entry) => (entry.covers || []).includes(item));
    const whole = measure ? measurementWhole(measure, covering.filter((entry) => !entry.role).map(reads).filter(Boolean)) : [];
    for (const entry of covering) {
      const definition = reads(entry), partOfMeasure = !!measure && !!definition && measurementBase(definition) === measure;
      const role = entry.role || (partOfMeasure && !whole.includes(definition) ? "adjusts" : "counts");
      if (!roles.has(entry)) roles.set(entry, new Map());
      roles.get(entry)!.set(item, role);
    }
  }
  return roles;
}
/** How a sheet stands to each work item: paid by an entry, included at no charge, only adjusted, or not on it at all. */
export function paySheetWork(sheet: Pick<PaySheet, "schema_ids" | "inputs" | "entries" | "work" | "equipment">) {
  const roles = paySheetCoverRoles(sheet), states = new Map<string, "paid" | "included" | "provided" | "adjusted">();
  for (const entry of sheet.entries) for (const [item, role] of roles.get(entry) || []) if (role === "counts" || !states.has(item)) states.set(item, role === "counts" ? "paid" : "adjusted");
  for (const entry of sheet.work) if (entry.included && states.get(entry.item) !== "paid") states.set(entry.item, "included");
  for (const item of sheet.equipment) for (const entry of item.provides) if (!states.has(entry.item) || states.get(entry.item) === "adjusted") states.set(entry.item, "provided");
  return states;
}

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
  /** Material on the project's live lists. */
  materials?: { item_id: string; item_type: string; quantity: number; unit: string; list_id?: string; line_id?: string; name?: string }[];
  fields?: Record<string, number>;
  manual?: Record<string, number>;
  /** What the job requires, by work item. Hours are estimated from it. */
  work?: { item: string; quantity: number | null }[];
  /** The work items this evaluation is for. Left out, it is for everything the sheet covers. */
  scope?: string[];
  /** Why something could not be read, by source kind. An input of that kind is then missing whatever its default says. */
  unavailable?: Partial<Record<PaySheetInput["source"]["kind"], string>>;
};
type Resolved = { value: number | null; structures: { id: string; name: string; value: number }[]; missing: boolean; reason: string };
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Hours estimated for the work in scope, from the sheet's hours for each item. Null when any of it cannot be sized yet. */
export function estimateWorkHours(sheet: Pick<PaySheet, "work">, context: Pick<PayContext, "work" | "scope">) {
  const rated = sheet.work.filter((entry) => entry.hours_per_unit !== undefined && (!context.scope || context.scope.includes(entry.item)));
  const basis: { item: string; quantity: number; hours_per_unit: number }[] = [], waiting: string[] = [];
  for (const entry of rated) {
    const required = (context.work || []).find((row) => row.item === entry.item);
    // An item the job does not require takes no time.
    if (!required) continue;
    if (required.quantity === null) waiting.push(entry.item); else basis.push({ item: entry.item, quantity: required.quantity, hours_per_unit: entry.hours_per_unit! });
  }
  const hours = waiting.length || !basis.length ? null : Math.round(basis.reduce((sum, row) => sum + row.quantity * row.hours_per_unit, 0) * 4) / 4;
  return { hours, basis, waiting };
}
function resolveInput(input: PaySheetInput, context: PayContext, sheet?: Pick<PaySheet, "work">): Resolved {
  const source = input.source, label = input.label || input.name;
  const blocked = context.unavailable?.[source.kind];
  if (blocked) return { value: null, structures: [], missing: true, reason: blocked };
  let value: number | null = null, reason = `${label} is not available for this job.`;
  let structures: Resolved["structures"] = [];
  if (source.kind === "measurement") {
    const amounts = measurementAmounts(context.measurements, source.definition);
    value = amounts.total;
    // Structures are priced one by one only when every structure has a value and together they are the project's
    // figure. Otherwise the total is the figure: it carries manual corrections, and a partial breakdown would underpay.
    const everyStructure = amounts.structures.length > 1 && amounts.structures.length === amounts.structure_count;
    const sum = amounts.structures.reduce((total, structure) => total + structure.value, 0);
    if (source.per_structure && everyStructure && (amounts.recorded_total === null || Math.abs(sum - amounts.recorded_total) <= Math.max(0.01, Math.abs(amounts.recorded_total) * 0.001))) structures = amounts.structures;
  } else if (source.kind === "material") {
    const matching = (context.materials || []).filter((line) => (source.item_id ? line.item_id === source.item_id : line.item_type.toLowerCase() === source.item_type!.toLowerCase()));
    const units = [...new Set(matching.map((line) => line.unit.trim().toLowerCase()))];
    // Ten rolls and four boxes are not fourteen of anything.
    if (units.length > 1) return { value: null, structures: [], missing: true, reason: `${label} is on the lists in different units (${units.join(", ")}), so it cannot be added up.` };
    value = matching.length ? matching.reduce((sum, line) => sum + (Number(line.quantity) || 0), 0) : null;
  } else if (source.kind === "field") value = finite(context.fields?.[source.key]);
  else if (source.kind === "work_hours") {
    value = finite(context.manual?.[input.name]) ?? estimateWorkHours(sheet || { work: [] }, context).hours;
    reason = `Enter ${label} for this job; they cannot be estimated until the work can be sized.`;
  } else { value = finite(context.manual?.[input.name]); reason = `Enter ${label} for this job.`; }
  if (value === null && !input.required && input.default !== undefined) value = input.default;
  return { value, structures, missing: value === null, reason };
}

/**
 * What each of a sheet's inputs reads on one job, in the same terms evaluation uses: the value, whether it is missing
 * and why, and where it came from (recorded on the job, typed for it, estimated from the work, or the input's default).
 * Reads nothing and changes nothing; an editor shows it beside a trial evaluation.
 */
export function resolvePaySheetInputs(sheet: Pick<PaySheet, "inputs" | "work">, context: PayContext) {
  return sheet.inputs.map((input) => {
    const resolved = resolveInput(input, context, sheet);
    const typed = finite(context.manual?.[input.name]) !== null && (input.source.kind === "manual" || input.source.kind === "work_hours");
    const recorded = resolveInput({ ...input, required: true, default: undefined }, context, sheet);
    const from = resolved.missing ? "missing" : typed ? "typed" : input.source.kind === "work_hours" ? "estimated" : recorded.missing ? "default" : "job";
    return { name: input.name, label: input.label || input.name, required: input.required, source: input.source, value: resolved.value, structures: resolved.structures, missing: resolved.missing, from, reason: resolved.missing ? resolved.reason : "" };
  });
}

export type PayLine = { entry_id: string; label: string; kind: string; quantity: number | null; unit: string; rate_cents: number; total_cents: number | null; structure_id?: string; structure_name?: string; covers?: string[]; adjusts?: string[]; covers_outside?: string[]; estimated?: boolean };
/**
 * Prices one job on one sheet. A line whose required input is missing comes back unresolved, never as zero, and the
 * result says which inputs are missing. An optional input that is absent contributes nothing.
 */
export function evaluatePaySheet(sheet: PaySheet, context: PayContext) {
  const inputs = new Map(sheet.inputs.map((input) => [input.name, { input, ...resolveInput(input, context, sheet) }]));
  const lines: PayLine[] = [], unresolved: { entry_id: string; label: string; input: string; reason: string; covers?: string[] }[] = [];
  const roles = paySheetCoverRoles(sheet), inScope = (item: string) => !context.scope || context.scope.includes(item);
  sheet.entries.forEach((entry, index) => {
    // An entry for work that is not part of this evaluation is not charged. One that also pays for work outside it
    // is charged in full, and says so: a price for two things cannot be split by guessing.
    const entryCovers = entry.covers || [];
    if (entryCovers.length && !entryCovers.some(inScope)) return;
    const role = roles.get(entry) || new Map<string, "counts" | "adjusts">();
    const cover = { covers: entryCovers.filter((item) => inScope(item) && role.get(item) !== "adjusts"), adjusts: entryCovers.filter((item) => inScope(item) && role.get(item) === "adjusts"), covers_outside: entryCovers.filter((item) => !inScope(item) && role.get(item) !== "adjusts") };
    const estimated = !!entry.input && inputs.get(entry.input)?.input.source.kind === "work_hours" && finite(context.manual?.[entry.input]) === null;
    const before0 = lines.length, unresolved0 = unresolved.length;
    priceEntry(entry, index);
    for (const line of lines.slice(before0)) { if (cover.covers.length) line.covers = cover.covers; if (cover.adjusts.length) line.adjusts = cover.adjusts; if (cover.covers_outside.length) line.covers_outside = cover.covers_outside; if (estimated) line.estimated = true; }
    for (const row of unresolved.slice(unresolved0)) if (cover.covers.length) row.covers = cover.covers;
  });
  function priceEntry(entry: PaySheet["entries"][number], index: number) {
    const entryId = entry.id || `entry_${index + 1}`, unit = entry.unit || (entry.kind === "hourly" || entry.kind === "cost_rate" ? "hour" : entry.kind === "flat" ? "job" : "");
    const gate = entry.when ? inputs.get(entry.when)! : null;
    if (gate) {
      // A gate that is required and unknown cannot be decided either way, so the entry is unresolved rather than dropped.
      if (gate.missing && (gate.input.required || context.unavailable?.[gate.input.source.kind])) { unresolved.push({ entry_id: entryId, label: entry.label, input: gate.input.name, reason: gate.reason }); return; }
      if (!(Number(gate.value) > 0)) return;
    }
    if (entry.kind === "salary") { lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: null, unit: unit || "period", rate_cents: entry.rate_cents, total_cents: null }); return; }
    if (entry.kind === "flat" && !entry.input) { lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: 1, unit, rate_cents: entry.rate_cents, total_cents: entry.rate_cents }); return; }
    const resolved = entry.input ? inputs.get(entry.input)! : null;
    if (!resolved || resolved.missing) {
      // An optional input with nothing recorded and no default simply does not apply to this job.
      if (resolved && !resolved.input.required && !context.unavailable?.[resolved.input.source.kind]) return;
      unresolved.push({ entry_id: entryId, label: entry.label, input: entry.input || "", reason: resolved ? resolved.reason : "Enter the hours for this job." });
      return;
    }
    const multiplier = entry.multiplier ?? 1, price = (quantity: number) => Math.round(quantity * multiplier * entry.rate_cents);
    const before = lines.length;
    if (entry.kind === "flat") lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: 1, unit, rate_cents: entry.rate_cents, total_cents: entry.rate_cents });
    else if (resolved.structures.length) { for (const structure of resolved.structures) if (structure.value * multiplier > 0) lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: structure.value * multiplier, unit, rate_cents: entry.rate_cents, total_cents: price(structure.value), structure_id: structure.id, structure_name: structure.name }); }
    else if (Number(resolved.value) * multiplier > 0) lines.push({ entry_id: entryId, label: entry.label, kind: entry.kind, quantity: Number(resolved.value) * multiplier, unit, rate_cents: entry.rate_cents, total_cents: price(Number(resolved.value)) });
    // A minimum is for the entry as a whole, however many structures it was priced across.
    const earned = lines.slice(before).reduce((sum, line) => sum + (line.total_cents || 0), 0);
    if (lines.length > before && entry.minimum_cents && earned < entry.minimum_cents) lines.push({ entry_id: entryId, label: `${entry.label} (minimum)`, kind: "minimum", quantity: 1, unit: "job", rate_cents: entry.minimum_cents - earned, total_cents: entry.minimum_cents - earned });
  }
  const hours = estimateWorkHours(sheet, context);
  const byInput = sheet.duration && "input" in sheet.duration ? sheet.duration : null, byHours = sheet.duration && "hours_per_day" in sheet.duration ? sheet.duration : null;
  const basis = byInput ? inputs.get(byInput.input)! : null;
  // Scheduling works in half days; anything measurable rounds up to the next half.
  const duration_days = byInput && basis && !basis.missing ? Math.ceil((Number(basis.value) / byInput.units_per_day) * 2) / 2 : byHours && hours.hours !== null ? Math.ceil((hours.hours / byHours.hours_per_day) * 2) / 2 : null;
  const states = paySheetWork(sheet);
  return {
    sheet: { id: sheet.id, name: sheet.name, subject: sheet.subject, revision: sheet.revision },
    lines,
    equipment: sheet.equipment.map((item, index) => ({ id: item.id || `equipment_${index + 1}`, name: item.name, ...(item.equipment_type_id ? { equipment_type_id: item.equipment_type_id } : {}), included: item.included, total_cents: item.included ? 0 : item.rate_cents || 0, provides: (item.provides || []).filter((entry) => inScope(entry.item)) })),
    // The work this evaluation accounts for and how: paid by a line, included at no charge, or provided by equipment.
    work: { items: [...states].filter(([item]) => inScope(item)).map(([item, state]) => ({ item, state })), hours: hours.hours, hours_basis: hours.basis },
    unresolved,
    missing_inputs: [...inputs.values()].filter((entry) => entry.missing).map((entry) => ({ name: entry.input.name, label: entry.input.label || entry.input.name, required: entry.input.required, source: entry.input.source, reason: entry.reason })),
    duration_days,
    // What the estimate of days rests on, so it can be explained rather than taken on trust.
    duration_basis: byInput && basis && !basis.missing ? { label: basis.input.label || basis.input.name, value: Number(basis.value), units_per_day: byInput.units_per_day } : byHours && hours.hours !== null ? { label: "Estimated hours", value: hours.hours, units_per_day: byHours.hours_per_day } : null,
    total_cents: lines.reduce((sum, line) => sum + (line.total_cents || 0), 0) + sheet.equipment.reduce((sum, item) => sum + (item.included ? 0 : item.rate_cents || 0), 0),
    // The part of the total that is projection only: salaried time at its cost rate, which no one is paid per job.
    projection_only_cents: lines.filter((line) => line.kind === "cost_rate").reduce((sum, line) => sum + (line.total_cents || 0), 0),
    complete: unresolved.length === 0
  };
}

const requireWrite = (orgId: string, actor: Actor) => requireActor(orgId, actor, "manage_company_settings", "pay_sheet_write_denied", "Pay sheet editing requires company settings access.");
function row(document: { id: string; revision?: number; data: JsonObject }): PaySheet {
  const data = document.data as unknown as Omit<PaySheet, "id" | "revision">;
  return { id: document.id, subject: data.subject, name: data.name, schema_ids: data.schema_ids || [], inputs: data.inputs || [], entries: (data.entries || []).map((entry) => ({ ...entry, covers: entry.covers || [] })), equipment: (data.equipment || []).map((item) => ({ ...item, provides: item.provides || [] })), work: data.work || [], duration: data.duration ?? null, revision: Number(document.revision || 0) };
}
export async function listPaySheets(orgId: string): Promise<PaySheet[]> {
  return (await listDocuments(orgId, PAY_SHEET_COLLECTION)).filter((document) => !document.data.archived_at).map(row).sort((a, b) => a.name.localeCompare(b.name));
}
export async function readPaySheet(orgId: string, sheetId: string) {
  const sheet = (await listPaySheets(orgId)).find((entry) => entry.id === sheetId);
  if (!sheet) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  return sheet;
}
export async function savePaySheet(orgId: string, input: unknown, auth: Actor) {
  requireWrite(orgId, auth);
  const parsed = paySheetInputSchema.parse(input);
  await requireAssignee(orgId, parsed.subject);
  const all = await listPaySheets(orgId);
  const existing = parsed.id ? all.find((entry) => entry.id === parsed.id) || null : null;
  if (parsed.id && !existing) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  // An assignee has one sheet for each kind of work, and at most one that names none, so it is never unclear which applies.
  const clash = all.find((entry) => entry.id !== parsed.id && entry.subject.type === parsed.subject.type && entry.subject.id === parsed.subject.id && (parsed.schema_ids.length ? entry.schema_ids.some((schema) => parsed.schema_ids.includes(schema)) : !entry.schema_ids.length));
  if (clash) throw badRequest("pay_sheet_overlap", `${clash.name} already covers ${parsed.schema_ids.length ? "that kind of work" : "work that names no kind"} for this assignee.`);
  const { id: _id, expected_revision: _revision, ...data } = parsed;
  const document = await upsertDocument(orgId, PAY_SHEET_COLLECTION, {
    ...(existing ? { id: existing.id, expected_revision: parsed.expected_revision ?? existing.revision } : {}),
    data: { ...data, duration: data.duration ?? null, entries: data.entries.map((entry, index) => ({ ...entry, id: entry.id || `entry_${index + 1}` })), updated_by_user_id: String(auth.userId || "") } as unknown as JsonObject,
    metadata: { kind: "labor_pay_sheet", subject_type: parsed.subject.type, subject_id: parsed.subject.id }
  }, { replace: true });
  return row(document as { id: string; revision?: number; data: JsonObject });
}
export async function archivePaySheet(orgId: string, input: unknown, auth: Actor) {
  requireWrite(orgId, auth);
  const parsed = paySheetArchiveSchema.parse(input);
  const document = (await listDocuments(orgId, PAY_SHEET_COLLECTION)).find((entry) => entry.id === parsed.id && !entry.data.archived_at);
  if (!document) throw badRequest("pay_sheet_unknown", "This pay sheet is unavailable.");
  await upsertDocument(orgId, PAY_SHEET_COLLECTION, { id: parsed.id, expected_revision: parsed.expected_revision ?? Number(document.revision || 0), data: { ...document.data, archived_at: new Date().toISOString(), archived_by_user_id: String(auth.userId || "") }, metadata: { kind: "labor_pay_sheet", subject_type: String((document.data.subject as { type?: string } | undefined)?.type || ""), subject_id: String((document.data.subject as { id?: string } | undefined)?.id || "") } }, { replace: true });
  return { id: parsed.id, archived: true };
}
