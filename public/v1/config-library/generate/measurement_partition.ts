import type { Generator } from "./index.js";
import { listMeasurementPartitions } from "../../platform/publication/measurement-schemas.js";

/** The measurement dictionary's partitions, from the code that registered them. */
export const measurementPartitionGenerator: Generator = {
  kind: "measurement_partition",
  run: () => listMeasurementPartitions().map(({ id, ...data }) => ({ id, data }))
};
