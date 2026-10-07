import { badRequest } from "../../platform/errors.js";
import type { JsonObject } from "../../platform/storage.js";
import { scopeItemPriceResult } from "../../proposals/scope.js";

/**
 * Choices a presentation accepts over a scope-items tree. Selection picks keep
 * the shape documents already record as outputs.selections, so the existing
 * write-through (applyScopeSelections) applies them. Variant picks have no
 * server writer elsewhere: applyVariantChoices mirrors the line-items editor
 * (doc-workflow applyVariants) and must change with it.
 */
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const invalid = (message: string) => badRequest("presentation_choice_invalid", message);

export type ScopeChoices = { selections: Record<string, string | boolean>; variants: Record<string, Record<string, string>> };
export function normalizeChoices(value: unknown): ScopeChoices {
  const raw = object(value);
  return { selections: { ...object(raw.selections) } as ScopeChoices["selections"], variants: Object.fromEntries(Object.entries(object(raw.variants)).map(([id, picks]) => [id, { ...object(picks) } as Record<string, string>])) };
}

function walk(items: unknown, visit: (item: JsonObject) => void) {
  for (const value of list(items)) { const item = object(value); visit(item); walk(item.children, visit); }
}
function find(items: unknown, id: string): JsonObject | null {
  let found: JsonObject | null = null;
  walk(items, item => { if (!found && text(item.id) === id) found = item; });
  return found;
}
/**
 * What a presentation offers: every alternative and optional line on the
 * estimate. Putting an option on the estimate is the decision to show it;
 * there is no second flag to remember.
 */
const offeredTo = (_item: JsonObject) => true;
const dimensionsOf = (item: JsonObject) => list(item.variant_dimensions).map(object).filter(dimension => text(dimension.id) && list(dimension.values).length);
const valueIds = (dimension: JsonObject) => list(dimension.values).map(value => text(object(value).id));
function offeredValues(item: JsonObject, dimension: JsonObject) {
  // A dimension left off the proposal offers nothing.
  if (object(item.variant_omitted)[text(dimension.id)] === true) return [];
  const listed = object(item.variant_offered)[text(dimension.id)];
  return Array.isArray(listed) ? listed.map(text) : valueIds(dimension);
}
function excludedValues(item: JsonObject, dimension: JsonObject, selected: JsonObject) {
  const out = new Set<string>();
  for (const other of dimensionsOf(item)) {
    if (other.id === dimension.id) continue;
    const chosen = list(other.values).map(object).find(value => text(value.id) === text(selected[text(other.id)]));
    list(object(object(chosen).excludes)[text(dimension.id)]).forEach(id => out.add(text(id)));
  }
  return out;
}

/** One pick: { group_id, item_id } within a choice group, or { item_id, selected } for an optional line. */
export function selectionChoice(items: unknown, value: unknown): Record<string, string | boolean> {
  const pick = object(value), itemId = text(pick.item_id);
  const item = itemId ? find(items, itemId) : null;
  if (!item || !offeredTo(item)) throw invalid("That option is not offered in this presentation.");
  const selection = object(item.selection), mode = text(selection.mode), groupId = text(selection.group_id);
  if (mode === "choice" && groupId) {
    if (pick.group_id !== undefined && text(pick.group_id) !== groupId) throw invalid("That option belongs to another group.");
    if (pick.selected === false) throw invalid("Pick another option in the group instead of clearing it.");
    return { [groupId]: itemId };
  }
  if (mode === "optional") {
    if (typeof pick.selected !== "boolean") throw invalid("Optional lines take selected: true or false.");
    return { [itemId]: pick.selected };
  }
  throw invalid("That line is not a choice.");
}

