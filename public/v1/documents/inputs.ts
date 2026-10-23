import type { JsonObject } from "../platform/storage.js";
import { scopeItemPriceResult } from "../proposals/scope.js";
import { FMDocModel } from "./schemas.js";

/**
 * Bound inputs: values a document shows that come from its own data and can
 * be typed into where they appear (docs/architecture/document-as-sent-editing.md).
 *
 * FMDocModel.resolveBindings(..., { trace: true }) says where each bound value
 * comes from (binding.path) and gives a first kind from the path's root:
 * params.* is "input", computed.* "derived", project/customer/org/doc
 * "upstream". This file refines params.* paths: projections the resolver
 * builds (scope_rows, ...) and fields a data rule computes are "derived", and
 * a rule may say how a typed value is stored (a line's amount is stored as
 * its unit price). Rules are registered per kind of data, not per template,
 * so any document that shows the same data gets the same behavior.
 */

type Binding = JsonObject & { path?: string | null; kind?: string; value?: unknown; format?: string | null };

export type DocumentInputRule = {
  id: string;
  /** Does this rule own the path (segments after "params")? */
  matches(segments: Array<string | number>, params: JsonObject): boolean;
  /** "input" | "derived" for an owned path; null leaves the default. */
  classify(segments: Array<string | number>, params: JsonObject): "input" | "derived" | null;
  /** Store a parsed value; return false to fall back to a plain set. */
  apply?(params: JsonObject, segments: Array<string | number>, value: unknown): boolean;
};

const rules: DocumentInputRule[] = [];

export function registerDocumentInputRule(rule: DocumentInputRule) {
  const index = rules.findIndex(existing => existing.id === rule.id);
  if (index >= 0) rules[index] = rule;
  else rules.push(rule);
}

/** Params the resolver computes on every resolution; never stored inputs. */
export const RESOLUTION_ONLY_PARAMS = new Set([
  "scope_rows", "line_rows", "conditional_rows", "line_conditional_rows", "scope_packages",
  "pricing_rows", "pricing_conditional_rows", "spec_derived", "__sources", "account", "measurement_requirements"
]);

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function segmentsOf(path: string): Array<string | number> {
  return String(path || "").split(".").filter(Boolean).map(part => (/^\d+$/.test(part) ? Number(part) : part));
}

function ruleFor(segments: Array<string | number>, params: JsonObject) {
  return rules.find(rule => rule.matches(segments, params)) || null;
}

/** The kind of a params.* path: "input" when a person may type into it here. */
export function documentInputKind(path: string, documentValue: JsonObject): "input" | "derived" {
  const segments = segmentsOf(path);
  if (segments[0] !== "params" || segments.length < 2) return "derived";
  const rest = segments.slice(1);
  const key = String(rest[0]);
  if (RESOLUTION_ONLY_PARAMS.has(key)) return "derived";
  const params = asObject(documentValue.params);
  const declared = Object.prototype.hasOwnProperty.call(params, key) || Object.prototype.hasOwnProperty.call(asObject(documentValue.param_defs), key);
  if (!declared) return "derived";
  const rule = ruleFor(rest, params);
  const ruled = rule ? rule.classify(rest, params) : null;
  if (ruled) return ruled;
  // A value inside stored data that is not there yet (an empty optional
  // description) is still typed into its own place.
  return "input";
}

/**
 * Refine traced bindings in a resolved definition (in place). Every run with
 * binding.kind "input" is re-checked against the document's stored data and
 * the registered rules.
 */
