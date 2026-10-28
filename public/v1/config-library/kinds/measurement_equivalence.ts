import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { listMeasurementDefinitions, listMeasurementEquivalences, unitQuantity } from "../../platform/publication/measurement-schemas.js";
import { DICTIONARY_ID, unchanged } from "./dictionary-shared.js";

export const MEASUREMENT_EQUIVALENCE_KIND = "measurement_equivalence";

/**
 * Two or more definitions that are the same quantity in different units (roof squares and roof area). The first
 * listed is the one a person enters. The entry id names the equivalence; by convention it is the first member's id.
 */
export const measurementEquivalenceData = z.object({
  measurements: z.array(z.string().regex(DICTIONARY_ID)).min(2).max(8),
  description: z.string().max(1000)
}).strict();
export type MeasurementEquivalenceData = z.infer<typeof measurementEquivalenceData>;

export const measurementEquivalenceKind: LibraryKind<MeasurementEquivalenceData> = {
  kind: MEASUREMENT_EQUIVALENCE_KIND,
  title: "Measurement equivalences",
  description: "Definitions that are the same quantity in different units, converted by the units' scales. An addition to the dictionary that changes neither definition. Only ever added to.",
  idPattern: DICTIONARY_ID,
  schema: measurementEquivalenceData,
  appendOnly: true,
  titleOf: (data) => data.measurements.join(" = "),
  validate(data, ctx) {
    const definitions = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
    const members = data.measurements.map((id) => definitions.get(id));
    if (new Set(data.measurements).size !== data.measurements.length) return ["An equivalence names each measurement once."];
    if (members.some((definition) => !definition)) return ["An equivalence names two or more defined measurements."];
    const errors: string[] = [];
    const quantity = unitQuantity(members[0]!.unit);
    const taken = new Set(listMeasurementEquivalences().filter((equivalence) => (equivalence.id || equivalence.measurements[0]) !== ctx.id).flatMap((equivalence) => equivalence.measurements));
    for (const definition of members) {
      if (!definition!.key || definition!.slice || !quantity || unitQuantity(definition!.unit) !== quantity) errors.push(`${definition!.id} cannot be equivalent: it needs its own key, no partition, and a unit of the same kind.`);
      if (taken.has(definition!.id)) errors.push(`${definition!.id} is already in an equivalence.`);
    }
    return errors;
  },
  compatible: (previous, next, id) => unchanged(previous, next, ["measurements"], id)
};
