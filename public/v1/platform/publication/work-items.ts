import { libraryEntries, libraryVersion } from "../../config-library/library.js";
import { badRequest } from "../errors.js";
import type { JsonSchema } from "./contracts.js";
import { listMeasurementDefinitions, listMeasurementSchemas, measurementAmounts, measurementBase } from "./measurement-schemas.js";
import { registerDataProvider } from "./providers.js";
import { contentHash, jsonClone } from "./validation.js";

/**
 * One shared dictionary of what a job can require, and per kind of work the list of what its jobs do require.
 *
 * A work item is something that has to happen on a job, stated without a price and without saying who does it:
 * "tear off the old roofing", measured in squares. A function is the other kind of requirement: a capacity the job
 * needs that is not labor, such as somewhere for the debris to go, measured in cubic yards. Either is met by a line on
 * a work order. How an assignee charges for it, and whether they bring the equipment, is their pay sheet's business.
 *
 * A kind of work (the same ids as measurement schemas: roofing, siding) lists the items its jobs require and says how
 * much of each, from measurements. The amount is the work, not the pay: thirty squares to tear off, whatever pitch
 * they are at. Pitch and everything else stay in the measurements for a pay sheet to read. Like the measurement
 * dictionary, this only grows: an item's meaning and unit never change.
 */
export type WorkItemKind = "work" | "function";
export type WorkItemDefinition = {
  id: string; label: string; kind: WorkItemKind; unit: string; description: string;
  /** For a function: equipment usually meets it a load at a time, emptied and used again. Only a starting point for whoever sets a type up. */
  per_load_default?: boolean;
};
/**
 * How much of an item a job requires. Measurements are added together, then multiplied by `factor` and by each
 * project field in `scale` (existing layers, say), which falls back to its default when the project has no value.
 */
export type WorkQuantity = { fixed: number } | { measurements: string[]; factor?: number; scale?: { field: string; default: number }[] };
export type WorkSchemaItem = {
  item: string;
  quantity: WorkQuantity;
  /** Listed under another item of this schema that causes it, as disposal is caused by tear-off. It is still met on its own. */
  under?: string;
  /** Required only where there is some of it: a roof with no walls needs no wall flashing. */
  optional?: boolean;
};
export type WorkSchema = { id: string; version: string; items: WorkSchemaItem[] };

/**
 * The dictionary is data: config library entries of the kinds work_item and work_schema (config-library/kinds/),
 * rebuilt whenever the library changes (`libraryVersion`), so reads stay synchronous and current. The register*
 * functions add to it in this process only (tests check the dictionary's rules with them); what they add is kept
 * across rebuilds.
 */
type Dictionary = { items: Map<string, WorkItemDefinition>; schemas: Map<string, WorkSchema> };
const ID = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
export const WORK_LIBRARY_KINDS = { item: "work_item", schema: "work_schema" } as const;
let dictionary: Dictionary = { items: new Map(), schemas: new Map() };
let builtAt = -1;
const localAdditions: Array<(target: Dictionary) => void> = [];
function dict(): Dictionary {
  const version = libraryVersion();
  if (version !== builtAt) {
    builtAt = version;
    const target: Dictionary = { items: new Map(), schemas: new Map() };
    const problems: string[] = [];
    const attempt = (what: string, add: () => void) => { try { add(); } catch (error) { problems.push(`${what}: ${(error as Error).message}`); } };
    for (const entry of libraryEntries<Omit<WorkItemDefinition, "id">>(WORK_LIBRARY_KINDS.item)) attempt(entry.id, () => addItem(target, { ...entry.data, id: entry.id } as WorkItemDefinition));
    for (const entry of libraryEntries<Omit<WorkSchema, "id">>(WORK_LIBRARY_KINDS.schema)) attempt(entry.id, () => addSchema(target, { ...entry.data, id: entry.id } as WorkSchema));
    // Entries are checked when they are saved, so this only happens to a snapshot or store written some other way.
    if (problems.length) console.error(`Work item dictionary: ${problems.length} library entries were left out. ${problems.join(" ")}`);
    for (const add of localAdditions) { try { add(target); } catch { /* no longer fits the library's dictionary */ } }
    dictionary = target;
  }
  return dictionary;
}

