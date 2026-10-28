import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { capabilityValuesErrors, capabilityValuesSchema } from "./capability_values.js";

/**
 * A capability preset (docs/architecture/config-library.md): a whole configuration an operator applies to an
 * organization, or names as the signup preset. `base` says where values not named start, computed from the running
 * registry so a capability added later is covered: `off` (every on/off capability off, settings at their defaults),
 * `defaults` (every capability at its default) or `all_on` (every on/off capability on). `values` are laid over it.
 * Built-in presets are edited here, in the library; the operator routes edit only presets that are not built in.
 */
export const CAPABILITY_PRESET_KIND = "capability_preset";
export const PRESET_BASES = ["off", "defaults", "all_on"] as const;
export type PresetBase = (typeof PRESET_BASES)[number];

export type CapabilityPresetData = {
  name: string;
  description: string;
  builtin: boolean;
  base: PresetBase;
  values: Record<string, boolean | number | string>;
};

export const capabilityPresetKind: LibraryKind<CapabilityPresetData> = {
  kind: CAPABILITY_PRESET_KIND,
  title: "Capability presets",
  description: "Named capability configurations operators apply to organizations or choose for signup.",
  idPattern: /^[a-z0-9][a-z0-9_]{0,79}$/,
  schema: z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).default(""),
    builtin: z.boolean().default(false),
    base: z.enum(PRESET_BASES).default("off"),
    values: capabilityValuesSchema.default({})
  }).strict() as unknown as z.ZodType<CapabilityPresetData>,
  validate: (data) => capabilityValuesErrors(data.values, "values"),
  titleOf: (data) => data.name
};
