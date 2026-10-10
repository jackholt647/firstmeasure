import { badRequest } from "../platform/errors.js";
import { resolveCatalogItemToScopeItem, type JsonObject } from "./resolver.js";

/**
 * Generates a priced scope for one scope piece from the organization's price
 * book and a set of measurements. This is the server form of what the legacy
 * proposal builder did in the browser: the catalog assembly supplies the
 * lines, each line's quantity formula is evaluated against the measurements,
 * and interchangeable products are grouped into choice groups. Measurements
 * are used as given; nothing is rounded to whole units here.
 */

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

const numeric = (value: unknown) => {
  const next = typeof value === "string" ? Number(value.replace(/,/g, "")) : Number(value);
  return Number.isFinite(next) && next > 0 ? next : 0;
};

const PITCH_BUCKETS = ["pitch2to4Squares", "pitch4to6Squares", "pitch6to8Squares", "pitch9to12Squares", "pitch13PlusSquares"];

/**
 * Fill in the derived roof areas the price book formulas reference. A report
 * may give pitch buckets, a total, or both; the total never falls below the
 * sum of its buckets, and a bare total counts as walkable shingle area.
 */
export function normalizeScopeMeasurements(input: unknown): Record<string, number> {
  const source = asObject(input);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) out[key] = numeric(value);
  }
  const flat = out.flatRoofSquares || 0;
  let shingle = PITCH_BUCKETS.reduce((sum, key) => sum + (out[key] || 0), 0);
  let total = shingle + flat;
  const suppliedTotal = out.roofSquares || 0;
  const suppliedShingle = out.shingleSquares || 0;
  if (total <= 0 && suppliedTotal > 0) {
    out.pitch4to6Squares = suppliedTotal;
    shingle = suppliedTotal;
    total = suppliedTotal;
  } else if (shingle <= 0 && suppliedShingle > 0) {
    out.pitch4to6Squares = suppliedShingle;
    shingle = suppliedShingle;
    total = shingle + flat;
  } else if (suppliedTotal > total) {
    total = suppliedTotal;
  }
  // Sums of decimal areas pick up binary noise; four places is finer than any report.
  out.shingleSquares = Math.round(shingle * 1e4) / 1e4;
  out.roofSquares = Math.round(total * 1e4) / 1e4;
  out.wastePercent = out.wastePercent || 0;
  out.structures = Math.max(1, Math.round(out.structures || out.structureCount || 1));
  return out;
}

type FormulaToken = { type: string; value: string };

/**
 * Evaluate a price book quantity formula (tokens of measurement, custom_field,
 * number, operator and paren) against measurements. Unknown measurements are
 * zero; a malformed formula yields zero rather than a guess.
 */
export function evaluateQuantityFormula(configValue: unknown, measurements: Record<string, number>): number {
  const config = asObject(configValue);
  let value = evaluateFormulaTokens(config, measurements);
  if (config.includeWaste === true || config.include_waste === true) value *= 1 + (Number(measurements.wastePercent) || 0) / 100;
  return Math.max(0, Math.round(value * 100) / 100);
}

