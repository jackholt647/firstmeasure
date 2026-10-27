import { describeDataProvider } from "../platform/publication/providers.js";
import { describeAction } from "../platform/publication/actions.js";
import { initializePublication } from "../platform/publication/bootstrap.js";
import { widgetDefinition } from "../platform/widgets/catalog.js";
import { definitionForKey, measurementSchema } from "../platform/publication/measurement-schemas.js";
import { workItem } from "../platform/publication/work-items.js";
import { capabilityDefinition } from "../platform/capabilities.js";
import { validateConditions } from "../work/conditions.js";
import { libraryEntry } from "./library.js";
import type { RegistryChecks } from "./contracts.js";

/**
 * What the running code registers, read when an entry is saved: in-memory lookups only, so a save's checks take
 * milliseconds. The registries load once per process (`warmRegistryChecks` at boot on dev, so the first save is fast too).
 */
let checks: RegistryChecks | undefined;
export function warmRegistryChecks() { return registryChecks(); }
export function registryChecks(): RegistryChecks {
  if (checks) return checks;
  initializePublication();
  return checks = {
    provider: (id, version) => !!describeDataProvider(id, version),
    providerExport: (id, exportName) => !!(describeDataProvider(id) as { exports?: Record<string, unknown> } | null)?.exports?.[exportName],
    action: (id, version) => !!describeAction(id, version),
    widget: (id, version = "1") => { try { widgetDefinition(id, version); return true; } catch { return false; } },
    measurementKey: (key) => !!definitionForKey(key),
    measurementSchema: (id) => { try { return !!measurementSchema(id); } catch { return false; } },
    workItem: (id) => !!workItem(id),
    capability: (id) => { try { return !!capabilityDefinition(id); } catch { return false; } },
    conditions: (value, at) => validateConditions(value, at),
    entry: (kind, id) => libraryEntry(kind, id)
  };
}
