import type { Generator } from "./index.js";
import { appFlagDefaultsGenerator } from "./app_flag_defaults.js";
import { capabilityDefaultsGenerator } from "./capability_defaults.js";
import { capabilityPresetGenerator } from "./capability_preset.js";
import { capabilitySignupPresetGenerator } from "./capability_signup_preset.js";
import { sandboxConfigurationGenerator } from "./sandbox_configuration.js";

/** Every kind's one-shot generator (see ./index.ts). One import per kind; removed with that kind's code seeds. */
export async function allGenerators(): Promise<Generator[]> {
  return [
    appFlagDefaultsGenerator,
    capabilityDefaultsGenerator,
    capabilityPresetGenerator,
    capabilitySignupPresetGenerator,
    sandboxConfigurationGenerator
  ];
}
