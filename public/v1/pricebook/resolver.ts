import { badRequest, notFound } from "./errors.js";

export type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(patch)) return cloneJson(patch);
  if (base && typeof base === "object" && patch && typeof patch === "object") {
    const output: JsonObject = { ...(base as JsonObject) };
    for (const [key, value] of Object.entries(patch as JsonObject)) {
      output[key] = key in output ? deepMerge(output[key], value) : cloneJson(value);
    }
    return output;
  }
  return cloneJson(patch);
}

function catalogItems(catalog: JsonObject) {
  return asArray(catalog.items).map(asObject);
}

function catalogItem(catalog: JsonObject, itemId: string) {
  return catalogItems(catalog).find((item) => cleanText(item.id) === itemId) || null;
}

function normalizeComponent(value: unknown, index = 0) {
  const component = asObject(value);
  return {
    ...component,
    id: cleanText(component.id) || `component_${index + 1}`,
    item_ref: cleanText(component.item_ref || component.itemRef || component.item_id || component.itemId),
    included: component.included === true,
    price_driving: component.price_driving !== false && component.priceDriving !== false,
    overrides: asObject(component.overrides)
  };
}

function variationSetsById(catalog: JsonObject) {
  return new Map(asArray(catalog.variation_sets || catalog.variationSets).map(asObject).map((set) => [cleanText(set.id), set]));
}

function itemVariations(catalog: JsonObject, item: JsonObject) {
  const sets = variationSetsById(catalog);
  const direct = asArray(item.variations).map(asObject);
  const fromSets = asArray(item.variation_set_refs || item.variationSetRefs)
    .map(cleanText)
    .map((setId) => sets.get(setId))
    .filter(Boolean)
    .flatMap((set) => asArray(asObject(set).values).map(asObject).map((value) => ({
      id: cleanText(value.id),
      label: cleanText(value.label || value.name || value.id),
      name: cleanText(value.name || value.label),
      variation_set_id: cleanText(asObject(set).id),
      overrides: {
        variables: { [cleanText(asObject(set).variable_key || asObject(set).id)]: cleanText(value.id) },
        ...(asObject(asObject(item.variation_overrides || item.variationOverrides)[cleanText(value.id)]))
      }
    })));
  const byId = new Map<string, JsonObject>();
  [...fromSets, ...direct].forEach((variation) => {
    const id = cleanText(variation.id);
    if (id) byId.set(id, { ...(byId.get(id) || {}), ...variation });
  });
  return [...byId.values()];
}

export function validateCatalogGraph(catalogValue: unknown) {
  const catalog = asObject(catalogValue);
  const items = catalogItems(catalog);
  const ids = new Set<string>();
  items.forEach((item) => {
    const id = cleanText(item.id);
    if (!id) throw badRequest("pricebook_item_missing_id", "Every price book item requires an id.");
    if (ids.has(id)) throw badRequest("pricebook_duplicate_item_id", `Duplicate price book item id '${id}'.`);
    ids.add(id);
  });
  const variationSetIds = new Set<string>();
  asArray(catalog.variation_sets || catalog.variationSets).map(asObject).forEach((set) => {
    const id = cleanText(set.id);
    if (!id) throw badRequest("pricebook_variation_set_missing_id", "Every variation set requires an id.");
    if (variationSetIds.has(id)) throw badRequest("pricebook_duplicate_variation_set_id", `Duplicate variation set id '${id}'.`);
    variationSetIds.add(id);
  });
  items.forEach((item) => {
    asArray(item.variation_set_refs || item.variationSetRefs).map(cleanText).filter(Boolean).forEach((setId) => {
      if (!variationSetIds.has(setId)) throw badRequest("pricebook_unknown_variation_set", `Item '${item.id}' references missing variation set '${setId}'.`);
    });
    asArray(item.components).map(normalizeComponent).forEach((component) => {
      if (!component.item_ref) throw badRequest("pricebook_component_missing_ref", `Item '${item.id}' has a component without item_ref.`);
      if (!ids.has(component.item_ref)) throw badRequest("pricebook_unknown_component_ref", `Item '${item.id}' references missing component '${component.item_ref}'.`);
    });
  });
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (itemId: string, path: string[]) => {
    if (visiting.has(itemId)) throw badRequest("pricebook_circular_component_ref", `Circular price book component reference: ${[...path, itemId].join(" -> ")}`);
    if (visited.has(itemId)) return;
    visiting.add(itemId);
    const item = catalogItem(catalog, itemId);
    asArray(item?.components).map(normalizeComponent).forEach((component) => visit(component.item_ref, [...path, itemId]));
    visiting.delete(itemId);
    visited.add(itemId);
  };
  ids.forEach((id) => visit(id, []));
  return catalog;
}

