/**
 * What kind of company an organization is, and the kinds of work it does (docs/architecture/setup-steps.md).
 *
 * Data, not configuration: a company type and a service are entries in these lists, and the lists only grow. Never
 * change an entry's id or meaning; add a new one. Each entry carries its copy as a `guided-experiences` language key
 * and the words people type when they search for it (`terms`).
 *
 * Both map onto concepts the platform already has rather than inventing a parallel taxonomy:
 * - a company type names the chooser's `organization.industry` value (guided-experiences/chooser.ts, which the
 *   roofing price book setup already reads) and the CRM industry pack it starts from (crm/presets.ts INDUSTRY_PACKS);
 * - a service names the kind of work it is measured as (`work_kind`, a measurement schema id in
 *   platform/publication/measurement-schemas.ts: roofing, gutters, siding) when there is one.
 */
export type CatalogCopy = { key: string; text: string };
export type CompanyType = {
  id: string; label: CatalogCopy; terms: string[];
  /** The chooser's organization.industry value. */
  industry: string;
  /** The CRM industry pack (crm/presets.ts) this kind of company starts from. */
  crm_pack: "roofing" | "in_home" | "home_services" | "appointments" | "general";
  /** The services offered first for this kind of company, most common first. */
  services: string[];
};
export type Service = { id: string; label: CatalogCopy; terms: string[]; work_kind?: "roofing" | "gutters" | "siding" };

const c = (prefix: string, id: string, text: string): CatalogCopy => ({ key: `gx_${prefix}_${id}`, text });
const type = (id: string, text: string, terms: string[], industry: string, crm_pack: CompanyType["crm_pack"], services: string[]): CompanyType => ({ id, label: c("company_type", id, text), terms, industry, crm_pack, services });
const service = (id: string, text: string, terms: string[], work_kind?: Service["work_kind"]): Service => ({ id, label: c("service", id, text), terms, ...(work_kind ? { work_kind } : {}) });

