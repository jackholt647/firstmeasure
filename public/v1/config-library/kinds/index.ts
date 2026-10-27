import { registerLibraryKind } from "../kinds.js";
import { appFlagDefaultsKind } from "./app_flag_defaults.js";
import { capabilityDefaultsKind } from "./capability_defaults.js";
import { capabilityPresetKind } from "./capability_preset.js";
import { capabilitySignupPresetKind } from "./capability_signup_preset.js";
import { sandboxConfigurationKind } from "./sandbox_configuration.js";
/**
 * Every config library kind, registered once. One import and one call per kind file; a kind's file belongs to the
 * domain that reads its entries.
 */
let registered = false;
export function registerAllLibraryKinds() {
  if (registered) return;
  registered = true;
  registerLibraryKind(appFlagDefaultsKind);
  registerLibraryKind(capabilityDefaultsKind);
  registerLibraryKind(capabilityPresetKind);
  registerLibraryKind(capabilitySignupPresetKind);
  registerLibraryKind(sandboxConfigurationKind);
}
