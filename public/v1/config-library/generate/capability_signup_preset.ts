import type { Generator } from "./index.js";
import "../kinds/capability_values.js";
import { firstMeasureSignupValues } from "../../platform/capabilities.js";
import { CAPABILITY_SIGNUP_PRESET_ID, CAPABILITY_SIGNUP_PRESET_KIND } from "../kinds/capability_signup_preset.js";

/** No signup preset (the code's answer with nothing configured) and public signup's fixed start, firstMeasureSignupValues. */
export const capabilitySignupPresetGenerator: Generator = {
  kind: CAPABILITY_SIGNUP_PRESET_KIND,
  run: () => [{ id: CAPABILITY_SIGNUP_PRESET_ID, data: { preset_id: "", values: firstMeasureSignupValues({}) } }]
};
