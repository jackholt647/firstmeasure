import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Generator } from "./index.js";
import { ACCESSORY_ROLES, BRAND_LOOK, CATEGORY, DEFAULT_ICE_COVERAGE, DEFAULT_RULE, DEFAULT_SLOTS, FEATURED, ICE_COVERAGE, ROLE_RULE } from "../../pricebook/setups/roofing.js";

const research = (file: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../materials/roofing-research/${file}`, import.meta.url)), "utf8"));

/** The roofing setup's data: the three research files and the setup's default tables (pricebook/setups/roofing.ts). */
export const pricebookSetupGenerator: Generator = {
  kind: "pricebook_setup",
  run: () => [
    { id: "roofing.catalog", data: { trade: "roofing", part: "catalog", content: research("roofing-catalog-2026.json") } },
    { id: "roofing.components", data: { trade: "roofing", part: "components", content: research("roof-type-components-2026.json") } },
    { id: "roofing.suppliers", data: { trade: "roofing", part: "suppliers", content: research("roofing-suppliers-2026.json") } },
    { id: "roofing.settings", data: { trade: "roofing", part: "settings", content: JSON.parse(JSON.stringify({
      featured_brands: FEATURED, brand_looks: BRAND_LOOK, default_rules: DEFAULT_RULE, accessory_roles: ACCESSORY_ROLES, role_rules: ROLE_RULE, categories: CATEGORY,
      default_slots: DEFAULT_SLOTS, ice_coverage: Object.entries(ICE_COVERAGE).map(([id, widths]) => ({ id, widths })), default_ice_coverage: DEFAULT_ICE_COVERAGE
    })) } }
  ]
};
