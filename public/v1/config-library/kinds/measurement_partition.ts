import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";
import { DICTIONARY_ID, unchanged } from "./dictionary-shared.js";

export const MEASUREMENT_PARTITION_KIND = "measurement_partition";

/** One way of cutting a whole measurement into parts (roof squares by pitch band). The entry id is the partition id. */
export const measurementPartitionData = z.object({
  /** The whole measurement it cuts: a definition that is not itself a part. */
  of: z.string().regex(DICTIONARY_ID),
  /** The attribute of the building it cuts by (`roof.pitch`). */
  dimension: z.string().regex(DICTIONARY_ID),
  label: z.string().trim().min(1).max(120),
  /** Whether its parts add up to the whole. */
  complete: z.boolean(),
  description: z.string().max(1000)
}).strict();
export type MeasurementPartitionData = z.infer<typeof measurementPartitionData>;

export const measurementPartitionKind: LibraryKind<MeasurementPartitionData> = {
  kind: MEASUREMENT_PARTITION_KIND,
  title: "Measurement partitions",
  description: "How a whole measurement is cut into parts by an attribute of the building, and whether the parts add up to the whole. Parts of one partition never overlap. Only ever added to.",
  idPattern: DICTIONARY_ID,
  schema: measurementPartitionData,
  appendOnly: true,
  titleOf: (data) => data.label,
  validate(data, ctx) {
    const base = listMeasurementDefinitions().find((definition) => definition.id === data.of);
    if (!base) return [`Partition ${ctx.id} cuts ${data.of}, which is not in the dictionary.`];
    // A part of a part would need the overlap of two attributes, which is only known where someone measured it.
    if (base.slice) return [`Partition ${ctx.id} must cut a whole measurement, and ${data.of} is itself a part.`];
    return [];
  },
  compatible: (previous, next, id) => unchanged(previous, next, ["of", "dimension", "complete"], id)
};
