import type { JsonObject } from "../platform/storage.js";
import { lineItemStyles, startFlowTemplate } from "./seeds.js";
import { addFlowPage, componentColumn, componentRow, flowBlocks, flowColumn, flowComponent, flowImage, flowLogo, flowRepeater, flowRow, flowSpacer, flowText, labeledText, type RunSpec } from "./template-kit.js";

/**
 * Documents a project sends about its materials rather than to its customer: the
 * purchase order a supplier fills, and the shopping list someone takes to pick the
 * materials up. The Materials order window writes their params (materials/ordering.ts);
 * an organization can change how either is written by editing its copy of the template.
 */

const BODY_FONT = { family: "var(--fm-body-font)", size_pt: 10, color: "var(--fm-text)" };
const MUTED_FONT = { family: "var(--fm-body-font)", size_pt: 9, color: "var(--fm-color-muted)" };
const TITLE_FONT = { family: "var(--fm-display-font)", size_pt: 22, weight: 800, color: "var(--fm-text)" };
const PANEL_FILL = "color-mix(in srgb, var(--fm-primary) 6%, var(--fm-color-paper))";
const MONEY_WIDTH = 74;

export const PURCHASE_ORDER_DEFAULT_TERMS = "Please confirm this order, its prices and the delivery appointment before you ship it. Put the PO number on every packing slip and invoice. Do not substitute a product, color or quantity without our approval.";
export const SHOPPING_LIST_DEFAULT_NOTES = "Check off each item as you load it. Ask the counter for anything that is missing before you leave.";

function when(node: JsonObject, condition: string): JsonObject {
  node.bind = { ...(node.bind as JsonObject | undefined), if: condition };
  return node;
}

function header(label: string, align: string, size: { w?: number; grow?: number }) {
  return flowText([{ text: label }], { align, font: { family: "var(--fm-body-font)", size_pt: 8, weight: 800, color: "#ffffff", transform: "uppercase" }, ...size });
}

/** A party's name over its address and contact lines (one string, lines separated by newlines). */
function party(label: string, name: string, details: string): JsonObject {
  return labeledText(label, [
    { bind: name },
    { text: "\n" },
    { bind: `coalesce(${details}, '')`, font: { size_pt: 9, weight: 400, color: "var(--fm-color-muted)" } }
  ], { grow: 1 });
}

function moneyRow(label: RunSpec[], amount: RunSpec[], strong = false): JsonObject {
  const font = strong ? { family: "var(--fm-display-font)", size_pt: 12, weight: 800, color: "var(--fm-text)" } : BODY_FONT;
  return flowRow([flowText(label, { font, grow: 1 }), flowText(amount, { font, align: "right", w: 110 })], { gap: 8 });
}

function purchaseOrderComponents(): JsonObject {
  return {
    po_header: { params: {}, root: componentRow([
      header("Item", "left", { grow: 1 }), header("SKU", "left", { w: 78 }), header("Qty", "right", { w: 44 }), header("Unit", "left", { w: 50 }),
      header("Price", "right", { w: MONEY_WIDTH }), header("Amount", "right", { w: MONEY_WIDTH })
    ], { gap: 6, padding: [5, 8, 5, 8], fill: "var(--fm-primary)", align: "center" }) },
    po_row: {
      params: { item: { type: "object" } },
      root: componentRow([
        flowBlocks([
          { runs: [{ bind: "item.name" }], style_ref: "li_name" },
          { runs: [{ bind: "coalesce(item.details, '')" }], style_ref: "li_meta", collapse_empty: true }
        ], { grow: 1 }),
        flowText([{ bind: "coalesce(item.sku, '')" }], { style_ref: "li_meta", w: 78 }),
        flowText([{ bind: "item.quantity" }], { style_ref: "li_amount", align: "right", w: 44 }),
        flowText([{ bind: "coalesce(item.unit, '')" }], { style_ref: "li_meta", w: 50 }),
        flowText([{ bind: "not_empty(item.unit_price_cents) ? (item.unit_price_cents | money) : ''" }], { style_ref: "li_meta", align: "right", w: MONEY_WIDTH }),
        flowText([{ bind: "not_empty(item.total_cents) ? (item.total_cents | money) : ''" }], { style_ref: "li_amount", align: "right", w: MONEY_WIDTH })
      ], { gap: 6, padding: [6, 8, 6, 8] })
    }
  };
}