export const SERVICES: readonly Service[] = Object.freeze([
  service("roof_replacement", "Re-roofs and replacements", ["reroof", "re-roof", "roof replacement", "tear off", "new roof", "shingles"], "roofing"),
  service("roof_repair", "Roof repairs", ["leak", "roof repair", "patch"], "roofing"),
  service("roof_inspection", "Roof inspections", ["inspection", "assessment", "roof certification"], "roofing"),
  service("storm_insurance", "Storm and insurance work", ["storm", "hail", "wind", "insurance", "claims", "restoration"], "roofing"),
  service("commercial_low_slope", "Commercial and low-slope roofing", ["flat roof", "tpo", "epdm", "pvc", "modified bitumen", "commercial", "low slope"], "roofing"),
  service("gutters", "Gutters", ["gutter", "downspouts", "seamless"], "gutters"),
  service("gutter_guards", "Gutter guards", ["leaf guard", "gutter protection"], "gutters"),
  service("gutter_cleaning", "Gutter cleaning", ["clean gutters"], "gutters"),
  service("siding", "Siding", ["vinyl siding", "fiber cement", "hardie", "cladding", "lap siding"], "siding"),
  service("siding_repair", "Siding repairs", ["siding repair"], "siding"),
  service("soffit_fascia", "Soffit and fascia", ["soffit", "fascia", "trim", "capping"]),
  service("windows", "Windows", ["replacement windows", "glass", "window"]),
  service("doors", "Entry and storm doors", ["door", "front door", "storm door"]),
  service("patio_doors", "Patio doors", ["slider", "sliding door", "french door"]),
  service("skylights", "Skylights", ["skylight", "sun tunnel"]),
  service("solar", "Solar", ["solar panels", "pv", "photovoltaic"]),
  service("batteries", "Battery storage", ["battery", "powerwall", "energy storage"]),
  service("decks", "Decks and porches", ["deck", "porch", "railing", "pergola"]),
  service("painting_exterior", "Exterior painting", ["paint", "exterior paint"]),
  service("painting_interior", "Interior painting", ["paint", "interior paint"]),
  service("cabinet_painting", "Cabinet painting", ["cabinets", "refinishing"]),
  service("staining", "Staining", ["stain", "deck stain", "fence stain"]),
  service("drywall", "Drywall", ["sheetrock", "plaster"]),
  service("remodeling", "Remodeling", ["renovation", "remodel"]),
  service("additions", "Additions", ["addition", "new construction", "build"]),
  service("kitchen_remodeling", "Kitchen remodeling", ["kitchen", "cabinets", "countertops"]),
  service("bathroom_remodeling", "Bathroom remodeling", ["bathroom", "bath", "shower"]),
  service("basement_finishing", "Basement finishing", ["basement"]),
  service("cabinetry", "Cabinetry", ["cabinets", "millwork"]),
  service("carpentry", "Carpentry", ["trim carpentry", "framing", "woodwork"]),
  service("demolition", "Demolition", ["demo", "tear out"]),
  service("foundation_repair", "Foundation repair", ["foundation", "piers", "crawl space"]),
  service("garage_doors", "Garage doors", ["garage door", "openers"]),
  service("masonry", "Masonry", ["brick", "stone", "chimney", "tuckpointing"]),
  service("pressure_washing", "Pressure washing", ["power washing", "soft wash"]),
  service("restoration", "Water and fire restoration", ["water damage", "fire damage", "mold", "restoration"]),
  service("tile", "Tile", ["tile install", "backsplash"]),
  service("waterproofing", "Waterproofing", ["basement waterproofing", "sealing"]),
  service("flooring", "Flooring", ["floors", "tile", "hardwood", "carpet", "lvp"]),
  service("insulation", "Insulation", ["attic", "blown in", "spray foam"]),
  service("hvac_install", "HVAC installation", ["ac", "air conditioning", "furnace", "heat pump", "mini split"]),
  service("hvac_repair", "HVAC repair", ["ac repair", "furnace repair", "heating repair"]),
  service("hvac_maintenance", "HVAC maintenance", ["tune up", "service plan"]),
  service("ductwork", "Ductwork", ["ducts", "duct cleaning"]),
  service("plumbing_repair", "Plumbing repair", ["leak", "pipe", "plumbing"]),
  service("water_heaters", "Water heaters", ["tankless", "hot water"]),
  service("drains", "Drains and sewer", ["sewer", "clog", "drain cleaning"]),
  service("repiping", "Repiping", ["repipe", "pex"]),
  service("plumbing_fixtures", "Plumbing fixtures", ["faucet", "toilet", "sink"]),
  service("electrical_repair", "Electrical repair", ["wiring", "outlets", "electrical"]),
  service("panel_upgrades", "Panel upgrades", ["breaker", "service upgrade", "electrical panel"]),
  service("ev_chargers", "EV chargers", ["car charger", "electric vehicle"]),
  service("lighting", "Lighting", ["lights", "fixtures", "landscape lighting"]),
  service("generators", "Generators", ["backup power", "standby generator"]),
  service("lawn_care", "Lawn care", ["mowing", "lawn", "fertilizing"]),
  service("landscape_design", "Landscape design", ["planting", "garden", "landscaping"]),
  service("hardscaping", "Hardscaping", ["patio", "pavers", "retaining wall", "walkway"]),
  service("irrigation", "Irrigation", ["sprinklers", "drip"]),
  service("tree_service", "Tree service", ["tree trimming", "tree removal"]),
  service("snow_removal", "Snow removal", ["plowing", "snow"]),
  service("fencing", "Fencing", ["fence", "gates"]),
  service("concrete", "Concrete", ["driveway", "slab", "sidewalk"])
]);

