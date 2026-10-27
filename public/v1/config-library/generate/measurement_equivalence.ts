import type { Generator } from "./index.js";
import { listMeasurementEquivalences } from "../../platform/publication/measurement-schemas.js";

/** The measurement equivalences, each named by its first member (the one a person enters). */
export const measurementEquivalenceGenerator: Generator = {
  kind: "measurement_equivalence",
  run: () => listMeasurementEquivalences().map((data) => ({ id: data.measurements[0]!, data }))
};