function addItem(target: Dictionary, item: WorkItemDefinition) {
  if (!ID.test(item.id) || !item.label.trim() || !item.unit.trim() || !["work", "function"].includes(item.kind)) throw badRequest("work_item_invalid", "A work item needs a stable id, a label, a unit and a kind.");
  if (target.items.has(item.id)) throw badRequest("work_item_duplicate", `Work item ${item.id} is already defined.`);
  target.items.set(item.id, Object.freeze(jsonClone(item)));
}
function addSchema(target: Dictionary, schema: WorkSchema) {
  const measured = listMeasurementSchemas().find((entry) => entry.id === schema.id);
  if (!measured || !schema.version || !schema.items.length) throw badRequest("work_schema_invalid", "A work schema is for a kind of work that has a measurement schema, and lists at least one item.");
  if (target.schemas.has(schema.id)) throw badRequest("work_schema_duplicate", `Work schema ${schema.id} is already registered.`);
  const allowed = new Set(measured.measurements.map((entry) => entry.definition)), units = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition.unit]));
  const seen = new Set<string>();
  for (const entry of schema.items) {
    if (!target.items.has(entry.item)) throw badRequest("work_schema_unknown_item", `Schema ${schema.id} names ${entry.item}, which is not in the dictionary.`);
    if (seen.has(entry.item)) throw badRequest("work_schema_invalid", `Schema ${schema.id} lists ${entry.item} twice.`);
    seen.add(entry.item);
    if ("fixed" in entry.quantity) { if (!(entry.quantity.fixed > 0)) throw badRequest("work_schema_invalid", `${entry.item} needs an amount above zero.`); continue; }
    if (!entry.quantity.measurements.length) throw badRequest("work_schema_invalid", `${entry.item} needs a measurement to be worked out from.`);
    for (const definition of entry.quantity.measurements) if (!allowed.has(definition)) throw badRequest("work_schema_unknown_measurement", `${entry.item} reads ${definition}, which is not part of the ${schema.id} measurement schema.`);
    // Feet and squares are not added together.
    if (new Set(entry.quantity.measurements.map((definition) => units.get(definition))).size > 1) throw badRequest("work_schema_invalid", `${entry.item} adds measurements in different units.`);
  }
  for (const entry of schema.items) if (entry.under && (!seen.has(entry.under) || entry.under === entry.item)) throw badRequest("work_schema_invalid", `${entry.item} is listed under ${entry.under}, which is not another item of ${schema.id}.`);
  target.schemas.set(schema.id, Object.freeze(jsonClone(schema)));
}
/** Adds to the dictionary in this process only, with the dictionary's rules. Library entries are the dictionary. */
function addLocally(add: (target: Dictionary) => void) { add(dict()); localAdditions.push(add); }
export function registerWorkItem(item: WorkItemDefinition) { addLocally((target) => addItem(target, item)); }
export function registerWorkSchema(schema: WorkSchema) { addLocally((target) => addSchema(target, schema)); }
export function listWorkItems() { return [...dict().items.values()].map((item) => jsonClone(item)); }
export function listWorkSchemas() { return [...dict().schemas.values()].map((schema) => jsonClone(schema)); }
export function workItem(id: string) { const item = dict().items.get(id); return item ? jsonClone(item) : null; }
/** Every item the given kinds of work can require. */
export function workItemsForSchemas(schemaIds: string[]): string[] {
  return [...new Set(schemaIds.flatMap((id) => dict().schemas.get(id)?.items.map((entry) => entry.item) || []))];
}