/** A purchase order to one supplier: its number, dates, who it is from and where it ships, the lines and their prices, and the terms. */
export function purchaseOrderTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "purchase_order");
  addFlowPage(doc, theme, "body", "Purchase Order", [
    flowLogo({ w: 150, h: 32 }),
    flowRow([
      flowText([{ text: "Purchase Order" }], { font: TITLE_FONT, grow: 1 }),
      labeledText("PO number", [{ bind: "coalesce(params.po_number, '')" }], { w: 150, align: "right" })
    ], { align: "end" }),
    flowRow([
      labeledText("Order date", [{ bind: "params.order_date | date" }], { grow: 1 }),
      labeledText("Requested delivery", [
        { bind: "coalesce(params.delivery_label, '')" }
      ], { grow: 2 })
    ], { gap: 20 }),
    flowRow([
      party("Supplier", "coalesce(params.supplier.name, 'Supplier')", "params.supplier.details"),
      party("Ship to", "coalesce(params.ship_to.name, project.title, '')", "coalesce(params.ship_to.details, project.address)"),
      party("Ordered by", "coalesce(params.buyer.name, org.name, '')", "params.buyer.details")
    ], { gap: 20 }),
    when(flowText([{ bind: "coalesce(params.intro, '')" }], { font: BODY_FONT }), "not_empty(params.intro)"),
    flowSpacer(4),
    flowComponent("po_header"),
    flowRepeater({
      source: "{{params.lines}}",
      component: "po_row",
      as: "row",
      layout: { direction: "column", columns: 1, gap_pt: 1 },
      break_rules: { repeat_header: true, header_component: "po_header", min_rows_per_segment: 2, keep_with_next: [] },
      empty_text: "Choose the materials this purchase order is for."
    }),
    when(flowColumn([
      moneyRow([{ text: "Subtotal" }], [{ bind: "params.subtotal_cents | money" }]),
      when(moneyRow([{ text: "Delivery" }], [{ bind: "params.delivery_cents | money" }]), "coalesce(params.delivery_cents, 0) > 0"),
      moneyRow([{ text: "Total" }], [{ bind: "params.total_cents | money" }], true),
      when(flowText([{ text: "Some prices are not known yet. Please quote them when you confirm." }], { font: MUTED_FONT }), "params.prices_complete == false")
    ], { gap: 5, padding: [10, 12, 10, 12], fill: PANEL_FILL }), "not_empty(params.total_cents)"),
    when(flowColumn([
      flowText([{ text: "Notes" }], { style_ref: "h2" }),
      flowText([{ bind: "coalesce(params.notes, '')" }], { font: BODY_FONT })
    ], { gap: 4 }), "not_empty(params.notes)"),
    when(flowColumn([
      flowText([{ text: "Terms" }], { style_ref: "h2" }),
      flowText([{ bind: "coalesce(params.terms, '')" }], { font: MUTED_FONT })
    ], { gap: 4 }), "not_empty(params.terms)")
  ], { gap: 7 });
  doc.components = purchaseOrderComponents();
  doc.styles = lineItemStyles();
  doc.params = {
    project: { type: "entity", entity: "project" },
    po_number: { type: "string", label: "PO number", required: true },
    order_date: { type: "date", label: "Order date" },
    delivery_label: { type: "string", label: "Requested delivery" },
    supplier: { type: "object", label: "Supplier" },
    ship_to: { type: "object", label: "Ship to" },
    buyer: { type: "object", label: "Ordered by" },
    intro: { type: "text", label: "Message to the supplier" },
    lines: { type: "list", items: { type: "object" }, label: "Lines", required: true },
    subtotal_cents: { type: "currency" },
    delivery_cents: { type: "currency" },
    total_cents: { type: "currency" },
    prices_complete: { type: "boolean", default: true },
    notes: { type: "text", label: "Notes" },
    terms: { type: "text", label: "Terms", default: PURCHASE_ORDER_DEFAULT_TERMS }
  };
  doc.outputs = {};
  return doc;
}

