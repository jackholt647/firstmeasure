import type { Generator } from "./index.js";
import { listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";

/** The measurement dictionary's definitions, from the code that registered them (platform/publication/measurement-schemas.ts). */
export const measurementDefinitionGenerator: Generator = {
  kind: "measurement_definition",
  run: () => listMeasurementDefinitions().map(({ id, ...data }) => ({ id, data }))
};
