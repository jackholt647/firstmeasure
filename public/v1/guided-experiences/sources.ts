import { roofingSetupOptions, roofingSupplierPresets } from "../pricebook/setups/roofing.js";
import { laborSetupOptions } from "../labor/labor-setup.js";
import { registerGuidedSource } from "./registry.js";

/**
 * Guided sources: code that fills a setup step's options on the server when the experience is read (product catalogs,
 * prices for the organization's region, its groups and outside companies). Experiences are library entries
 * (config-library kind guided_experience) and name a source by id in a step's `source`; saving an entry that names one
 * not registered here is refused.
 */
let registered = false;
export function ensureGuidedSources() {
  if (registered) return;
  registered = true;
  // Products, rules and prices for the organization's price region. The chooser context supplies the region.
  registerGuidedSource("pricebook.roofing_setup", (_ctx, chooser) => roofingSetupOptions(chooser.organization.state, chooser.organization.region));
  registerGuidedSource("labor.setup", (ctx) => laborSetupOptions(ctx.orgId));
  registerGuidedSource("operations.suppliers", () => ({ suppliers: roofingSupplierPresets() }));
  registerGuidedSource("operations.workforce", (ctx) => laborSetupOptions(ctx.orgId));
}
