import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";
import { SCHEMA_ID, sameJson } from "./dictionary-shared.js";

export const MEASUREMENT_SCHEMA_KIND = "measurement_schema";

/** A kind of work's selection from the measurement dictionary (`roofing`, `siding`). The entry id is the schema id. */
export const measurementSchemaData = z.object({
  version: z.string().trim().min(1).max(20),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000),
  measurements: z.array(z.object({ definition: z.string().min(1).max(160), required: z.boolean() }).strict()).min(1).max(400)
}).strict();
export type MeasurementSchemaData = z.infer<typeof measurementSchemaData>;

export const measurementSchemaKind: LibraryKind<MeasurementSchemaData> = {
  kind: MEASUREMENT_SCHEMA_KIND,
  title: "Measurement schemas",
  description: "Per kind of work (roofing, gutters, siding), the dictionary measurements it speaks in and which it requires. A selection only grows: a measurement is never dropped or made required or optional again, and a changed selection is a new version.",
  idPattern: SCHEMA_ID,
  schema: measurementSchemaData,
  appendOnly: true,
  titleOf: (data) => data.title,
  validate(data, ctx) {
    const known = new Set(listMeasurementDefinitions().map((definition) => definition.id));
    const errors: string[] = [];
    const seen = new Set<string>();
    for (const entry of data.measurements) {
      if (!known.has(entry.definition)) errors.push(`Schema ${ctx.id} names ${entry.definition}, which is not in the dictionary.`);
      if (seen.has(entry.definition)) errors.push(`Schema ${ctx.id} lists ${entry.definition} twice.`);
      seen.add(entry.definition);
    }
    return errors;
  },
  compatible(previous, next, id) {
    const errors: string[] = [];
    const after = new Map(next.measurements.map((entry) => [entry.definition, entry]));
    for (const entry of previous.measurements) {
      const now = after.get(entry.definition);
      if (!now) errors.push(`${id}: ${entry.definition} can never be dropped from the schema.`);
      else if (now.required !== entry.required) errors.push(`${id}: whether ${entry.definition} is required never changes.`);
    }
    const before = new Map(previous.measurements.map((entry) => [entry.definition, entry]));
    const grew = next.measurements.some((entry) => !before.has(entry.definition));
    if (grew && next.version === previous.version) errors.push(`${id}: a changed selection is a new version; version ${previous.version} is taken.`);
    if (!grew && !sameJson(previous.version, next.version)) errors.push(`${id}: the version changes only with the selection.`);
    return errors;
  }
};
