import type { Generator } from "./index.js";
import { listMeasurementSchemas } from "../../platform/publication/measurement-schemas.js";

/** The measurement schemas (roofing, gutters, siding), from the code that registered them. */
export const measurementSchemaGenerator: Generator = {
  kind: "measurement_schema",
  run: () => listMeasurementSchemas().map(({ id, ...data }) => ({ id, data }))
};