/** One pick: { item_id, dimension_id, value_id }. Only offered, compatible values. */
export function variantChoice(items: unknown, variants: ScopeChoices["variants"], value: unknown): { itemId: string; dimensionId: string; valueId: string } {
  const pick = object(value), itemId = text(pick.item_id), dimensionId = text(pick.dimension_id), valueId = text(pick.value_id);
  const item = itemId ? find(items, itemId) : null;
  const dimension = item ? dimensionsOf(item).find(entry => text(entry.id) === dimensionId) : undefined;
  if (!item || !dimension || !valueIds(dimension).includes(valueId)) throw invalid("That variant is not available on this line.");
  if (!offeredValues(item, dimension).includes(valueId)) throw invalid("That variant is not offered in this presentation.");
  const selected = { ...object(item.selected_variants), ...object(variants[itemId]) };
  if (excludedValues(item, dimension, selected).has(valueId)) throw invalid("That variant cannot be combined with the current selection.");
  return { itemId, dimensionId, valueId };
}

/** Apply stored variant picks: keep every dimension legal, then reprice the line. */
export function applyVariantChoices(items: unknown[], variants: ScopeChoices["variants"]): unknown[] {
  const apply = (value: unknown): unknown => {
    const item = { ...object(value) };
    if (Array.isArray(item.children) && item.children.length) item.children = item.children.map(apply);
    const picks = object(variants[text(item.id)]);
    const dimensions = dimensionsOf(item);
    if (!Object.keys(picks).length || !dimensions.length) return item;
    const selected: JsonObject = { ...object(item.selected_variants) };
    for (const dimension of dimensions) {
      const id = text(dimension.id);
      if (picks[id] !== undefined && valueIds(dimension).includes(text(picks[id])) && offeredValues(item, dimension).includes(text(picks[id]))) selected[id] = text(picks[id]);
    }
    for (const dimension of dimensions) {
      const id = text(dimension.id), ids = valueIds(dimension), excluded = excludedValues(item, dimension, selected), offered = offeredValues(item, dimension);
      const allowed = ids.filter(entry => !excluded.has(entry));
      // "" is a real answer: no default until someone picks one.
      if (object(item.variant_omitted)[id] === true) selected[id] = "";
      else if (selected[id] === "") continue;
      else if (!allowed.includes(text(selected[id]))) selected[id] = allowed.find(entry => offered.includes(entry)) || allowed[0] || ids[0];
    }
    const chosen = (dimension: JsonObject) => object(list(dimension.values).map(object).find(entry => text(entry.id) === text(selected[text(dimension.id)])));
    item.selected_variants = selected;
    let price = Number(item.variant_base_price);
    if (item.variant_base_price !== undefined && item.variant_base_price !== null && Number.isFinite(price)) {
      for (const dimension of dimensions) {
        const adjustment = object(chosen(dimension).adjustment);
        if (adjustment.operation === "add") price += Number(adjustment.value) || 0;
        else if (adjustment.operation === "multiply") price *= Number(adjustment.value) || 1;
      }
      item.unit_price = Math.round(price * 100) / 100;
    }
    item.variant_summary = dimensions.map(dimension => text(chosen(dimension).label)).filter(Boolean).join(" · ");
    item.variables = { ...object(item.variables), ...selected };
    return item;
  };
  return items.map(apply);
}

/** The contract carries the outcome: its lines are no longer open to customer choice. */
export function lockChoices(items: unknown[]): unknown[] {
  return items.map(value => {
    const item = { ...object(value) };
    if (Array.isArray(item.children)) item.children = lockChoices(item.children);
    const selection = object(item.selection);
    if (Array.isArray(selection.selectable_by)) item.selection = { ...selection, selectable_by: selection.selectable_by.filter(actor => text(actor) !== "customer") };
    return item;
  });
}

const ROW_FIELDS = ["id", "name", "display_name", "description", "quantity", "unit", "unit_price_cents", "amount_cents", "depth", "variant", "show_amount", "included", "selected", "badge", "discount", "condition_met", "variant_summary", "selected_variants"] as const;
/** Customer-safe projection of a priced row: never costs, notes or price book snapshots. */
export function publicRow(value: unknown): JsonObject {
  const row = object(value), out: JsonObject = {};
  for (const field of ROW_FIELDS) if (row[field] !== undefined && row[field] !== null) out[field] = row[field];
  const selection = object(row.selection);
  if (text(selection.mode)) out.selection = { mode: text(selection.mode), ...(text(selection.group_id) ? { group_id: text(selection.group_id) } : {}) };
  return out;
}

