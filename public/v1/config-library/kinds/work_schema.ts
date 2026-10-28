import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { listMeasurementDefinitions, listMeasurementSchemas } from "../../platform/publication/measurement-schemas.js";
import { DICTIONARY_ID, SCHEMA_ID, sameJson } from "./dictionary-shared.js";

export const WORK_SCHEMA_KIND = "work_schema";

const quantity = z.union([
  z.object({ fixed: z.number().finite().positive() }).strict(),
  z.object({
    measurements: z.array(z.string().regex(DICTIONARY_ID)).min(1).max(20),
    factor: z.number().finite().positive().optional(),
    scale: z.array(z.object({ field: z.string().trim().min(1).max(80), default: z.number().finite() }).strict()).max(5).optional()
  }).strict()
]);
/**
 * What one kind of work requires of a job (platform/publication/work-items.ts): the same id as its measurement
 * schema, the items, and how much of each from measurements. The amounts are rules of thumb and may be changed; an
 * item is never dropped, and any change is a new version.
 */
export const workSchemaData = z.object({
  version: z.string().trim().min(1).max(20),
  items: z.array(z.object({
    item: z.string().regex(DICTIONARY_ID),
    quantity,
    /** Listed under another item of this schema that causes it, as disposal is caused by tear-off. */
    under: z.string().regex(DICTIONARY_ID).optional(),
    /** Required only where there is some of it. */
    optional: z.boolean().optional()
  }).strict()).min(1).max(200)
}).strict();
export type WorkSchemaData = z.infer<typeof workSchemaData>;

export const workSchemaKind: LibraryKind<WorkSchemaData> = {
  kind: WORK_SCHEMA_KIND,
  title: "Work schemas",
  description: "Per kind of work, the work items and functions its jobs require and how much of each is worked out from measurements. Items are never dropped; amounts are rules of thumb that may change, and every change is a new version.",
  idPattern: SCHEMA_ID,
  schema: workSchemaData,
  appendOnly: true,
  titleOf: (_data, id) => `${id} work`,
  validate(data, ctx) {
    const measured = listMeasurementSchemas().find((entry) => entry.id === ctx.id);
    if (!measured) return [`A work schema is for a kind of work that has a measurement schema, and there is no ${ctx.id} measurement schema.`];
    const allowed = new Set(measured.measurements.map((entry) => entry.definition));
    const units = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition.unit]));
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const entry of data.items) {
      if (!ctx.registries.workItem(entry.item)) errors.push(`Schema ${ctx.id} names ${entry.item}, which is not in the dictionary.`);
      if (seen.has(entry.item)) errors.push(`Schema ${ctx.id} lists ${entry.item} twice.`);
      seen.add(entry.item);
      if ("fixed" in entry.quantity) continue;
      for (const definition of entry.quantity.measurements) if (!allowed.has(definition)) errors.push(`${entry.item} reads ${definition}, which is not part of the ${ctx.id} measurement schema.`);
      // Feet and squares are not added together.
      if (new Set(entry.quantity.measurements.map((definition) => units.get(definition))).size > 1) errors.push(`${entry.item} adds measurements in different units.`);
    }
    for (const entry of data.items) if (entry.under && (!seen.has(entry.under) || entry.under === entry.item)) errors.push(`${entry.item} is listed under ${entry.under}, which is not another item of ${ctx.id}.`);
    return errors;
  },
  compatible(previous, next, id) {
    const errors: string[] = [];
    const after = new Set(next.items.map((entry) => entry.item));
    for (const entry of previous.items) if (!after.has(entry.item)) errors.push(`${id}: ${entry.item} can never be dropped from the schema.`);
    const changed = !sameJson(previous.items, next.items);
    if (changed && next.version === previous.version) errors.push(`${id}: a changed schema is a new version; version ${previous.version} is taken.`);
    if (!changed && next.version !== previous.version) errors.push(`${id}: the version changes only with the schema.`);
    return errors;
  }
};
