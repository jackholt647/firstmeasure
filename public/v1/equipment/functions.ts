import { z } from "zod";

import { badRequest } from "../platform/errors.js";
import { listMeasurementSchemas, measurementSchemaIdsForScope } from "../platform/publication/measurement-schemas.js";
import { listWorkSchemas, workItem } from "../platform/publication/work-items.js";

/**
 * The functions equipment fulfils. A function is a capacity a job needs that is not labor (debris disposal, in cubic
 * yards); it has one definition in the work item dictionary. An equipment type says which functions it provides and
 * how much, in the same shape a pay sheet's equipment uses, so a line on a project's equipment list can carry it as
 * `metadata.provides` and the project's requirements count it. A unit may hold a different amount than its type.
 */
type Row = Record<string, unknown>;
const workItemId = z.string().trim().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/).max(120);
const amount = z.number().finite().min(0).max(1e9);
const text = (value: unknown) => String(value ?? "").trim();
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) as Row[] : []);

function onlyFunctions(entries: { item: string }[], context: z.RefinementCtx) {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const definition = workItem(entry.item);
    if (!definition) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "item"], message: `${entry.item} is not in the work item dictionary.` });
    else if (definition.kind !== "function") context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "item"], message: `Equipment can only provide a function, and ${entry.item} is work.` });
    if (seen.has(entry.item)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "item"], message: `${entry.item} is listed twice.` });
    seen.add(entry.item);
  });
}

/**
 * What an equipment type provides. per_load means it can be emptied and used again, so its capacity never limits the
 * job; otherwise capacity is all it holds. Capacity is in the function's own unit.
 */
export const equipmentProvidesSchema = z.array(z.object({ item: workItemId, capacity: amount.optional(), per_load: z.boolean().default(false) }).strict()).max(20).superRefine(onlyFunctions);
/** What one unit holds, where that differs from its type. Only for functions its type provides. */
export const unitProvidesSchema = z.array(z.object({ item: workItemId, capacity: amount }).strict()).max(20).superRefine(onlyFunctions);
export type EquipmentProvides = { item: string; capacity?: number; per_load: boolean };

/** A stored list read back defensively: entries that no longer name a function are left out. */
function stored(value: unknown): EquipmentProvides[] {
  return rows(value).filter((entry) => workItem(text(entry.item))?.kind === "function").map((entry) => ({
    item: text(entry.item),
    ...(typeof entry.capacity === "number" && Number.isFinite(entry.capacity) && entry.capacity >= 0 ? { capacity: entry.capacity } : {}),
    per_load: entry.per_load === true
  }));
}

/** What a unit provides: its type's functions, with the unit's own capacity where it has one. */
export function effectiveProvides(type: unknown, unit?: unknown): EquipmentProvides[] {
  const own = new Map(stored((unit as Row | null | undefined)?.provides).map((entry) => [entry.item, entry.capacity]));
  return stored((type as Row | null | undefined)?.provides).map((entry) => (own.get(entry.item) === undefined ? entry : { ...entry, capacity: own.get(entry.item)! }));
}

/** A unit cannot hold something its type does not provide. */
export function assertUnitProvides(type: unknown, unitProvides: unknown) {
  const offered = new Set(stored((type as Row | null | undefined)?.provides).map((entry) => entry.item));
  for (const entry of rows(unitProvides)) {
    if (!offered.has(text(entry.item))) throw badRequest("equipment_unit_provides_invalid", `${text(entry.item)} is not a function this unit's type provides. Add it to the type first.`);
  }
}

export type AvailableFunction = { id: string; label: string; unit: string; description: string; schemas: { id: string; title: string }[] };

/** The functions the given kinds of work need of a job, each with the kinds of work that need it. */
export function functionsForSchemas(schemaIds: string[]): AvailableFunction[] {
  const wanted = new Set(schemaIds), titles = new Map(listMeasurementSchemas().map((schema) => [schema.id, schema.title]));
  const found = new Map<string, AvailableFunction>();
  for (const schema of listWorkSchemas()) {
    if (!wanted.has(schema.id)) continue;
    for (const entry of schema.items) {
      const definition = workItem(entry.item);
      if (!definition || definition.kind !== "function") continue;
      const row = found.get(definition.id) || { id: definition.id, label: definition.label, unit: definition.unit, description: definition.description, schemas: [] };
      row.schemas.push({ id: schema.id, title: titles.get(schema.id) || schema.id });
      found.set(definition.id, row);
    }
  }
  return [...found.values()].sort((first, second) => first.label.localeCompare(second.label));
}

/**
 * The functions this organization's equipment can be asked for: those needed by the kinds of work its enabled scopes
 * work in. A scope names its kinds of work with `measurement_schema_ids`. An organization with no such scope sees none.
 */
export async function availableEquipmentFunctions(orgId: string, branchId = "default") {
  const { listScopeTemplates } = await import("../scopes/storage.js");
  const scopes = await listScopeTemplates(orgId, text(branchId) || "default");
  const schemaIds = [...new Set(scopes.flatMap((scope) => measurementSchemaIdsForScope(scope.definition)))].sort();
  return { schema_ids: schemaIds, functions: functionsForSchemas(schemaIds) };
}