/** The whole measurement an item's amount is in these kinds of work, when it is exactly one measurement; otherwise "". */
export function workItemMeasure(schemaIds: string[], itemId: string): string {
  for (const schemaId of schemaIds) {
    const quantity = dict().schemas.get(schemaId)?.items.find((entry) => entry.item === itemId)?.quantity;
    if (quantity && "measurements" in quantity && quantity.measurements.length === 1 && (quantity.factor ?? 1) === 1 && !(quantity.scale || []).length) return measurementBase(quantity.measurements[0]!);
  }
  return "";
}
export type WorkRequirement = {
  item: string; label: string; kind: WorkItemKind; unit: string; description: string;
  schemas: string[];
  /** The item of the same job that causes this one, when there is one. */
  under: string;
  /** How much is required, or null when it cannot be worked out yet. Never zero for "unknown". */
  quantity: number | null;
  /**
   * The whole measurement the amount is, when it is exactly one measurement and nothing else. A pay line that reads
   * this measurement, or parts of it, can then be compared with the requirement.
   */
  measure: string;
  reason: string;
};
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
function amount(quantity: WorkQuantity, context: { measurements?: unknown; fields?: Record<string, number> }): number | null {
  if ("fixed" in quantity) return quantity.fixed;
  // A roof with no hips has no hip length recorded, so what is recorded is added up; nothing recorded at all is unknown.
  const read = quantity.measurements.map((definition) => measurementAmounts(context.measurements, definition).total).filter((value): value is number => value !== null);
  if (!read.length) return null;
  let total = read.reduce((sum, value) => sum + value, 0) * (quantity.factor ?? 1);
  for (const scale of quantity.scale || []) total *= finite(context.fields?.[scale.field]) ?? scale.default;
  return total;
}
/**
 * What a job of these kinds of work would require if it included everything, from its measurements: the scope
 * set's sizing of each item. What a particular project requires is decided by its scope artifacts
 * (labor/scope-artifacts.ts), which use this for the amounts. An item that two kinds of work both require is one
 * requirement with the amounts added. Reads nothing and changes nothing.
 */
export function workRequirements(schemaIds: string[], context: { measurements?: unknown; fields?: Record<string, number> }, options: { includeEmpty?: boolean } = {}): WorkRequirement[] {
  const rows = new Map<string, WorkRequirement>();
  for (const schemaId of [...new Set(schemaIds)]) {
    const schema = dict().schemas.get(schemaId);
    if (!schema) continue;
    for (const entry of schema.items) {
      const definition = dict().items.get(entry.item)!, quantity = amount(entry.quantity, context);
      if (entry.optional && !(Number(quantity) > 0) && !options.includeEmpty) continue;
      const single = "measurements" in entry.quantity && entry.quantity.measurements.length === 1 && (entry.quantity.factor ?? 1) === 1 && !(entry.quantity.scale || []).length;
      const existing = rows.get(entry.item);
      if (existing) {
        existing.schemas.push(schemaId);
        existing.quantity = existing.quantity === null || quantity === null ? null : existing.quantity + quantity;
        existing.measure = "";
        continue;
      }
      rows.set(entry.item, {
        item: definition.id, label: definition.label, kind: definition.kind, unit: definition.unit, description: definition.description, schemas: [schemaId], under: entry.under || "",
        quantity, measure: single ? measurementBase((entry.quantity as { measurements: string[] }).measurements[0]!) : "",
        reason: quantity === null ? `${definition.label} cannot be sized until this project has the measurements it is worked out from.` : ""
      });
    }
  }
  return [...rows.values()];
}

// ---- Publication ----
const itemSchema: JsonSchema = { type: "object", required: ["id", "label", "kind", "unit", "description"], properties: { id: { type: "string" }, label: { type: "string" }, kind: { enum: ["work", "function"] }, unit: { type: "string" }, description: { type: "string" }, per_load_default: { type: "boolean" } }, additionalProperties: false };
const schemaSchema: JsonSchema = { type: "object", required: ["id", "version", "items"], properties: { id: { type: "string" }, version: { type: "string" }, items: { type: "array", items: { type: "object", required: ["item", "quantity"], properties: { item: { type: "string" }, quantity: { type: "object" }, under: { type: "string" }, optional: { type: "boolean" } }, additionalProperties: false } } }, additionalProperties: false };
let registered = false;
export function registerWorkItemProvider() {
  if (registered) return;
  registered = true;
  const anyone = { scopes: ["organization", "project"] as const, permissions: ["view_project_data"], systemKinds: ["work", "module", "agent"] as const };
  registerDataProvider({ id: "work-items", version: "1", apps: ["materials", "crew", "documents"], exports: {
    dictionary: { description: "Everything a job can require that the platform has a shared meaning for: work to be done (tear off old roofing, in squares) and functions, which are capacities a job needs that are not labor (debris disposal, in cubic yards). No prices and no one named.", schema: { type: "array", items: itemSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listWorkItems(); return { value, revision: `sha256:${contentHash(value)}` }; } },
    catalog: { description: "What each kind of work (roofing, siding) requires of a job: the work items and functions, how much of each is worked out from measurements, and which item causes which.", schema: { type: "array", items: schemaSchema }, schemaVersion: "1", access: anyone,
      read: async () => { const value = listWorkSchemas(); return { value, revision: `sha256:${contentHash(value)}` }; } }
  } });
}
