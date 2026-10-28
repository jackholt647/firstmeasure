import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { capabilityValuesErrors, capabilityValuesSchema } from "./capability_values.js";

/**
 * The default value of every capability (docs/architecture/config-library.md). The declarations (keys, kinds,
 * labels, requires, options) are code in platform/capability_defs.ts and code gates on the keys; what each one is
 * when nothing else sets it is this one entry, laid over the declarations as the registry is read
 * (platform/capabilities.ts). A value capability the entry does not name is off (a number its minimum or 0, a choice
 * its first option).
 */
export const CAPABILITY_DEFAULTS_KIND = "capability_defaults";
export const CAPABILITY_DEFAULTS_ID = "platform";

export type CapabilityDefaultsData = { values: Record<string, boolean | number | string> };

export const capabilityDefaultsKind: LibraryKind<CapabilityDefaultsData> = {
  kind: CAPABILITY_DEFAULTS_KIND,
  title: "Capability defaults",
  description: "What every app, feature and setting is for an organization that has not set it: one value per declared capability key.",
  idPattern: /^platform$/,
  schema: z.object({ values: capabilityValuesSchema }).strict(),
  validate: (data, ctx) => [
    ...(ctx.id === CAPABILITY_DEFAULTS_ID ? [] : [`There is one capability defaults entry, ${CAPABILITY_DEFAULTS_ID}.`]),
    ...Object.keys(data.values).filter((key) => !ctx.registries.capability(key)).map((key) => `values.${key}: ${key} is not a declared capability.`),
    ...capabilityValuesErrors(data.values, "values").filter((error) => !error.endsWith("is not a declared capability."))
  ],
  titleOf: () => "Capability defaults"
};
