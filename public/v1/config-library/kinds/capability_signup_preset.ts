import { z } from "zod";
import type { LibraryKind } from "../contracts.js";
import { capabilityValuesErrors, capabilityValuesSchema } from "./capability_values.js";
import { CAPABILITY_PRESET_KIND } from "./capability_preset.js";

/**
 * What a newly registered organization starts with (docs/architecture/config-library.md): the capability preset
 * public signup applies (`preset_id`, empty for the capability defaults) and the values every signup gets whatever
 * the preset or the app flag defaults say (`values`: today the FirstMeasure-only start). Operators choose the preset
 * with PUT /v1/platform/organizations/:orgId/capabilities/signup-preset.
 */
export const CAPABILITY_SIGNUP_PRESET_KIND = "capability_signup_preset";
export const CAPABILITY_SIGNUP_PRESET_ID = "new_organization";

export type CapabilitySignupPresetData = { preset_id: string; values: Record<string, boolean | number | string> };

export const capabilitySignupPresetKind: LibraryKind<CapabilitySignupPresetData> = {
  kind: CAPABILITY_SIGNUP_PRESET_KIND,
  title: "Signup capability preset",
  description: "The preset public signup applies, and the values every new organization starts with on top of it.",
  idPattern: /^new_organization$/,
  schema: z.object({
    preset_id: z.string().trim().max(80).regex(/^([a-z0-9][a-z0-9_]{0,79})?$/).default(""),
    values: capabilityValuesSchema.default({})
  }).strict() as unknown as z.ZodType<CapabilitySignupPresetData>,
  validate: (data, ctx) => [
    ...(ctx.id === CAPABILITY_SIGNUP_PRESET_ID ? [] : [`There is one signup preset entry, ${CAPABILITY_SIGNUP_PRESET_ID}.`]),
    ...(data.preset_id && !ctx.registries.entry(CAPABILITY_PRESET_KIND, data.preset_id) ? [`preset_id: there is no capability preset ${data.preset_id}.`] : []),
    ...capabilityValuesErrors(data.values, "values")
  ],
  titleOf: () => "Signup capability preset"
};
