import type { Generator } from "./index.js";
import "../kinds/capability_values.js";
import { capabilityDefaultValues } from "../../platform/capabilities.js";
import { CAPABILITY_DEFAULTS_ID, CAPABILITY_DEFAULTS_KIND } from "../kinds/capability_defaults.js";

/** The `default` of every value capability the code declares today (platform/capability_defs.ts and modules). */
export const capabilityDefaultsGenerator: Generator = {
  kind: CAPABILITY_DEFAULTS_KIND,
  run: () => [{ id: CAPABILITY_DEFAULTS_ID, data: { values: capabilityDefaultValues() } }]
};
