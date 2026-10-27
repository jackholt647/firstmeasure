import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { definitionForKey, listMeasurementDefinitions, listMeasurementPartitions } from "../../platform/publication/measurement-schemas.js";
import { DICTIONARY_ID, unchanged } from "./dictionary-shared.js";

export const MEASUREMENT_DEFINITION_KIND = "measurement_definition";

/** One meaning in the measurement dictionary (platform/publication/measurement-schemas.ts). The entry id is the definition id. */
export const measurementDefinitionData = z.object({
  /** The key a measurement dataset stores it under. A family of keys uses `keyPattern` instead. */
  key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.]*$/).max(80).optional(),
  keyPattern: z.string().min(2).max(200).optional(),
  label: z.string().trim().min(1).max(120),
  unit: z.string().trim().min(1).max(40),
  levels: z.array(z.enum(["project", "structure"])).min(1).max(2),
  derive: z.object({ from: z.string().regex(DICTIONARY_ID), above: z.number().finite(), upTo: z.number().finite().nullable() }).strict().optional(),
  slice: z.object({ partition: z.string().regex(DICTIONARY_ID) }).strict().optional(),
  description: z.string().max(1000)
}).strict();
export type MeasurementDefinitionData = z.infer<typeof measurementDefinitionData>;

function patternOf(source: string) { try { return new RegExp(source); } catch { return null; } }

export const measurementDefinitionKind: LibraryKind<MeasurementDefinitionData> = {
  kind: MEASUREMENT_DEFINITION_KIND,
  title: "Measurement definitions",
  description: "The shared measurement dictionary: what each measurement means, the dataset key it is stored under, its unit and where it can be recorded. Only ever added to; a key, unit or meaning never changes.",
  idPattern: DICTIONARY_ID,
  schema: measurementDefinitionData,
  appendOnly: true,
  titleOf: (data) => data.label,
  validate(data, ctx) {
    const errors: string[] = [];
    const others = listMeasurementDefinitions().filter((definition) => definition.id !== ctx.id);
    if (!data.key === !data.keyPattern) errors.push("A measurement has either one key or one key pattern.");
    if (new Set(data.levels).size !== data.levels.length) errors.push("levels lists a level twice.");
    if (data.key) {
      const owner = definitionForKey(data.key);
      if (owner && owner.id !== ctx.id) errors.push(`Key ${data.key} already belongs to ${owner.id}.`);
    }
    if (data.keyPattern) {
      const pattern = patternOf(data.keyPattern);
      if (!pattern) errors.push(`keyPattern ${data.keyPattern} is not a valid regular expression.`);
      else for (const other of others) if (other.key && pattern.test(other.key)) errors.push(`keyPattern ${data.keyPattern} would claim ${other.key}, which belongs to ${other.id}.`);
    }
    if (data.slice) {
      const partition = listMeasurementPartitions().find((entry) => entry.id === data.slice!.partition);
      const base = partition && others.find((definition) => definition.id === partition.of);
      if (!partition) errors.push(`Measurement ${ctx.id} names partition ${data.slice.partition}, which is not defined.`);
      else if (base && base.unit !== data.unit) errors.push(`Measurement ${ctx.id} is a part of ${partition.of} and must be in its unit.`);
    }
    if (data.derive) {
      const family = others.find((definition) => definition.id === data.derive!.from);
      if (!family) errors.push(`Measurement ${ctx.id} derives from ${data.derive.from}, which is not in the dictionary.`);
      else if (family.unit !== data.unit) errors.push(`Measurement ${ctx.id} derives from ${data.derive.from}, which is in another unit.`);
      if (data.derive.upTo !== null && !(data.derive.upTo > data.derive.above)) errors.push("derive.upTo must be above derive.above.");
    }
    return errors;
  },
  compatible(previous, next, id) {
    const errors = unchanged(previous, next, ["key", "keyPattern", "unit", "derive", "slice"], id);
    // A level may be added (a project-only measurement becoming recordable per structure), never taken away.
    for (const level of previous.levels) if (!next.levels.includes(level)) errors.push(`${id}: the ${level} level can never be removed.`);
    return errors;
  }
};
