import type { Generator } from "./index.js";
import { listWorkSchemas } from "../../platform/publication/work-items.js";

/** What each kind of work requires, from the code that registered it. */
export const workSchemaGenerator: Generator = {
  kind: "work_schema",
  run: () => listWorkSchemas().map(({ id, ...data }) => ({ id, data }))
};
