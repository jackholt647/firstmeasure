import type { Generator } from "./index.js";
import "../kinds/capability_values.js";
import { builtinCapabilityPresets, capabilityDefaultValues, valueCapabilities, type CapabilityValue } from "../../platform/capabilities.js";
import { CAPABILITY_PRESET_KIND } from "../kinds/capability_preset.js";

/**
 * The five built-in capability presets as the code builds them today. Platform Defaults and Full Platform were
 * computed from the registry; they become a `base` (`defaults`, `all_on`) so a capability added later is still
 * covered. The others were "everything off, then these": their `values` are what differs from that start.
 */
export const capabilityPresetGenerator: Generator = {
  kind: CAPABILITY_PRESET_KIND,
  run: () => {
    const off = Object.fromEntries(valueCapabilities().map((node) => [node.key, node.type === "boolean" ? false : node.default as CapabilityValue]));
    return builtinCapabilityPresets().map((preset) => {
      const base = preset.id === "platform_defaults" ? "defaults" : preset.id === "full_platform" ? "all_on" : "off";
      if (base === "defaults" && JSON.stringify(preset.values) !== JSON.stringify(capabilityDefaultValues())) throw new Error("Platform Defaults is no longer the registry defaults.");
      const values = base === "off" ? Object.fromEntries(Object.entries(preset.values).filter(([key, value]) => off[key] !== value)) : {};
      return { id: preset.id, data: { name: preset.name, description: preset.description, builtin: true, base, values } };
    });
  }
};