export function classifyTracedBindings(resolvedDefinition: JsonObject, documentValue: JsonObject) {
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as JsonObject;
    if (Array.isArray(value.runs)) {
      for (const run of value.runs) {
        const binding = asObject(asObject(run).binding) as Binding;
        if (binding.kind === "input" && binding.path) binding.kind = documentInputKind(String(binding.path), documentValue);
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(resolvedDefinition);
}

/** Every traced binding in a resolved definition, first occurrence per path. */
export function tracedBindings(resolvedDefinition: JsonObject): Map<string, Binding> {
  const found = new Map<string, Binding>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const value = node as JsonObject;
    if (Array.isArray(value.runs)) {
      for (const run of value.runs) {
        const binding = asObject(asObject(run).binding) as Binding;
        const path = String(binding.path || "");
        if (!path || binding.kind === "pinned") continue;
        const existing = found.get(path);
        if (!existing || (existing.kind !== "input" && binding.kind === "input")) found.set(path, binding);
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === "object") visit(child);
  };
  visit(resolvedDefinition);
  return found;
}

/** Store one parsed value at a params.* path, through its rule when one owns it. */
export function applyDocumentInput(params: JsonObject, path: string, value: unknown) {
  const rest = segmentsOf(path).slice(1);
  if (!rest.length) return;
  const rule = ruleFor(rest, params);
  if (rule?.apply && rule.apply(params, rest, value)) return;
  FMDocModel.setPath(params, rest, value);
}

/** Top-level params keys a set of paths writes. */
export function touchedParamKeys(paths: string[]) {
  return [...new Set(paths.map(path => String(segmentsOf(path)[1] ?? "")).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Line items (scope_items, line_items, option slots, proposal_options[n].items,
// pricing_adjustments). The pricing engine (service.ts enrichScopeRow /
// enrichConditionalRows) computes amount_cents and unit_price_cents; a line's
// own inputs are its quantity, unit price and text. A typed amount is stored
// as the line's unit price (amount / quantity), or as an explicit amount when
// no unit price in cents gives that amount exactly. A group line's amount is
// the sum of its lines and stays derived.
// ---------------------------------------------------------------------------

const LINE_LIST_KEYS = new Set(["scope_items", "line_items", "pricing_adjustments", "option_a_items", "option_b_items", "option_c_items"]);
const LINE_DERIVED_FIELDS = new Set(["selected", "show_amount", "variant", "depth", "indent_label", "condition_met", "included", "source_path", "id", "children", "rows", "conditional_rows", "total_cents", "price_cents", "selected_variation_id", "selected_variation_label",
  // Written from the variants chosen for the line (doc-workflow, presentation choices).
  "variant_summary", "selected_variants"]);

/** [listPrefix, rowPath, field] for a path into a line list, or null. */
function lineRowPath(segments: Array<string | number>): { row: Array<string | number>; field: string } | null {
  let at = 0;
  if (LINE_LIST_KEYS.has(String(segments[0]))) at = 1;
  else if (segments[0] === "proposal_options" && typeof segments[1] === "number" && segments[2] === "items") at = 3;
  else return null;
  if (typeof segments[at] !== "number") return null;
  let end = at + 1;
  while (segments[end] === "children" && typeof segments[end + 1] === "number") end += 2;
  if (end !== segments.length - 1) return null;
  return { row: segments.slice(0, end), field: String(segments[end]) };
}

function hasChildLines(row: JsonObject) {
  return Array.isArray(row.children) && row.children.some(child => child && typeof child === "object");
}

registerDocumentInputRule({
  id: "documents.line_items",
  matches: segments => lineRowPath(segments) !== null,
  classify(segments, params) {
    const located = lineRowPath(segments);
    if (!located) return null;
    const row = asObject(FMDocModel.getPath(params, located.row));
    if (!Object.keys(row).length) return "derived";
    if (LINE_DERIVED_FIELDS.has(located.field)) return "derived";
    if (located.field === "amount_cents" || located.field === "unit_price_cents") {
      if (row.price_driving === false || asObject(row.pricing).formula) return "derived";
      if (located.field === "amount_cents" && hasChildLines(row)) return "derived";
    }
    return "input";
  },
  apply(params, segments, value) {
    const located = lineRowPath(segments);
    if (!located) return false;
    const row = FMDocModel.getPath(params, located.row) as JsonObject | undefined;
    if (!row || typeof row !== "object") return false;
    const clearExplicit = () => { for (const key of ["amount", "total", "total_price", "totalPrice", "amount_cents"]) delete row[key]; };
    if (located.field === "quantity") {
      row.quantity = Math.max(0, Number(value) || 0);
      // A typed amount stood in for an inexact unit price; quantity × unit
      // price takes over again once the quantity changes.
      if (Number(row.unit_price ?? row.unitPrice ?? row.base_price ?? row.basePrice) > 0) clearExplicit();
      return true;
    }
    if (located.field === "unit_price_cents") {
      const cents = Math.round(Number(value) || 0);
      clearExplicit();
      delete row.unitPrice; delete row.base_price; delete row.basePrice;
      row.unit_price = cents / 100;
      return true;
    }
    if (located.field === "amount_cents") {
      const cents = Math.round(Number(value) || 0);
      const quantity = Math.max(0, Number(row.quantity ?? 1) || 0);
      clearExplicit();
      delete row.unitPrice; delete row.base_price; delete row.basePrice;
      if (cents < 0) {
        // Discount lines: the engine honors an explicit negative amount.
        row.unit_price = 0;
        row.amount_cents = cents;
        return true;
      }
      row.unit_price = quantity > 0 ? Math.round((cents / quantity)) / 100 : cents / 100;
      if (quantity <= 0 || scopeItemPriceResult(row).own_amount_cents !== cents) {
        // No whole-cent unit price gives this amount (or the line has a
        // variation price): keep the typed amount explicitly.
        row.unit_price = quantity > 0 ? cents / quantity / 100 : 0;
        row.amount = cents / 100;
      }
      return true;
    }
    return false;
  }
});
