import type { JsonObject } from "../../platform/storage.js";
import { registerDocumentWidgetResolver, type WidgetResolveContext } from "../widgets/registry.js";

/**
 * Server halves of the widgets a presentation slide mounts. They read the
 * presentation's evaluated, customer-safe state (placed on the resolve context
 * by presentation-service) and return null anywhere else, so one dropped onto
 * an ordinary document degrades to its placeholder.
 */
export const PRESENTATION_WIDGETS = ["doc.price_display", "doc.choice_selection", "doc.selection_review"] as const;
export const PRESENTATION_STATE_KEY = "__presentation";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const list = (value: unknown): JsonObject[] => Array.isArray(value) ? value.map(object) : [];
function presented(ctx: WidgetResolveContext) {
  const state = object(ctx.params[PRESENTATION_STATE_KEY]);
  return Object.keys(object(state.pricing)).length ? { pricing: object(state.pricing), offered: object(state.offered), inputs: object(state.inputs), targets: object(state.targets), writable: state.writable === true } : null;
}
/** The key a choice is known by everywhere: evidence, review jump-backs and widget config. */
export function choiceKey(config: JsonObject) {
  const kind = text(config.kind) || (config.dimension_id ? "variant" : config.group_id ? "group" : "optional");
  return kind === "group" ? `group:${text(config.group_id)}` : kind === "variant" ? `variant:${text(config.item_id)}:${text(config.dimension_id)}` : `optional:${text(config.item_id)}`;
}

let registered = false;
export function registerPresentationWidgetResolvers() {
  if (registered) return;
  registered = true;
  // config: { of: "total" | "subtotal" | "tax" | "deposit" | "line" | "group", line_id?, group_id?, label? }
  registerDocumentWidgetResolver("doc.price_display", async (ctx, config) => {
    const state = presented(ctx);
    if (!state) return null;
    const of = text(config.of) || "total", totals = object(state.pricing.totals);
    let amount: unknown = null, label = text(config.label);
    if (of === "line") { const row = list(state.pricing.rows).find(entry => text(entry.id) === text(config.line_id)); amount = row?.amount_cents ?? null; label ||= text(row?.display_name || row?.name); }
    else if (of === "group") { const group = list(state.offered.groups).find(entry => text(entry.id) === text(config.group_id)); const chosen = list(group?.options).find(entry => entry.selected === true); amount = chosen?.price_cents ?? null; label ||= text(group?.label); }
    else if (of === "deposit") amount = list(state.pricing.schedule).find(entry => entry.due_rule === "on_signature" || entry.payment_kind === "deposit")?.amount_cents ?? null;
    else amount = totals[`${of}_cents`] ?? null;
    return amount === null || amount === undefined ? null : { of, label, amount_cents: amount, currency: text(state.pricing.currency) || "USD" };
  }, { title: "Price", category: "data" });
  // config: { kind: "group", group_id } | { kind: "optional", item_id } | { kind: "variant", item_id, dimension_id }
  registerDocumentWidgetResolver("doc.choice_selection", async (ctx, config) => {
    const state = presented(ctx);
    if (!state) return null;
    const key = choiceKey(config), kind = key.split(":")[0]!;
    const base = { kind, key, writable: state.writable, total_cents: object(state.pricing.totals).total_cents ?? null };
    if (kind === "group") { const group = list(state.offered.groups).find(entry => text(entry.id) === text(config.group_id)); return group ? { ...base, input: text(state.inputs.scope_selections), group } : null; }
    if (kind === "optional") { const option = list(state.offered.optional).find(entry => text(entry.id) === text(config.item_id)); return option ? { ...base, input: text(state.inputs.scope_selections), option } : null; }
    const line = list(state.offered.variants).find(entry => text(entry.item_id) === text(config.item_id));
    const dimension = list(line?.dimensions).find(entry => text(entry.id) === text(config.dimension_id));
    return line && dimension ? { ...base, input: text(state.inputs.variant), item_id: line.item_id, name: line.name, dimension } : null;
  }, { title: "Choice", category: "input" });
  // Every choice with what is chosen now, and the slide that changes it.
  registerDocumentWidgetResolver("doc.selection_review", async ctx => {
    const state = presented(ctx);
    if (!state) return null;
    const target = (key: string) => state.targets[key] || null;
    return {
      writable: state.writable, totals: state.pricing.totals, schedule: state.pricing.schedule || [],
      groups: list(state.offered.groups).map(group => ({ key: `group:${group.id}`, id: group.id, label: group.label, chosen: list(group.options).find(entry => entry.selected === true) || null, options: list(group.options).length, target: target(`group:${group.id}`) })),
      optional: list(state.offered.optional).map(option => ({ key: `optional:${option.id}`, ...option, target: target(`optional:${option.id}`) })),
      variants: list(state.offered.variants).flatMap(line => list(line.dimensions).map(dimension => ({ key: `variant:${line.item_id}:${dimension.id}`, item_id: line.item_id, name: line.name, dimension_id: dimension.id, label: dimension.label, chosen: list(dimension.values).find(entry => entry.selected === true) || null, target: target(`variant:${line.item_id}:${dimension.id}`) })))
    };
  }, { title: "Review choices", category: "data" });
}