export const COMPANY_TYPES: readonly CompanyType[] = Object.freeze([
  type("roofing_contractor", "Roofing contractor", ["roofer", "roofing", "roof", "reroof", "storm restoration"], "roofing", "roofing",
    ["roof_replacement", "roof_repair", "roof_inspection", "storm_insurance", "gutters", "siding", "windows", "skylights", "solar", "commercial_low_slope"]),
  type("general_contractor", "General contractor", ["gc", "builder", "construction", "renovation", "remodeler"], "general_contractor", "home_services",
    ["remodeling", "additions", "kitchen_remodeling", "bathroom_remodeling", "roof_replacement", "siding", "windows", "decks", "flooring", "concrete"]),
  type("home_improvement", "Home improvement company", ["remodeler", "remodeling", "home improvement", "handyman", "renovation"], "home_improvement", "home_services",
    ["remodeling", "kitchen_remodeling", "bathroom_remodeling", "basement_finishing", "flooring", "painting_interior", "decks", "windows", "doors", "carpentry"]),
  type("exterior_remodeler", "Exterior remodeler", ["exteriors", "exterior", "home improvement", "storm restoration"], "exteriors", "roofing",
    ["roof_replacement", "siding", "gutters", "windows", "doors", "decks", "painting_exterior", "storm_insurance", "soffit_fascia"]),
  type("siding_contractor", "Siding contractor", ["siding", "vinyl", "fiber cement", "hardie"], "exteriors", "home_services",
    ["siding", "siding_repair", "soffit_fascia", "gutters", "windows", "painting_exterior"]),
  type("gutter_contractor", "Gutter contractor", ["gutters", "downspouts", "gutter guards", "seamless"], "exteriors", "home_services",
    ["gutters", "gutter_guards", "gutter_cleaning", "soffit_fascia", "roof_repair"]),
  type("windows_doors", "Windows and doors", ["windows", "doors", "glass", "replacement windows"], "exteriors", "in_home",
    ["windows", "doors", "patio_doors", "skylights", "siding"]),
  type("solar_installer", "Solar installer", ["solar", "pv", "panels", "battery"], "solar", "in_home",
    ["solar", "batteries", "roof_replacement", "panel_upgrades", "ev_chargers"]),
  type("painting_contractor", "Painting contractor", ["painter", "painting"], "painting", "home_services",
    ["painting_exterior", "painting_interior", "cabinet_painting", "staining", "drywall"]),
  type("hvac_contractor", "HVAC contractor", ["heating", "cooling", "air conditioning", "furnace", "ac", "heat pump"], "hvac", "home_services",
    ["hvac_install", "hvac_repair", "hvac_maintenance", "ductwork", "insulation"]),
  type("plumbing_contractor", "Plumbing contractor", ["plumber", "plumbing", "water heater", "drains"], "plumbing", "home_services",
    ["plumbing_repair", "water_heaters", "drains", "repiping", "plumbing_fixtures"]),
  type("electrical_contractor", "Electrical contractor", ["electrician", "electrical", "wiring", "panel"], "electrical", "home_services",
    ["electrical_repair", "panel_upgrades", "ev_chargers", "lighting", "generators"]),
  type("landscaping", "Landscaping company", ["landscaper", "lawn", "yard", "hardscape"], "landscaping", "home_services",
    ["lawn_care", "landscape_design", "hardscaping", "irrigation", "tree_service", "snow_removal"])
]);

/** "Other": a kind of company the list does not have yet, in the person's own words. */
export const OTHER_COMPANY_TYPE = "other";
export const OTHER_LABEL = c("company_type", "other", "Other");

const typeById = new Map(COMPANY_TYPES.map((entry) => [entry.id, entry]));
const serviceById = new Map(SERVICES.map((entry) => [entry.id, entry]));
export const companyType = (id: string) => typeById.get(id) || null;
export const serviceOf = (id: string) => serviceById.get(id) || null;

/** Checked when the module loads, so a bad catalog edit stops the server rather than a setup. */
(function check() {
  const ids = new Set<string>();
  for (const entry of [...COMPANY_TYPES.map((t) => `type:${t.id}`), ...SERVICES.map((s) => `service:${s.id}`)]) {
    if (ids.has(entry)) throw new Error(`Company profile catalog repeats ${entry}.`);
    ids.add(entry);
  }
  for (const entry of COMPANY_TYPES) for (const id of entry.services) if (!serviceById.has(id)) throw new Error(`Company type ${entry.id} names service ${id}, which is not in the catalog.`);
  if (typeById.has(OTHER_COMPANY_TYPE)) throw new Error("\"other\" is reserved for a company type in the person's own words.");
})();