/** The formula's own value, before any modifier or rounding. */
function evaluateFormulaTokens(config: JsonObject, measurements: Record<string, number>): number {
  const tokens = asArray(config.tokens).map(asObject).map((token): FormulaToken => ({ type: cleanText(token.type), value: cleanText(token.value) }));
  if (!tokens.length) return 1;
  let index = 0;
  const factor = (): number => {
    const token = tokens[index++];
    if (!token) throw new Error("unexpected end");
    if (token.type === "paren" && token.value === "(") {
      const value = expression();
      const close = tokens[index++];
      if (!close || close.value !== ")") throw new Error("unclosed parenthesis");
      return value;
    }
    if (token.type === "operator" && token.value === "-") return -factor();
    if (token.type === "operator" && token.value === "+") return factor();
    if (token.type === "number") {
      const value = Number(token.value || 0);
      if (!Number.isFinite(value)) throw new Error("invalid number");
      return value;
    }
    if (token.type === "measurement" || token.type === "custom_field") return Number(measurements[token.value]) || 0;
    throw new Error("unexpected token");
  };
  const term = (): number => {
    let value = factor();
    while (tokens[index]?.type === "operator" && ["*", "/"].includes(tokens[index]!.value)) {
      const operator = tokens[index++]!.value;
      const right = factor();
      value = operator === "*" ? value * right : (right === 0 ? 0 : value / right);
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    while (tokens[index]?.type === "operator" && ["+", "-"].includes(tokens[index]!.value)) {
      const operator = tokens[index++]!.value;
      const right = term();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = expression();
    return index === tokens.length && Number.isFinite(value) ? Math.max(0, value) : 0;
  } catch {
    return 0;
  }
}

/**
 * Quantity modifiers adjust a line's formula quantity by a rule the whole
 * trade shares rather than by a line of its own. Waste is the roofing one:
 * a percent added to every material that is cut to fit. A price book may
 * declare its own under quantity_modifiers; without any, waste applies to
 * lines whose formula asks for it.
 */
export type QuantityModifier = {
  id: string;
  label: string;
  /** One or two letters shown beside an affected line. */
  badge: string;
  description: string;
  /** percent: add value% · multiply: times value · add: plus value. */
  operation: "percent" | "multiply" | "add";
  /** Measurement that supplies the value; value is the fixed fallback. */
  variable: string;
  value: number;
  applies_to: { formula_flag?: string; item_ids?: string[]; item_types?: string[]; categories?: string[]; units?: string[] };
};

const DEFAULT_MODIFIERS: QuantityModifier[] = [{
  id: "waste",
  label: "Waste",
  badge: "W",
  description: "Extra material for cuts, starter courses and offcuts.",
  operation: "percent",
  variable: "wastePercent",
  value: 0,
  applies_to: { formula_flag: "includeWaste" }
}];

function catalogModifiers(catalog: JsonObject): QuantityModifier[] {
  const declared = asArray(catalog.quantity_modifiers || catalog.quantityModifiers || asObject(catalog.settings).quantity_modifiers).map(asObject);
  if (!declared.length) return DEFAULT_MODIFIERS;
  const texts = (value: unknown) => asArray(value).map(cleanText).filter(Boolean);
  return declared.filter((entry) => cleanText(entry.id)).map((entry) => {
    const applies = asObject(entry.applies_to || entry.appliesTo);
    const operation = cleanText(entry.operation);
    return {
      id: cleanText(entry.id),
      label: cleanText(entry.label || entry.name) || cleanText(entry.id),
      badge: (cleanText(entry.badge) || cleanText(entry.label || entry.id).slice(0, 1)).slice(0, 2).toUpperCase(),
      description: cleanText(entry.description),
      operation: operation === "multiply" || operation === "add" ? operation : "percent",
      variable: cleanText(entry.variable),
      value: Number(entry.value) || 0,
      applies_to: {
        ...(cleanText(applies.formula_flag || applies.formulaFlag) ? { formula_flag: cleanText(applies.formula_flag || applies.formulaFlag) } : {}),
        item_ids: texts(applies.item_ids || applies.itemIds),
        item_types: texts(applies.item_types || applies.itemTypes),
        categories: texts(applies.categories),
        units: texts(applies.units)
      }
    };
  });
}

function modifierApplies(modifier: QuantityModifier, line: JsonObject, catalogItem: JsonObject) {
  const applies = modifier.applies_to;
  if (asArray(catalogItem.quantity_modifiers || catalogItem.quantityModifiers).map(cleanText).includes(modifier.id)) return true;
  if (applies.formula_flag && asObject(line.formula_config)[applies.formula_flag] === true) return true;
  if (applies.item_ids?.includes(cleanText(catalogItem.id))) return true;
  if (applies.item_types?.includes(cleanText(catalogItem.itemTypeId || catalogItem.item_type_id))) return true;
  if (applies.categories?.includes(cleanText(catalogItem.category))) return true;
  return !!applies.units?.includes(cleanText(line.unit));
}

export function applyQuantityModifier(quantity: number, operation: string, value: number) {
  if (operation === "multiply") return quantity * value;
  if (operation === "add") return quantity + value;
  return quantity * (1 + value / 100);
}

/**
 * How a quantity is rounded for the proposal. Areas and lengths are bought
 * whole, so they round up; a price book item may set quantity_rounding
 * ({ mode: "up" | "nearest" | "none", decimals }).
 */
export function quantityRounding(unit: string, catalogItem: JsonObject = {}): { mode: string; decimals: number } {
  const declared = asObject(catalogItem.quantity_rounding || catalogItem.quantityRounding);
  if (cleanText(declared.mode)) return { mode: cleanText(declared.mode), decimals: Math.max(0, Math.min(4, Number(declared.decimals) || 0)) };
  const cleaned = cleanText(unit).toLowerCase();
  if (["sq", "lf", "ft", "sf", "sqft"].includes(cleaned)) return { mode: "up", decimals: 0 };
  if (["ea", "each", "count", "job", "scope"].includes(cleaned)) return { mode: "nearest", decimals: 0 };
  return { mode: "nearest", decimals: 2 };
}

export function roundQuantity(value: number, rounding: { mode: string; decimals: number }) {
  if (rounding.mode === "none") return Math.max(0, Math.round(value * 1e4) / 1e4);
  const factor = 10 ** rounding.decimals;
  // Binary noise must not push 25.0000001 up to 26.
  const scaled = Math.round(value * factor * 1e6) / 1e6;
  return Math.max(0, (rounding.mode === "up" ? Math.ceil(scaled) : Math.round(scaled)) / factor);
}

/**
 * Quantity for one line: formula, then modifiers, then rounding. The steps
 * are kept on the line (base_quantity, quantity_adjustments,
 * quantity_rounding) so a reviewer can see why 25.7 squares became 29, and a
 * modifier's value can be changed without regenerating the scope.
 */
function applyQuantities(catalog: JsonObject, item: JsonObject, measurements: Record<string, number>) {
  const catalogItem = asArray(catalog.items).map(asObject).find((entry) => cleanText(entry.id) === referencedItemId(item)) || {};
  const base = evaluateFormulaTokens(asObject(item.formula_config), measurements);
  let quantity = base;
  const adjustments: JsonObject[] = [];
  for (const modifier of catalogModifiers(catalog)) {
    if (!modifierApplies(modifier, item, catalogItem)) continue;
    const value = modifier.variable ? Number(measurements[modifier.variable]) || 0 : modifier.value;
    quantity = applyQuantityModifier(quantity, modifier.operation, value);
    adjustments.push({ id: modifier.id, label: modifier.label, badge: modifier.badge, operation: modifier.operation, variable: modifier.variable, value });
  }
  const rounding = quantityRounding(cleanText(item.unit), catalogItem);
  item.base_quantity = Math.round(base * 1e4) / 1e4;
  item.quantity_adjustments = adjustments;
  item.quantity_rounding = rounding;
  item.quantity = String(roundQuantity(quantity, rounding));
  asArray(item.children).map(asObject).forEach((child) => applyQuantities(catalog, child, measurements));
}

/** Swatches for color names a price book lists without a hex value. */
const COLOR_HEX: Record<string, string> = {
  charcoal: "#3f4144", weathered_wood: "#6f6354", barkwood: "#5b4a3c", shakewood: "#8b6f4e", driftwood: "#8c8478",
  pewter_gray: "#7d8286", slate: "#55606a", hickory: "#6a4a34", mission_brown: "#4a3a30", hunter_green: "#3b4d3f",
  biscayne_blue: "#4d6275", fox_hollow_gray: "#6f7377", white: "#f4f4f2", black: "#1f2023", bronze: "#5a4a3a",
  brown: "#5c4433", gray: "#8a8d91", tan: "#c9b79c", almond: "#e6d9bd", clay: "#b3a595", red: "#8f3a2f", green: "#3f5a45", blue: "#44607c"
};

/**
 * The ways one line can vary without becoming another line: colors and other
 * options. Each dimension lists its values with the per-unit price change and
 * the values of other dimensions it rules out. Read from the item's
 * variant_dimensions, or from its plain option lists when it has none.
 */
function lineVariantDimensions(catalogItem: JsonObject): JsonObject[] {
  const declared = asArray(catalogItem.variant_dimensions || catalogItem.variantDimensions).map(asObject).filter((dimension) => cleanText(dimension.kind) !== "pricing_policy");
  const source = declared.length ? declared : asArray(catalogItem.options).map(asObject).filter((option) => asArray(option.values).length > 1);
  return source.filter((dimension) => cleanText(dimension.id)).map((dimension) => {
    const id = cleanText(dimension.id);
    const kind = cleanText(dimension.kind) || (/colou?r/i.test(id) ? "color" : "option");
    return {
      id,
      label: cleanText(dimension.label) || id,
      kind,
      values: asArray(dimension.values).map(asObject).map((value) => {
        const valueId = cleanText(value.id ?? value.value);
        const adjustment = asObject(value.adjustment);
        const operation = cleanText(adjustment.operation);
        return {
          id: valueId,
          label: cleanText(value.label) || valueId,
          ...(kind === "color" ? { hex: cleanText(value.hex) || COLOR_HEX[valueId] || "" } : {}),
          // add: dollars per unit; multiply: factor on the unit price.
          ...(operation === "add" || operation === "multiply" ? { adjustment: { operation, value: Number(adjustment.value) || 0 } } : {}),
          ...(Object.keys(asObject(value.excludes)).length ? { excludes: asObject(value.excludes) } : {})
        };
      }).filter((value) => value.id)
    };
  }).filter((dimension) => asArray(dimension.values).length > 1);
}

function pricedLine(catalog: JsonObject, itemId: string, measurements: Record<string, number>): JsonObject {
  const line = resolveCatalogItemToScopeItem(catalog, itemId);
  applyQuantities(catalog, line, measurements);
  const catalogItem = asArray(catalog.items).map(asObject).find((entry) => cleanText(entry.id) === itemId) || {};
  const dimensions = lineVariantDimensions(catalogItem);
  if (dimensions.length) {
    const chosen = asObject(line.selected_variants);
    const defaults = asObject(catalogItem.defaultOptions || catalogItem.default_options);
    line.variant_dimensions = dimensions;
    // The price before any variant is applied; the screen recomputes from it.
    line.variant_base_price = Number(catalogItem.unit_price ?? catalogItem.unitPrice ?? 0) || 0;
    line.selected_variants = Object.fromEntries(dimensions.map((dimension) => {
      const ids = asArray(dimension.values).map((value) => cleanText(asObject(value).id));
      const wanted = cleanText(chosen[cleanText(dimension.id)] ?? defaults[cleanText(dimension.id)]);
      return [dimension.id, ids.includes(wanted) ? wanted : ids[0]];
    }));
    // Every value is offered until the reviewer switches some off.
    line.variant_offered = Object.fromEntries(dimensions.map((dimension) => [dimension.id, asArray(dimension.values).map((value) => cleanText(asObject(value).id))]));
  }
  return line;
}

function catalogHas(catalog: JsonObject, itemId: string) {
  return asArray(catalog.items).map(asObject).some((item) => cleanText(item.id) === itemId);
}

function referencedItemId(item: JsonObject) {
  const ref = asObject(item.pricebook_ref);
  return cleanText(ref.item_id || ref.catalog_item_id);
}

type ChoiceGroup = {
  /** selection.group_id shared by the alternatives. */
  group: string;
  title: string;
  /** Catalog item type + category the alternatives come from. */
  itemType: string;
  category: string;
  /** Alternatives in display order; ones missing from the catalog are skipped. */
  items: string[];
  defaultItem: string;
  /** Alternatives the customer may pick between. */
  customerItems: string[];
};

/**
 * One complete way to do the job. A recipe with packages offers them as a
 * single choice: each is a whole set of lines, so picking one swaps the lot.
 */
type PackageOption = {
  id: string;
  title: string;
  description: string;
  /** The product this option takes from each choice group, by group id. */
  picks: Record<string, string>;
  /** Extras this option includes in its price. */
  include: string[];
};

type PieceRecipe = {
  /** Catalog assembly that supplies the fixed lines. */
  assembly?: string;
  /** Heads the lines of a piece the catalog has no assembly for. */
  root?: { name: string; description: string };
  /** Lines every report-based scope carries even when the assembly omits them. */
  ensure: string[];
  choices: ChoiceGroup[];
  /** Optional extras offered with the job; not in the price until chosen. */
  addons: string[];
  /** Per item, the measurement a missing one falls back to. */
  measurementFallbacks?: Record<string, Record<string, string>>;
  packages?: { group: string; title: string; defaultOption: string; options: PackageOption[] };
};

// Gutters hang on the eaves, so an unmeasured gutter run is priced at the eave length.
const GUTTER_FALLBACK = { gutter_replace: { gutterLf: "eavesLf" }, gutter_removal: { gutterLf: "eavesLf" }, gutter_guard: { gutterLf: "eavesLf" } };

const ROOF_CHOICES: ChoiceGroup[] = [
  // `items` are the options a new proposal starts with; every other price
  // book item of the same item type can be added from the review screen.
  { group: "shingle_profile", title: "Shingle", itemType: "field_shingles", category: "shingle_roofs",
    items: ["gaf_ns", "gaf_hd", "gaf_uhdz"], defaultItem: "gaf_hd", customerItems: ["gaf_ns", "gaf_hd", "gaf_uhdz"] },
  { group: "underlayment_profile", title: "Underlayment", itemType: "underlayment", category: "underlayments",
    items: ["underlayment", "gaf_feltbuster", "gaf_tiger_paw"], defaultItem: "underlayment", customerItems: ["underlayment", "gaf_feltbuster", "gaf_tiger_paw"] },
  { group: "leak_barrier_profile", title: "Leak barrier", itemType: "leak_barrier", category: "leak_barriers",
    items: ["ice_water", "gaf_weatherwatch", "owens_weatherlock"], defaultItem: "ice_water", customerItems: ["ice_water", "gaf_weatherwatch", "owens_weatherlock"] }
];
const ROOF_ENSURE = ["headwall_flashing", "sidewall_flashing", "pipe_boot", "skylight_flashing", "chimney_flashing"];

const ROOF_REPLACEMENT: PieceRecipe = {
  assembly: "roof_replacement",
  ensure: ROOF_ENSURE,
  // Gutters are a separate trade: offered with the roof, never assumed.
  addons: ["pipe_boot_lifetime", "warranty_system_plus", "warranty_silver_pledge", "gutter_replace", "downspout"],
  measurementFallbacks: GUTTER_FALLBACK,
  choices: ROOF_CHOICES
};

/** The same roof as three complete options; the customer picks one. */
const ROOF_REPLACEMENT_OPTIONS: PieceRecipe = {
  assembly: "roof_replacement",
  ensure: ROOF_ENSURE,
  addons: ["gutter_replace", "downspout"],
  measurementFallbacks: GUTTER_FALLBACK,
  choices: ROOF_CHOICES,
  packages: {
    group: "roof_package", title: "Your roof", defaultOption: "better",
    options: [
      { id: "good", title: "Good", description: "A dependable architectural roof at the lowest price.",
        picks: { shingle_profile: "gaf_ns", underlayment_profile: "underlayment", leak_barrier_profile: "ice_water" }, include: [] },
      { id: "better", title: "Better", description: "Our most chosen roof: high-definition shingles and a 50-year system warranty.",
        picks: { shingle_profile: "gaf_hd", underlayment_profile: "gaf_feltbuster", leak_barrier_profile: "gaf_weatherwatch" }, include: ["warranty_system_plus"] },
      { id: "best", title: "Best", description: "The thickest shingle, premium underlayment, lifetime pipe boots and manufacturer-backed workmanship coverage.",
        picks: { shingle_profile: "gaf_uhdz", underlayment_profile: "gaf_tiger_paw", leak_barrier_profile: "gaf_weatherwatch" }, include: ["pipe_boot_lifetime", "warranty_silver_pledge"] }
    ]
  }
};

/** A gutter job on its own: take down, hang new, guards if wanted. */
const GUTTER_REPLACEMENT: PieceRecipe = {
  root: { name: "Gutter Replacement", description: "New seamless gutters and downspouts, with the old ones taken down and hauled away." },
  ensure: ["gutter_removal", "gutter_replace", "downspout"],
  addons: ["gutter_guard"],
  measurementFallbacks: GUTTER_FALLBACK,
  choices: []
};

// Keyed by the scope template the piece sells, so signing starts that scope.
const RECIPES: Record<string, PieceRecipe> = { roof_replacement: ROOF_REPLACEMENT, gutters: GUTTER_REPLACEMENT };
/** Other ways to price the same piece: "options" offers it as Good / Better / Best. */
const VARIANTS: Record<string, Record<string, PieceRecipe>> = { roof_replacement: { options: ROOF_REPLACEMENT_OPTIONS } };

export function scopeGenerationSupports(templateId: string) {
  return Object.prototype.hasOwnProperty.call(RECIPES, cleanText(templateId));
}

const itemTypeOf = (item: JsonObject) => cleanText(item.itemTypeId || item.item_type_id);

/** Price book items that can stand in for one another in a choice group. */
function groupCandidates(catalog: JsonObject, group: ChoiceGroup): JsonObject[] {
  return asArray(catalog.items).map(asObject).filter((item) => itemTypeOf(item) === group.itemType && cleanText(item.status) !== "archived");
}

function choiceLine(catalog: JsonObject, group: ChoiceGroup, itemId: string, measurements: Record<string, number>, selected: boolean, customer: boolean): JsonObject {
  const line = pricedLine(catalog, itemId, measurements);
  line.selection = {
    mode: "choice",
    group_id: group.group,
    group_title: group.title,
    group_behavior: "single",
    selected,
    default_selected: selected,
    customer_visible: true,
    selectable_by: ["internal", "customer"]
  };
  // An alternative carries its own price; it is never an "included" line.
  line.included = false;
  line.price_driving = true;
  return line;
}

function applyChoiceGroup(catalog: JsonObject, root: JsonObject, group: ChoiceGroup, measurements: Record<string, number>) {
  const candidateIds = new Set(groupCandidates(catalog, group).map((item) => cleanText(item.id)));
  const available = group.items.filter((id) => candidateIds.has(id));
  // One option is not a choice: leave the assembly's own line as it is.
  if (available.length < 2) return;
  const replaced: JsonObject[] = [];
  root.children = asArray(root.children).map(asObject).filter((child) => {
    const selection = asObject(child.selection);
    const inGroup = cleanText(selection.mode) === "choice" && cleanText(selection.group_id) === group.group;
    if (inGroup || candidateIds.has(referencedItemId(child))) {
      replaced.push(child);
      return false;
    }
    return true;
  });
  const assemblyPick = referencedItemId(asObject(replaced.find((child) => asObject(child.selection).selected === true)));
  const selectedId = available.includes(assemblyPick) ? assemblyPick : (available.includes(group.defaultItem) ? group.defaultItem : available[0]!);
  for (const id of available) {
    (root.children as JsonObject[]).push(choiceLine(catalog, group, id, measurements, id === selectedId, group.customerItems.includes(id)));
  }
}

/**
 * Every price book item that could be added to a choice group, priced from
 * the same measurements. The review screen searches these so adding a fourth
 * shingle does not mean searching the whole price book.
 */
export function choiceGroupCandidates(catalogValue: unknown, templateIdValue: string, groupValue: string, measurementsValue: unknown): JsonObject[] {
  const recipe = RECIPES[cleanText(templateIdValue)];
  if (!recipe) throw badRequest("scope_generation_unsupported", `Scope generation is not available for '${cleanText(templateIdValue)}'.`);
  // Review screens namespace group ids per scope piece ("piece_x:shingle_profile").
  const groupId = cleanText(groupValue).split(":").pop() || "";
  const group = recipe.choices.find((entry) => entry.group === groupId);
  if (!group) throw badRequest("scope_choice_group_unknown", `'${groupId}' is not a choice group of this scope.`);
  const catalog = asObject(catalogValue);
  const measurements = normalizeScopeMeasurements(measurementsValue);
  return groupCandidates(catalog, group).map((item) => choiceLine(catalog, group, cleanText(item.id), measurements, false, true));
}

const lineQuantity = (line: JsonObject) => Number(line.quantity) || 0;

/** Measurements as one line reads them: its own, or the fallback the recipe names. */
function lineMeasurements(recipe: PieceRecipe, itemId: string, measurements: Record<string, number>) {
  const fallbacks = recipe.measurementFallbacks?.[itemId];
  if (!fallbacks) return measurements;
  const out = { ...measurements };
  for (const [key, from] of Object.entries(fallbacks)) if (!((out[key] ?? 0) > 0)) out[key] = out[from] || 0;
  return out;
}

/**
 * The piece's fixed lines under its root: the assembly's own plus the ensured
 * ones. A line measured at zero is left out, so nothing prints at no quantity
 * for no money; measure it and regenerate to bring it in.
 */
function fixedScope(catalog: JsonObject, recipe: PieceRecipe, measurements: Record<string, number>) {
  const fixed = (id: string) => pricedLine(catalog, id, lineMeasurements(recipe, id, measurements));
  const root: JsonObject = recipe.assembly ? pricedLine(catalog, recipe.assembly, measurements) : {
    id: scopeLineId("piece"), type: "scope_item", name: recipe.root!.name, display_name: recipe.root!.name, description: recipe.root!.description,
    unit: "ea", quantity: "1", base_price: 0, unit_price: 0, included: false, price_driving: true, selection: { mode: "fixed", selected: true }, children: []
  };
  const present = new Set<string>();
  const collect = (item: JsonObject) => { const id = referencedItemId(item); if (id) present.add(id); asArray(item.children).map(asObject).forEach(collect); };
  collect(root);
  const children = asArray(root.children).map(asObject);
  for (const id of recipe.ensure) {
    if (!present.has(id) && catalogHas(catalog, id)) { children.push(fixed(id)); present.add(id); }
  }
  // Fixed lines are part of the package; alternatives are priced on their own.
  for (const child of children) {
    child.included = true;
    child.price_driving = child.price_driving !== false;
  }
  root.children = children.filter((child) => cleanText(asObject(child.selection).mode) === "choice" || lineQuantity(child) > 0);
  return { root, present };
}

const scopeLineId = (prefix: string) => `scope_${prefix}_${Math.random().toString(36).slice(2, 8)}`;

/** Optional extras offered beside the scope, each priced from its own measurement. */
function addonLines(catalog: JsonObject, recipe: PieceRecipe, measurements: Record<string, number>, present: Set<string>): JsonObject[] {
  const lines: JsonObject[] = [];
  for (const id of recipe.addons) {
    if (present.has(id) || !catalogHas(catalog, id)) continue;
    const line = pricedLine(catalog, id, lineMeasurements(recipe, id, measurements));
    if (!(lineQuantity(line) > 0)) continue;
    line.selection = { mode: "optional", selected: false, default_selected: false, customer_visible: true, selectable_by: ["internal", "customer"] };
    line.included = false;
    line.price_driving = true;
    lines.push(line);
  }
  return lines;
}

/**
 * One complete option: every fixed line, the option's product from each
 * choice group, and the extras it includes. Its lines are fixed, so the
 * option is chosen or passed over as a whole.
 */
function packageLine(catalog: JsonObject, recipe: PieceRecipe, option: PackageOption, measurements: Record<string, number>, selected: boolean): JsonObject {
  const packages = recipe.packages!;
  const { root } = fixedScope(catalog, recipe, measurements);
  const grouped = new Set(recipe.choices.flatMap((group) => groupCandidates(catalog, group).map((item) => cleanText(item.id))));
  const shared = asArray(root.children).map(asObject).filter((child) => cleanText(asObject(child.selection).mode) !== "choice" && !grouped.has(referencedItemId(child)));
  // The products that set the option apart lead; the lines every option shares follow.
  const children: JsonObject[] = [];
  const highlights: string[] = [];
  const add = (id: string) => {
    if (!catalogHas(catalog, id)) return;
    const line = pricedLine(catalog, id, lineMeasurements(recipe, id, measurements));
    if (!(lineQuantity(line) > 0)) return;
    line.selection = { mode: "fixed", selected: true };
    line.included = true;
    line.price_driving = true;
    children.push(line);
    highlights.push(cleanText(line.display_name || line.name));
  };
  for (const group of recipe.choices) add(option.picks[group.group] || group.defaultItem);
  option.include.forEach(add);
  children.push(...shared);
  return {
    id: scopeLineId(option.id), type: "scope_item", name: option.title, display_name: option.title, description: option.description,
    // What sets this option apart, for the comparison the customer sees.
    highlights,
    unit: "ea", quantity: "1", base_price: 0, unit_price: 0, included: false, price_driving: true,
    selection: { mode: "choice", group_id: packages.group, group_title: packages.title, group_behavior: "single", selected, default_selected: selected, customer_visible: true, selectable_by: ["internal", "customer"] },
    children
  };
}

/** One priced root scope item for a scope piece. */
export function generatePieceScope(catalogValue: unknown, templateIdValue: string, measurementsValue: unknown, variantValue: unknown = ""): JsonObject {
  const templateId = cleanText(templateIdValue);
  const variant = cleanText(variantValue);
  const recipe = variant ? VARIANTS[templateId]?.[variant] : RECIPES[templateId];
  if (!recipe) throw badRequest("scope_generation_unsupported", `Scope generation is not available for '${[templateId, variant].filter(Boolean).join(" / ")}'.`);
  const catalog = asObject(catalogValue);
  if (recipe.assembly && !catalogHas(catalog, recipe.assembly)) {
    throw badRequest("scope_generation_assembly_missing", `The price book has no '${recipe.assembly}' assembly to build this scope from.`);
  }
  const measurements = normalizeScopeMeasurements(measurementsValue);
  const { root, present } = fixedScope(catalog, recipe, measurements);
  if (recipe.packages) {
    // The root only heads the options; each carries its own complete set of lines.
    for (const option of recipe.packages.options) option.include.forEach((id) => present.add(id));
    root.children = recipe.packages.options.map((option) => packageLine(catalog, recipe, option, measurements, option.id === recipe.packages!.defaultOption));
  } else {
    for (const group of recipe.choices) applyChoiceGroup(catalog, root, group, measurements);
  }
  (root.children as JsonObject[]).push(...addonLines(catalog, recipe, measurements, present));
  root.scope_template_id = templateId;
  // The modifiers in play and their current values, for the review screen.
  root.quantity_modifiers = catalogModifiers(catalog).map((modifier) => ({
    ...modifier,
    value: modifier.variable ? Number(measurements[modifier.variable]) || 0 : modifier.value
  }));
  return root;
}
