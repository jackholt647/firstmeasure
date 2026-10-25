import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { badRequest } from "../../platform/errors.js";
import { definitionForKey, listMeasurementDefinitions } from "../../platform/publication/measurement-schemas.js";
import { ROOFING_LIBRARY_ITEMS } from "../../materials/roofing-library-data.js";
import { industryMeasurementDefaults, readMeasurementDefaults, saveMeasurementDefaults, type MeasurementDefaults } from "../../materials/measurement-defaults.js";
import { getOrganizationPricebook, saveOrganizationCatalog } from "../storage.js";
import type { TradeSetup } from "./index.js";

/**
 * The roofing price book setup. What an organization picks (shingle manufacturers and lines, its waste, how wide its
 * ice and water barrier runs at the eaves, its markup) becomes:
 *
 * - price book items for those lines, the primary brand's system accessories, the common non-brand items and,
 *   optionally, labor and service lines, priced for its region; each item's quantity formula is written over
 *   measurement dictionary keys only and converted to the item's own order unit with that product's coverage
 *   (an Owens Corning bundle covers 32.8 sq ft, not a flat third of a square);
 * - the measurement defaults (materials/measurement-defaults.ts) that turn a roof's measurements into its materials
 *   list, naming those products and their packages.
 *
 * Both go through their own writers. Products and rules come from the roofing research catalog
 * (materials/roofing-research/roofing-catalog-2026.json) and fall back to the roofing library. An item whose rule
 * needs something the dictionary does not hold (pipe boots, stories, decking sheets) gets no formula and is marked
 * as entered by hand. Every number is a starting point the organization changes afterwards.
 */

export type Product = {
  id: string; name: string; code: string; kind: "line" | "accessory" | "generic" | "labor"; role: string; brand: string; manufacturer: string;
  unit: string; cost: number; price: number; note: string; tier: string; popular: boolean; confidence: string;
  /** How much of its rule's unit one order unit covers: squares per bundle, feet per bundle, squares per roll. */
  coverage: number; rule: string;
};
export type Rule = { id: string; label: string; explanation: string; group: string; formula: string | null; unit: string; include_waste: boolean; show: boolean; order: number; per_package?: number };
type Brand = { id: string; name: string; color: string; tagline: string; lines: Product[]; accessories: Product[] };
type Region = { id: string; label: string; states: string[]; material: number; labor: number };
export type RoofingCatalog = { source: "research" | "library"; markup: number; brands: Brand[]; generic: Product[]; labor: Product[]; rules: Rule[]; regions: Region[] };

const FEATURED = ["gaf", "owens_corning", "malarkey", "certainteed"];
const BRAND_LOOK: Record<string, { name: string; color: string; tagline: string }> = {
  gaf: { name: "GAF", color: "#d71920", tagline: "Timberline, Royal Sovereign" },
  owens_corning: { name: "Owens Corning", color: "#d6246e", tagline: "Duration, Oakridge, Supreme" },
  malarkey: { name: "Malarkey", color: "#1f6f43", tagline: "Highlander, Vista, Legacy" },
  certainteed: { name: "CertainTeed", color: "#0a5aa5", tagline: "Landmark, XT 25, Presidential" }
};
/** Research rule ids beside the measurement-default rule keys they fill. */
const DEFAULT_RULE: Record<string, string> = { field_shingles: "shingles", starter: "starter", hip_ridge: "hip_ridge", ice_water: "ice_water", underlayment: "underlayment", drip_edge: "drip_edge", ridge_vent: "ridge_vent", step_flashing: "step_flashing", headwall_flashing: "headwall_flashing", valley_metal: "valley_metal", roofing_nails: "coil_nails", cap_nails: "cap_nails" };
const ACCESSORY_ROLES = ["starter", "hip_ridge", "underlayment", "ice_water", "ridge_vent"];
const CATEGORY: Record<string, string> = { line: "shingle_roofs", starter: "shingle_roofs", hip_ridge: "shingle_roofs", underlayment: "shingle_roofs", ice_water: "leak_barriers", ridge_vent: "accessories", flashing: "flashing", penetrations: "accessories", fasteners: "accessories", sealants: "accessories", decking: "misc", labor: "misc" };
/** A sample roof for the walkthrough's worked examples, by dictionary key: about 28 squares with a few hips and valleys. */
const SAMPLE_ROOF: Record<string, number> = { roofSquares: 28, flatRoofSquares: 2, pitch2to4Squares: 1, pitch6to8Squares: 10, pitch9to12Squares: 4, pitch13PlusSquares: 0, eavesLf: 140, rakesLf: 90, hipsLf: 40, ridgesLf: 45, valleyLf: 30, sideWallLf: 18, headWallLf: 12, chimneyStepLf: 8, chimneyApronLf: 4, handCarriedSquares: 0 };
const NATIONAL: Region = { id: "national", label: "National average", states: [], material: 1, labor: 1 };