function selectionFromComponent(component: JsonObject, item: JsonObject) {
  const source = asObject(component.selection || item.selection);
  if (Object.keys(source).length) return source;
  return { mode: "fixed", selected: true, selectable_by: ["internal"] };
}

function normalizePriceUpdateRule(value: unknown): JsonObject {
  const rule = asObject(value);
  const mode = ["fixed", "live", "conditional"].includes(cleanText(rule.mode)) ? cleanText(rule.mode) : "fixed";
  return {
    ...rule,
    id: cleanText(rule.id) || (mode === "fixed" ? "fixed_forever" : mode),
    label: cleanText(rule.label) || (mode === "fixed" ? "Fixed forever" : mode === "live" ? "Live price" : "Conditional price"),
    mode,
    source: cleanText(rule.source) || "organization_pricebook",
    lock_on: asArray(rule.lock_on).map(cleanText).filter(Boolean)
  };
}

function selectedVariantValues(item: JsonObject, component: JsonObject) {
  const defaults = asObject(item.default_variant_selection || item.defaultVariantSelection);
  const requested = asObject(component.selected_variants || component.selectedVariants || asObject(component.overrides).selected_variants);
  const selection: JsonObject = { ...defaults, ...requested };
  asArray(item.variant_dimensions || item.variantDimensions).map(asObject).forEach((dimension) => {
    const id = cleanText(dimension.id);
    const first = asObject(asArray(dimension.values)[0]);
    if (id && !cleanText(selection[id]) && first.id) selection[id] = cleanText(first.id);
  });
  return selection;
}

function combinationKey(item: JsonObject, selection: JsonObject) {
  return asArray(item.variant_dimensions || item.variantDimensions)
    .map(asObject)
    .map((dimension) => `${cleanText(dimension.id)}=${cleanText(selection[cleanText(dimension.id)])}`)
    .filter((part) => !part.endsWith("="))
    .join("|");
}

function applyVariantAdjustment(current: number, adjustmentValue: unknown, target: "sell_price" | "internal_cost") {
  const adjustment = asObject(adjustmentValue);
  const adjustmentTarget = cleanText(adjustment.target) || "sell_price";
  if (adjustmentTarget !== target && adjustmentTarget !== "both") return current;
  const amount = Number(adjustment.value ?? 0);
  if (!Number.isFinite(amount)) return current;
  if (adjustment.operation === "add") return current + amount;
  if (adjustment.operation === "multiply") return current * amount;
  if (adjustment.operation === "divide") return amount === 0 ? current : current / amount;
  if (adjustment.operation === "formula") return evaluateVariantArithmetic(cleanText(adjustment.formula), current);
  return current;
}