function shoppingListComponents(): JsonObject {
  return {
    sl_row: {
      params: { item: { type: "object" } },
      root: componentColumn([
        when(componentRow([
          flowBlocks([
            { runs: [{ bind: "coalesce(item.supplier, 'Supplier')" }], style_ref: "sl_group" },
            { runs: [{ bind: "coalesce(item.address, '')" }], style_ref: "li_meta", collapse_empty: true }
          ], { grow: 1 })
        ], { padding: [10, 8, 4, 8] }), "item.kind == 'group'"),
        when(componentRow([
          flowText([{ bind: "item.checked == true ? '☑' : '☐'" }], { font: { family: "var(--fm-body-font)", size_pt: 15, color: "var(--fm-text)" }, w: 20 }),
          flowImage("item.image", { w: 40, h: 40 }, { alt: "Item" }),
          flowBlocks([
            { runs: [{ bind: "item.name" }], style_ref: "li_name" },
            { runs: [{ bind: "coalesce(item.details, '')" }], style_ref: "li_meta", collapse_empty: true }
          ], { grow: 1 }),
          flowText([{ bind: "concat(item.quantity, ' ', coalesce(item.unit, ''))" }], { style_ref: "li_amount", align: "right", w: 96 })
        ], { gap: 8, padding: [5, 8, 5, 8], align: "center" }), "item.kind != 'group'")
      ], { gap: 0 })
    }
  };
}

/** A pickup checklist: each supplier's items with how many to load, an image and a box to tick. */
export function shoppingListTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "shopping_list");
  addFlowPage(doc, theme, "body", "Shopping List", [
    flowLogo({ w: 150, h: 32 }),
    flowRow([
      flowText([{ bind: "coalesce(params.title, 'Shopping List')" }], { font: TITLE_FONT, grow: 1 }),
      labeledText("Date", [{ bind: "params.list_date | date" }], { w: 120, align: "right" })
    ], { align: "end" }),
    flowRow([
      labeledText("Project", [
        { bind: "coalesce(params.project.title, project.title, '')" },
        { text: "\n" },
        { bind: "coalesce(params.project.address, project.address, '')", font: { size_pt: 9, weight: 400, color: "var(--fm-color-muted)" } }
      ], { grow: 1 }),
      when(labeledText("Picked up by", [{ bind: "coalesce(params.assignee, '')" }], { grow: 1 }), "not_empty(params.assignee)")
    ], { gap: 20 }),
    when(flowText([{ bind: "coalesce(params.notes, '')" }], { font: MUTED_FONT }), "not_empty(params.notes)"),
    flowRepeater({
      source: "{{params.rows}}",
      component: "sl_row",
      as: "row",
      layout: { direction: "column", columns: 1, gap_pt: 0 },
      break_rules: { min_rows_per_segment: 2, keep_with_next: [] },
      empty_text: "Choose the materials to pick up."
    })
  ], { gap: 7 });
  doc.components = shoppingListComponents();
  doc.styles = { ...lineItemStyles(), sl_group: { family: "var(--fm-display-font)", size_pt: 12, weight: 800, color: "var(--fm-text)" } };
  doc.params = {
    project: { type: "entity", entity: "project" },
    title: { type: "string", label: "Title" },
    list_date: { type: "date", label: "Date" },
    assignee: { type: "string", label: "Picked up by" },
    notes: { type: "text", label: "Notes", default: SHOPPING_LIST_DEFAULT_NOTES },
    rows: { type: "list", items: { type: "object" }, label: "Rows", required: true }
  };
  doc.outputs = {};
  return doc;
}