const lower = (value: unknown) => String(value ?? "").trim().toLowerCase();
const round2 = (value: number) => Math.round(value * 100) / 100;
const num = (...values: unknown[]) => { for (const value of values) { const n = Number(value); if (Number.isFinite(n) && n > 0) return n; } return 0; };
const list = (value: unknown) => Array.isArray(value) ? value as Record<string, unknown>[] : [];
const obj = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const RESEARCH_PATH = () => path.resolve(process.cwd(), "materials/roofing-research/roofing-catalog-2026.json");
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

/** Reads the research catalog in its own schema (schema_version 1). Returns null when it is absent or unreadable. */
export function readResearchCatalog(file = RESEARCH_PATH()): RoofingCatalog | null {
  if (!existsSync(file)) return null;
  try {
    const mtime = statSync(file).mtimeMs;
    if (cache && cache.file === file && cache.mtime === mtime) return cache.value;
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const rules: Rule[] = list(raw.estimating_rules).map((rule) => ({ id: String(rule.id), label: String(rule.label || rule.id), explanation: String(rule.explanation || ""), group: String(rule.group || ""),
      formula: typeof rule.pricebook_formula === "string" ? rule.pricebook_formula : null, unit: String(rule.unit || "ea"), include_waste: rule.include_waste === true, show: rule.show_in_setup === true, order: Number(rule.order || 0), per_package: num(obj(rule.order_packaging).units_per_package) }));
    const unitOf = (ruleId: string) => rules.find((rule) => rule.id === ruleId)?.unit || "ea";
    // A product's own coverage first; the rule's usual package where the product gives none (a 7,200 nail box, a net 10-square roll).
    const covered = (ruleId: string, entry: Record<string, unknown>) => {
      const own = coverageFor(ruleId, unitOf(ruleId), entry), usual = rules.find((rule) => rule.id === ruleId)?.per_package || 0;
      if (ruleId === "underlayment") return num(num(obj(entry.coverage).sq_ft_net) / 100, usual, own);
      return own === 1 && usual > 0 ? usual : own;
    };
    const markup = num(raw.default_markup_percent) || 35;
    const sell = (cost: number) => round2(cost * (1 + markup / 100));
    const product = (entry: Record<string, unknown>, kind: Product["kind"], brand: string, manufacturer: string, rule: string, role = ""): Product => {
      const cost = num(entry.default_price);
      const labor = kind === "labor";
      return { id: String(entry.id), name: String(entry.name), code: String(entry.manufacturer_code || "").split(" ")[0] || "", kind, role: role || rule, brand, manufacturer,
        unit: String(entry.unit || (kind === "line" ? "bundle" : "ea")), cost: labor ? 0 : cost, price: labor ? cost : sell(cost), note: String(entry.price_note || entry.note || ""),
        tier: String(entry.tier || ""), popular: entry.popular === true, confidence: String(entry.price_confidence || ""), coverage: covered(rule, entry), rule };
    };
    const brands: Brand[] = list(raw.manufacturers).map((maker) => {
      const id = String(maker.pricebook_manufacturer || maker.id), look = BRAND_LOOK[id] || { name: String(maker.name), color: String(obj(maker.logo_hint).primary_color || "#344054"), tagline: "" };
      const manufacturer = String(maker.name || look.name);
      return { id, name: manufacturer, color: String(obj(maker.logo_hint).primary_color || look.color), tagline: look.tagline,
        lines: list(maker.product_lines).map((line) => ({ ...product(line, "line", id, manufacturer, "field_shingles"), name: `${manufacturer} ${String(line.name)}` })),
        accessories: list(maker.accessories).filter((entry) => ACCESSORY_ROLES.includes(String(entry.role))).map((entry) => ({ ...product(entry, "accessory", id, manufacturer, String(entry.role)), name: `${manufacturer} ${String(entry.name)}` })) };
    }).filter((brand) => brand.lines.length);
    const generic = list(raw.generic_items).map((entry) => ({ ...product(entry, "generic", "", "", String(entry.rule_id || "")), role: String(entry.category || "misc") }));
    const labor = list(raw.labor_items).map((entry) => ({ ...product(entry, "labor", "", "", String(entry.rule_id || "")), role: "labor" }));
    const regions: Region[] = list(raw.regions).map((region) => ({ id: String(region.id), label: String(region.label || region.id), states: list(region.states).map(String), material: num(region.material_multiplier) || 1, labor: num(region.labor_multiplier, region.price_multiplier) || 1 }));
    const value: RoofingCatalog = { source: "research", markup, brands, generic, labor, rules, regions: regions.some((region) => region.id === "national") ? regions : [NATIONAL, ...regions] };
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
    return { id, name, code, kind: (lower(type) === "shingles" ? "line" : "accessory") as Product["kind"], role, brand: brandOf(manufacturer), manufacturer, unit, cost, price, note, tier: /3-tab/i.test(name) ? "3_tab" : "architectural", popular: false, confidence: "library", coverage: coverage[role] || 1, rule: role };
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
  return { source: "library", markup: 35, brands, generic: [], labor: [], rules, regions: [NATIONAL] };
}

export function roofingCatalog(): RoofingCatalog { return readResearchCatalog() || libraryCatalog(); }

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

/** The rule's formula for one product: in the product's order unit, with the organization's eave width for ice and water. */
export function productFormula(rule: Rule, product: Product, iceEaveWidth: number) {
  let formula = rule.formula;
  if (rule.id === "ice_water" && formula) formula = formula.replace(/eavesLf\s*\*\s*\d+(?:\.\d+)?/, `eavesLf * ${iceEaveWidth}`);
  if (!dictionaryOnly(formula)) return null;
  const tokens = [{ type: "paren", value: "(" }, ...formulaTokens(formula!), { type: "paren", value: ")" }];
  const coverage = product.kind === "labor" ? 1 : product.coverage;
  if (coverage > 0 && Math.abs(coverage - 1) > 1e-9) tokens.push({ type: "operator", value: "/" }, { type: "number", value: String(Math.round(coverage * 10000) / 10000) });
  return { tokens, includeWaste: rule.include_waste, measurement_keys: tokens.filter((token) => token.type === "measurement").map((token) => token.value) };
}

/** What the setup shows: brands and their lines, the walkthrough's rules and sample roof, and prices for the region. */
export function roofingSetupOptions(state: string, regionId = "") {
  const catalog = roofingCatalog(), region = regionFor(catalog, state, regionId);
  const price = (product: Product) => round2(product.price * (product.kind === "labor" ? region.labor : region.material));
  const card = (product: Product) => ({ id: product.id, name: product.name, kind: product.kind, role: product.role, unit: product.unit, price: price(product), tier: product.tier, popular: product.popular, confidence: product.confidence, brand: product.brand, coverage: product.coverage, rule: product.rule });
  const defaults = industryMeasurementDefaults();
  return {
    trade: "roofing", catalog: catalog.source, markup: catalog.markup,
    region: { id: region.id, label: region.label }, regions: catalog.regions.map((entry) => ({ id: entry.id, label: entry.label })),
    brands: catalog.brands.sort((a, b) => FEATURED.indexOf(a.id) - FEATURED.indexOf(b.id)).map((brand) => ({ id: brand.id, name: brand.name, color: brand.color, tagline: brand.tagline, lines: brand.lines.map(card), accessories: brand.accessories.map(card) })),
    generic: catalog.generic.map(card), labor: catalog.labor.map(card),
    rules: catalog.rules.filter((rule) => rule.show).sort((a, b) => a.order - b.order).map((rule) => ({ ...rule, measurements: rule.formula && dictionaryOnly(rule.formula) ? formulaTokens(rule.formula).filter((t) => t.type === "measurement").map((t) => ({ key: t.value, label: definitionForKey(t.value)?.label || t.value })) : [], manual: !dictionaryOnly(rule.formula) })),
    waste: { default: "roof", options: [10, 12, 15, 20], settings: defaults.materials.waste },
    ice_eave_width: { default: 6, options: [6, 3, 0] },
    sample: SAMPLE_ROOF
  };
}

export const roofingSelectionsSchema = z.object({
  brands: z.array(z.string().max(40)).min(1).max(12),
  lines: z.array(z.string().max(120)).min(1).max(80),
  /** The shingle a new materials list uses; the first chosen line otherwise. Its brand supplies the accessories. */
  default_line: z.string().max(120).optional(),
  /** Shingle waste: worked out from each roof's hips, valleys and pitch, or a fixed percent. */
  waste: z.union([z.literal("roof"), z.number().finite().min(0).max(40)]).default("roof"),
  /** Feet of ice and water barrier up from the eaves: 6 (two rows), 3 (one row) or 0. */
  ice_eave_width: z.union([z.literal(0), z.literal(3), z.literal(6)]).default(6),
  /** Percent added to cost for the sell price of materials. */
  markup: z.number().finite().min(0).max(300).optional(),
  include_labor: z.boolean().default(true),
  /** Sell prices the person typed, per product id. */
  prices: z.record(z.number().finite().min(0).max(100000)).default({}),
  region: z.string().max(40).default(""),
  state: z.string().max(2).default("")
}).strict();
export type RoofingSelections = z.infer<typeof roofingSelectionsSchema>;

/** The price book items and measurement defaults the selections produce. Pure: nothing is read or written. */
export function buildRoofingSetup(selections: RoofingSelections, current: MeasurementDefaults, catalog = roofingCatalog()) {
  const region = regionFor(catalog, selections.state, selections.region);
  const brands = catalog.brands.filter((brand) => selections.brands.includes(brand.id));
  if (!brands.length) throw badRequest("pricebook_setup_brands", "Choose at least one shingle manufacturer.");
  const offered = new Map(brands.flatMap((brand) => brand.lines.map((line) => [line.id, line] as const)));
  const lines = selections.lines.filter((id) => offered.has(id));
  if (!lines.length) throw badRequest("pricebook_setup_lines", "Choose at least one shingle line from the manufacturers you picked.");
  const defaultLine = selections.default_line && lines.includes(selections.default_line) ? selections.default_line : lines[0]!;
  // Accessories follow the default shingle's manufacturer, as a system warranty does; another chosen brand fills a gap.
  const primary = brands.find((brand) => brand.lines.some((line) => line.id === defaultLine))!;
  const accessory = (role: string) => primary.accessories.find((entry) => entry.role === role) || brands.flatMap((brand) => brand.accessories).find((entry) => entry.role === role) || null;
  const generic = new Map<string, Product>();
  for (const entry of catalog.generic) if (!generic.has(entry.rule)) generic.set(entry.rule, entry);
  const chosen: Product[] = [
    ...lines.map((id) => offered.get(id)!),
    ...ACCESSORY_ROLES.map(accessory).filter((entry): entry is Product => !!entry),
    ...generic.values(),
    ...(selections.include_labor ? catalog.labor : [])
  ];
  const markupFactor = selections.markup === undefined ? 1 : (1 + selections.markup / 100) / (1 + catalog.markup / 100);
  const rules = new Map(catalog.rules.map((rule) => [rule.id, rule]));
  const items = chosen.map((product) => {
    const labor = product.kind === "labor";
    const multiplier = labor ? region.labor : region.material;
    const price = selections.prices[product.id] ?? round2(product.price * multiplier * (labor ? 1 : markupFactor));
    const rule = rules.get(product.rule);
    const formula = rule ? productFormula(rule, product, selections.ice_eave_width) : null;
    return {
      id: product.id, kind: "atomic", name: product.name, code: product.code, type: labor ? "Labor" : product.kind === "line" ? "Shingles" : product.role, category: CATEGORY[product.kind === "line" ? "line" : product.role] || "misc",
      segment: "sloped", manufacturer: product.manufacturer, unit: product.unit, internal_cost: round2(product.cost * multiplier), unit_price: price, unitPrice: price, base_price: price,
      description: product.note, external_description: "",
      ...(formula ? { formulaConfig: { tokens: formula.tokens, includeWaste: formula.includeWaste } } : {}), autoAdd: false,
      metadata: { source: "guided_setup", setup: "pricebook.roofing", catalog: catalog.source, price_region: region.id, price_confidence: product.confidence, rule: product.rule,
        ...(formula ? { measurement_keys: formula.measurement_keys, coverage_per_unit: product.coverage } : { quantity: "entered_by_hand" }) }
    };
  });
  // The measurement defaults name these products, in their own packages.
  const settings: MeasurementDefaults = JSON.parse(JSON.stringify(current));
  settings.materials.enabled = true;
  const productFor = (key: string) => {
    const ruleId = Object.entries(DEFAULT_RULE).find(([, value]) => value === key)?.[0] || "";
    if (ruleId === "field_shingles") return offered.get(defaultLine)!;
    if (ACCESSORY_ROLES.includes(ruleId)) return accessory(ruleId);
    return generic.get(ruleId) || null;
  };
  for (const rule of settings.materials.rules) {
    const product = productFor(rule.key);
    if (rule.key === "shingles") rule.waste = selections.waste;
    if (rule.key === "ice_water") {
      // One 3 ft roll's length runs along the eaves for every 3 ft of width, and once down each valley.
      rule.terms = [...(selections.ice_eave_width ? [{ measurement: "roof.eave_length", factor: selections.ice_eave_width / 3 }] : []), { measurement: "roof.valley_length", factor: 1 }];
      if (product) rule.package = { unit: product.unit, coverage: round2(product.coverage * 100 / 3) };
    } else if (product && product.coverage > 0) rule.package = { unit: product.unit, coverage: product.coverage };
    if (product) { rule.product_id = product.id; rule.product_type = ""; }
  }
  // A rule the setup does not cover (low-slope sheets) keeps the library product it names, written beside the rest.
  const written = new Set(items.map((item) => item.id));
  const keyOf = new Map(listMeasurementDefinitions().map((definition) => [definition.id, definition.key || ""]));
  for (const rule of settings.materials.rules) {
    if (!rule.enabled || !rule.product_id || written.has(rule.product_id)) continue;
    const row = ROOFING_LIBRARY_ITEMS.find(([id]) => id === rule.product_id);
    if (!row) continue;
    const [id, name, code, type, manufacturer, unit, cost, price, note] = row;
    const formula = rule.terms.map((term, i) => `${term.factor < 0 ? "- " : i ? "+ " : ""}${Math.abs(term.factor) !== 1 ? `${Math.abs(term.factor)} * ` : ""}${keyOf.get(term.measurement)}`).join(" ");
    const product: Product = { id, name, code, kind: "generic", role: lower(type), brand: "", manufacturer, unit, cost, price, note, tier: "", popular: false, confidence: "library", coverage: rule.package?.coverage || 1, rule: rule.key };
    const tokens = productFormula({ id: rule.key, label: rule.label, explanation: "", group: rule.group, formula, unit: "", include_waste: rule.waste !== 0, show: false, order: 0 }, product, selections.ice_eave_width);
    const sell = round2(price * region.material * markupFactor);
    items.push({ id, kind: "atomic", name, code, type, category: CATEGORY[lower(type)] || (lower(type) === "low slope" ? "flat_roofs" : "misc"), segment: lower(type) === "low slope" ? "flat" : "sloped", manufacturer, unit,
      internal_cost: round2(cost * region.material), unit_price: selections.prices[id] ?? sell, unitPrice: selections.prices[id] ?? sell, base_price: selections.prices[id] ?? sell, description: note, external_description: "",
      ...(tokens ? { formulaConfig: { tokens: tokens.tokens, includeWaste: tokens.includeWaste } } : {}), autoAdd: false,
      metadata: { source: "guided_setup", setup: "pricebook.roofing", catalog: "library", price_region: region.id, price_confidence: "library", rule: rule.key, ...(tokens ? { measurement_keys: tokens.measurement_keys, coverage_per_unit: product.coverage } : { quantity: "entered_by_hand" }) } });
    written.add(id);
  }
  return { items, settings, default_line: defaultLine, primary_brand: primary.id, region };
}

/** Writes the setup: the price book through its catalog writer, then the measurement defaults through theirs. */
export async function applyRoofingSetup(orgId: string, input: unknown) {
  const selections = roofingSelectionsSchema.parse(input);
  const current = await readMeasurementDefaults(orgId);
  const built = buildRoofingSetup(selections, current.settings);
  const book = await getOrganizationPricebook(orgId);
  const ids = new Set(built.items.map((item) => item.id));
  const saved = await saveOrganizationCatalog(orgId, { ...book.catalog, items: [...book.catalog.items.filter((item) => !ids.has(String((item as { id?: unknown }).id))), ...built.items] }, Number(book.manifest.revision));
  const defaults = await saveMeasurementDefaults(orgId, { settings: built.settings, expected_revision: current.revision });
  return {
    trade: "roofing", items: built.items.length, item_ids: built.items.map((item) => item.id), default_line: built.default_line, primary_brand: built.primary_brand,
    region: built.region.id, pricebook_revision: Number((saved as { manifest?: { revision?: unknown } }).manifest?.revision ?? 0), defaults_revision: defaults.revision
  };
}

export const roofingTradeSetup: TradeSetup = {
  trade: "roofing", title: "Roofing", schema: roofingSelectionsSchema,
  options: (regionId) => roofingSetupOptions("", regionId), apply: applyRoofingSetup
};
