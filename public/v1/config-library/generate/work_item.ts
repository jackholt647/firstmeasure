import type { Generator } from "./index.js";
import { listWorkItems } from "../../platform/publication/work-items.js";

/** The work item dictionary, from the code that registered it (platform/publication/work-items.ts). */
export const workItemGenerator: Generator = {
  kind: "work_item",
  run: () => listWorkItems().map(({ id, ...data }) => ({ id, data }))
};
