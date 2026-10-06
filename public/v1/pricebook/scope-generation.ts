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
  let value = 0;
  try {
    value = expression();
    if (index !== tokens.length || !Number.isFinite(value)) return 0;
  } catch {
    return 0;
  }
  if (config.includeWaste === true || config.include_waste === true) value *= 1 + (Number(measurements.wastePercent) || 0) / 100;
  return Math.max(0, Math.round(value * 100) / 100);
}

function applyQuantities(item: JsonObject, measurements: Record<string, number>) {
  item.quantity = String(evaluateQuantityFormula(item.formula_config, measurements));
  asArray(item.children).map(asObject).forEach((child) => applyQuantities(child, measurements));
}

function pricedLine(catalog: JsonObject, itemId: string, measurements: Record<string, number>): JsonObject {
  const line = resolveCatalogItemToScopeItem(catalog, itemId);
  applyQuantities(line, measurements);
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

type PieceRecipe = {
  /** Catalog assembly that supplies the fixed lines. */
  assembly: string;
  /** Lines every report-based scope carries even when the assembly omits them. */
  ensure: string[];
  choices: ChoiceGroup[];
};

const ROOF_REPLACEMENT: PieceRecipe = {
  assembly: "roof_replacement",
  ensure: ["headwall_flashing", "sidewall_flashing", "pipe_boot", "skylight_flashing", "chimney_flashing", "gutter_replace", "downspout"],
  choices: [
    { group: "shingle_profile", title: "Shingle", itemType: "field_shingles", category: "shingle_roofs",
      items: ["gaf_ns", "gaf_hd", "gaf_uhdz", "gaf_camelot_ii", "gaf_slateline", "gaf_grand_sequoia", "owens_duration", "malarkey_vista", "certainteed_landmark"],
      defaultItem: "gaf_hd", customerItems: ["gaf_ns", "gaf_hd", "gaf_uhdz"] },
    { group: "underlayment_profile", title: "Underlayment", itemType: "underlayment", category: "underlayments",
      items: ["underlayment", "gaf_shinglemate", "gaf_feltbuster", "gaf_tiger_paw"],
      defaultItem: "underlayment", customerItems: ["underlayment", "gaf_feltbuster", "gaf_tiger_paw"] },
    { group: "leak_barrier_profile", title: "Leak barrier", itemType: "leak_barrier", category: "leak_barriers",
      items: ["ice_water", "gaf_weatherwatch", "owens_weatherlock"],
      defaultItem: "ice_water", customerItems: ["ice_water", "gaf_weatherwatch", "owens_weatherlock"] }
  ]
};

const RECIPES: Record<string, PieceRecipe> = { roof_replacement: ROOF_REPLACEMENT };

export function scopeGenerationSupports(templateId: string) {
  return Object.prototype.hasOwnProperty.call(RECIPES, cleanText(templateId));
}

function applyChoiceGroup(catalog: JsonObject, root: JsonObject, group: ChoiceGroup, measurements: Record<string, number>) {
  const available = group.items.filter((id) => {
    const item = asArray(catalog.items).map(asObject).find((entry) => cleanText(entry.id) === id);
    return !!item && cleanText(item.itemTypeId || item.item_type_id) === group.itemType && cleanText(item.category) === group.category;
  });
  if (!available.length) return;
  const candidates = new Set(group.items);
  const replaced: JsonObject[] = [];
  root.children = asArray(root.children).map(asObject).filter((child) => {
    const selection = asObject(child.selection);
    const inGroup = cleanText(selection.mode) === "choice" && cleanText(selection.group_id) === group.group;
    if (inGroup || candidates.has(referencedItemId(child))) {
      replaced.push(child);
      return false;
    }
    return true;
  });
  const assemblyPick = referencedItemId(asObject(replaced.find((child) => asObject(child.selection).selected === true)));
  const selectedId = available.includes(assemblyPick) ? assemblyPick : (available.includes(group.defaultItem) ? group.defaultItem : available[0]!);
  for (const id of available) {
    const line = pricedLine(catalog, id, measurements);
    const customer = group.customerItems.includes(id);
    line.selection = {
      mode: "choice",
      group_id: group.group,
      group_title: group.title,
      group_behavior: "single",
      selected: id === selectedId,
      default_selected: id === selectedId,
      customer_visible: customer,
      selectable_by: customer || id === selectedId ? ["internal", "customer"] : ["internal"]
    };
    // An alternative carries its own price; it is never an "included" line.
    line.included = false;
    line.price_driving = true;
    (root.children as JsonObject[]).push(line);
  }
}

/** One priced root scope item for a scope piece. */
export function generatePieceScope(catalogValue: unknown, templateIdValue: string, measurementsValue: unknown): JsonObject {
  const templateId = cleanText(templateIdValue);
  const recipe = RECIPES[templateId];
  if (!recipe) throw badRequest("scope_generation_unsupported", `Scope generation is not available for '${templateId}'.`);
  const catalog = asObject(catalogValue);
  if (!catalogHas(catalog, recipe.assembly)) {
    throw badRequest("scope_generation_assembly_missing", `The price book has no '${recipe.assembly}' assembly to build this scope from.`);
  }
  const measurements = normalizeScopeMeasurements(measurementsValue);
  const root = pricedLine(catalog, recipe.assembly, measurements);
  const present = new Set<string>();
  const collect = (item: JsonObject) => { const id = referencedItemId(item); if (id) present.add(id); asArray(item.children).map(asObject).forEach(collect); };
  collect(root);
  const children = asArray(root.children).map(asObject);
  for (const id of recipe.ensure) {
    if (!present.has(id) && catalogHas(catalog, id)) children.push(pricedLine(catalog, id, measurements));
  }
  // Fixed lines are part of the package; alternatives are priced on their own.
  for (const child of children) {
    child.included = true;
    child.price_driving = child.price_driving !== false;
  }
  root.children = children;
  for (const group of recipe.choices) applyChoiceGroup(catalog, root, group, measurements);
  root.scope_template_id = templateId;
  return root;
}
