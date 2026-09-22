import { randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export type ScopePriceResult = {
  amount_cents: number;
  own_amount_cents: number;
  children_amount_cents: number;
  selected: boolean;
};

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function measurementsHaveValues(value: unknown) {
  return Object.values(asObject(value)).some((item) => {
    if (item == null || item === "" || typeof item === "object") return false;
    const number = Number(item);
    return Number.isFinite(number) && number > 0;
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null)) as T;
}

export function scopeId(prefix = "scope_item") {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 18)}`;
}

export function moneyCents(value: unknown): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const input = asObject(value);
    if (Number.isFinite(Number(input.amount_cents))) return Math.round(Number(input.amount_cents));
    if (Number.isFinite(Number(input.cents))) return Math.round(Number(input.cents));
    if (Number.isFinite(Number(input.amount))) return Math.round(Number(input.amount) * 100);
  }
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  }
  return Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : 0;
}

export function moneyDisplay(cents: number, currency = "USD") {
  return (Math.round(Number(cents || 0)) / 100).toLocaleString("en-US", {
    style: "currency",
    currency: cleanText(currency) || "USD"
  });
}

function numberValue(value: unknown, fallback = 1) {
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[$,\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function normalizeSelection(value: unknown, fallbackSelected = true) {
  const selection = asObject(value);
  const mode = ["fixed", "optional", "choice"].includes(cleanText(selection.mode))
    ? cleanText(selection.mode)
    : "fixed";
  const selected = mode === "fixed" ? true : selection.selected !== false && selection.default_selected !== false && fallbackSelected;
  const selectableBy = asArray(selection.selectable_by || selection.selectableBy)
    .map(cleanText)
    .filter((actor) => ["internal", "customer", "system"].includes(actor));
  return {
    mode,
    selected,
    selected_by: cleanText(selection.selected_by || selection.selectedBy || (selected ? "system" : "")),
    selectable_by: selectableBy.length ? selectableBy : ["internal"],
    group_id: cleanText(selection.group_id || selection.groupId),
    group_behavior: ["single", "multiple"].includes(cleanText(selection.group_behavior || selection.groupBehavior))
      ? cleanText(selection.group_behavior || selection.groupBehavior)
      : undefined,
    required: selection.required === true,
    default_selected: selection.default_selected === true || selection.defaultSelected === true,
    locked_after: cleanText(selection.locked_after || selection.lockedAfter),
    ...selection
  };
}

function normalizeVariationSelection(value: unknown) {
  const selection = asObject(value);
  const selectableBy = asArray(selection.selectable_by || selection.selectableBy)
    .map(cleanText)
    .filter((actor) => ["internal", "customer", "system"].includes(actor));
  return {
    selected_variation_id: cleanText(selection.selected_variation_id || selection.selectedVariationId || selection.default_variation_id || selection.defaultVariationId),
    selected_by: cleanText(selection.selected_by || selection.selectedBy),
    selectable_by: selectableBy,
    required: selection.required === true,
    default_variation_id: cleanText(selection.default_variation_id || selection.defaultVariationId),
    ...selection
  };
}

function normalizeVariation(value: unknown, index = 0) {
  const variation = asObject(value);
  return {
    ...variation,
    id: cleanText(variation.id) || `variation_${index + 1}`,
    label: cleanText(variation.label || variation.name || variation.id || `Variation ${index + 1}`),
    name: cleanText(variation.name || variation.label),
    overrides: asObject(variation.overrides)
  };
}

export function normalizeScopeItem(value: unknown, index = 0): JsonObject {
  const item = asObject(value);
  const id = cleanText(item.id) || scopeId();
  const children = asArray(item.children).map((child, childIndex) => normalizeScopeItem(child, childIndex));
  const basePrice = item.base_price ?? item.basePrice ?? item.unit_price ?? item.unitPrice ?? item.amount ?? 0;
  const quantity = item.quantity ?? 1;
  return {
    ...item,
    id,
    type: cleanText(item.type || "scope_item") || "scope_item",
    name: cleanText(item.name || item.label || `Scope Item ${index + 1}`) || `Scope Item ${index + 1}`,
    display_name: cleanText(item.display_name || item.displayName || item.name || item.label),
    description: cleanText(item.description),
    unit: cleanText(item.unit || "ea") || "ea",
    quantity,
    base_price: basePrice,
    unit_price: item.unit_price ?? item.unitPrice ?? basePrice,
    included: item.included === true,
    price_driving: item.price_driving !== false && item.priceDriving !== false,
    variables: asObject(item.variables),
    measurements: asObject(item.measurements),
    formula: cleanText(item.formula),
    formula_config: asObject(item.formula_config || item.formulaConfig),
    media_refs: asArray(item.media_refs || item.mediaRefs || item.images).map(asObject),
    selection: normalizeSelection(item.selection, item.selected !== false),
    variation_selection: normalizeVariationSelection(item.variation_selection || item.variationSelection),
    variations: asArray(item.variations).map(normalizeVariation),
    selection_groups: asArray(item.selection_groups || item.selectionGroups).map(asObject),
    children
  };
}

export function normalizeProposalScope(value: unknown): JsonObject {
  const scope = asObject(value);
  return {
    ...scope,
    schema_version: Number(scope.schema_version || 1) || 1,
    root_items: asArray(scope.root_items || scope.rootItems || scope.items).map((item, index) => normalizeScopeItem(item, index)),
    variables: asObject(scope.variables),
    measurements: asObject(scope.measurements),
    selection_state: asObject(scope.selection_state || scope.selectionState)
  };
}

function scopePieceTemplateId(value: unknown) {
  const piece = asObject(value);
  return cleanText(piece.template_id || piece.templateId || piece.scope_template_id || piece.type);
}

function scopeItemPieceId(value: unknown) {
  const item = asObject(value);
  return cleanText(item.scope_piece_id || item.scopePieceId || item.piece_id || item.pieceId);
}

/**
 * Freezes the part of the scope consumed by downstream production systems onto
 * each proposal piece. This keeps material generation deterministic even when a
 * proposal contains multiple scope templates or the live price book changes.
 */
export function enrichedProposalScopePieces(scopeValue: unknown): JsonObject[] {
  const scope = normalizeProposalScope(scopeValue);
  const roots = asArray(scope.root_items).map((item, index) => normalizeScopeItem(item, index));
  const pieces = asArray(scope.pieces || scope.scope_pieces).map(asObject);
  const scopeMeasurements = asObject(scope.measurements);
  return pieces.map((piece, index) => {
    const pieceId = cleanText(piece.id || piece.pieceId || piece.scope_piece_id) || `scope_piece_${index + 1}`;
    const templateId = scopePieceTemplateId(piece);
    const explicitRoots = asArray(piece.root_items || piece.rootItems).map((item, rootIndex) => normalizeScopeItem(item, rootIndex));
    const requestedRootIds = new Set(asArray(piece.root_item_ids || piece.rootItemIds).map(cleanText).filter(Boolean));
    let matchedRoots = roots.filter((root) => scopeItemPieceId(root) === pieceId || requestedRootIds.has(cleanText(root.id)));
    if (!matchedRoots.length && templateId) {
      matchedRoots = roots.filter((root) => scopePieceTemplateId(root) === templateId);
    }
    if (!matchedRoots.length && pieces.length === 1) matchedRoots = roots;
    const pieceMeasurements = asObject(piece.measurements);
    return {
      ...piece,
      id: pieceId,
      template_id: templateId,
      root_items: matchedRoots.length ? matchedRoots : explicitRoots,
      // Empty piece measurements commonly come from a scope created before a
      // salesperson typed measurements manually. Preserve real per-piece data,
      // but otherwise inherit the proposal/scope measurements.
      measurements: measurementsHaveValues(pieceMeasurements)
        ? { ...scopeMeasurements, ...pieceMeasurements }
        : { ...pieceMeasurements, ...scopeMeasurements }
    };
  });
}

export function proposalScopeWithEnrichedPieces(scopeValue: unknown): JsonObject {
  const scope = normalizeProposalScope(scopeValue);
  const pieces = enrichedProposalScopePieces(scope);
  return pieces.length ? { ...scope, pieces } : scope;
}

function selectedVariation(item: JsonObject) {
  const selection = asObject(item.variation_selection);
  const selectedId = cleanText(selection.selected_variation_id || selection.selectedVariationId || selection.default_variation_id || selection.defaultVariationId);
  if (!selectedId) return null;
  return asArray(item.variations).map(asObject).find((variation) => cleanText(variation.id) === selectedId) || null;
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

export function resolveScopeItemVariation(itemValue: unknown): JsonObject {
  const item = normalizeScopeItem(itemValue);
  const variation = selectedVariation(item);
  if (!variation) return item;
  const overrides = asObject(variation.overrides);
  const resolved = deepMerge(item, overrides) as JsonObject;
  resolved.id = item.id;
  resolved.selected_variation_id = cleanText(variation.id);
  resolved.selected_variation_label = cleanText(variation.label || variation.name);
  resolved.children = item.children;
  resolved.variations = item.variations;
  resolved.variation_selection = item.variation_selection;
  return normalizeScopeItem(resolved);
}

export function scopeItemSelected(itemValue: unknown): boolean {
  const item = asObject(itemValue);
  const selection = asObject(item.selection);
  const mode = cleanText(selection.mode || "fixed");
  if (mode === "fixed" || !mode) return true;
  return selection.selected === true;
}

function ownScopeItemAmountCents(itemValue: unknown): number {
  const item = resolveScopeItemVariation(itemValue);
  // "Included" hides the line's separate price in the customer document; it
  // still contributes to the package total, as it does in the proposal editor.
  // Non-chargeable items explicitly opt out with price_driving: false.
  if (!scopeItemSelected(item) || item.price_driving === false) return 0;
  const explicit = moneyCents(item.amount ?? item.total ?? item.total_price ?? item.totalPrice);
  if (explicit > 0) return explicit;
  const quantity = numberValue(item.quantity, 1);
  const unitPrice = moneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice);
  return Math.round(Math.max(0, quantity) * unitPrice);
}

export function scopeItemPriceResult(itemValue: unknown): ScopePriceResult {
  const item = normalizeScopeItem(itemValue);
  const selected = scopeItemSelected(item);
  if (!selected) return { amount_cents: 0, own_amount_cents: 0, children_amount_cents: 0, selected: false };
  const own = ownScopeItemAmountCents(item);
  const children = asArray(item.children).reduce<number>((sum, child) => sum + scopeItemPriceResult(child).amount_cents, 0);
  return {
    amount_cents: own + children,
    own_amount_cents: own,
    children_amount_cents: children,
    selected
  };
}

export function proposalScopeTotalCents(scopeValue: unknown): number {
  const scope = normalizeProposalScope(scopeValue);
  return asArray(scope.root_items).reduce<number>((sum, item) => sum + scopeItemPriceResult(item).amount_cents, 0);
}

export function walkScopeItems(scopeOrItems: unknown, visitor: (item: JsonObject, path: string[]) => void) {
  const items = Array.isArray(scopeOrItems)
    ? scopeOrItems
    : asArray(asObject(scopeOrItems).root_items || asObject(scopeOrItems).children);
  const visit = (itemValue: unknown, path: string[]) => {
    const item = normalizeScopeItem(itemValue);
    visitor(item, path);
    asArray(item.children).forEach((child, index) => visit(child, [...path, cleanText(item.id) || String(index)]));
  };
  items.forEach((item, index) => visit(item, [String(index)]));
}

export function findScopeItem(scopeValue: unknown, itemId: string): JsonObject | null {
  const needle = cleanText(itemId);
  if (!needle || needle === "root") return null;
  let found: JsonObject | null = null;
  walkScopeItems(normalizeProposalScope(scopeValue), (item) => {
    if (!found && cleanText(item.id) === needle) found = item;
  });
  return found;
}

function scopeChildrenForRoot(scope: JsonObject, rootItemId: string) {
  if (!rootItemId || rootItemId === "root") return asArray(scope.root_items).map((item, index) => normalizeScopeItem(item, index));
  const root = findScopeItem(scope, rootItemId);
  return root ? [root] : [];
}

export function scopeItemsForView(scopeValue: unknown, viewValue: unknown): JsonObject[] {
  const scope = normalizeProposalScope(scopeValue);
  const view = asObject(viewValue);
  const rootId = cleanText(view.root_item_id || view.rootItemId || view.scope_root_id || view.scopeRootId || "root") || "root";
  const renderDepth = Math.max(0, Math.round(Number(view.render_depth ?? view.renderDepth ?? 1) || 1));
  const showIncluded = view.show_included_items !== false && view.showIncludedItems !== false;
  const showUnselected = view.show_unselected_options === true || view.showUnselectedOptions === true;
  const rows: JsonObject[] = [];
  const add = (itemValue: unknown, depth: number) => {
    const item = resolveScopeItemVariation(itemValue);
    const selected = scopeItemSelected(item);
    if ((selected || showUnselected) && (showIncluded || item.included !== true)) {
      rows.push({
        ...item,
        depth,
        selected,
        amount_cents: scopeItemPriceResult(item).amount_cents,
        own_amount_cents: scopeItemPriceResult(item).own_amount_cents
      });
    }
    if (depth >= renderDepth) return;
    asArray(item.children).forEach((child) => add(child, depth + 1));
  };
  scopeChildrenForRoot(scope, rootId).forEach((item) => add(item, 0));
  return rows;
}

export function publicScopeLineItems(scopeValue: unknown, viewValue: unknown): JsonObject[] {
  return scopeItemsForView(scopeValue, viewValue).map((item) => ({
    id: cleanText(item.id),
    label: cleanText(item.display_name || item.name || "Line item"),
    description: cleanText(item.description),
    depth: Number(item.depth || 0),
    selected: item.selected !== false,
    included: item.included === true,
    quantity: cleanText(item.quantity || "1"),
    unit: cleanText(item.unit),
    unit_price: moneyDisplay(moneyCents(item.unit_price ?? item.unitPrice ?? item.base_price ?? item.basePrice)),
    amount: moneyDisplay(Number(item.amount_cents || 0)),
    media_refs: asArray(item.media_refs).map(asObject),
    selected_variation_id: cleanText(item.selected_variation_id)
  }));
}