export type OfferedAlternative = { path: string; choices: ScopeChoices };
/** Everything the viewer may change, plus the choice state each alternative would produce. */
export function offeredChoices(items: unknown[], choices: ScopeChoices) {
  const groups = new Map<string, JsonObject>(), optional: JsonObject[] = [], variants: JsonObject[] = [], alternatives: OfferedAlternative[] = [];
  // price_cents: what the line costs when chosen, by the proposal pricing math.
  // The color a line is offered in, for drawing it when it has no photo.
  const colorHex = (item: JsonObject) => {
    const color = dimensionsOf(item).find(dimension => text(dimension.kind) === "color" || /colou?r/i.test(text(dimension.id)));
    if (!color) return "";
    const values = list(color.values).map(object), chosen = text(object(item.selected_variants)[text(color.id)]);
    return text(object(values.find(value => text(value.id) === chosen) || values[0]).hex);
  };
  const line = (item: JsonObject) => ({ id: text(item.id), ...(colorHex(item) ? { color_hex: colorHex(item) } : {}), name: text(item.display_name || item.name), title: text(item.display_name || item.name), description: text(item.external_description || item.description), quantity: item.quantity ?? 1, unit: text(item.unit),
    price_cents: scopeItemPriceResult({ ...item, selection: { ...object(item.selection), selected: true } }).amount_cents, media_refs: list(item.media_refs).map(object), ...(text(item.image_url) ? { image_url: text(item.image_url) } : {}), offered: true });
  const withSelection = (patch: Record<string, string | boolean>): ScopeChoices => ({ selections: { ...choices.selections, ...patch }, variants: choices.variants });
  walk(items, item => {
    const selection = object(item.selection), mode = text(selection.mode), id = text(item.id);
    if (!id) return;
    if (offeredTo(item) && mode === "choice" && text(selection.group_id)) {
      const groupId = text(selection.group_id);
      const group = groups.get(groupId) || { id: groupId, label: text(selection.group_title) || groupId, selected: null, options: [] };
      if (selection.selected === true) group.selected = id;
      (group.options as JsonObject[]).push({ ...line(item), selected: selection.selected === true });
      groups.set(groupId, group);
      if (selection.selected !== true) alternatives.push({ path: `group:${groupId}:${id}`, choices: withSelection({ [groupId]: id }) });
    } else if (offeredTo(item) && mode === "optional") {
      optional.push({ ...line(item), selected: selection.selected === true });
      alternatives.push({ path: `optional:${id}`, choices: withSelection({ [id]: selection.selected !== true }) });
    }
    // A deselected line's variants cannot change the price until it is chosen.
    if (mode && mode !== "fixed" && selection.selected !== true) return;
    const dimensions = dimensionsOf(item).map(dimension => {
      const dimensionId = text(dimension.id), selected = text(object(item.selected_variants)[dimensionId]);
      const offered = offeredValues(item, dimension), excluded = excludedValues(item, dimension, object(item.selected_variants));
      const values = list(dimension.values).map(object).filter(entry => offered.includes(text(entry.id))).map(entry => {
        const valueId = text(entry.id), available = !excluded.has(valueId);
        if (available && valueId !== selected) alternatives.push({ path: `variant:${id}:${dimensionId}:${valueId}`, choices: { selections: choices.selections, variants: { ...choices.variants, [id]: { ...object(choices.variants[id]) as Record<string, string>, [dimensionId]: valueId } } } });
        return { id: valueId, label: text(entry.label) || valueId, ...(text(entry.hex) ? { hex: text(entry.hex) } : {}), available, selected: valueId === selected };
      });
      return { id: dimensionId, label: text(dimension.label) || dimensionId, kind: text(dimension.kind) || "option", selected, values };
    }).filter(dimension => dimension.values.length > 1);
    if (dimensions.length) variants.push({ item_id: id, name: text(item.display_name || item.name), dimensions });
  });
  return { offered: { groups: [...groups.values()].filter(group => (group.options as unknown[]).length > 1), optional, variants }, alternatives };
}
