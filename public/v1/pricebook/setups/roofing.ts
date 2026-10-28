import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest } from "../../platform/errors.js";
import { definitionForKey, listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";
import { ROOFING_LIBRARY_ITEMS } from "../../materials/roofing-library-data.js";
import { industryMeasurementDefaults, readMeasurementDefaults, ruleLineUnit, saveMeasurementDefaults, type MeasurementDefaults } from "../../materials/measurement-defaults.js";
import { getOrganizationPricebook, saveOrganizationCatalog } from "../storage.js";
import type { TradeSetup } from "./index.js";
import type { PublicationContext } from "../../platform/publication/contracts.js";
import { ROOFING_LIBRARY_SUPPLIERS } from "../../materials/roofing-library-data.js";

/**
 * The roofing price book setup. What an organization says it installs becomes its price book and the measurement
 * defaults that turn a roof's measurements into a materials list when no document has said otherwise:
 *
 * - The kinds of roof it installs (`roof_types`: shingle, shake, metal, tile, slate, TPO, PVC, EPDM, torch-down).
 * - Shingle: the manufacturers it uses. Every product they make goes into the price book, so it is searchable; the
 *   defaults (`defaults`: shingle, underlayment, ice and water and how far it runs, pipe boot, the three vents, the
 *   low-slope system) are what generation uses. Each starts from the first picked manufacturer that makes one.
 * - Any other kind: its components come from roof-type-components-2026.json (data, provisional) as price book
 *   items; with no shingle, the default material (`default_material`, one of those systems) becomes the measurement
 *   defaults: one rule per standard component, through the same rule model as shingles.
 *
 * Price book items carry quantity formulas over measurement dictionary keys only, in the item's own order unit
 * (an Owens Corning bundle covers 32.8 sq ft, not a flat third of a square). Something the dictionary does not count
 * (pipe boots, box vents, stories, decking sheets) gets no formula and is marked as entered by hand. Both are written
 * through their own writers. Every number is a starting point the organization changes afterwards.
 */

export type Product = {
  id: string; name: string; code: string; kind: "line" | "accessory" | "generic" | "labor" | "component"; role: string; brand: string; manufacturer: string;
  unit: string; cost: number; price: number; note: string; tier: string; popular: boolean; confidence: string;
  /** How much of its rule's unit one order unit covers: squares per bundle, feet per bundle, squares per roll. */
  coverage: number; rule: string;
  /** Shingle lines: how prominent the line is ("default", "visible", "more"); search finds every line. */
  visibility?: "default" | "visible" | "more";
  /** Shingle lines whose starter course shows, so it is bought in the shingle's colour. */
  reveals_starter?: boolean;
  /** A starter strip made in the designer shingles' colours. */
  colored_starter?: boolean;
  /** The brand's flagship line, which the shingle default starts from. */
  flagship?: boolean;
  /** The product a role defaults to for its brand (or, generic, everywhere) when it is not simply the first listed. */
  setup_default?: boolean;
  /** Low-slope products: which membrane system (a roof type id: tpo, pvc, epdm, mod_bit). */
  system?: string;
  /** Data added without a listing to check against, to be replaced as research lands. */
  provisional?: boolean;
  /** Components: the system they belong to, their group, terms and waste, and whether they are on a typical job. */
  component?: { system: string; key: string; group: string; standard: boolean; explain: string; terms: { measurement: string; factor: number }[]; waste: number; by_hand: boolean };
};
export type Rule = { id: string; label: string; explanation: string; group: string; formula: string | null; unit: string; include_waste: boolean; show: boolean; order: number; per_package?: number };
type Brand = { id: string; name: string; color: string; tagline: string; logo?: string; lines: Product[]; accessories: Product[] };
type Region = { id: string; label: string; states: string[]; material: number; labor: number };
/** A kind of roof the setup asks about and the component systems it covers; `catalog` kinds use the manufacturer catalog. */
export type RoofType = { id: string; label: string; systems: string[]; catalog: boolean; low_slope?: { cap: string; base?: string } };
export type RoofingCatalog = { source: "research" | "library"; brands: Brand[]; generic: Product[]; labor: Product[]; rules: Rule[]; regions: Region[]; roof_types: RoofType[] };
/** One system of the roof-type components (standing seam metal, TPO): its components as price book products. */
export type ComponentSystem = { id: string; label: string; status: string; components: Product[] };

export const FEATURED = ["gaf", "owens_corning", "malarkey", "certainteed"];
export const BRAND_LOOK: Record<string, { name: string; color: string; tagline: string }> = {
  gaf: { name: "GAF", color: "#d71920", tagline: "Timberline, Royal Sovereign" },
  owens_corning: { name: "Owens Corning", color: "#d6246e", tagline: "Duration, Oakridge, Supreme" },
  malarkey: { name: "Malarkey", color: "#1f6f43", tagline: "Highlander, Vista, Legacy" },
  certainteed: { name: "CertainTeed", color: "#0a5aa5", tagline: "Landmark, XT 25, Presidential" }
};
/** Research rule ids beside the measurement-default rule keys they fill. */
export const DEFAULT_RULE: Record<string, string> = { field_shingles: "shingles", starter: "starter", hip_ridge: "hip_ridge", ice_water: "ice_water", underlayment: "underlayment", drip_edge: "drip_edge", ridge_vent: "ridge_vent", intake_vent: "intake_vent", step_flashing: "step_flashing", headwall_flashing: "headwall_flashing", valley_metal: "valley_metal", roofing_nails: "coil_nails", cap_nails: "cap_nails" };
export const ACCESSORY_ROLES = ["starter", "hip_ridge", "underlayment", "ice_water", "ridge_vent", "intake_vent", "box_vent", "pipe_boot", "low_slope_membrane", "low_slope_base", "low_slope_cap"];
/** The research rule an accessory role is measured by, where it is not the role itself. */
export const ROLE_RULE: Record<string, string> = { pipe_boot: "pipe_boots", box_vent: "box_vents", low_slope_membrane: "low_slope", low_slope_base: "low_slope", low_slope_cap: "low_slope" };
export const CATEGORY: Record<string, string> = { line: "shingle_roofs", starter: "shingle_roofs", hip_ridge: "shingle_roofs", underlayment: "shingle_roofs", ice_water: "leak_barriers", ridge_vent: "accessories", intake_vent: "accessories", box_vent: "accessories", ventilation: "accessories", pipe_boot: "accessories", flashing: "flashing", penetrations: "accessories", fasteners: "accessories", sealants: "accessories", decking: "misc", labor: "misc", low_slope_membrane: "flat_roofs", low_slope_base: "flat_roofs", low_slope_cap: "flat_roofs" };
/**
 * The slots of the defaults step: which products can fill each (accessory roles of the picked brands, then generic
 * items measured by the same rule). The browser composes the same lists from the same data (guided-setup.js).
 */
export const DEFAULT_SLOTS = {
  underlayment: { role: "underlayment", rule: "underlayment" },
  ice_water: { role: "ice_water", rule: "ice_water" },
  pipe_boot: { role: "pipe_boot", rule: "pipe_boots", generic_first: true },
  ridge_vent: { role: "ridge_vent", rule: "ridge_vent" },
  intake_vent: { role: "intake_vent", rule: "intake_vent" },
  box_vent: { role: "box_vent", rule: "box_vents" }
} as const;
export type DefaultSlot = keyof typeof DEFAULT_SLOTS;
/**
 * How far the ice and water barrier runs, in feet up from each edge (a valley gets a course centred in it). The
 * default is 18 in around the eaves and rakes plus the valleys. Quantities follow the choice: the measurement rule
 * counts 3 ft courses (one per foot of eave at 3 ft, half a course at 18 in) and the price book formula square feet.
 */
export const ICE_COVERAGE = {
  perimeter_18_valleys: { eaves: 1.5, rakes: 1.5, valleys: 3 },
  eaves_36_valleys: { eaves: 3, rakes: 0, valleys: 3 },
  eaves_72_valleys: { eaves: 6, rakes: 0, valleys: 3 },
  eaves_36: { eaves: 3, rakes: 0, valleys: 0 },
  valleys: { eaves: 0, rakes: 0, valleys: 3 },
  none: null
} as const;
export type IceCoverage = keyof typeof ICE_COVERAGE;
export const DEFAULT_ICE_COVERAGE: IceCoverage = "perimeter_18_valleys";
const LOW_SLOPE_SYSTEMS = ["tpo", "pvc", "epdm", "mod_bit", "none"] as const;
const NATIONAL: Region = { id: "national", label: "National average", states: [], material: 1, labor: 1 };

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (...values: unknown[]) => { for (const value of values) { const n = Number(value); if (Number.isFinite(n) && n > 0) return n; } return 0; };
const list = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
const obj = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A brand's logo as a site path: the research writes images under public/images/brands/<trade>/. */
export function logoPath(value: unknown) {
  const raw = String(typeof value === "string" ? value : obj(value).src ?? obj(value).path ?? obj(value).url ?? "").trim().split("\\").join("/");
  if (!raw || /[<>"'\s]/.test(raw) || /^(javascript|data):/i.test(raw)) return "";
  if (/^https:\/\//i.test(raw)) return raw;
  const site = raw.replace(/^(\.\/)+/, "").replace(/^public\//, "").replace(/^\/+/, "");
  return /\.(svg|png|webp|jpe?g)$/i.test(site) ? `/${site}` : "";
}
const RESEARCH_PATH = () => path.resolve(process.cwd(), "materials/roofing-research/roofing-catalog-2026.json");
const COMPONENTS_PATH = () => path.resolve(process.cwd(), "materials/roofing-research/roof-type-components-2026.json");
let cache: { file: string; mtime: number; value: RoofingCatalog | null } | null = null;

/** Coverage of one order unit in its rule's unit, from the research's product facts. */
function coverageFor(rule: string, unit: string, raw: Record<string, unknown>) { return Math.round(rawCoverage(rule, unit, raw) * 1e6) / 1e6; }
function rawCoverage(rule: string, unit: string, raw: Record<string, unknown>) {
  const c = obj(raw.coverage), size = obj(raw.order_size);
  if (rule === "field_shingles") return num(raw.coverage_sq_ft_per_bundle) / 100 || 1 / num(raw.bundles_per_square, 3);
  if (unit === "lf") return num(c.lf, size.lf, c.length_ft) || 1;
  if (unit === "sq") return num(num(c.sq_ft_net, size.sq_ft_net) / 100, c.squares_gross, size.squares_gross, num(c.sq_ft_gross) / 100) || 1;
  if (unit === "ea" && rule === "step_flashing") return num(size.pieces, c.pieces) || 1;
  return 1;
}

/** The kinds of roof the setup asks about (the catalog's `roof_types`), shingle alone where the file has none. */
function roofTypesOf(raw: Record<string, unknown>): RoofType[] {
  const types = list(raw.roof_types).map((entry) => ({ id: String(entry.id), label: String(entry.label || entry.id), systems: list(entry.systems).map(String), catalog: entry.catalog === true,
    ...(entry.low_slope ? { low_slope: { cap: String(obj(entry.low_slope).cap || ""), ...(obj(entry.low_slope).base ? { base: String(obj(entry.low_slope).base) } : {}) } } : {}) })).filter((entry) => /^[a-z][a-z0-9_]{0,39}$/.test(entry.id));
  return types.length ? types : [{ id: "shingle", label: "Shingle", systems: [], catalog: true }];
}

/** Reads the research catalog in its own schema (schema_version 1). Returns null when it is absent or unreadable. */
export function readResearchCatalog(file = RESEARCH_PATH()): RoofingCatalog | null {
  if (!existsSync(file)) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.value;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const rules: Rule[] = list(raw.estimating_rules).map((rule) => ({ id: String(rule.id), label: String(rule.label || rule.id), explanation: String(rule.explanation || ""), group: String(rule.group || ""),
      formula: typeof rule.pricebook_formula === "string" ? rule.pricebook_formula : null, unit: String(rule.unit || "ea"), include_waste: rule.include_waste === true, show: rule.show_in_setup === true, order: Number(rule.order || 0), per_package: num(obj(rule.order_packaging).units_per_package) }));
    // Low-slope products are sold by the roll and cover squares; they have no research rule of their own.
    const unitOf = (ruleId: string) => ruleId === "low_slope" ? "sq" : rules.find((rule) => rule.id === ruleId)?.unit || "ea";
    // A product's own coverage first; the rule's usual package where the product gives none (a 7,200 nail box, a net 10-square roll).
    const covered = (ruleId: string, entry: Record<string, unknown>) => {
      const own = coverageFor(ruleId, unitOf(ruleId), entry), usual = rules.find((rule) => rule.id === ruleId)?.per_package || 0;
      if (ruleId === "underlayment") return num(num(obj(entry.coverage).sq_ft_net) / 100, usual, own);
      return own === 1 && usual > 0 ? usual : own;
    };
    const product = (entry: Record<string, unknown>, kind: Product["kind"], brand: string, manufacturer: string, rule: string, role = ""): Product => {
      const cost = num(entry.default_price);
      return { id: String(entry.id), name: String(entry.name), code: String(entry.manufacturer_code || "").split(" ")[0] || "", kind, role: role || rule, brand, manufacturer,
        unit: String(entry.unit || (kind === "line" ? "bundle" : "ea")), cost, price: cost, note: String(entry.price_note || entry.provisional_note || entry.note || ""),
        tier: String(entry.tier || ""), popular: entry.popular === true, confidence: String(entry.price_confidence || ""), coverage: covered(rule, entry), rule,
        ...(kind === "line" ? { visibility: (["default", "visible", "more"].includes(String(entry.setup_visibility)) ? entry.setup_visibility : entry.popular === true ? "default" : "visible") as Product["visibility"], reveals_starter: entry.reveals_starter === true } : {}),
        ...(entry.setup_flagship === true ? { flagship: true } : {}), ...(entry.setup_default === true ? { setup_default: true } : {}),
        ...(entry.system ? { system: String(entry.system) } : {}), ...(entry.provisional === true ? { provisional: true } : {}),
        ...(entry.colored_starter === true || entry.role === "starter_designer" ? { colored_starter: true } : {}) };
    };
    const brands: Brand[] = list(raw.manufacturers).map((maker) => {
      const id = String(maker.pricebook_manufacturer || maker.id), look = BRAND_LOOK[id] || { name: String(maker.name), color: String(obj(maker.logo_hint).primary_color || "#344054"), tagline: "" };
      const manufacturer = String(maker.name || look.name);
      // A brand without a written tagline is described by its first few lines, popular ones first.
      const named = list(maker.product_lines).sort((a, b) => Number(b.popular === true) - Number(a.popular === true)).map((line) => String(line.name || "")).filter(Boolean);
      const tagline = BRAND_LOOK[id]?.tagline || named.slice(0, 3).join(", ");
      return { id, name: manufacturer, color: String(obj(maker.logo_hint).primary_color || look.color), tagline, ...(logoPath(maker.logo) ? { logo: logoPath(maker.logo) } : {}),
        lines: list(maker.product_lines).map((line) => ({ ...product(line, "line", id, manufacturer, "field_shingles"), name: `${manufacturer} ${String(line.name)}` })),
        // A designer starter ("starter_designer") is a starter: it is told apart by `colored_starter`.
        accessories: list(maker.accessories).map((entry) => entry.role === "starter_designer" ? { ...entry, role: "starter", colored_starter: true } : entry).filter((entry) => ACCESSORY_ROLES.includes(String(entry.role)))
          .map((entry) => ({ ...product(entry, "accessory", id, manufacturer, ROLE_RULE[String(entry.role)] || String(entry.role), String(entry.role)), name: `${manufacturer} ${String(entry.name)}` })) };
    }).filter((brand) => brand.lines.length);
    const generic = list(raw.generic_items).map((entry) => ({ ...product(entry, "generic", "", "", String(entry.rule_id || "")), role: String(entry.category || "misc") }));
    const labor = list(raw.labor_items).map((entry) => ({ ...product(entry, "labor", "", "", String(entry.rule_id || "")), role: "labor" }));
    const regions: Region[] = list(raw.regions).map((region) => ({ id: String(region.id), label: String(region.label || region.id), states: list(region.states).map(String), material: num(region.material_multiplier) || 1, labor: num(region.labor_multiplier, region.price_multiplier) || 1 }));
    const value: RoofingCatalog = { source: "research", brands, generic, labor, rules, regions: regions.some((region) => region.id === "national") ? regions : [NATIONAL, ...regions], roof_types: roofTypesOf(raw) };
    cache = { file, mtime, value };
    return value;
  } catch { return null; }
}

/** The roofing library as a catalog, for a checkout without the research file. */
export function libraryCatalog(): RoofingCatalog {
  const brandOf = (manufacturer: string) => FEATURED.find((id) => lower(manufacturer).replace(/\s+/g, "_").includes(id)) || "";
  const types: Record<string, string> = { "starter": "starter", "hip & ridge": "hip_ridge", "underlayment": "underlayment", "ice & water": "ice_water" };
  const coverage: Record<string, number> = { field_shingles: 1 / 3, starter: 120, hip_ridge: 25, underlayment: 10, ice_water: 2, ridge_vent: 4 };
  const products = ROOFING_LIBRARY_ITEMS.map(([id, name, code, type, manufacturer, unit, cost, price, note]) => {
    const role = lower(type) === "shingles" ? "field_shingles" : types[lower(type)] || (/ridge vent/i.test(name) ? "ridge_vent" : "");
    return { id, name, code, kind: (lower(type) === "shingles" ? "line" : "accessory") as Product["kind"], role, brand: brandOf(manufacturer), manufacturer, unit, cost, price: cost, note, tier: /3-tab/i.test(name) ? "3_tab" : "architectural", popular: false, confidence: "library", coverage: coverage[role] || 1, rule: role };
  });
  const brands = FEATURED.map((id) => ({ id, ...BRAND_LOOK[id]!, lines: products.filter((p) => p.brand === id && p.kind === "line"), accessories: products.filter((p) => p.brand === id && p.kind === "accessory" && ACCESSORY_ROLES.includes(p.role)) })).filter((brand) => brand.lines.length);
  const rules: Rule[] = [
    { id: "field_shingles", label: "Shingles", explanation: "Shingles cover every square of roof except the nearly flat part, plus waste for cutting.", group: "shingles", formula: "roofSquares - flatRoofSquares", unit: "sq", include_waste: true, show: true, order: 1 },
    { id: "starter", label: "Starter strip", explanation: "The first row along the eaves and rakes.", group: "shingles", formula: "eavesLf + rakesLf", unit: "lf", include_waste: false, show: true, order: 2 },
    { id: "hip_ridge", label: "Hip and ridge cap", explanation: "Caps every hip and ridge.", group: "shingles", formula: "ridgesLf + hipsLf", unit: "lf", include_waste: false, show: true, order: 3 },
    { id: "ice_water", label: "Ice and water barrier", explanation: "Along the eaves, down every valley and over low-slope sections.", group: "underlayment", formula: "(eavesLf * 6 + valleyLf * 3) / 100 + pitch2to4Squares", unit: "sq", include_waste: false, show: true, order: 4 },
    { id: "underlayment", label: "Underlayment", explanation: "Covers the whole shingled deck.", group: "underlayment", formula: "roofSquares - flatRoofSquares", unit: "sq", include_waste: false, show: true, order: 5 },
    { id: "ridge_vent", label: "Ridge vent", explanation: "Runs along the ridges.", group: "ventilation", formula: "ridgesLf", unit: "lf", include_waste: false, show: true, order: 6 }
  ];
  return { source: "library", brands, generic: [], labor: [], rules, regions: [NATIONAL], roof_types: [{ id: "shingle", label: "Shingle", systems: [], catalog: true }] };
}

export function roofingCatalog(): RoofingCatalog { return readResearchCatalog() || libraryCatalog(); }

/** A component's price book item id: rtc-<system>-<key>. */
export const componentItemId = (system: string, key: string) => `rtc-${system}-${key}`.replace(/_/g, "-").slice(0, 120);
/** A component's measurement-default rule key: <system>_<key>, so a system's rules are found and replaced together. */
export const componentRuleKey = (system: string, key: string) => `${system}_${key}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
let componentsCache: { file: string; mtime: number; value: Map<string, ComponentSystem> } | null = null;
/**
 * The roof-type components (materials/roofing-research/roof-type-components-2026.json, provisional research): for each
 * system, what a job needs and how much, as dictionary measurement terms, a waste allowance and a package. A component
 * whose terms are not dictionary measurements in one unit is left out rather than guessed.
 */
export function roofTypeComponents(file = COMPONENTS_PATH()): Map<string, ComponentSystem> {
  if (!existsSync(file)) return new Map();
  try {
    const mtime = statSync(file).mtimeMs;
    if (componentsCache && componentsCache.file === file && componentsCache.mtime === mtime) return componentsCache.value;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const known = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition]));
    const value = new Map<string, ComponentSystem>();
    for (const type of list(raw.types)) {
      const system = String(type.id || "");
      if (!/^[a-z][a-z0-9_]{0,39}$/.test(system)) continue;
      const components: Product[] = [];
      for (const entry of list(type.components)) {
        const key = String(entry.key || "");
        const terms = list(entry.terms).map((term) => ({ measurement: String(term.measurement), factor: Number(term.factor) })).filter((term) => Number.isFinite(term.factor) && term.factor !== 0);
        const units = new Set(terms.map((term) => known.get(term.measurement)?.unit));
        const byHand = entry.entered_by_hand === true || !terms.length;
        if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || (!byHand && (units.has(undefined) || units.size !== 1 || terms.length > 8 || terms.some((term) => Math.abs(term.factor) > 10)))) continue;
        const cost = num(entry.unit_cost_estimate);
        components.push({ id: componentItemId(system, key), name: String(entry.label || key), code: "", kind: "component", role: system, brand: "", manufacturer: "", unit: String(entry.unit || "ea"), cost, price: cost,
          note: String(entry.explain || ""), tier: "", popular: false, confidence: "provisional", coverage: num(entry.coverage) || 1, rule: "", provisional: entry.provisional !== false,
          component: { system, key, group: String(entry.group || "Materials"), standard: entry.standard === true, explain: String(entry.explain || ""), terms: byHand ? [] : terms, waste: Math.max(0, Math.min(40, Number(entry.waste_percent) || 0)), by_hand: byHand } });
      }
      value.set(system, { id: system, label: String(type.label || system), status: String(raw.status || "provisional"), components });
    }
    componentsCache = { file, mtime, value };
    return value;
  } catch { return new Map(); }
}

/** A supplier the setup offers: which manufacturers it stocks, how much of each range, and costs we have seen. */
export type SupplierPreset = { id: string; name: string; kind: string; color: string; manufacturers: string[]; line_scope: "full_range" | "retail_core"; regions: string; prices: Record<string, number> };
const SUPPLIERS_PATH = () => path.resolve(process.cwd(), "materials/roofing-research/roofing-suppliers-2026.json");
/** The supplier research (materials/roofing-research/roofing-suppliers-2026.json), with each one's observed library prices. */
export function roofingSupplierPresets(file = SUPPLIERS_PATH()): SupplierPreset[] {
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return list(raw.suppliers).map((entry) => {
      const library = ROOFING_LIBRARY_SUPPLIERS.find((supplier) => supplier.name === String(entry.library_supplier || ""));
      const prices = Object.fromEntries((library?.offerings || []).filter(([, , cents]) => cents != null).map(([itemId, , cents]) => [itemId, round2(Number(cents) / 100)]));
      return { id: String(entry.id), name: String(entry.name), kind: String(entry.kind || "distributor"), color: String(entry.color || "#344054"), manufacturers: list(entry.manufacturers).map(String),
        line_scope: entry.line_scope === "retail_core" ? "retail_core" as const : "full_range" as const, regions: String(entry.regions || ""), prices };
    }).filter((preset) => preset.id && preset.name);
  } catch { return []; }
}

/** The region whose states include this one, else the one with the chooser's region id, else national. */
export function regionFor(catalog: RoofingCatalog, state: string, regionId = "") {
  const code = String(state || "").trim().toUpperCase();
  return (code && catalog.regions.find((region) => region.states.includes(code))) || catalog.regions.find((region) => region.id === regionId) || catalog.regions.find((region) => region.id === "national") || NATIONAL;
}

/** A price book formula string ("(eavesLf * 6 + valleyLf * 3) / 100") as tokens. Every identifier must be a dictionary key. */
export function formulaTokens(formula: string) {
  const tokens: { type: string; value: string }[] = [];
  const pattern = /\s*(?:([A-Za-z][A-Za-z0-9]*)|(\d+(?:\.\d+)?)|([-+*/])|([()]))/y;
  let index = 0;
  while (index < formula.length) {
    if (/^\s*$/.test(formula.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(formula);
    if (!match) throw badRequest("pricebook_setup_formula", `Cannot read the formula ${formula}.`);
    index = pattern.lastIndex;
    if (match[1]) {
      if (!definitionForKey(match[1])) throw badRequest("pricebook_setup_formula", `${match[1]} is not a measurement in the dictionary.`);
      tokens.push({ type: "measurement", value: match[1] });
    } else if (match[2]) tokens.push({ type: "number", value: match[2] });
    else if (match[3]) tokens.push({ type: "operator", value: match[3] });
    else tokens.push({ type: "paren", value: match[4]! });
  }
  return tokens;
}
/** Whether a formula only reads dictionary keys, so it can be a price book formula. */
export function dictionaryOnly(formula: string | null) {
  if (!formula) return false;
  try { formulaTokens(formula); return true; } catch { return false; }
}

const fmtNumber = (value: number) => String(Math.round(value * 10000) / 10000);
/** The ice and water formula in squares of barrier for a coverage choice, plus the low-slope squares it also covers. */
export function iceWaterFormula(coverage: IceCoverage) {
  const widths = ICE_COVERAGE[coverage] || ICE_COVERAGE.eaves_36_valleys;
  const parts = ([["eavesLf", widths.eaves], ["rakesLf", widths.rakes], ["valleyLf", widths.valleys]] as const).filter(([, width]) => width > 0).map(([key, width]) => `${key} * ${fmtNumber(width)}`);
  return `(${parts.join(" + ")}) / 100 + pitch2to4Squares`;
}
/** The ice and water measurement-default terms for a coverage choice: lengths of a 3 ft course. Null for none. */
export function iceWaterTerms(coverage: IceCoverage) {
  const widths = ICE_COVERAGE[coverage];
  if (!widths) return null;
  return ([["roof.eave_length", widths.eaves], ["roof.rake_length", widths.rakes], ["roof.valley_length", widths.valleys]] as const).filter(([, width]) => width > 0).map(([measurement, width]) => ({ measurement, factor: Math.round(width / 3 * 10000) / 10000 }));
}

/** The rule's formula for one product, in the product's order unit. */
export function productFormula(rule: Rule, product: Product, iceCoverage: IceCoverage = DEFAULT_ICE_COVERAGE) {
  let formula = rule.formula;
  if (rule.id === "ice_water") formula = iceWaterFormula(iceCoverage === "none" ? "eaves_36_valleys" : iceCoverage);
  if (!dictionaryOnly(formula)) return null;
  const tokens = [{ type: "paren", value: "(" }, ...formulaTokens(formula!), { type: "paren", value: ")" }];
  const coverage = product.kind === "labor" ? 1 : product.coverage;
  if (coverage > 0 && Math.abs(coverage - 1) > 1e-9) tokens.push({ type: "operator", value: "/" }, { type: "number", value: String(Math.round(coverage * 10000) / 10000) });
  return { tokens, includeWaste: rule.include_waste, measurement_keys: tokens.filter((token) => token.type === "measurement").map((token) => token.value) };
}
/** A component's formula: its terms plus its own waste, in its order unit. Null for one entered by hand. */
export function componentFormula(product: Product) {
  const part = product.component;
  if (!part || part.by_hand || !part.terms.length) return null;
  const keyOf = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition.key || ""]));
  const terms = part.terms.map((term, i) => `${term.factor < 0 ? "- " : i ? "+ " : ""}${keyOf.get(term.measurement)}${Math.abs(term.factor) !== 1 ? ` * ${fmtNumber(Math.abs(term.factor))}` : ""}`).join(" ");
  const formula = `(${terms})${part.waste ? ` * ${fmtNumber(1 + part.waste / 100)}` : ""}${Math.abs(product.coverage - 1) > 1e-9 ? ` / ${fmtNumber(product.coverage)}` : ""}`;
  if (!dictionaryOnly(formula)) return null;
  const tokens = formulaTokens(formula);
  return { tokens, includeWaste: false, measurement_keys: tokens.filter((token) => token.type === "measurement").map((token) => token.value) };
}

// ---- Defaults ----

/** The picked brands in the order they were picked: the first is where defaults come from. */
function pickedBrands(catalog: RoofingCatalog, ids: string[]) { return ids.map((id) => catalog.brands.find((brand) => brand.id === id)).filter((brand): brand is Brand => !!brand); }
const plain = (entry: Product) => !entry.colored_starter;
/** Every product that can fill a slot: the picked brands' accessories of its role, then generic items of its rule. */
export function slotCandidates(catalog: RoofingCatalog, brands: Brand[], slot: DefaultSlot) {
  const { role, rule } = DEFAULT_SLOTS[slot];
  const branded = brands.flatMap((brand) => brand.accessories.filter((entry) => entry.role === role && plain(entry)));
  const generic = catalog.generic.filter((entry) => entry.rule === rule);
  return "generic_first" in DEFAULT_SLOTS[slot] ? [...generic, ...branded] : [...branded, ...generic];
}
/** A slot's default: the generic default where the slot starts generic (lead pipe boots), else the first picked brand that makes one. */
export function slotDefault(catalog: RoofingCatalog, brands: Brand[], slot: DefaultSlot) {
  const { role, rule } = DEFAULT_SLOTS[slot];
  const generic = catalog.generic.filter((entry) => entry.rule === rule);
  if ("generic_first" in DEFAULT_SLOTS[slot]) { const found = generic.find((entry) => entry.setup_default) || generic[0]; if (found) return found; }
  for (const brand of brands) {
    const own = brand.accessories.filter((entry) => entry.role === role && plain(entry));
    if (own.length) return own.find((entry) => entry.setup_default) || own[0]!;
  }
  return generic.find((entry) => entry.setup_default) || generic[0] || null;
}
/** A brand's flagship line: marked in the catalog, else its first usual line. */
export function flagshipLine(brand: Brand) { return brand.lines.find((line) => line.flagship) || brand.lines.find((line) => line.visibility === "default") || brand.lines[0] || null; }
/** The generic low-slope products for a roof type, from its components (TPO membrane; modified bitumen base and cap). */
function lowSlopeGeneric(catalog: RoofingCatalog, systems: Map<string, ComponentSystem>, typeId: string) {
  const type = catalog.roof_types.find((entry) => entry.id === typeId);
  const system = type?.low_slope && type.systems[0] ? systems.get(type.systems[0]) : undefined;
  const find = (key: string | undefined) => key ? system?.components.find((entry) => entry.component?.key === key) || null : null;
  return { cap: find(type?.low_slope?.cap), base: find(type?.low_slope?.base) };
}
/** Every product that can be a low-slope system's membrane (or cap sheet): the picked brands' first, then the generic one. */
export function lowSlopeCandidates(catalog: RoofingCatalog, systems: Map<string, ComponentSystem>, brands: Brand[], system: string) {
  const branded = brands.flatMap((brand) => brand.accessories.filter((entry) => entry.system === system && (entry.role === "low_slope_membrane" || entry.role === "low_slope_cap")));
  const generic = lowSlopeGeneric(catalog, systems, system).cap;
  return [...branded, ...(generic ? [generic] : [])];
}
/** The base sheet that goes with a cap sheet: the same company's, else the generic one; none for a single-ply membrane. */
function lowSlopeBase(catalog: RoofingCatalog, systems: Map<string, ComponentSystem>, cap: Product | null, system: string) {
  if (!cap || !catalog.roof_types.find((entry) => entry.id === system)?.low_slope?.base) return null;
  const sameBrand = cap.brand ? catalog.brands.find((brand) => brand.id === cap.brand)?.accessories.find((entry) => entry.role === "low_slope_base" && entry.system === system) : undefined;
  return sameBrand || lowSlopeGeneric(catalog, systems, system).base;
}

// ---- What the setup shows ----

const rank = (id: string) => FEATURED.includes(id) ? FEATURED.indexOf(id) : FEATURED.length;
export function roofingSetupOptions(state: string, regionId = "") {
  const catalog = roofingCatalog(), region = regionFor(catalog, state, regionId), systems = roofTypeComponents();
  const price = (product: Product) => round2(product.price * (product.kind === "labor" ? region.labor : region.material));
  const card = (product: Product) => ({ id: product.id, name: product.name, kind: product.kind, role: product.role, unit: product.unit, price: price(product), tier: product.tier, popular: product.popular, confidence: product.confidence, brand: product.brand, coverage: product.coverage, rule: product.rule,
    ...(product.visibility ? { visibility: product.visibility } : {}), ...(product.reveals_starter ? { reveals_starter: true } : {}), ...(product.colored_starter ? { colored_starter: true } : {}),
    ...(product.flagship ? { flagship: true } : {}), ...(product.setup_default ? { setup_default: true } : {}), ...(product.system ? { system: product.system } : {}), ...(product.provisional ? { provisional: true } : {}) });
  return {
    trade: "roofing", catalog: catalog.source,
    region: { id: region.id, label: region.label }, regions: catalog.regions.map((entry) => ({ id: entry.id, label: entry.label })),
    // What kinds of roof: each names its component systems (standing seam, exposed-fastener and stone-coated for metal).
    roof_types: catalog.roof_types.map((type) => ({ id: type.id, label: type.label, catalog: type.catalog, ...(type.low_slope ? { low_slope: true } : {}),
      systems: type.catalog ? [] : type.systems.map((id) => systems.get(id)).filter((system): system is ComponentSystem => !!system).map((system) => ({ id: system.id, label: system.label, components: system.components.length, standard: system.components.filter((entry) => entry.component?.standard).length,
        parts: system.components.filter((entry) => entry.component?.standard).map((entry) => entry.name) })) })),
    // The four most installed first, then every other brand in the catalog's order.
    brands: [...catalog.brands].sort((a, b) => rank(a.id) - rank(b.id)).map((brand) => ({ id: brand.id, name: brand.name, color: brand.color, tagline: brand.tagline, ...(brand.logo ? { logo: brand.logo } : {}), lines: brand.lines.map(card), accessories: brand.accessories.map(card) })),
    generic: catalog.generic.map(card), labor: catalog.labor.map(card),
    // The generic low-slope products by system, from the roof-type components.
    low_slope: Object.fromEntries(LOW_SLOPE_SYSTEMS.filter((id) => id !== "none").map((id) => { const found = lowSlopeGeneric(catalog, systems, id); return [id, { ...(found.cap ? { cap: card(found.cap) } : {}), ...(found.base ? { base: card(found.base) } : {}) }]; })),
    suppliers: roofingSupplierPresets(),
    ice_coverage: { default: DEFAULT_ICE_COVERAGE, options: Object.keys(ICE_COVERAGE) },
    components_status: [...systems.values()][0]?.status || ""
  };
}

const iceCoverage = z.enum(Object.keys(ICE_COVERAGE) as [IceCoverage, ...IceCoverage[]]);
export const roofingSelectionsSchema = z.object({
  /** The kinds of roof the organization installs (catalog `roof_types`); shingle when not said, as before this question. */
  roof_types: z.array(z.string().max(40)).min(1).max(12).default(["shingle"]),
  /** Shingle: the manufacturers, in the order picked. The first that makes something is where its default comes from. */
  brands: z.array(z.string().max(40)).max(12).default([]),
  /** Older selections: shingle lines are no longer picked (every line of a picked brand is written). Read for default_line only. */
  lines: z.array(z.string().max(120)).max(80).optional(),
  default_line: z.string().max(120).optional(),
  /** Shingle: the products generation uses, by slot; anything left out is the slot's default. */
  defaults: z.object({
    shingle: z.string().max(120), underlayment: z.string().max(120), ice_water: z.string().max(120), ice_coverage: iceCoverage,
    pipe_boot: z.string().max(120), ridge_vent: z.string().max(120), intake_vent: z.string().max(120), box_vent: z.string().max(120),
    low_slope_system: z.enum(LOW_SLOPE_SYSTEMS), low_slope: z.string().max(120)
  }).partial().strict().default({}),
  /** No shingle: the component system new materials lists use (a system id from the roof-type components). */
  default_material: z.string().max(60).optional(),
  /** Shingle waste: worked out from each roof's hips, valleys and pitch, or a fixed percent. */
  waste: z.union([z.literal("roof"), z.number().finite().min(0).max(40)]).default("roof"),
  /** Older selections: feet of ice and water up from the eaves. Read as a coverage when `defaults.ice_coverage` is absent. */
  ice_eave_width: z.union([z.literal(0), z.literal(3), z.literal(6)]).optional(),
  include_labor: z.boolean().default(true),
  /** Costs the person typed (what they pay), per product id. */
  prices: z.record(z.number().finite().min(0).max(100000)).default({}),
  region: z.string().max(40).default(""),
  state: z.string().max(2).default(""),
  /**
   * Per material (a measurement-default rule key): where its amount comes from ("report": worked out from the
   * measurement report; "hand": entered on each job), its waste ("roof": from the report; or a percent) and how much
   * one package covers. For an agent; the guided setup asks none of this.
   */
  rules: z.record(z.object({
    source: z.enum(["report", "hand"]).optional(),
    waste: z.union([z.literal("roof"), z.number().finite().min(0).max(40)]).optional(),
    coverage: z.number().finite().positive().max(1e6).optional()
  }).strict()).default({}),
  /**
   * Who provides the materials: a researched supplier (its preset id) or one the person typed, with the items it
   * carries and its costs. Saved as the organization's suppliers through their own published writer.
   */
  suppliers: z.array(z.object({
    preset: z.string().max(60).optional(),
    name: z.string().trim().min(1).max(200),
    item_ids: z.array(z.string().max(160)).max(500).default([]),
    prices: z.record(z.number().finite().min(0).max(100000)).default({})
  }).strict()).max(12).default([]),
  /** Who does the labor and how each is paid: saved through labor.setup.apply (labor/labor-setup.ts), as the person. */
  labor: z.object({ assignees: z.array(z.unknown()).max(40).default([]), skipped: z.boolean().optional() }).strict().optional()
}).strict();
export type RoofingSelections = z.infer<typeof roofingSelectionsSchema>;

const OLD_ICE: Record<number, IceCoverage> = { 6: "eaves_72_valleys", 3: "eaves_36_valleys", 0: "valleys" };
/**
 * The defaults the selections name, each checked against what can fill its slot; anything missing or not offered is
 * the slot's default. Pure.
 */
export function resolveDefaults(selections: RoofingSelections, catalog = roofingCatalog(), systems = roofTypeComponents()) {
  const brands = pickedBrands(catalog, selections.brands);
  const chosen = selections.defaults;
  const pick = (slot: DefaultSlot) => { const offered = slotCandidates(catalog, brands, slot); return offered.find((entry) => entry.id === chosen[slot]) || slotDefault(catalog, brands, slot); };
  const lines = brands.flatMap((brand) => brand.lines);
  const asked = chosen.shingle || selections.default_line;
  const shingle = lines.find((line) => line.id === asked) || (brands[0] ? flagshipLine(brands[0]) : null);
  // The low-slope system: TPO unless they install other membranes and not TPO; then the first they install.
  const installed = selections.roof_types.filter((id) => catalog.roof_types.find((type) => type.id === id)?.low_slope);
  const system = chosen.low_slope_system || (installed.length && !installed.includes("tpo") ? installed[0]! : "tpo");
  const capOffered = system === "none" ? [] : lowSlopeCandidates(catalog, systems, brands, system);
  const cap = capOffered.find((entry) => entry.id === chosen.low_slope) || capOffered[0] || null;
  return {
    shingle, underlayment: pick("underlayment"), ice_water: pick("ice_water"), pipe_boot: pick("pipe_boot"),
    ridge_vent: pick("ridge_vent"), intake_vent: pick("intake_vent"), box_vent: pick("box_vent"),
    ice_coverage: (chosen.ice_coverage || (selections.ice_eave_width !== undefined ? OLD_ICE[selections.ice_eave_width] : undefined) || DEFAULT_ICE_COVERAGE) as IceCoverage,
    low_slope: { system, cap, base: system === "none" ? null : lowSlopeBase(catalog, systems, cap, system) }
  };
}

/** The component systems of the selected roof types, in order; `types` are roof type ids. */
function selectedSystems(catalog: RoofingCatalog, systems: Map<string, ComponentSystem>, types: string[]) {
  return types.flatMap((id) => catalog.roof_types.find((type) => type.id === id && !type.catalog)?.systems || []).map((id) => systems.get(id)).filter((system): system is ComponentSystem => !!system);
}
/** A component's measurement-default rule: its terms, waste and package, naming its price book item. */
function componentRule(product: Product) {
  const part = product.component!;
  return { key: componentRuleKey(part.system, part.key), enabled: true, label: product.name.slice(0, 120), group: part.group.slice(0, 80) || "Materials", terms: part.terms, waste: part.waste,
    package: { unit: product.unit.slice(0, 40) || "ea", coverage: product.coverage }, product_id: product.id, product_type: "", alternatives: [] };
}

/** The price book items and measurement defaults the selections produce. Pure: nothing is read or written. */
export function buildRoofingSetup(selections: RoofingSelections, current: MeasurementDefaults, catalog = roofingCatalog(), systems = roofTypeComponents()) {
  const region = regionFor(catalog, selections.state, selections.region);
  const types = selections.roof_types.filter((id) => catalog.roof_types.some((type) => type.id === id));
  if (!types.length) throw badRequest("pricebook_setup_roof_types", "Choose at least one kind of roof.");
  const shingle = types.some((id) => catalog.roof_types.find((type) => type.id === id)?.catalog);
  const brands = pickedBrands(catalog, selections.brands);
  if (shingle && !brands.length) throw badRequest("pricebook_setup_brands", "Choose at least one roofing manufacturer.");
  const others = selectedSystems(catalog, systems, types);
  // Every component of every other kind of roof goes in the price book, standard or not, so it is searchable.
  const components = others.flatMap((system) => system.components);
  const resolved = shingle ? resolveDefaults({ ...selections, roof_types: types }, catalog, systems) : null;
  const rules = new Map(catalog.rules.map((rule) => [rule.id, rule]));
  const chosen: Product[] = [];
  if (shingle) {
    chosen.push(...brands.flatMap((brand) => [...brand.lines, ...brand.accessories]), ...catalog.generic, ...(selections.include_labor ? catalog.labor : []));
    // A low-slope default from a roof type they did not pick is written too, so the rule has its product.
    for (const entry of [resolved!.low_slope.cap, resolved!.low_slope.base]) if (entry && !chosen.some((product) => product.id === entry.id) && !components.some((product) => product.id === entry.id)) chosen.push(entry);
  }
  chosen.push(...components);
  const iceChoice = resolved?.ice_coverage || DEFAULT_ICE_COVERAGE;
  // Hand-entered defaults (pipe boots, box vents) are recorded on the item: the report does not count them.
  const handDefaults = new Map<string, string>(resolved ? [[resolved.pipe_boot?.id || "", "pipe_boots"], [resolved.box_vent?.id || "", "box_vents"]] : []);
  // Costs only: the Materials list totals what the job's materials cost. No markup is assumed; sell prices are a
  // document's business (materials-plus or cost-plus), so the price book's sell price is written equal to the cost.
  const seen = new Set<string>();
  const items = chosen.filter((product) => !seen.has(product.id) && !!seen.add(product.id)).map((product) => {
    const labor = product.kind === "labor";
    const multiplier = labor ? region.labor : region.material;
    const price = selections.prices[product.id] ?? round2(product.cost * multiplier);
    const rule = rules.get(product.rule);
    const formula = product.component ? componentFormula(product) : rule ? productFormula(rule, product, iceChoice) : null;
    const part = product.component;
    const flat = part ? !!catalog.roof_types.find((type) => type.systems.includes(part.system))?.low_slope : product.role.startsWith("low_slope");
    const category = part ? (flat ? (["Membrane system", "Field"].includes(part.group) ? "flat_roofs" : "flat_roof_accessories") : ({ Underlayment: "underlayments", Flashing: "flashing", Field: "misc" } as Record<string, string>)[part.group] || "accessories")
      : CATEGORY[product.kind === "line" ? "line" : product.role] || "misc";
    const typeName = part ? systems.get(part.system)?.label || part.system : labor ? "Labor" : product.kind === "line" ? "Shingles" : product.role;
    return {
      id: product.id, kind: "atomic", name: product.name, code: product.code, type: typeName, category,
      segment: flat ? "flat" : "sloped", manufacturer: product.manufacturer, unit: product.unit, internal_cost: price, unit_price: price, unitPrice: price, base_price: price,
      description: product.note, external_description: "",
      ...(formula ? { formulaConfig: { tokens: formula.tokens, includeWaste: formula.includeWaste } } : {}), autoAdd: false,
      // Attributes other rules read (measurement defaults `alternatives`): a line that shows its starter course.
      ...(product.reveals_starter ? { attributes: { reveals_starter: true } } : {}), ...(product.colored_starter ? { attributes: { colored_starter: true } } : {}),
      metadata: { source: "guided_setup", setup: "pricebook.roofing", catalog: part ? "roof_type_components" : catalog.source, price_region: region.id, price_confidence: product.confidence, rule: product.rule || (part ? componentRuleKey(part.system, part.key) : ""),
        ...(product.provisional ? { provisional: true } : {}), ...(part ? { roof_system: part.system, standard: part.standard } : {}),
        ...(handDefaults.has(product.id) ? { default_for: handDefaults.get(product.id) } : {}),
        ...(formula ? { measurement_keys: formula.measurement_keys, coverage_per_unit: product.coverage } : { quantity: "entered_by_hand" }) }
    };
  });

  // The measurement defaults: shingle rules naming the defaults, or the default material's components.
  const componentRules = (rule: { key: string }) => [...systems.keys()].some((id) => rule.key.startsWith(`${id}_`));
  const ranComponents = current.materials.rules.some(componentRules);
  // A shingle setup after a component one starts from the industry rules again; otherwise the organization's own.
  const settings: MeasurementDefaults = JSON.parse(JSON.stringify(shingle && ranComponents ? industryMeasurementDefaults() : current));
  settings.materials.enabled = true;
  settings.materials.rules = settings.materials.rules.filter((rule) => !componentRules(rule));
  let defaultMaterial: string | null = null;
  if (shingle) applyShingleDefaults(settings, selections, resolved!, brands, catalog);
  else {
    const system = others.find((entry) => entry.id === selections.default_material) || others[0];
    if (!system) throw badRequest("pricebook_setup_material", "There is no materials data for these kinds of roof yet.");
    defaultMaterial = system.id;
    // Only the default material's standard, measured components are generated; the rest are searchable items.
    for (const rule of settings.materials.rules) rule.enabled = false;
    const room = 60 - settings.materials.rules.length;
    settings.materials.rules.push(...system.components.filter((entry) => entry.component?.standard && !entry.component.by_hand).slice(0, room).map(componentRule));
  }
  // A rule the setup does not cover keeps the library product it names, written beside the rest.
  const written = new Set(items.map((item) => item.id));
  const keyOf = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition.key || ""]));
  for (const rule of settings.materials.rules) {
    if (!rule.enabled || !rule.product_id || written.has(rule.product_id)) continue;
    const row = ROOFING_LIBRARY_ITEMS.find(([id]) => id === rule.product_id);
    if (!row) continue;
    const [id, name, code, type, manufacturer, unit, cost, , note] = row;
    const formula = rule.terms.map((term, i) => `${term.factor < 0 ? "- " : i ? "+ " : ""}${Math.abs(term.factor) !== 1 ? `${Math.abs(term.factor)} * ` : ""}${keyOf.get(term.measurement)}`).join(" ");
    const product: Product = { id, name, code, kind: "generic", role: lower(type), brand: "", manufacturer, unit, cost, price: cost, note, tier: "", popular: false, confidence: "library", coverage: rule.package?.coverage || 1, rule: rule.key };
    const tokens = productFormula({ id: rule.key, label: rule.label, explanation: "", group: rule.group, formula, unit: "", include_waste: rule.waste !== 0, show: false, order: 0 }, product, iceChoice);
    const sell = round2(cost * region.material);
    items.push({ id, kind: "atomic", name, code, type, category: CATEGORY[lower(type)] || (lower(type) === "low slope" ? "flat_roofs" : "misc"), segment: lower(type) === "low slope" ? "flat" : "sloped", manufacturer, unit,
      internal_cost: selections.prices[id] ?? sell, unit_price: selections.prices[id] ?? sell, unitPrice: selections.prices[id] ?? sell, base_price: selections.prices[id] ?? sell, description: note, external_description: "",
      ...(tokens ? { formulaConfig: { tokens: tokens.tokens, includeWaste: tokens.includeWaste } } : {}), autoAdd: false,
      metadata: { source: "guided_setup", setup: "pricebook.roofing", catalog: "library", price_region: region.id, price_confidence: "library", rule: rule.key, ...(tokens ? { measurement_keys: tokens.measurement_keys, coverage_per_unit: product.coverage } : { quantity: "entered_by_hand" }) } });
    written.add(id);
  }
  return {
    items, settings, roof_types: types, region, default_material: defaultMaterial,
    default_line: resolved?.shingle?.id || null, primary_brand: resolved?.shingle?.brand || brands[0]?.id || null,
    defaults: resolved ? { shingle: resolved.shingle?.id || null, underlayment: resolved.underlayment?.id || null, ice_water: resolved.ice_water?.id || null, ice_coverage: resolved.ice_coverage,
      pipe_boot: resolved.pipe_boot?.id || null, ridge_vent: resolved.ridge_vent?.id || null, intake_vent: resolved.intake_vent?.id || null, box_vent: resolved.box_vent?.id || null,
      low_slope_system: resolved.low_slope.system, low_slope: resolved.low_slope.cap?.id || null, low_slope_base: resolved.low_slope.base?.id || null } : null
  };
}

/** The shingle rules, each naming its default product in its own package. */
function applyShingleDefaults(settings: MeasurementDefaults, selections: RoofingSelections, resolved: ReturnType<typeof resolveDefaults>, brands: Brand[], catalog: RoofingCatalog) {
  const shingle = resolved.shingle!;
  // Starter and hip and ridge follow the default shingle's manufacturer, as a system warranty does; another picked brand fills a gap.
  const primary = brands.find((brand) => brand.id === shingle.brand) || brands[0]!;
  const accessory = (role: string) => primary.accessories.find((entry) => entry.role === role && plain(entry)) || brands.flatMap((brand) => brand.accessories).find((entry) => entry.role === role && plain(entry)) || null;
  const coloredStarter = primary.accessories.find((entry) => entry.colored_starter) || brands.flatMap((brand) => brand.accessories).find((entry) => entry.colored_starter) || null;
  const generic = new Map<string, Product>();
  for (const entry of catalog.generic) if (!generic.has(entry.rule) || entry.setup_default) generic.set(entry.rule, entry);
  const products: Record<string, Product | null> = {
    shingles: shingle, starter: accessory("starter"), hip_ridge: accessory("hip_ridge"), underlayment: resolved.underlayment, ice_water: resolved.ice_water,
    ridge_vent: resolved.ridge_vent, intake_vent: resolved.intake_vent, low_slope_cap: resolved.low_slope.cap, low_slope_base: resolved.low_slope.base
  };
  const productFor = (key: string) => key in products ? products[key] ?? null : generic.get(Object.entries(DEFAULT_RULE).find(([, value]) => value === key)?.[0] || "") || null;
  // Intake vents run along the eaves; a set of defaults saved before they were asked about gets the rule.
  if (resolved.intake_vent && !settings.materials.rules.some((rule) => rule.key === "intake_vent") && settings.materials.rules.length < 60) {
    const at = settings.materials.rules.findIndex((rule) => rule.key === "ridge_vent");
    settings.materials.rules.splice(at < 0 ? settings.materials.rules.length : at + 1, 0, { key: "intake_vent", enabled: true, label: "Intake vent", group: "Ventilation", terms: [{ measurement: "roof.eave_length", factor: 1 }], waste: 0, product_id: "", product_type: "", alternatives: [] });
  }
  const rules = new Map(catalog.rules.map((rule) => [rule.id, rule]));
  const covered = new Set(["shingles", "starter", "hip_ridge", "underlayment", "ice_water", "ridge_vent", "intake_vent", "low_slope_cap", "low_slope_base", "drip_edge"]);
  for (const rule of settings.materials.rules) {
    const product = productFor(rule.key);
    if (covered.has(rule.key)) rule.enabled = true;
    if (rule.key === "shingles") rule.waste = selections.waste;
    if (rule.key === "ice_water") {
      // The coverage choice: lengths of a 3 ft course along each edge it covers, and one down each valley.
      const terms = iceWaterTerms(resolved.ice_coverage);
      if (terms?.length) rule.terms = terms; else rule.enabled = false;
      if (product) rule.package = { unit: product.unit, coverage: round2(product.coverage * 100 / 3) };
    } else if (rule.key === "low_slope_cap" || rule.key === "low_slope_base") {
      if (!product) rule.enabled = false;
      // A single-ply membrane (TPO, PVC, EPDM) is one sheet; modified bitumen is a base and a cap from the same company.
      if (rule.key === "low_slope_cap") rule.label = resolved.low_slope.base ? "Low-slope cap sheet" : "Low-slope membrane";
      // Low-slope products and components both cover squares, the line's unit.
      if (product && product.coverage > 0) rule.package = { unit: product.unit, coverage: product.coverage };
      // A product's coverage is in its research rule's unit. Where that is not the line's (step flashing counts pieces,
      // cap nails count pails), it says nothing about this rule, so the rule keeps its own.
    } else if (product && product.coverage > 0 && rules.get(product.rule)?.unit === ruleLineUnit(rule)) rule.package = { unit: product.unit, coverage: product.coverage };
    if (product) { rule.product_id = product.id; rule.product_type = ""; }
    const own = selections.rules[rule.key];
    if (own?.source) rule.enabled = own.source === "report";
    if (own?.waste !== undefined) rule.waste = own.waste;
    if (own?.coverage && rule.package) rule.package = { ...rule.package, coverage: own.coverage };
    // The starter buys the coloured starter when the job's shingle shows its starter course.
    if (rule.key === "starter") rule.alternatives = coloredStarter ? [{ when: { rule: "shingles", attribute: "reveals_starter", equals: true }, product_id: coloredStarter.id, ...(coloredStarter.coverage > 0 ? { package: { unit: coloredStarter.unit, coverage: coloredStarter.coverage } } : {}) }] : [];
  }
}

/**
 * The costs the supplier columns show, as price book costs: for each item, a cost typed in a supplier's column (the
 * first chosen supplier that carries it), else the price seen at that supplier, else nothing (the typical cost
 * stays). A price typed for the item itself still wins. Never a markup.
 */
export function supplierItemCosts(selections: RoofingSelections, presets = roofingSupplierPresets()) {
  const typed: Record<string, number> = {}, seen: Record<string, number> = {};
  const byId = new Map(presets.map((preset) => [preset.id, preset]));
  for (const choice of selections.suppliers) {
    const preset = choice.preset ? byId.get(choice.preset) : undefined;
    for (const itemId of choice.item_ids) {
      if (typed[itemId] === undefined && choice.prices[itemId] !== undefined) typed[itemId] = choice.prices[itemId]!;
      if (seen[itemId] === undefined && preset?.prices[itemId] !== undefined) seen[itemId] = preset.prices[itemId]!;
    }
  }
  return { ...seen, ...typed };
}

/** Writes the setup: the price book through its catalog writer, then the measurement defaults through theirs. */
export async function applyRoofingSetup(ctx: PublicationContext, input: unknown) {
  const orgId = ctx.organizationId;
  const parsed = roofingSelectionsSchema.parse(input);
  const typedForItems = parsed.prices;
  const selections = { ...parsed, prices: { ...supplierItemCosts(parsed), ...parsed.prices } };
  const current = await readMeasurementDefaults(orgId);
  const built = buildRoofingSetup(selections, current.settings);
  const book = await getOrganizationPricebook(orgId);
  // A cost a price sheet set (pricebook.prices.update) stays unless the person typed another.
  for (const item of built.items as Record<string, unknown>[]) {
    const before = (book.catalog.items as Record<string, unknown>[]).find((entry) => entry.id === item.id);
    const metadata = (before?.metadata || {}) as Record<string, unknown>;
    if (before && metadata.price_source === "price_sheet" && typedForItems[String(item.id)] === undefined && !parsed.suppliers.some((choice) => choice.prices[String(item.id)] !== undefined)) Object.assign(item, { internal_cost: before.internal_cost, unit_price: before.unit_price, unitPrice: before.unit_price, base_price: before.unit_price, metadata: { ...(item.metadata as Record<string, unknown>), price_source: "price_sheet" } });
  }
  const ids = new Set(built.items.map((item) => item.id));
  const saved = await saveOrganizationCatalog(orgId, { ...book.catalog, items: [...book.catalog.items.filter((item) => !ids.has(String((item as { id?: unknown }).id))), ...built.items] }, Number(book.manifest.revision));
  const defaults = await saveMeasurementDefaults(orgId, { settings: built.settings, expected_revision: current.revision });
  const suppliers = await saveSetupSuppliers(ctx, selections, new Set(built.items.map((item) => item.id)));
  // Who does the labor: only when the step was played (it needs groups of users and outside companies).
  const labor = parsed.labor?.assignees.length ? await saveSetupLabor(ctx, { assignees: parsed.labor.assignees }) : null;
  // Skipped: the Labor column waits until someone does labor (materials/resource-types.ts laborColumnShown).
  if (parsed.labor?.skipped) await laborColumnWithAssignees(ctx);
  // Items an agent added from a price sheet (pricebook.items.add) are part of what was set up.
  const fromSheets = (book.catalog.items as Record<string, unknown>[]).filter((item) => (item.metadata as Record<string, unknown> | undefined)?.added_from === "price_sheet" && !ids.has(String(item.id))).map((item) => String(item.id));
  return {
    suppliers,
    ...(labor ? { labor } : {}),
    trade: "roofing", roof_types: built.roof_types, items: built.items.length, item_ids: [...built.items.map((item) => item.id), ...fromSheets],
    default_line: built.default_line, primary_brand: built.primary_brand, default_material: built.default_material, defaults: built.defaults,
    region: built.region.id, pricebook_revision: Number((saved as { manifest?: { revision?: unknown } }).manifest?.revision ?? 0), defaults_revision: defaults.revision
  };
}

/**
 * Saves the chosen suppliers through the suppliers' own published writer (suppliers.supplier.save), as the person.
 * A supplier already saved under the same name keeps its other items: of the items this setup writes, it carries the
 * ones ticked in its column and drops the others. Prices are costs in cents (never marked up).
 */
async function saveSetupSuppliers(ctx: PublicationContext, selections: RoofingSelections, written: Set<string>) {
  if (!selections.suppliers.length) return [];
  const { invokeAction } = await import("../../platform/publication/actions.js");
  const { listSuppliers } = await import("../../materials/suppliers.js");
  const presets = new Map(roofingSupplierPresets().map((preset) => [preset.id, preset]));
  const existing = await listSuppliers(ctx.organizationId);
  const command = { ...ctx, mode: "command" as const };
  const saved: { id: string; name: string; items: number }[] = [];
  for (const choice of selections.suppliers) {
    const preset = choice.preset ? presets.get(choice.preset) : undefined;
    const current = existing.find((supplier) => supplier.name.trim().toLowerCase() === choice.name.trim().toLowerCase());
    const offerings = new Map((current?.offerings || []).map((row) => [row.item_id, row]));
    for (const itemId of written) if (!choice.item_ids.includes(itemId)) offerings.delete(itemId);
    for (const itemId of choice.item_ids.filter((id) => written.has(id))) {
      // A typed price wins; then a price already saved (a price sheet the agent read); then the supplier's observed price.
      const saved = offerings.get(itemId)?.price_cents;
      const dollars = choice.prices[itemId] ?? (saved != null ? saved / 100 : preset?.prices[itemId]);
      offerings.set(itemId, { item_id: itemId, sku: offerings.get(itemId)?.sku || "", price_cents: dollars === undefined ? null : Math.round(dollars * 100) });
    }
    const input = { ...(current ? { id: current.id, expected_revision: current.revision } : {}), name: current?.name || choice.name, roles: current?.roles?.length ? current.roles : ["material_supplier"], offerings: [...offerings.values()] };
    const key = `pricebook-setup:${ctx.organizationId}:${choice.name.toLowerCase()}:${JSON.stringify(input).length}:${Date.now()}`;
    const result = await invokeAction(command, { action: "suppliers.supplier.save", target: { scope: "organization", organizationId: ctx.organizationId } }, input, { idempotencyKey: key }) as { value?: { id?: string } };
    saved.push({ id: String(result.value?.id || current?.id || ""), name: input.name, items: input.offerings.length });
  }
  return saved;
}

/** Saves `shown: with_assignees` on the Labor column, through the resource type's own action, as the person. */
async function laborColumnWithAssignees(ctx: PublicationContext) {
  const [{ invokeAction }, { listResourceTypes }] = await Promise.all([import("../../platform/publication/actions.js"), import("../../materials/resource-types.js")]);
  const labor = (await listResourceTypes(ctx.organizationId, { includeHidden: true })).find((row) => row.id === "labor") as { name: string; icon: string; color: string; revision: number; shown?: string } | undefined;
  if (!labor || labor.shown === "with_assignees") return;
  await invokeAction({ ...ctx, mode: "command" as const }, { action: "materials.resource-type.update", target: { scope: "organization", organizationId: ctx.organizationId } },
    { id: "labor", name: labor.name, icon: labor.icon, color: labor.color, shown: "with_assignees", expected_revision: labor.revision }, { idempotencyKey: `pricebook-setup:labor-column:${ctx.organizationId}:${labor.revision}` });
}

/** The labor step's choices, through their own published action (labor.setup.apply) as the person. */
async function saveSetupLabor(ctx: PublicationContext, labor: { assignees: unknown[] }) {
  const { invokeAction } = await import("../../platform/publication/actions.js");
  const result = await invokeAction({ ...ctx, mode: "command" as const }, { action: "labor.setup.apply", target: { scope: "organization", organizationId: ctx.organizationId } }, labor, { idempotencyKey: `pricebook-setup:labor:${ctx.organizationId}:${JSON.stringify(labor).length}:${Date.now()}` }) as { value?: unknown };
  return result.value ?? null;
}

export const roofingTradeSetup: TradeSetup = {
  trade: "roofing", title: "Roofing", schema: roofingSelectionsSchema,
  options: (regionId) => roofingSetupOptions("", regionId), apply: applyRoofingSetup
};