function evaluateVariantArithmetic(formula: string, current: number) {
  if (!formula) return current;
  const tokens = formula.match(/[A-Za-z_][A-Za-z0-9_]*|(?:\d+\.?\d*|\.\d+)|[()+\-*/]/g) || [];
  if (tokens.join("") !== formula.replace(/\s+/g, "")) return current;
  let index = 0;
  const factor = (): number => {
    const token = tokens[index++];
    if (token === "(") {
      const value = expression();
      if (tokens[index++] !== ")") throw new Error("unclosed parenthesis");
      return value;
    }
    if (token === "-") return -factor();
    if (token === "+") return factor();
    if (["base", "current", "price", "sell_price", "cost", "internal_cost"].includes(String(token))) return current;
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error("invalid number");
    return value;
  };
  const term = (): number => {
    let value = factor();
    while (["*", "/"].includes(tokens[index] ?? "")) {
      const operator = tokens[index++];
      const right = factor();
      value = operator === "*" ? value * right : (right === 0 ? value : value / right);
    }
    return value;
  };
  const expression = (): number => {
    let value = term();
    while (["+", "-"].includes(tokens[index] ?? "")) {
      const operator = tokens[index++];
      const right = term();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  try {
    const value = expression();
    return index === tokens.length && Number.isFinite(value) ? value : current;
  } catch {
    return current;
  }
}

function resolveVariantCombination(item: JsonObject, component: JsonObject) {
  const selection = selectedVariantValues(item, component);
  let sellPrice = Number(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice ?? 0) || 0;
  let internalCost = Number(item.internal_cost ?? item.internalCost ?? 0) || 0;
  let updateRule = normalizePriceUpdateRule(item.default_pricing_update_rule || item.defaultPricingUpdateRule);
  const skuParts: string[] = [];

  asArray(item.variant_dimensions || item.variantDimensions).map(asObject).forEach((dimension) => {
    const dimensionId = cleanText(dimension.id);
    const valueId = cleanText(selection[dimensionId]);
    const value = asArray(dimension.values).map(asObject).find((entry) => cleanText(entry.id) === valueId);
    if (!value) return;
    sellPrice = applyVariantAdjustment(sellPrice, value.adjustment, "sell_price");
    internalCost = applyVariantAdjustment(internalCost, value.adjustment, "internal_cost");
    if (cleanText(dimension.kind) === "pricing_policy") updateRule = normalizePriceUpdateRule(value.pricing_update_rule || value.pricingUpdateRule);
    if (dimension.affects_sku !== false && cleanText(dimension.kind) !== "pricing_policy") skuParts.push(`${dimensionId}:${valueId}`);
  });

  const key = combinationKey(item, selection);
  const override = asObject(asObject(item.variant_overrides || item.variantOverrides)[key]);
  const resolved = deepMerge(item, override) as JsonObject;
  sellPrice = Number(override.unit_price ?? override.unitPrice ?? sellPrice) || 0;
  internalCost = Number(override.internal_cost ?? override.internalCost ?? internalCost) || 0;
  updateRule = normalizePriceUpdateRule(override.pricing_update_rule || override.pricingUpdateRule || updateRule);
  return {
    item: resolved,
    selection,
    combination_key: key,
    sku_key: [cleanText(item.code || item.id), ...skuParts].filter(Boolean).join("/") || cleanText(item.id),
    unit_price: sellPrice,
    internal_cost: internalCost,
    pricing_update_rule: updateRule
  };
}

function scopeItemFromCatalogItem(catalog: JsonObject, item: JsonObject, component: JsonObject, stack: string[]): JsonObject {
  const itemId = cleanText(item.id);
  if (stack.includes(itemId)) throw badRequest("pricebook_circular_component_ref", `Circular price book component reference: ${[...stack, itemId].join(" -> ")}`);
  const merged = deepMerge(item, component.overrides || {}) as JsonObject;
  const variant = resolveVariantCombination(merged, component);
  const pricingUpdateRule = normalizePriceUpdateRule(component.pricing_update_rule || component.pricingUpdateRule || asObject(component.overrides).pricing_update_rule || variant.pricing_update_rule);
  const resolvedItem = variant.item;
  const quantity = component.quantity ?? merged.quantity ?? 1;
  const unitPrice = variant.unit_price;
  const capturedAt = new Date().toISOString();
  const scopeItem: JsonObject = {
    id: cleanText(component.scope_item_id || component.scopeItemId) || `scope_${itemId}_${Math.random().toString(36).slice(2, 8)}`,
    type: "scope_item",
    pricebook_ref: {
      item_id: itemId,
      catalog_item_id: itemId,
      revision: merged.revision ?? null,
      global_item_ref: asObject(merged.global_item_ref),
      selected_variants: variant.selection,
      combination_key: variant.combination_key
    },
    name: cleanText(component.name || resolvedItem.name || itemId),
    display_name: cleanText(component.display_name || component.displayName || resolvedItem.display_name || resolvedItem.displayName || component.name || resolvedItem.name),
    description: cleanText(component.description || resolvedItem.external_description || resolvedItem.description),
    internal_description: cleanText(resolvedItem.internal_description),
    external_description: cleanText(resolvedItem.external_description || resolvedItem.description),
    unit: cleanText(resolvedItem.unit || "ea") || "ea",
    quantity,
    base_price: resolvedItem.base_price ?? resolvedItem.basePrice ?? unitPrice,
    unit_price: unitPrice,
    internal_cost: variant.internal_cost,
    amount: resolvedItem.amount,
    sku_key: variant.sku_key,
    selected_variants: variant.selection,
    variant_combination_key: variant.combination_key,
    pricing_update_rule: pricingUpdateRule,
    pricebook_snapshot: {
      captured_at: capturedAt,
      item_id: itemId,
      name: cleanText(resolvedItem.name),
      unit: cleanText(resolvedItem.unit || "ea") || "ea",
      unit_price: unitPrice,
      internal_cost: variant.internal_cost,
      selected_variants: variant.selection,
      combination_key: variant.combination_key,
      sku_key: variant.sku_key,
      pricing_update_rule: pricingUpdateRule
    },
    included: component.included === true || merged.included === true,
    price_driving: component.price_driving !== false && component.priceDriving !== false && merged.price_driving !== false && merged.priceDriving !== false,
    variables: deepMerge(merged.variables || {}, component.variables || {}) as JsonObject,
    measurements: deepMerge(merged.measurements || {}, component.measurements || {}) as JsonObject,
    formula: cleanText(component.formula || merged.formula),
    formula_config: asObject(component.formula_config || component.formulaConfig || merged.formula_config || merged.formulaConfig),
    media_refs: asArray(component.media_refs || component.mediaRefs || resolvedItem.media_refs || resolvedItem.mediaRefs || resolvedItem.images).map(asObject),
    selection: selectionFromComponent(component, merged),
    variation_selection: asObject(component.variation_selection || component.variationSelection || merged.variation_selection || merged.variationSelection),
    variations: itemVariations(catalog, merged),
    selection_groups: asArray(component.selection_groups || component.selectionGroups || merged.selection_groups || merged.selectionGroups).map(asObject),
    children: []
  };
  scopeItem.children = asArray(merged.components)
    .map(normalizeComponent)
    .map((childComponent) => {
      const child = catalogItem(catalog, childComponent.item_ref);
      if (!child) throw notFound("pricebook_component_not_found", `Component '${childComponent.item_ref}' was not found.`);
      return scopeItemFromCatalogItem(catalog, child, childComponent, [...stack, itemId]);
    });
  return scopeItem;
}

export function resolveCatalogItemToScopeItem(catalogValue: unknown, itemId: string, componentOverrides: JsonObject = {}) {
  const catalog = validateCatalogGraph(catalogValue);
  const item = catalogItem(catalog, cleanText(itemId));
  if (!item) throw notFound("pricebook_item_not_found", `Price book item '${itemId}' was not found.`);
  return scopeItemFromCatalogItem(catalog, item, normalizeComponent({ item_ref: itemId, overrides: componentOverrides }), []);
}

export function autoAddScopeItems(catalogValue: unknown) {
  const catalog = validateCatalogGraph(catalogValue);
  return catalogItems(catalog)
    .filter((item) => item.autoAdd === true || item.auto_add === true)
    .map((item) => resolveCatalogItemToScopeItem(catalog, cleanText(item.id)));
}
