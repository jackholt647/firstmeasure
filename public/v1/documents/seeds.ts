import type { JsonObject } from "../platform/storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { FMDocModel } from "./schemas.js";
import { repairIncorrectCompanyAccent, themeDefinitionWithOrganizationDefaults } from "./theme-defaults.js";
import {
  archiveDocumentTemplate,
  createDocumentTemplate,
  createDocumentTheme,
  createDocumentWorkflow,
  listDocumentThemes,
  publishDocumentTemplate,
  publishDocumentTheme,
  publishDocumentWorkflow,
  readDocumentTemplate,
  readDocumentTheme,
  readDocumentThemeVersion,
  readDocumentWorkflow
} from "./storage.js";
import { uploadTemplateDefinition } from "./extraction.js";
import {
  addFlowPage,
  componentColumn,
  componentRow,
  flowBlocks,
  flowColumn,
  flowComponent,
  flowImage,
  flowLogo,
  flowRepeater,
  flowRow,
  flowSpacer,
  flowText,
  flowWidget,
  labeledText,
  type RunSpec
} from "./template-kit.js";

/**
 * Seeded presets: three themes porting the legacy proposal CSS themes
 * (margin / triangles / clean from apps/project-request PROPOSAL_THEMES) into
 * theme documents, starter templates for proposal, invoice and change order,
 * the showcase one-page legal agreement (spec §10.5) and three-option
 * proposal (spec §10.3), and their fill workflows alongside the flagship
 * "Roofing proposal intake". Presets upgrade by preset_revision, copying the
 * scope-template pattern (scopes/storage.ts ensureDefaultScopeTemplates).
 */
export const DOCUMENT_PRESET_REVISION = 31;

function defaultProposalPaymentSchedule(): JsonObject[] {
  return [
    { id: "deposit", label: "Deposit", kind: "percent", percent: 30, payment_kind: "deposit", due_rule: "on_signature" },
    { id: "final", label: "Final payment", kind: "percent", percent: 70, payment_kind: "final", due_rule: "project_completion" }
  ];
}

const PAGE_W = 612;
const PAGE_H = 792;

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

// ---------------------------------------------------------------------------
// Node helpers
// ---------------------------------------------------------------------------

type Frame = { x: number; y: number; w: number; h: number; z?: number };

function shapeRect(frame: Frame, fill: string, extra: JsonObject = {}) {
  return FMDocModel.createNode("shape", {
    frame,
    style: { fill: { type: "solid", color: fill } },
    props: { shape: "rect" },
    ...extra
  });
}

function shapePolygon(frame: Frame, points: Array<{ x: number; y: number }>, fill: string) {
  return FMDocModel.createNode("shape", {
    frame,
    style: { fill: { type: "solid", color: fill } },
    props: { shape: "polygon", points }
  });
}

/**
 * options.style_ref applies a NAMED block style (doc.styles → theme
 * type_styles) instead of inline fonts — seeded templates prefer refs so org
 * rebranding means editing a handful of styles, not every block.
 */
function textNode(frame: Frame, runs: RunSpec[], options: JsonObject = {}) {
  const font = asObject(options.font);
  const styleRef = cleanText(options.style_ref);
  return FMDocModel.createNode("text", {
    frame,
    style: Object.keys(font).length ? { font } : {},
    props: {
      blocks: [{
        id: FMDocModel.generateId("blk"),
        type: cleanText(options.block_type || "paragraph") || "paragraph",
        align: cleanText(options.align || "left") || "left",
        ...(styleRef ? { style_ref: styleRef } : {}),
        runs: runs.map((run) => ({ text: run.text || "", ...(run.bind ? { bind: run.bind } : {}), ...(run.font ? { font: run.font } : {}), ...(run.color ? { color: run.color } : {}), ...(run.weight ? { weight: run.weight } : {}) }))
      }]
    }
  });
}

/** Multi-block text node for stacked label/value or totals content. */
function textBlocksNode(frame: Frame, blocks: Array<{ runs: RunSpec[]; style_ref?: string; align?: string }>, options: JsonObject = {}) {
  const font = asObject(options.font);
  return FMDocModel.createNode("text", {
    frame,
    style: Object.keys(font).length ? { font } : {},
    props: {
      blocks: blocks.map((block) => ({
        id: FMDocModel.generateId("blk"),
        type: "paragraph",
        align: cleanText(block.align || options.align || "left") || "left",
        ...(block.style_ref ? { style_ref: block.style_ref } : {}),
        runs: block.runs.map((run) => ({ text: run.text || "", ...(run.bind ? { bind: run.bind } : {}), ...(run.font ? { font: run.font } : {}), ...(run.color ? { color: run.color } : {}), ...(run.weight ? { weight: run.weight } : {}) }))
      }))
    }
  });
}

function widgetNode(ref: string, config: JsonObject, frame: Frame) {
  return FMDocModel.createNode("widget", {
    frame,
    props: { widget: ref, config }
  });
}

/**
 * Company logo image bound to the resolved org scope. service.ts fills
 * org.logo_url (media file URL for interactive renders, data URI for
 * static/PDF snapshots); bind.if removes the node when the org has no logo.
 */
function orgLogoNode(frame: Frame) {
  const node = FMDocModel.createNode("image", {
    frame: { z: 5, ...frame },
    props: { fit: "contain", alt: "Company logo" }
  });
  (node as JsonObject).bind = {
    props: { "props.media": "{{org.logo_url}}" },
    if: "not_empty(org.logo_url)"
  };
  return node;
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

// Full fallback stacks matching FMDocRenderer.fontStackFor output exactly, so
// theme font vars never resolve to a bare family name (bare names render with
// the browser default when the family is unavailable — the "terms page not
// Montserrat" class of bug).
const DISPLAY_FONT_STACK = '"Montserrat", "Trebuchet MS", "Helvetica Neue", Helvetica, Arial, sans-serif';
const BODY_FONT_STACK = '"Inter", "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif';

function baseTokens(primaryFallback: string, accentFallback: string) {
  return {
    colors: {
      // Org branding drives the palette; hexes below are only fallbacks for
      // orgs that never configured brand colors. Org branding stores the pair
      // as colors.primary/colors.secondary (see invoicePresentation /
      // publicCustomerPortalBranding), so both accent and secondary reference
      // the org's secondary color.
      primary: { from: "org.branding.colors.primary", fallback: primaryFallback },
      secondary: { from: "org.branding.colors.secondary", fallback: accentFallback },
      accent: { from: "org.branding.colors.secondary", fallback: accentFallback },
      // Derived from the accent at paint time so it follows org branding too.
      accent_soft: "color-mix(in srgb, var(--fm-accent) 34%, transparent)",
      text: "#111827",
      muted: "#667085",
      paper: "#ffffff"
    },
    fonts: { display: DISPLAY_FONT_STACK, body: BODY_FONT_STACK },
    spacing: {
      page_margin_pt: 40,
      page_margin_top_pt: 40,
      page_margin_right_pt: 40,
      page_margin_bottom_pt: 40,
      page_margin_left_pt: 40,
      gap_pt: 12
    }
  };
}

function baseTypeStyles() {
  return {
    h1: { family: "var(--fm-display-font)", size_pt: 26, weight: 800, color: "var(--fm-text)" },
    h2: { family: "var(--fm-display-font)", size_pt: 16, weight: 800, color: "var(--fm-text)" },
    body: { family: "var(--fm-body-font)", size_pt: 11, weight: 400, color: "var(--fm-text)" },
    caption: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 600, color: "var(--fm-color-muted)" },
    legal: { family: "var(--fm-body-font)", size_pt: 7.5, weight: 400, color: "var(--fm-color-muted)" }
  };
}

/** Margin — 48pt full-height primary rail plus a 10pt accent stripe on every page. */
function marginThemeDefinition(): JsonObject {
  return {
    name: "Margin",
    tokens: baseTokens("#2563EB", "#bfdbfe"),
    type_styles: baseTypeStyles(),
    page_masters: [
      {
        id: "m_margin_body",
        match: { role: "*" },
        chrome: [
          shapeRect({ x: 0, y: 0, w: 48, h: PAGE_H, z: 0 }, "var(--fm-primary)"),
          shapeRect({ x: 48, y: 0, w: 10, h: PAGE_H, z: 0 }, "var(--fm-accent)")
        ],
        content_inset: { top: 48, left: 104, right: 48, bottom: 48 }
      }
    ],
    widget_skins: {
      "doc.line_items": { header_fill: "var(--fm-primary)", header_color: "#ffffff" },
      "doc.payment_schedule": { header_fill: "var(--fm-primary)", header_color: "#ffffff" }
    }
  };
}

/** Triangles — corner triangle shapes; a bolder pair on the cover. */
function trianglesThemeDefinition(): JsonObject {
  const topLeft = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }];
  const bottomRight = [{ x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  return {
    name: "Triangles",
    tokens: baseTokens("#2563EB", "#bfdbfe"),
    type_styles: baseTypeStyles(),
    page_masters: [
      {
        id: "m_triangles_cover",
        match: { role: "cover" },
        chrome: [
          shapePolygon({ x: 0, y: 0, w: 245, h: 230, z: 0 }, topLeft, "var(--fm-color-accent-soft)"),
          shapePolygon({ x: 0, y: 0, w: 178, h: 182, z: 1 }, topLeft, "var(--fm-primary)"),
          shapePolygon({ x: PAGE_W - 135, y: PAGE_H - 175, w: 135, h: 175, z: 0 }, bottomRight, "var(--fm-color-accent-soft)")
        ],
        content_inset: { top: 160, left: 64, right: 64, bottom: 72 }
      },
      {
        id: "m_triangles_body",
        match: { role: "*" },
        chrome: [
          shapePolygon({ x: 0, y: 0, w: 220, h: 80, z: 0 }, topLeft, "var(--fm-primary)"),
          shapePolygon({ x: PAGE_W - 280, y: PAGE_H - 140, w: 280, h: 140, z: 0 }, bottomRight, "var(--fm-color-accent-soft)"),
          shapePolygon({ x: PAGE_W - 150, y: PAGE_H - 150, w: 150, h: 150, z: 1 }, bottomRight, "var(--fm-primary)")
        ],
        content_inset: { top: 104, left: 64, right: 64, bottom: 104 }
      }
    ],
    widget_skins: {
      "doc.line_items": { header_fill: "var(--fm-primary)", header_color: "#ffffff" }
    }
  };
}

/** Clean — a light header bar with a primary rule on every page. */
function cleanThemeDefinition(): JsonObject {
  return {
    name: "Clean",
    tokens: baseTokens("#2563EB", "#bfdbfe"),
    type_styles: baseTypeStyles(),
    page_masters: [
      {
        id: "m_clean_body",
        match: { role: "*" },
        chrome: [
          shapeRect({ x: 0, y: 0, w: PAGE_W, h: 52, z: 0 }, "color-mix(in srgb, var(--fm-primary) 5%, var(--fm-color-paper))"),
          shapeRect({ x: 0, y: 49, w: PAGE_W, h: 3, z: 1 }, "var(--fm-primary)")
        ],
        content_inset: { top: 80, left: 48, right: 48, bottom: 48 }
      }
    ],
    widget_skins: {
      "doc.line_items": { header_fill: "color-mix(in srgb, var(--fm-primary) 5%, var(--fm-color-paper))", header_color: "var(--fm-text)" }
    }
  };
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Line-item components for the proposal pricing page (spec §3.4: widgets do
 * behavior, components do layout). li_row renders one scope item bound to
 * {{item.*}}; li_header is the column header; li_totals binds the doc's
 * computed subtotal/tax/total. Each is a row flow whose name column grows, so
 * the table follows whatever width the page margins leave it.
 */
const LI_QTY_WIDTH = 72;
const LI_AMOUNT_WIDTH = 96;

export function proposalLineItemComponents(): JsonObject {
  const headerText = (label: string, align: string, size: { w?: number; grow?: number }) => flowText([{ text: label }], {
    align,
    font: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 800, color: "#ffffff", transform: "uppercase" },
    ...size
  });
  const liHeader = componentRow([
    headerText("Item", "left", { grow: 1 }),
    headerText("Qty", "center", { w: LI_QTY_WIDTH }),
    headerText("Amount", "right", { w: LI_AMOUNT_WIDTH })
  ], { gap: 8, padding: [5, 8, 5, 8], fill: "var(--fm-primary)", align: "center" });
  const liRow = componentRow([
    flowBlocks([
      // scope_rows are the flat projection: children get an indent label,
      // parents keep the rolled-up amount (see flattenScopeRows).
      { runs: [{ bind: "coalesce(item.display_name, item.name)" }], style_ref: "li_name" },
      { runs: [{ bind: "coalesce(item.description, '')" }], style_ref: "li_meta", collapse_empty: true },
      // Conditional-pricing badge chip ("Pay by bank", "3% card fee",
      // "Sign within 7 days") — empty for ordinary rows.
      { runs: [{ bind: "coalesce(item.badge, '')" }], style_ref: "li_badge", collapse_empty: true }
    ], { grow: 1 }),
    flowText([{ bind: "item.quantity | qty(item.unit)" }], { style_ref: "body", align: "center", w: LI_QTY_WIDTH }),
    flowText([
      // A package proposal prints "Included" under its parent's price; an
      // itemized one (params.show_line_prices) prints every line's amount.
      { bind: "(coalesce(item.show_amount, true) || coalesce(params.show_line_prices, false)) ? (item.amount_cents | money) : 'Included'" }
    ], { style_ref: "li_amount", align: "right", w: LI_AMOUNT_WIDTH })
  ], { gap: 8, padding: [6, 8, 6, 8] });
  // Row roles from the flat projection (service.ts collectPricedProjection):
  // children indent as a block, so a name and its description stay aligned.
  const liRowVariants = {
    child: { props: { flow: { padding: [4, 8, 4, 24] } } },
    group: { props: { flow: { padding: [8, 8, 4, 8] } } }
  };
  const liTotals = componentColumn([
    flowBlocks([
      { runs: [{ text: "Subtotal   " }, { bind: "computed.subtotal_cents | money" }], style_ref: "body", align: "right" },
      // Conditional pricing adjustments (ACH/card/early-signing rows) —
      // blank when nothing applies under the current checkout state.
      { runs: [{ bind: "coalesce(computed.adjustments_cents, 0) != 0 ? concat('Adjustments   ', (computed.adjustments_cents | money)) : ''" }], style_ref: "body", align: "right", collapse_empty: true },
      { runs: [{ text: "Tax (" }, { bind: "coalesce(params.tax_percent, 0)" }, { text: "%)   " }, { bind: "computed.tax_cents | money" }], style_ref: "body", align: "right" },
      { runs: [{ text: "Total   " }, { bind: "computed.total_cents | money" }], style_ref: "li_total", align: "right" }
    ])
  ], { padding: [8, 8, 4, 8] });
  return {
    li_header: { params: {}, root: liHeader },
    li_row: { params: { item: { type: "pricebook_line" } }, root: liRow, variants: liRowVariants },
    li_totals: { params: {}, root: liTotals }
  };
}

/** Named styles the line-item components reference. */
export function lineItemStyles(): JsonObject {
  return {
    li_name: { family: "var(--fm-body-font)", size_pt: 10.5, weight: 700, color: "var(--fm-text)" },
    li_meta: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 400, color: "var(--fm-color-muted)" },
    li_amount: { family: "var(--fm-body-font)", size_pt: 10.5, weight: 700, color: "var(--fm-text)" },
    li_total: { family: "var(--fm-display-font)", size_pt: 13, weight: 800, color: "var(--fm-text)" }
  };
}

/** Header + rows + totals of a line-item table, as blocks of a page body. */
export function lineItemBlocks(source: string, emptyText: string, tail: JsonObject[] = [flowComponent("li_totals")]): JsonObject[] {
  return [
    flowComponent("li_header"),
    flowRepeater({
      // scope_rows = the server's flat, depth-annotated projection of the
      // scope tree (one instance per row, children indented, parents carry
      // the rolled-up amount). Binding the raw tree here renders exactly one
      // row per top-level assembly.
      source,
      component: "li_row",
      as: "row",
      layout: { direction: "column", columns: 1, gap_pt: 2 },
      break_rules: { repeat_header: true, header_component: "li_header", min_rows_per_segment: 2, keep_with_next: [] },
      empty_text: emptyText
    }),
    ...tail
  ];
}

// ---------------------------------------------------------------------------
// media_text_row — content-blocks component (spec §10.1). One row of
// params.content_blocks: media column + title/body text column. Variants
// media_left / media_right mirror the layout (repeaters cycle them via
// variant_by_index for layout:"auto" rows; a row's own layout wins when it
// names a variant, including "text_only"). Rows without media just hide the
// media column (bind.if), so "auto" stays text-friendly.
//
// display:"popup" media MUST emit the data-fmdoc-media-popup attribute per
// the doc-widgets contract. Plain nodes cannot emit arbitrary attributes, so
// the component embeds a doc.media_popup WIDGET node for popup display (and
// for video — its static render prints the poster box + watch-online URL);
// inline image display uses a plain image node.
// ---------------------------------------------------------------------------

function mediaTextRowChildren(mirror: boolean): JsonObject[] {
  const inlineImage = flowImage("block.media", { w: 180, h: 120 }, { alt: "Project detail" });
  inlineImage.bind = {
    props: { "props.media": "{{block.media}}" },
    if: "not_empty(coalesce(block.media.media_id, block.media.url, '')) && coalesce(block.display, 'inline') != 'popup' && !not_empty(coalesce(block.video.url, block.video, ''))"
  };
  const popup = flowWidget("doc.media_popup@1", {
    media: "{{block.media}}",
    video_url: "{{coalesce(block.video.url, block.video, '')}}",
    caption: "{{coalesce(block.title, '')}}",
    thumb_size_pt: 132
  }, { w: 180, h: 120 });
  popup.bind = {
    if: "(coalesce(block.display, 'inline') == 'popup' || not_empty(coalesce(block.video.url, block.video, ''))) && (not_empty(coalesce(block.media.media_id, block.media.url, '')) || not_empty(coalesce(block.video.url, block.video, '')))"
  };
  const text = mediaTextRowText();
  return mirror ? [text, inlineImage, popup] : [inlineImage, popup, text];
}

function mediaTextRowText(): JsonObject {
  return flowBlocks([
    { runs: [{ bind: "coalesce(block.title, '')" }], style_ref: "cb_title" },
    { runs: [{ bind: "coalesce(block.body, '')" }], style_ref: "cb_body" }
  ], { grow: 1 });
}

function mediaTextRowComponent(): JsonObject {
  return {
    media_text_row: {
      params: { block: { type: "object" } },
      root: componentRow(mediaTextRowChildren(false), { gap: 16 }),
      // deepMerge replaces arrays wholesale, so each variant carries its FULL
      // children set; media_left is the root layout (empty patch).
      variants: {
        media_left: {},
        media_right: { children: mediaTextRowChildren(true) },
        text_only: { children: [mediaTextRowText()] }
      }
    }
  };
}

/** Named styles the content-blocks and adjustment rows reference. */
function contentBlockStyles(): JsonObject {
  return {
    cb_title: { family: "var(--fm-display-font)", size_pt: 12, weight: 800, color: "var(--fm-text)" },
    cb_body: { family: "var(--fm-body-font)", size_pt: 9.5, weight: 400, color: "var(--fm-color-muted)" },
    li_badge: { family: "var(--fm-body-font)", size_pt: 7.5, weight: 800, color: "#047857", transform: "uppercase" }
  };
}

/**
 * Content-blocks repeater (details pages). "auto" rows alternate
 * media_left/media_right by index; per-row layout overrides.
 */
function contentBlocksRepeater(source: string): JsonObject {
  return flowRepeater({
    source,
    component: "media_text_row",
    as: "block",
    layout: { direction: "column", columns: 1, gap_pt: 16 },
    variant_by_index: ["media_left", "media_right"],
    break_rules: { repeat_header: false, min_rows_per_segment: 1, keep_with_next: [] },
    empty_text: "No project details added yet."
  });
}

/**
 * Seeded conditional-pricing examples (spec §10.4). A dedicated
 * params.pricing_adjustments list — NOT scope_items — so discounts and fees
 * demo without polluting the scope editor. Formulas are CENTS and reference
 * rows_subtotal_cents (the scope base subtotal, injected by service.ts).
 */
function defaultPricingAdjustments(): JsonObject[] {
  return [
    {
      id: "disc_ach",
      name: "ACH payment discount",
      description: "2% off when paying by bank transfer.",
      discount: true,
      badge: "Pay by bank",
      condition: "checkout.payment_method == 'ach'",
      pricing: { formula: "0 - round(rows_subtotal_cents * 0.02)" },
      quantity: 1,
      unit: "ea"
    },
    {
      id: "fee_card",
      name: "Card processing fee",
      description: "Applied to card payments only.",
      badge: "3% card fee",
      condition: "checkout.payment_method == 'card'",
      pricing: { formula: "round(rows_subtotal_cents * (coalesce(checkout.processing_fee_percent, 3) / 100))" },
      quantity: 1,
      unit: "ea"
    },
    {
      id: "disc_early",
      name: "Early signing discount",
      description: "3% off when you sign within 7 days of receiving this proposal.",
      discount: true,
      badge: "Sign within 7 days",
      condition: "days_since(doc.sent_at) < 7",
      pricing: { formula: "0 - round(rows_subtotal_cents * 0.03)" },
      quantity: 1,
      unit: "ea"
    }
  ];
}

/** Flow-anchored repeater rendering the enriched adjustment rows via li_row. */
function pricingAdjustmentsRepeater(): JsonObject {
  return flowRepeater({
    // params.pricing_rows is the server enrichment's flat projection
    // (excluded rows dropped); raw pricing_adjustments is the pre-resolve
    // fallback so the template previews sensibly.
    source: "{{coalesce(params.pricing_rows, params.pricing_adjustments)}}",
    component: "li_row",
    as: "row",
    layout: { direction: "column", columns: 1, gap_pt: 2 },
    empty_text: ""
  });
}

/** A seeded theme's definition, for fitting template pages to its margins. */
export function seedThemeDefinition(themeId: string): JsonObject {
  const seed = THEME_SEEDS.find((theme) => theme.id === themeId);
  return seed ? seed.definition() : {};
}

/** Empty document on a seeded page style; add pages with addFlowPage. */
export function startFlowTemplate(themeId: string, documentType: string, options: { orientation?: string; paper?: string } = {}) {
  const doc = asObject(FMDocModel.createDocument({
    kind: "document",
    first_page_role: "body",
    theme_ref: { theme_id: themeId },
    metadata: { document_type: documentType },
    ...options
  }));
  return { doc, theme: seedThemeDefinition(themeId) };
}

function mutedFont(sizePt = 10.5): JsonObject {
  return { family: "var(--fm-body-font)", size_pt: sizePt, color: "var(--fm-color-muted)" };
}

/** Shared proposal cover blocks (standard + three-option templates). */
function proposalCoverBlocks(kicker: string): JsonObject[] {
  return [
    flowLogo({ w: 190, h: 40 }),
    flowSpacer(10),
    flowText([{ text: kicker }], {
      font: { family: "var(--fm-display-font)", size_pt: 11, weight: 800, color: "var(--fm-color-muted)", transform: "uppercase" }
    }),
    flowText([
      { text: "Proposal", bind: "coalesce(params.project.title, project.title, 'Proposal')" }
    ], { style_ref: "h1" }),
    flowImage("params.hero_photo", { h: 250 }),
    flowSpacer(10),
    flowRow([
      // params.customer when the doc was created with an explicit customer,
      // else the top-level customer entity (primary project contact).
      labeledText("Prepared for", [{ text: "", bind: "coalesce(params.customer.name, customer.name, 'Customer')" }], { grow: 1, size_pt: 12 }),
      labeledText("Prepared by", [{ text: "", bind: "coalesce(org.name, 'Our Company')" }], { grow: 1, size_pt: 12 })
    ], { gap: 20 }),
    flowText([
      { text: "", bind: "coalesce(params.project.address, project.address, '')" }
    ], { font: mutedFont(11) })
  ];
}

/** Shared proposal signature-page blocks. */
function proposalSignatureBlocks(): JsonObject[] {
  return [
    flowText([{ text: "Agreement" }], { style_ref: "h2" }),
    flowText([
      { text: "By signing below you accept this proposal and authorize the work described in the scope pages." }
    ], { font: mutedFont() }),
    flowWidget("doc.payment_schedule@1", { source: "params.payment_schedule" }),
    flowSpacer(8),
    flowRow([
      flowColumn([
        flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer Signature", signer: "customer" }, { h: 90 }),
        flowWidget("doc.pay_now@1", { label: "Deposit due" }, { h: 90 })
      ], { grow: 1, gap: 20 }),
      flowWidget("doc.qr@1", { label: "Review and sign online" }, { w: 120, h: 130 })
    ], { gap: 24 })
  ];
}

function proposalTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_margin", "proposal");
  addFlowPage(doc, theme, "cover", "Cover", proposalCoverBlocks("PROJECT PROPOSAL"));

  // Project details (spec §10.1): workflow-editable content blocks — media +
  // text rows alternating left/right, popup media via the doc.media_popup
  // widget chip inside media_text_row.
  addFlowPage(doc, theme, "body", "Project details", [
    flowText([{ text: "Project details" }], { style_ref: "h2" }),
    contentBlocksRepeater("{{params.content_blocks}}")
  ]);

  // Pricing page: li_header, a repeater over li_row instances, the
  // conditional pricing adjustments (spec §10.4) and li_totals are blocks of
  // the paginating body, so a long scope continues onto further pages.
  addFlowPage(doc, theme, "pricing", "Pricing", [
    flowText([{ text: "Scope & Pricing" }], { style_ref: "h2" }),
    flowSpacer(4),
    ...lineItemBlocks("{{coalesce(params.scope_rows, params.scope_items)}}", "No scope items selected yet.", [
      pricingAdjustmentsRepeater(),
      flowComponent("li_totals")
    ])
  ], { gap: 4 });

  addFlowPage(doc, theme, "signature", "Sign & Pay", proposalSignatureBlocks());

  addFlowPage(doc, theme, "fine_print", "Terms", [
    flowText([{ text: "Terms & Conditions" }], { style_ref: "h2" }),
    flowText([
      { text: "This proposal is valid for 30 days from the date issued. Work will be scheduled after the signed agreement and deposit are received. Any changes to the scope of work require a written change order. Manufacturer warranties apply to materials; workmanship is warranted per the agreement terms. Payment is due per the payment schedule on the signature page." }
    ], { style_ref: "legal" })
  ]);

  // Named styles the pricing components reference (theme type_styles carry
  // h1/h2/body/caption/legal; these are the doc-level additions).
  doc.styles = { ...lineItemStyles(), ...contentBlockStyles() };
  doc.components = { ...proposalLineItemComponents(), ...mediaTextRowComponent() };
  // Pricing math the totals component and portal read; rows carry cents after
  // server enrichment (service.ts enrichLineItemParams). Adjustments are the
  // conditional pricing rows (params.pricing_adjustments) — 0 until a
  // checkout state / send timestamp activates them.
  doc.computed = {
    subtotal_cents: "sum(params.scope_items[].amount_cents)",
    adjustments_cents: "sum(params.pricing_adjustments[].amount_cents)",
    tax_cents: "round((computed.subtotal_cents + computed.adjustments_cents) * coalesce(params.tax_percent, 0) / 100)",
    total_cents: "computed.subtotal_cents + computed.adjustments_cents + computed.tax_cents"
  };
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Scope line items" },
    // Auto-filled from the project at creation; the form renders a structured
    // summary, never raw JSON.
    measurements: { type: "measurements", label: "Measurements", default: "{{project.measurements}}" },
    payment_schedule: { type: "payment_schedule", label: "Payment schedule", default: defaultProposalPaymentSchedule() },
    deposit_cents: { type: "currency", label: "Deposit" },
    hero_photo: { type: "media", kinds: ["image"], label: "Hero photo" },
    tax_percent: { type: "percent", label: "Tax percent" },
    // Spec §10.1 content blocks (Project details page).
    content_blocks: { type: "list", label: "Project details" },
    // Spec §10.4 conditional pricing showcase rows (see defaultPricingAdjustments).
    pricing_adjustments: { type: "list", label: "Pricing adjustments", default: defaultPricingAdjustments() }
  };
  doc.outputs = {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    selections: { type: "select", from_widget: "doc.line_items" },
    deposit_payment: { type: "payment", obligation: "deposit", required_for: "completed" }
  };
  return doc;
}

function invoiceTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "invoice");
  addFlowPage(doc, theme, "body", "Invoice", [
    flowLogo({ w: 150, h: 32 }),
    flowText([
      { text: "Invoice " },
      { text: "", bind: "coalesce(params.invoice_number, '')" }
    ], { font: { family: "var(--fm-display-font)", size_pt: 20, weight: 800 } }),
    flowRow([
      labeledText("Billed to", [{ text: "", bind: "coalesce(params.customer.name, customer.name, 'Customer')" }], { grow: 1 }),
      labeledText("Due", [{ text: "", bind: "params.due_date | date" }], { w: 164, align: "right" })
    ]),
    flowSpacer(6),
    flowWidget("doc.line_items@1", {
      source: "params.line_items",
      show_prices: true,
      depth: 1,
      columns: ["name", "description", "qty", "unit_price", "amount"]
    }),
    flowSpacer(6),
    flowRow([
      flowWidget("doc.payment_schedule@1", { source: "params.payment_schedule" }, { grow: 1 }),
      flowColumn([
        flowWidget("doc.pay_now@1", { label: "Amount due", source: "params.amount_due_cents" }, { h: 90 }),
        flowWidget("doc.qr@1", { label: "Pay online" }, { w: 100, h: 104 })
      ], { w: 164, gap: 14 })
    ], { gap: 24 })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    invoice_number: { type: "string" },
    issue_date: { type: "date" },
    due_date: { type: "date" },
    line_items: { type: "list", items: { type: "pricebook_line" }, required: true },
    tax_percent: { type: "percent" },
    amount_due_cents: { type: "currency" }
  };
  doc.outputs = {
    payment: { type: "payment", required_for: "completed" }
  };
  return doc;
}

function changeOrderTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_margin", "change_order");
  addFlowPage(doc, theme, "body", "Change Order", [
    flowLogo(),
    flowText([{ text: "Change Order" }], { style_ref: "h1" }),
    flowText([
      { text: "", bind: "coalesce(params.project.title, project.title, '')" }
    ], { font: mutedFont(11) }),
    labeledText("Reason for change", [{ text: "", bind: "coalesce(params.reason, '')" }], { size_pt: 10.5 }),
    flowSpacer(6),
    flowWidget("doc.line_items@1", {
      source: "params.scope_items",
      show_prices: true,
      depth: 1
    })
  ]);
  addFlowPage(doc, theme, "signature", "Approval", [
    flowText([{ text: "Approval" }], { style_ref: "h2" }),
    flowText([
      { text: "Signing this change order approves the added scope and pricing above as an amendment to the original agreement." }
    ], { font: mutedFont(10) }),
    flowWidget("doc.payment_schedule@1", { source: "params.payment_schedule" }),
    flowSpacer(8),
    flowRow([
      flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer Signature", signer: "customer" }, { grow: 1, h: 90 }),
      flowWidget("doc.qr@1", { label: "Approve online" }, { w: 120, h: 130 })
    ], { gap: 24 })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    source_document_id: { type: "string" },
    reason: { type: "text" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, required: true },
    amount_cents: { type: "currency" },
    payment_schedule: { type: "payment_schedule" }
  };
  doc.outputs = {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    payment: { type: "payment", required_for: "completed" }
  };
  return doc;
}

/**
 * Kitchen finish selections — a change-order-family document whose body lists
 * the allowance groups and the customer's picks. The customer normally never
 * sees these pages (customer_presentation mode "workflow"); they exist so the
 * signed record renders/prints like any other document. The payment gate is
 * deliberately removed: selection deltas append to the payment schedule (due
 * at the next invoice) instead of demanding payment at selection time.
 */
function kitchenSelectionsTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "change_order");
  addFlowPage(doc, theme, "body", "Material Selections", [
    flowLogo(),
    flowText([{ text: "Material Selections" }], { style_ref: "h1" }),
    flowText([
      { text: "", bind: "coalesce(params.project.title, project.title, '')" }
    ], { font: mutedFont(11) }),
    flowText([
      { text: "Standard options are covered in full by your allowances. Upgrade prices below are the amount added to your project total; they are billed on your next invoice." }
    ], { font: mutedFont(10) }),
    flowSpacer(6),
    flowWidget("doc.line_items@1", {
      source: "params.scope_items",
      show_prices: true,
      depth: 2
    })
  ]);
  addFlowPage(doc, theme, "signature", "Approval", [
    flowText([{ text: "Selection Approval" }], { style_ref: "h2" }),
    flowText([
      { text: "Signing approves the selected materials. Any upgrade total above is added to the project's payment schedule as a selections adjustment." }
    ], { font: mutedFont(10) }),
    flowWidget("doc.payment_schedule@1", { source: "params.payment_schedule" }),
    flowSpacer(8),
    flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer Signature", signer: "customer" }, { w: 300, h: 90 })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    reason: { type: "text" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, required: true },
    payment_schedule: { type: "payment_schedule" }
  };
  doc.outputs = {
    // Selection-group picks; the engine solidifies them onto
    // params.scope_items so the authoritative total is the upgrade delta.
    selections: { type: "select", required: true, applies: "scope_selections", label: "Material selections" },
    sig_customer: { type: "signature", required: true, signer: "customer" },
    // Ungated payment: overrides the change_order type's required_for gate —
    // deltas are billed through the appended schedule, not at signing.
    payment: { type: "payment" }
  };
  return doc;
}

/** Customer-facing selections stepper: choose per-group materials, review, sign. */
function kitchenSelectionsWorkflowDefinition(): JsonObject {
  return {
    schema_version: 1,
    name: "Kitchen finish selections",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        reason: { type: "text" },
        scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Allowance options" },
        payment_schedule: { type: "payment_schedule" }
      },
      outputs: {
        selections: { type: "select", required: true, applies: "scope_selections", label: "Material selections" },
        sig_customer: { type: "signature", required: true, signer: "customer" },
        payment: { type: "payment" }
      }
    },
    steps: [
      {
        id: "st_prepare",
        title: "Prepare selections",
        audience: ["internal", "field"],
        items: [{
          kind: "line_items_review",
          writes: "params.scope_items",
          required: true,
          label: "Allowance options",
          description: "Each group's standard option is covered by the allowance; upgrade prices are the delta the customer pays."
        }]
      },
      {
        id: "st_choose",
        title: "Choose your materials",
        audience: ["internal", "field", "customer"],
        items: [{
          kind: "choice_group",
          writes: "outputs.selections",
          required: true,
          label: "Choose your materials",
          description: "Standard options are covered by your allowances. Upgrade prices are added to your next invoice.",
          options_from: "scope_items",
          presentation: { style: "cards" }
        }]
      },
      {
        id: "st_review",
        title: "Review",
        kind: "review",
        audience: ["internal", "field", "customer"],
        items: [{ kind: "review", presentation: { live: true } }],
        preview: { template_ref: "tpl_kitchen_selections", live: true }
      },
      {
        id: "st_sign",
        title: "Approve selections",
        audience: ["customer", "field"],
        items: [{
          kind: "signature",
          writes: "outputs.sig_customer",
          required: true,
          label: "Approve your selections",
          description: "Signing approves the materials above; any upgrade total is added to your payment schedule."
        }]
      }
    ],
    audiences: {
      internal: {},
      field: {},
      customer: { theme: "portal", hide_steps: ["st_prepare"] }
    }
  };
}

// ---------------------------------------------------------------------------
// Job cost report — internal money report generated from the Money tab.
// Data flows entirely through the report widgets (doc.money_metrics /
// doc.expense_breakdown / doc.payment_history), which resolve the same
// server-side summaries the Money tab renders. No outputs: reports are never
// signed or sent for completion.
// ---------------------------------------------------------------------------

function moneyReportTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "report");
  addFlowPage(doc, theme, "body", "Job Cost", [
    flowLogo({ w: 150, h: 32 }),
    flowText([
      { text: "", bind: "coalesce(params.report_title, 'Job Cost Report')" }
    ], { font: { family: "var(--fm-display-font)", size_pt: 20, weight: 800 } }),
    flowText([
      { text: "", bind: "coalesce(params.project.title, project.title, '')" },
      { text: "\n", font: { size_pt: 4 } },
      { text: "", bind: "coalesce(params.project.address, project.address, '')", font: { size_pt: 9, color: "var(--fm-color-muted)" } }
    ], { font: { family: "var(--fm-body-font)", size_pt: 11, weight: 700 } }),
    flowWidget("doc.money_metrics@1", {}),
    flowSpacer(6),
    flowText([{ text: "Expenses — projected vs. actual" }], { style_ref: "h2" }),
    flowWidget("doc.expense_breakdown@1", {})
  ]);
  addFlowPage(doc, theme, "body", "Payments", [
    flowText([{ text: "Payment history" }], { style_ref: "h2" }),
    flowWidget("doc.payment_history@1", {}),
    flowText([
      { text: "", bind: "coalesce(params.notes, '')" }
    ], { font: mutedFont(9.5) })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    report_title: { type: "string" },
    period_from: { type: "date" },
    period_to: { type: "date" },
    notes: { type: "text" }
  };
  doc.outputs = {};
  return doc;
}

function payrollReportTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "payroll_report", { orientation: "landscape" });
  addFlowPage(doc, theme, "body", "Payroll Report", [
    flowLogo({ w: 150, h: 32 }),
    flowText([
      { text: "", bind: "coalesce(params.report_title, 'Payroll Report')" }
    ], { font: { family: "var(--fm-display-font)", size_pt: 20, weight: 800 } }),
    flowText([
      { text: "", bind: "coalesce(params.coverage_label, '')" },
      { text: "\nGenerated ", font: { size_pt: 8, color: "var(--fm-color-muted)" } },
      { text: "", bind: "params.generated_at | date", font: { size_pt: 8, color: "var(--fm-color-muted)" } }
    ], { font: { family: "var(--fm-body-font)", size_pt: 10, weight: 700 } }),
    flowSpacer(4),
    flowWidget("doc.report_table@1", { columns: "params.columns", rows: "params.rows" })
  ]);
  doc.params = {
    report_title: { type: "string", required: true },
    coverage_label: { type: "string" },
    generated_at: { type: "date" },
    columns: { type: "list", items: { type: "object" }, required: true },
    rows: { type: "list", items: { type: "object" } }
  };
  doc.outputs = {};
  return doc;
}

function paymentReceiptTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "payment_receipt");
  const label = (text: string): RunSpec => ({ text: `${text}\n`, font: { size_pt: 8, weight: 800, color: "var(--fm-color-muted)" } });
  addFlowPage(doc, theme, "body", "Payment Receipt", [
    flowLogo({ w: 150, h: 32 }),
    flowRow([
      flowText([{ text: "Payment Receipt" }], { grow: 1, font: { family: "var(--fm-display-font)", size_pt: 22, weight: 800 } }),
      flowText([label("Receipt"), { text: "", bind: "coalesce(params.receipt_number, '')" }], {
        w: 164, align: "right", font: { family: "var(--fm-body-font)", size_pt: 10, weight: 700 }
      })
    ]),
    flowSpacer(16),
    flowBlocks([
      { runs: [label("Received from"), { text: "", bind: "coalesce(params.customer.name, customer.name, 'Customer')" }] },
      { runs: [label("Project"), { text: "", bind: "coalesce(params.project.title, project.title, params.project.address, project.address, '')" }] },
      { runs: [label("Payment date"), { text: "", bind: "params.payment_date | date" }] },
      { runs: [label("Payment method"), { text: "", bind: "coalesce(params.payment_method, 'Payment')" }] }
    ], { font: { family: "var(--fm-body-font)", size_pt: 11, weight: 700 } }),
    flowSpacer(24),
    flowText([
      { text: "Amount received\n", font: { size_pt: 9, weight: 800, color: "var(--fm-color-muted)" } },
      { text: "", bind: "params.amount_cents | money", font: { size_pt: 28, weight: 800, color: "var(--fm-color-primary)" } },
      { text: "\n", font: { size_pt: 5 } },
      { text: "", bind: "coalesce(params.status, 'Paid')", font: { size_pt: 10, weight: 800 } }
    ], { align: "right", font: { family: "var(--fm-display-font)" } })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    receipt_number: { type: "string", required: true },
    payment_date: { type: "date" },
    amount_cents: { type: "currency", required: true },
    payment_method: { type: "string" },
    status: { type: "string" }
  };
  doc.outputs = {};
  return doc;
}

// ---------------------------------------------------------------------------
// One-page legal roofing agreement (spec §10.5) — LEGAL paper (8.5×14),
// Clean theme (org brand colors flow through theme tokens only; nothing is
// hardcoded). Everything is absolutely positioned, so the document is
// structurally one page (only paginating flow frames can add pages).
//
// CHECKBOX BINDING APPROACH: doc.form_field's boolean kind writes
// outputs.form_values, but this agreement is SCOPE-DRIVEN with rep override —
// the workflow builds params.scope_items through the native scope steps, and
// service.ts derives params.spec_derived (tear-off / ventilation / flashing /
// shingle-system booleans + the underlayment type) from the priced scope rows.
// Every checkbox renders as a display glyph text run bound
// "coalesce(params.spec.X, params.spec_derived.X) ? '☑' : '☐'" so an explicit
// workflow override (params.spec.*) always wins over the derived value.
// Non-derivable boxes (existing roof type, warranty tier, terms) stay plain
// params.spec.* binds. Glyph runs pin an explicit symbol-capable font stack so
// ☑/☐ shape identically in the editor and the Playwright PDF harness.
// Value-bearing entry fields (customer info grid) use doc.form_field widgets
// with config.value bound to params.customer_info.* — the widget renders the
// bound value (or a blank rule) in static/print mode.
// ---------------------------------------------------------------------------

const LEGAL_BODY_FONT = { family: "var(--fm-body-font)", size_pt: 7.6, color: "var(--fm-text)" };

/**
 * Explicit stack for ☑/☐ runs: without it the glyphs resolve through the body
 * font's fallback chain, which differs between the editor (Inter present) and
 * the PDF harness (Segoe UI Symbol substitution) and shifts run metrics.
 */
const LEGAL_GLYPH_FONT = { family: '"Segoe UI Symbol", "Noto Sans Symbols 2", "Apple Symbols", "Segoe UI", sans-serif' };

function onePageLegalTemplateDefinition(): JsonObject {
  const doc = asObject(FMDocModel.createDocument({
    kind: "document",
    paper: "legal",
    first_page_role: "body",
    theme_ref: { theme_id: "thm_clean" },
    metadata: { document_type: "contract" }
  }));

  const glyph = (expr: string): RunSpec => ({ bind: expr, font: LEGAL_GLYPH_FONT });
  const check = (path: string) => `${path} ? '☑' : '☐'`;
  // Derived-with-override: explicit params.spec.X (true OR false) wins;
  // otherwise the server-derived params.spec_derived.X drives the glyph.
  const specPath = (key: string) => `coalesce(params.spec.${key}, params.spec_derived.${key})`;
  const specCheck = (key: string) => `${specPath(key)} ? '☑' : '☐'`;
  const fill = (path: string, blank = "____________") => `coalesce(${path}, '${blank}')`;
  const box = (path: string, label: string, trail: RunSpec[] = []): { runs: RunSpec[] } => ({
    runs: [glyph(check(path)), { text: ` ${label}` }, ...trail]
  });
  const specBox = (key: string, label: string, trail: RunSpec[] = []): { runs: RunSpec[] } => ({
    runs: [glyph(specCheck(key)), { text: ` ${label}` }, ...trail]
  });
  const underlaymentCheck = (value: string) => `coalesce(params.spec.underlayment, params.spec_derived.underlayment, '') == '${value}' ? '☑' : '☐'`;
  const sectionTitle = (x: number, y: number, w: number, title: string) => textNode({ x, y, w, h: 11 }, [{ text: title }], {
    font: { family: "var(--fm-display-font)", size_pt: 7.8, weight: 800, color: "var(--fm-primary)", transform: "uppercase" }
  });
  const sectionBody = (x: number, y: number, w: number, h: number, blocks: Array<{ runs: RunSpec[] }>) =>
    textBlocksNode({ x, y, w, h }, blocks, { font: LEGAL_BODY_FONT });
  const infoField = (x: number, y: number, w: number, label: string, key: string) => widgetNode("doc.form_field@1", {
    kind: "text",
    label,
    key,
    value: `{{coalesce(params.customer_info.${key}, '')}}`
  }, { x, y, w, h: 26 });

  const page = asObject((doc.pages as JsonObject[])[0]);
  page.name = "Agreement";
  page.children = [
    // ── Header (inside the Clean theme's 52pt brand bar) ────────────────────
    orgLogoNode({ x: 36, y: 8, w: 120, h: 30 }),
    textBlocksNode({ x: 164, y: 6, w: 216, h: 42 }, [
      { runs: [{ bind: "coalesce(org.name, 'Company')" }], style_ref: "" },
      { runs: [{ bind: "concat(coalesce(params.company_phone, org.branding.phone, ''), '   ', coalesce(params.company_website, org.branding.website, ''))" }] }
    ], { font: { family: "var(--fm-body-font)", size_pt: 8, weight: 700 } }),
    textBlocksNode({ x: 388, y: 6, w: 188, h: 42 }, [
      { runs: [{ text: "License # " }, { bind: fill("params.company_license") }], align: "right" },
      { runs: [{ bind: "coalesce(params.company_address, org.branding.address, '')" }], align: "right" }
    ], { font: { family: "var(--fm-body-font)", size_pt: 7.6, weight: 600 } }),
    // ── Title row ────────────────────────────────────────────────────────────
    textNode({ x: 36, y: 58, w: 360, h: 20 }, [{ text: "RESIDENTIAL ROOFING AGREEMENT" }], {
      font: { family: "var(--fm-display-font)", size_pt: 13, weight: 800, color: "var(--fm-text)" }
    }),
    textNode({ x: 400, y: 60, w: 176, h: 16 }, [
      { text: "Date  " },
      { bind: "coalesce((params.agreement_date | date), '____________')" }
    ], { align: "right", font: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 700 } }),
    // ── Customer information grid (doc.form_field widgets, params-bound) ────
    infoField(36, 84, 150, "Customer name", "name"),
    infoField(192, 84, 100, "Phone", "phone"),
    infoField(298, 84, 156, "Email", "email"),
    infoField(460, 84, 116, "Owner address", "owner_address"),
    infoField(36, 114, 120, "City", "city"),
    infoField(162, 114, 60, "State", "state"),
    infoField(228, 114, 70, "Zip", "zip"),
    infoField(304, 114, 272, "Project address", "project_address"),

    // ── LEFT COLUMN ──────────────────────────────────────────────────────────
    sectionTitle(36, 150, 264, "Existing roof tear-off"),
    sectionBody(36, 163, 264, 44, [
      { runs: [glyph(check("params.spec.tear_cedar")), { text: " Cedar shake   " }, glyph(check("params.spec.tear_shingles")), { text: " Shingles   " }, glyph(check("params.spec.tear_other")), { text: " Other" }] },
      { runs: [glyph(specCheck("tear_off")), { text: " Tear off " }, { bind: fill("params.spec.tear_off_layers", "__") }, { text: " layer(s) of existing roofing" }] },
      specBox("haul_debris", "Haul away and dispose of all roofing debris")
    ]),
    sectionTitle(36, 214, 264, "Deck preparation & ventilation"),
    sectionBody(36, 227, 264, 66, [
      specBox("renail_deck", "Re-nail decking to current code"),
      { runs: [glyph(specCheck("replace_plywood")), { text: " Replace plywood decking — " }, { bind: fill("params.spec.plywood_sheets", "__") }, { text: " sheets" }] },
      { runs: [{ text: "Underlayment:  " }, glyph(underlaymentCheck("synthetic")), { text: " Synthetic  " }, glyph(underlaymentCheck("safeguard")), { text: " Safeguard  " }, glyph(underlaymentCheck("tiger_paw")), { text: " Tiger Paw" }] },
      specBox("ice_water_shield", "Ice & water shield at eaves, valleys & penetrations"),
      { runs: [{ text: "Additional: " }, { bind: fill("params.spec.deck_additional", "________________________________") }] }
    ]),
    sectionTitle(36, 300, 264, "Ventilation"),
    sectionBody(36, 313, 264, 36, [
      specBox("ridge_vent", "Continuous ridge vent"),
      specBox("box_vents", "Box vents"),
      specBox("intake_vents", "Soffit / intake vents")
    ]),
    sectionTitle(36, 356, 264, "Flashing"),
    sectionBody(36, 369, 264, 58, [
      specBox("flashing_valleys", "Open metal valleys"),
      specBox("flashing_pipes", "Pipe flashings"),
      specBox("drip_edge", "Eave & gable drip edge"),
      specBox("counter_flashing", "Counter flashing"),
      specBox("furnace_flashing", "Furnace flashing")
    ]),

    // ── RIGHT COLUMN ─────────────────────────────────────────────────────────
    sectionTitle(312, 150, 264, "Roofing material"),
    sectionBody(312, 163, 264, 50, [
      specBox("install_shingle_system", "Install complete shingle roof system"),
      { runs: [{ text: "Manufacturer: " }, { bind: fill("params.materials.manufacturer", "__________________") }] },
      { runs: [{ text: "Product: " }, { bind: fill("params.materials.product", "____________________") }] },
      { runs: [{ text: "Color: " }, { bind: fill("params.materials.color", "______________________") }] }
    ]),
    sectionTitle(312, 220, 264, "Gutters"),
    sectionBody(312, 233, 264, 36, [
      specBox("gutters_5in", 'Install 5" seamless gutters & downspouts'),
      { runs: [{ text: "Color: " }, { bind: fill("params.materials.gutter_color", "______________________") }] },
      specBox("gutter_covers", "Gutter covers / screens")
    ]),
    sectionTitle(312, 276, 264, "Fascia"),
    sectionBody(312, 289, 264, 36, [
      { runs: [glyph(check("params.spec.fascia_new")), { text: " New fascia   " }, glyph(check("params.spec.fascia_replace")), { text: " Replace damaged sections" }] },
      { runs: [{ text: "Measurements: " }, { bind: fill("params.materials.fascia_measurements", "________________") }] },
      { runs: [{ text: "Material: " }, { bind: fill("params.materials.fascia_material", "____________________") }] }
    ]),
    sectionTitle(312, 332, 264, "Warranty"),
    sectionBody(312, 345, 264, 40, [
      { runs: [glyph("params.materials.warranty_tier == 'standard' ? '☑' : '☐'"), { text: " Standard   " }, glyph("params.materials.warranty_tier == 'extended' ? '☑' : '☐'"), { text: " Extended   " }, glyph("params.materials.warranty_tier == 'premium' ? '☑' : '☐'"), { text: " Premium" }] },
      { runs: [{ text: "Workmanship / labor: " }, { bind: fill("params.materials.labor_years", "____") }, { text: " years" }] },
      { runs: [{ text: "Manufacturer: " }, { bind: fill("params.materials.manufacturer_years", "____") }, { text: " years" }] }
    ]),
    sectionTitle(312, 392, 264, "Additional"),
    textBlocksNode({ x: 312, y: 405, w: 264, h: 118 }, [
      { runs: [{ text: "1. All material is guaranteed to be as specified and all work completed in a workmanlike manner according to standard practices." }] },
      { runs: [{ text: "2. Any alteration or deviation from these specifications involving extra cost becomes an extra charge only upon written change order." }] },
      { runs: [{ text: "3. Agreement contingent upon strikes, accidents, or delays beyond our control; owner to carry fire, tornado, and other necessary insurance." }] },
      { runs: [{ text: "4. Our workers are fully covered by Workman's Compensation insurance." }] },
      { runs: [{ text: "5. This proposal may be withdrawn by us if not accepted within 30 days." }] },
      { runs: [{ text: "6. Balance is due upon completion; past-due balances accrue the maximum finance charge allowed by law." }] },
      { runs: [{ text: "Owner initials: " }, { bind: fill("params.spec.owner_initials", "________") }] }
    ], { font: { family: "var(--fm-body-font)", size_pt: 6.4, color: "var(--fm-color-muted)" } }),

    // ── Notes ────────────────────────────────────────────────────────────────
    sectionTitle(36, 540, 540, "Notes & comments"),
    textBlocksNode({ x: 36, y: 553, w: 540, h: 64 }, [
      { runs: [{ bind: "coalesce(params.notes, '')" }] },
      { runs: [{ bind: "not_empty(coalesce(params.notes, '')) ? '' : '________________________________________________________________________________________________________'" }] },
      { runs: [{ bind: "not_empty(coalesce(params.notes, '')) ? '' : '________________________________________________________________________________________________________'" }] }
    ], { font: LEGAL_BODY_FONT }),

    // ── Footer: representative + signatures (left) ───────────────────────────
    textNode({ x: 36, y: 630, w: 280, h: 14 }, [
      { text: "Representative:  " },
      { bind: fill("params.representative", "______________________") }
    ], { font: { family: "var(--fm-body-font)", size_pt: 8, weight: 700 } }),
    sectionBody(36, 650, 280, 22, [
      box("params.spec.terms_accepted", "I have read and agree to the specifications, terms and conditions above.")
    ]),
    widgetNode("doc.signature@1", { output: "sig_customer", label: "Purchaser signature", signer: "customer" }, { x: 36, y: 678, w: 256, h: 74 }),
    textNode({ x: 36, y: 756, w: 256, h: 12 }, [
      { text: "Date:  " },
      { bind: "coalesce((outputs.sig_customer.signed_at | date), '____________')" }
    ], { font: { family: "var(--fm-body-font)", size_pt: 7.6 } }),
    widgetNode("doc.signature@1", { output: "sig_purchaser2", label: "Co-purchaser signature", signer: "customer" }, { x: 36, y: 774, w: 256, h: 74 }),

    // ── Footer: price panel (right) ──────────────────────────────────────────
    shapeRect({ x: 330, y: 630, w: 246, h: 250, z: 0 }, "color-mix(in srgb, var(--fm-primary) 5%, var(--fm-color-paper))"),
    textBlocksNode({ x: 342, y: 640, w: 222, h: 232 }, [
      // Explicit rep-entered price wins; otherwise the scope-computed total
      // (sum of the enriched scope rows) drives the panel.
      { runs: [{ text: "Contract price   " }, { bind: "computed.contract_price_cents | money" }], style_ref: "" },
      { runs: [{ text: "Tax code  " }, { bind: fill("params.pricing.tax_code", "______") }, { text: "    Rate  " }, { bind: "coalesce(params.pricing.tax_rate_percent, 0)" }, { text: "%" }] },
      { runs: [{ text: "Sales tax   " }, { bind: "computed.contract_tax_cents | money" }] },
      { runs: [{ text: "TOTAL   " }, { bind: "computed.contract_total_cents | money", weight: 800 }] },
      { runs: [{ text: "Amount paid   " }, { bind: "coalesce(params.pricing.amount_paid_cents, 0) | money" }] },
      { runs: [{ text: "Balance due   " }, { bind: "computed.balance_due_cents | money", weight: 800 }] },
      { runs: [{ text: "Due at start   " }, { bind: "coalesce(params.pricing.due_at_start_cents, 0) | money" }] },
      { runs: [{ text: "Balance on completion   " }, { bind: "computed.balance_due_cents | money" }] },
      { runs: [{ text: "Additional services: " }, { bind: fill("params.pricing.additional_services", "____________________") }] },
      box("params.pricing.financed", "Financed — see attached disclosure")
    ], { font: { family: "var(--fm-body-font)", size_pt: 8.2 } }),

    // ── Processing-fee fine print ────────────────────────────────────────────
    textNode({ x: 36, y: 900, w: 540, h: 90 }, [
      { text: "Payment processing: card payments may carry a processing fee of up to 3%; ACH / bank transfer payments carry no processing fee. The balance shown is due per the schedule above. This agreement, together with the specifications and terms printed here, constitutes the entire agreement between the parties; no verbal agreements will be honored. Cancellation within 3 business days of signing entitles the owner to a full refund of any deposit." }
    ], { font: { family: "var(--fm-body-font)", size_pt: 6.5, color: "var(--fm-color-muted)" } })
  ];

  doc.pages = [page];
  // In-order chain (resolveComputed evaluates keys in declaration order):
  // scope subtotal → contract price (explicit override wins, else the scope
  // total) → tax → total → balance.
  doc.computed = {
    scope_subtotal_cents: "sum(params.scope_items[].amount_cents)",
    contract_price_cents: "coalesce(params.pricing.contract_price_cents, computed.scope_subtotal_cents)",
    contract_tax_cents: "round(coalesce(computed.contract_price_cents, 0) * coalesce(params.pricing.tax_rate_percent, 0) / 100)",
    contract_total_cents: "coalesce(computed.contract_price_cents, 0) + computed.contract_tax_cents",
    balance_due_cents: "computed.contract_total_cents - coalesce(params.pricing.amount_paid_cents, 0)"
  };
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    // Scope-driven fill (same native steps as the roofing intake): the
    // workflow builds the scope, service.ts enriches rows to cents and derives
    // params.spec_derived + scope_rows at resolution time.
    scope_pieces: { type: "list", items: { type: "object" }, label: "Project pieces" },
    measurement_requirements: { type: "list", items: { type: "string" }, label: "Required measurements" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, label: "Scope line items" },
    measurements: { type: "measurements", label: "Measurements", default: "{{project.measurements}}" },
    agreement_date: { type: "date", label: "Agreement date" },
    customer_info: { type: "object", label: "Customer information" },
    spec: { type: "object", label: "Job specifications" },
    materials: { type: "object", label: "Materials & warranty" },
    pricing: { type: "object", label: "Contract pricing" },
    notes: { type: "text", label: "Notes & comments" },
    representative: { type: "string", label: "Representative" },
    company_license: { type: "string", label: "License number" },
    company_phone: { type: "string", label: "Company phone" },
    company_website: { type: "string", label: "Company website" },
    company_address: { type: "string", label: "Company address" }
  };
  doc.outputs = {
    sig_customer: { type: "signature", required: true, signer: "customer" },
    sig_purchaser2: { type: "signature", required: false, signer: "customer" }
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Three-option proposal (spec §10.3): one detail page per option (page
// repeat), a 3-column compare summary with a doc.choice_group bound to
// outputs.option_choice, and the standard cover/signature pages. The seeded
// workflow fills params.option_a_items/option_b_items/option_c_items;
// service.ts synthesizes params.proposal_options from those slots.
// ---------------------------------------------------------------------------

function optionSummaryComponents(): JsonObject {
  const miniRow = flowText([
    { bind: "coalesce(item.display_name, item.name)" }
  ], { style_ref: "li_meta" });
  delete miniRow.anchor;
  const selectedBadge = flowText([{ text: "✓ Selected" }], {
    font: { family: "var(--fm-body-font)", size_pt: 8.5, weight: 800, color: "#047857" }
  });
  // outputs.option_choice may be the raw id string or the widget's
  // { option_id } object — coalesce handles both.
  selectedBadge.bind = { if: "coalesce(outputs.option_choice.option_id, outputs.option_choice, '') == option.id" };
  const card = componentColumn([
    flowText([{ bind: "coalesce(option.label, 'Option')" }], {
      font: { family: "var(--fm-display-font)", size_pt: 12, weight: 800, color: "var(--fm-text)" }
    }),
    flowText([{ bind: "coalesce(option.total_cents, 0) | money" }], {
      font: { family: "var(--fm-display-font)", size_pt: 14, weight: 800, color: "var(--fm-primary)" }
    }),
    flowText([{ bind: "coalesce(option.summary, '')" }], {
      font: { family: "var(--fm-body-font)", size_pt: 7.8, color: "var(--fm-color-muted)" }
    }),
    flowRepeater({
      source: "{{coalesce(option.rows, option.items)}}",
      component: "li_mini",
      as: "item",
      layout: { direction: "column", columns: 1, gap_pt: 2 },
      empty_text: ""
    }),
    selectedBadge
  ], { gap: 5, padding: [10, 10, 10, 10], fill: "color-mix(in srgb, var(--fm-primary) 4%, var(--fm-color-paper))" });
  return {
    li_mini: { params: { item: { type: "object" } }, root: miniRow },
    option_summary_card: { params: { option: { type: "object" } }, root: card }
  };
}

function threeOptionProposalTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_margin", "proposal");
  addFlowPage(doc, theme, "cover", "Cover", proposalCoverBlocks("GOOD · BETTER · BEST PROPOSAL"));

  // One DETAIL page per option (page repeat over the enriched options).
  // Optional per-option media strip (option.content_blocks) reuses the
  // media_text_row component; the node is pruned for options without media
  // so an empty repeater never spills a blank continuation page.
  const detailMedia = flowRepeater({
    source: "{{option.content_blocks}}",
    component: "media_text_row",
    as: "block",
    layout: { direction: "column", columns: 1, gap_pt: 14 },
    variant_by_index: ["media_left", "media_right"],
    empty_text: ""
  });
  detailMedia.bind = { if: "count(option.content_blocks) > 0" };
  addFlowPage(doc, theme, "pricing", "Option detail", [
    flowText([{ bind: "coalesce(option.label, 'Option')" }], { style_ref: "h2" }),
    flowText([{ bind: "coalesce(option.summary, '')" }], { font: mutedFont(10) }),
    flowSpacer(4),
    ...lineItemBlocks("{{coalesce(option.rows, option.items)}}", "No line items in this option yet.", [
      flowText([
        { text: "Option total   " },
        { bind: "coalesce(option.total_cents, 0) | money" }
      ], { style_ref: "li_total", align: "right" }),
      detailMedia
    ])
  ], { gap: 4, repeat: { for: "{{params.proposal_options}}", as: "option" } });

  // SUMMARY page: 3-column compare cards + the selectable choice group.
  addFlowPage(doc, theme, "pricing", "Compare options", [
    flowText([{ text: "Compare your options" }], { style_ref: "h2" }),
    flowText([
      { text: "Every option includes full tear-off, cleanup and our workmanship warranty." }
    ], { font: mutedFont(9.5) }),
    flowRepeater({
      source: "{{params.proposal_options}}",
      component: "option_summary_card",
      as: "option",
      layout: { direction: "column", columns: 3, gap_pt: 10 },
      empty_text: "Options appear here once the workflow builds them."
    }),
    // Interactive pick — writes outputs.option_choice; the server derives
    // params.scope_items from the chosen option (solidify). Config options
    // feed straight from the enriched params.proposal_options (id/label/
    // description/price_cents aliases are set during enrichment).
    flowWidget("doc.choice_group@1", {
      title: "Choose your package",
      output_key: "option_choice",
      options: "{{params.proposal_options}}"
    }),
    flowText([
      { text: "Pick a package above — your selection becomes the contract scope and total." }
    ], { style_ref: "caption" })
  ]);

  addFlowPage(doc, theme, "signature", "Sign & Pay", proposalSignatureBlocks());

  doc.styles = { ...lineItemStyles(), ...contentBlockStyles() };
  doc.components = { ...proposalLineItemComponents(), ...mediaTextRowComponent(), ...optionSummaryComponents() };
  // Totals read the SOLIDIFIED scope (outputs.option_choice write-through
  // derives params.scope_items from the chosen option).
  doc.computed = {
    subtotal_cents: "sum(params.scope_items[].amount_cents)",
    adjustments_cents: "sum(params.pricing_adjustments[].amount_cents)",
    tax_cents: "round((computed.subtotal_cents + computed.adjustments_cents) * coalesce(params.tax_percent, 0) / 100)",
    total_cents: "computed.subtotal_cents + computed.adjustments_cents + computed.tax_cents"
  };
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    proposal_options: { type: "list", label: "Proposal options" },
    option_a_items: { type: "list", items: { type: "pricebook_line" }, label: "Option A line items" },
    option_b_items: { type: "list", items: { type: "pricebook_line" }, label: "Option B line items" },
    option_c_items: { type: "list", items: { type: "pricebook_line" }, label: "Option C line items" },
    option_a_label: { type: "string", label: "Option A name", default: "Good" },
    option_b_label: { type: "string", label: "Option B name", default: "Better" },
    option_c_label: { type: "string", label: "Option C name", default: "Best" },
    option_a_summary: { type: "string", label: "Option A summary" },
    option_b_summary: { type: "string", label: "Option B summary" },
    option_c_summary: { type: "string", label: "Option C summary" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, label: "Contract scope (from the chosen option)" },
    content_blocks: { type: "list", label: "Project details" },
    pricing_adjustments: { type: "list", label: "Pricing adjustments" },
    payment_schedule: { type: "payment_schedule", label: "Payment schedule", default: defaultProposalPaymentSchedule() },
    deposit_cents: { type: "currency", label: "Deposit" },
    hero_photo: { type: "media", kinds: ["image"], label: "Hero photo" },
    tax_percent: { type: "percent", label: "Tax percent" }
  };
  doc.outputs = {
    option_choice: { type: "select", required: true },
    sig_customer: { type: "signature", required: true, signer: "customer" },
    deposit_payment: { type: "payment", obligation: "deposit", required_for: "completed" }
  };
  return doc;
}

function roofingCompletionCertificateTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "completion_certificate");
  addFlowPage(doc, theme, "body", "Completion certificate", [
    flowLogo({ w: 150, h: 32 }),
    flowText([{ text: "Roofing Project Completion Certificate" }], { style_ref: "h1" }),
    flowRow([
      labeledText("Project", [
        { text: "", bind: "coalesce(project.title, params.project.title, 'Roofing project')" },
        { text: "\n" },
        { text: "", bind: "coalesce(project.address, params.project.address, '')" }
      ], { grow: 1 }),
      labeledText("Completed", [{ text: "", bind: "params.completed_at | date" }], { w: 164, align: "right" })
    ]),
    flowSpacer(8),
    flowText([{ text: "Work completed" }], { style_ref: "h2" }),
    flowText([
      { text: "", bind: "coalesce(params.work_summary, 'Roofing work was completed in accordance with the approved scope and change orders.')" }
    ], { font: { family: "var(--fm-body-font)", size_pt: 10.5 } }),
    flowSpacer(8),
    flowText([
      { text: "Warranty\n", font: { size_pt: 9, weight: 800 } },
      { text: "", bind: "coalesce(params.warranty_summary, 'Manufacturer and workmanship warranties apply according to the signed agreement.')" }
    ], { font: mutedFont(10) }),
    flowSpacer(16),
    flowRow([
      flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer completion sign-off", signer: "customer" }, { grow: 1, h: 100 }),
      flowWidget("doc.pay_now@1", { output: "final_payment", label: "Final payment", source: "params.final_payment_cents" }, { w: 164, h: 92 })
    ], { gap: 24 }),
    flowSpacer(12),
    flowText([
      { text: "Your signature confirms that the work described above has been presented as complete. It does not waive warranty rights or unresolved written punch-list items." }
    ], { style_ref: "legal" })
  ]);
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    completed_at: { type: "date", label: "Completion date" },
    work_summary: { type: "text", label: "Completed work" },
    warranty_summary: { type: "text", label: "Warranty summary" },
    final_payment_cents: { type: "currency", label: "Final payment" }
  };
  doc.outputs = {
    completion_ack: { type: "select", required: true },
    sig_customer: { type: "signature", required: true, signer: "customer" },
    final_payment: { type: "payment", obligation: "final", required_for: "completed" }
  };
  return doc;
}

function sameDayServiceAgreementTemplateDefinition(): JsonObject {
  const { doc, theme } = startFlowTemplate("thm_clean", "contract");
  addFlowPage(doc, theme, "body", "Service authorization", [
    flowLogo({ w: 150, h: 32 }),
    flowText([{ text: "Same-Day Service Authorization" }], { style_ref: "h1" }),
    flowRow([
      labeledText("Customer", [
        { text: "", bind: "coalesce(customer.name, params.customer.name, 'Customer')" },
        { text: "\n" },
        { text: "", bind: "coalesce(project.address, params.project.address, '')" }
      ], { grow: 1, size_pt: 10.5 }),
      labeledText("Service", [{ text: "", bind: "coalesce(params.service_category, 'Same-day service install')" }], { w: 164, align: "right", size_pt: 10.5 })
    ]),
    flowText([
      { text: "Diagnosis & proposed work\n", font: { size_pt: 9, weight: 800 } },
      { text: "", bind: "coalesce(params.diagnosis, 'Service work described below will be completed today.')" }
    ], { font: mutedFont(9.5) }),
    flowWidget("doc.line_items@1", { source: "params.scope_items", show_prices: true, depth: 1, columns: ["name", "description", "qty", "unit_price", "amount"] }),
    flowText([
      { text: "Authorized total   ", font: { size_pt: 9, weight: 800, color: "var(--fm-color-muted)" } },
      { text: "", bind: "computed.total_cents | money", font: { size_pt: 16, weight: 900 } }
    ], { font: { family: "var(--fm-display-font)" }, align: "right" }),
    flowText([{ text: "By signing, the customer authorizes the listed materials and labor at the quoted rates and directs the technician to begin work today. Additional work requires approval. Payment is due before work begins unless otherwise agreed in writing." }], { style_ref: "legal" }),
    flowSpacer(8),
    flowRow([
      flowWidget("doc.pay_now@1", { output: "payment", output_key: "payment", label: "Payment", amount_label: "Amount due", source: "computed.total_cents", button_label: "Pay" }, { w: 180, h: 108 }),
      flowWidget("doc.signature@1", { output: "sig_customer", label: "Customer authorization", signer: "customer" }, { grow: 1, h: 108 })
    ], { gap: 24 })
  ]);
  doc.computed = { total_cents: "sum(params.scope_items[].amount_cents)" };
  doc.params = {
    project: { type: "entity", entity: "project" },
    customer: { type: "entity", entity: "contact" },
    service_category: { type: "string", label: "Service type" },
    diagnosis: { type: "text", label: "Diagnosis and proposed work" },
    scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Materials and labor quote" }
  };
  doc.outputs = {
    payment: { type: "payment", obligation: "full", required_for: "completed" },
    sig_customer: { type: "signature", required: true, signer: "customer" }
  };
  return doc;
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

/**
 * Flagship intake workflow (spec §4), fully NATIVE stepper steps:
 * piece-type selection cards (piece_select — the scope templates' proposal
 * piece vocabulary), measurements derived from the SELECTED pieces (only
 * shown when the selection needs any), a generated line-items review list
 * (line_items_review — selection + measurements → pricebook-driven
 * root_items), customer options, then review with the live template preview.
 * No legacy builder UI is embedded anywhere. The customer audience sees only
 * options + review in the portal wizard.
 */
function roofingProposalIntakeWorkflowDefinition(): JsonObject {
  return {
    schema_version: 1,
    name: "Roofing proposal intake",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        // Selected proposal piece types (scope-template vocabulary) — drives
        // which later steps appear and what generation produces.
        scope_pieces: { type: "list", items: { type: "object" }, label: "Project pieces" },
        // Measurement keys the selected pieces' pricing formulas reference —
        // written by the piece_select renderer, read by st_measure's `when`.
        measurement_requirements: { type: "list", items: { type: "string" }, label: "Required measurements" },
        scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Scope line items" },
        measurements: { type: "measurements", label: "Measurements" },
        payment_schedule: { type: "payment_schedule", label: "Payment schedule" },
        deposit_cents: { type: "currency", label: "Deposit" },
        hero_photo: { type: "media", kinds: ["image"], label: "Hero photo" },
        tax_percent: { type: "percent", label: "Tax percent" },
        // Spec §10.1: workflow-editable media + text rows for the template's
        // "Project details" page.
        content_blocks: { type: "list", label: "Project details" }
      },
      outputs: {
        sig_customer: { type: "signature", required: true, signer: "customer" },
        selections: { type: "select", from_widget: "doc.line_items" },
        deposit_payment: { type: "payment", obligation: "deposit", required_for: "completed" }
      }
    },
    steps: [
      {
        id: "st_what",
        title: "What are we doing?",
        audience: ["internal"],
        items: [
          {
            kind: "piece_select",
            writes: "params.scope_pieces",
            required: true,
            label: "What are we doing?",
            description: "Pick one or more project types — pricing follows the pricebook.",
            presentation: { multi: true }
          }
        ]
      },
      {
        id: "st_measure",
        title: "Measurements",
        audience: ["internal"],
        // Only when the SELECTED pieces' pricing formulas need measurements
        // (maintenance-style scopes skip straight to line items). Collected
        // exactly once, here — generation consumes params.measurements.
        when: "{{count(params.measurement_requirements) > 0}}",
        auto_skip_when_complete: true,
        items: [
          {
            kind: "measurements",
            writes: "params.measurements",
            fields_from: "measurement_requirements",
            prefill: "project.measurements"
          }
        ]
      },
      {
        id: "st_items",
        title: "Line items",
        audience: ["internal"],
        items: [
          {
            kind: "line_items_review",
            writes: "params.scope_items",
            required: true,
            label: "Line items",
            description: "Generated from your selection and measurements — adjust quantities and prices, remove rows, or add more. Conditional pricing examples (ACH discount, card processing fee, early-signing discount) are seeded as pricing adjustments and activate automatically at checkout."
          }
        ]
      },
      {
        id: "st_details",
        title: "Project details",
        audience: ["internal"],
        items: [
          {
            kind: "content_blocks",
            writes: "params.content_blocks",
            label: "Project details",
            description: "Photos, videos and text blocks for the proposal's Project details page — layouts alternate automatically, popup media opens in a lightbox."
          }
        ]
      },
      {
        id: "st_options",
        title: "Customer options",
        audience: ["internal", "customer"],
        items: [
          {
            kind: "choice_group",
            writes: "outputs.selections",
            label: "Choose your options",
            // The customer-facing options ARE the scope's choice groups
            // (shingle profile, underlayment, optional add-ons) — derived
            // live from params.scope_items, never a detached catalog list.
            // Internal reps set defaults on the items; customers record
            // picks as outputs.selections.
            options_from: "scope_items",
            presentation: { style: "cards", images: true }
          }
        ]
      },
      {
        id: "st_review",
        title: "Review & send",
        kind: "review",
        audience: ["internal", "customer"],
        items: [
          { kind: "review", presentation: { live: true } }
        ],
        preview: { template_ref: "tpl_proposal_default", live: true }
      }
    ],
    audiences: {
      internal: {},
      customer: { theme: "portal", hide_steps: ["st_what", "st_measure", "st_items", "st_details"] }
    }
  };
}

/**
 * Scope-driven fill workflow for the one-page legal agreement. It STARTS with
 * the same native scope steps as the roofing intake (piece_select →
 * measurements → line_items_review) so the agreement's spec checkboxes and
 * contract price derive from the priced scope (service.ts writes
 * params.spec_derived + the scope-computed total at resolution). The later
 * spec/pricing steps are OVERRIDES: params.spec.* / params.pricing.* beat the
 * derived values wherever set. Purely internal except the final review step
 * (customers sign on the document itself).
 */
function onePageLegalWorkflowDefinition(): JsonObject {
  const bool = (key: string, label: string) => ({ kind: "boolean", writes: `params.spec.${key}`, label });
  return {
    schema_version: 1,
    name: "One-page agreement fill",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        // Native scope steps (roofing-intake pattern): selected piece types,
        // the measurement keys their pricing formulas need, and the generated
        // scope line items the agreement derives from.
        scope_pieces: { type: "list", items: { type: "object" }, label: "Project pieces" },
        measurement_requirements: { type: "list", items: { type: "string" }, label: "Required measurements" },
        scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Scope line items" },
        measurements: { type: "measurements", label: "Measurements" },
        customer_info: { type: "object", label: "Customer information" },
        spec: { type: "object", label: "Job specifications" },
        materials: { type: "object", label: "Materials & warranty" },
        pricing: { type: "object", label: "Contract pricing" },
        notes: { type: "text", label: "Notes & comments" },
        representative: { type: "string", label: "Representative" },
        agreement_date: { type: "date", label: "Agreement date" }
      },
      outputs: {
        sig_customer: { type: "signature", required: true, signer: "customer" }
      }
    },
    steps: [
      {
        id: "st_what",
        title: "What are we doing?",
        audience: ["internal"],
        items: [
          {
            kind: "piece_select",
            writes: "params.scope_pieces",
            required: true,
            label: "What are we doing?",
            description: "Pick one or more project types — pricing follows the pricebook.",
            presentation: { multi: true }
          }
        ]
      },
      {
        id: "st_measure",
        title: "Measurements",
        audience: ["internal"],
        // Only when the SELECTED pieces' pricing formulas need measurements —
        // collected exactly once, here; generation consumes params.measurements.
        when: "{{count(params.measurement_requirements) > 0}}",
        auto_skip_when_complete: true,
        items: [
          {
            kind: "measurements",
            writes: "params.measurements",
            fields_from: "measurement_requirements",
            prefill: "project.measurements"
          }
        ]
      },
      {
        id: "st_items",
        title: "Line items",
        audience: ["internal"],
        items: [
          {
            kind: "line_items_review",
            writes: "params.scope_items",
            required: true,
            label: "Line items",
            description: "Generated from your selection and measurements — the agreement's specification checkboxes and contract price derive from these rows."
          }
        ]
      },
      {
        id: "st_customer",
        title: "Customer information",
        audience: ["internal"],
        items: [
          { kind: "date", writes: "params.agreement_date", label: "Agreement date" },
          { kind: "text", writes: "params.customer_info.name", label: "Customer name" },
          { kind: "text", writes: "params.customer_info.phone", label: "Phone" },
          { kind: "text", writes: "params.customer_info.email", label: "Email" },
          { kind: "text", writes: "params.customer_info.owner_address", label: "Owner address" },
          { kind: "text", writes: "params.customer_info.city", label: "City" },
          { kind: "text", writes: "params.customer_info.state", label: "State" },
          { kind: "text", writes: "params.customer_info.zip", label: "Zip" },
          { kind: "text", writes: "params.customer_info.project_address", label: "Project address" }
        ]
      },
      {
        id: "st_specs",
        title: "Job specifications",
        audience: ["internal"],
        description: "These checkboxes auto-derive from the scope line items — set one here only to override the derived value.",
        items: [
          bool("tear_off", "Tear off existing roofing"),
          bool("tear_shingles", "Existing roof is shingles"),
          bool("tear_cedar", "Existing roof is cedar shake"),
          { kind: "number", writes: "params.spec.tear_off_layers", label: "Layers to tear off" },
          bool("haul_debris", "Haul away all debris"),
          bool("renail_deck", "Re-nail decking to code"),
          bool("replace_plywood", "Replace plywood decking"),
          { kind: "number", writes: "params.spec.plywood_sheets", label: "Plywood sheets" },
          { kind: "select", writes: "params.spec.underlayment", label: "Underlayment", options: ["synthetic", "safeguard", "tiger_paw"] },
          bool("ice_water_shield", "Ice & water shield"),
          { kind: "text", writes: "params.spec.deck_additional", label: "Additional deck prep" },
          bool("ridge_vent", "Continuous ridge vent"),
          bool("box_vents", "Box vents"),
          bool("intake_vents", "Soffit / intake vents"),
          bool("flashing_valleys", "Open metal valleys"),
          bool("flashing_pipes", "Pipe flashings"),
          bool("drip_edge", "Eave & gable drip edge"),
          bool("counter_flashing", "Counter flashing"),
          bool("furnace_flashing", "Furnace flashing"),
          bool("gutters_5in", 'Install 5" seamless gutters'),
          bool("gutter_covers", "Gutter covers / screens"),
          bool("fascia_new", "New fascia"),
          bool("fascia_replace", "Replace damaged fascia"),
          bool("install_shingle_system", "Install complete shingle system")
        ]
      },
      {
        id: "st_materials",
        title: "Materials & warranty",
        audience: ["internal"],
        items: [
          { kind: "text", writes: "params.materials.manufacturer", label: "Manufacturer" },
          { kind: "text", writes: "params.materials.product", label: "Product" },
          { kind: "text", writes: "params.materials.color", label: "Color" },
          { kind: "text", writes: "params.materials.gutter_color", label: "Gutter color" },
          { kind: "text", writes: "params.materials.fascia_measurements", label: "Fascia measurements" },
          { kind: "text", writes: "params.materials.fascia_material", label: "Fascia material" },
          { kind: "select", writes: "params.materials.warranty_tier", label: "Warranty tier", options: ["standard", "extended", "premium"] },
          { kind: "number", writes: "params.materials.labor_years", label: "Labor warranty (years)" },
          { kind: "number", writes: "params.materials.manufacturer_years", label: "Manufacturer warranty (years)" }
        ]
      },
      {
        id: "st_pricing",
        title: "Pricing",
        audience: ["internal"],
        items: [
          { kind: "currency", writes: "params.pricing.contract_price_cents", label: "Contract price", description: "Leave blank to use the scope-computed total from the line items." },
          { kind: "text", writes: "params.pricing.tax_code", label: "Tax code" },
          { kind: "number", writes: "params.pricing.tax_rate_percent", label: "Tax rate (%)" },
          { kind: "currency", writes: "params.pricing.amount_paid_cents", label: "Amount paid" },
          { kind: "currency", writes: "params.pricing.due_at_start_cents", label: "Due at start" },
          { kind: "text", writes: "params.pricing.additional_services", label: "Additional services" },
          { kind: "boolean", writes: "params.pricing.financed", label: "Financed" }
        ]
      },
      {
        id: "st_notes",
        title: "Notes & representative",
        audience: ["internal"],
        items: [
          { kind: "text", writes: "params.notes", label: "Notes & comments" },
          { kind: "text", writes: "params.representative", label: "Representative name" }
        ]
      },
      {
        id: "st_review",
        title: "Review & send",
        kind: "review",
        audience: ["internal", "customer"],
        items: [{ kind: "review", presentation: { live: true } }],
        preview: { template_ref: "tpl_one_page_legal", live: true }
      }
    ],
    audiences: {
      internal: {},
      customer: { theme: "portal", hide_steps: ["st_what", "st_measure", "st_items", "st_customer", "st_specs", "st_materials", "st_pricing", "st_notes"] }
    }
  };
}

/**
 * Three-option proposal workflow (spec §10.3). Client kinds cannot write
 * array indices, so each option is a plain line_items_review writing its own
 * slot param (option_a_items/...); service.ts synthesizes
 * params.proposal_options from the slots at resolve/solidify time. Customers
 * see only the compare/choose step and the live review.
 */
function threeOptionProposalWorkflowDefinition(): JsonObject {
  const optionStep = (slot: "a" | "b" | "c", fallback: string) => ({
    id: `st_option_${slot}`,
    title: `Option ${slot.toUpperCase()} — ${fallback}`,
    audience: ["internal"],
    // Option A is always visible; B and C only appear once their slot holds
    // items (the document rail card's "Add variant" fills a slot, and the
    // runtime re-evaluates `when` on every write, revealing the step live).
    ...(slot === "a" ? {} : { when: `{{not_empty(params.option_${slot}_items)}}` }),
    items: [
      { kind: "text", writes: `params.option_${slot}_label`, label: "Option name", description: `Shown as the option heading (defaults to "${fallback}").` },
      { kind: "text", writes: `params.option_${slot}_summary`, label: "One-line summary" },
      {
        kind: "line_items_review",
        writes: `params.option_${slot}_items`,
        required: slot === "a",
        label: `Option ${slot.toUpperCase()} line items`,
        description: "Build this option's scope — pricing follows the pricebook."
      }
    ]
  });
  return {
    schema_version: 1,
    name: "Three-option proposal",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        option_a_items: { type: "list", items: { type: "pricebook_line" }, label: "Option A line items" },
        option_b_items: { type: "list", items: { type: "pricebook_line" }, label: "Option B line items" },
        option_c_items: { type: "list", items: { type: "pricebook_line" }, label: "Option C line items" },
        option_a_label: { type: "string", label: "Option A name" },
        option_b_label: { type: "string", label: "Option B name" },
        option_c_label: { type: "string", label: "Option C name" },
        option_a_summary: { type: "string", label: "Option A summary" },
        option_b_summary: { type: "string", label: "Option B summary" },
        option_c_summary: { type: "string", label: "Option C summary" },
        proposal_options: { type: "list", label: "Assembled options" },
        scope_items: { type: "list", label: "Contract scope" },
        hero_photo: { type: "media", kinds: ["image"], label: "Hero photo" },
        tax_percent: { type: "percent", label: "Tax percent" }
      },
      outputs: {
        option_choice: { type: "select", required: true },
        sig_customer: { type: "signature", required: true, signer: "customer" },
        deposit_payment: { type: "payment", obligation: "deposit", required_for: "completed" }
      }
    },
    steps: [
      optionStep("a", "Good"),
      optionStep("b", "Better"),
      optionStep("c", "Best"),
      {
        id: "st_choice",
        title: "Choose a package",
        audience: ["internal", "customer"],
        items: [
          {
            kind: "choice_group",
            writes: "outputs.option_choice",
            required: true,
            label: "Choose your package",
            // Options derive from the assembled proposal_options (enriched
            // with per-option totals), never a detached list.
            options_from: "params.proposal_options",
            presentation: { style: "cards" }
          }
        ]
      },
      {
        id: "st_review",
        title: "Review & send",
        kind: "review",
        audience: ["internal", "customer"],
        items: [{ kind: "review", presentation: { live: true } }],
        preview: { template_ref: "tpl_three_option_proposal", live: true }
      }
    ],
    audiences: {
      internal: {},
      customer: { theme: "portal", hide_steps: ["st_option_a", "st_option_b", "st_option_c"] }
    }
  };
}

function sameDayServiceFieldWorkflowDefinition(): JsonObject {
  return {
    schema_version: 1,
    name: "Same-day service visit",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        service_category: { type: "string", label: "Service type" },
        diagnosis: { type: "text", label: "Diagnosis and proposed work" },
        scope_items: { type: "list", items: { type: "pricebook_line" }, required: true, label: "Materials and labor quote" }
      },
      outputs: {
        payment: { type: "payment", obligation: "full", required_for: "completed" },
        sig_customer: { type: "signature", required: true, signer: "customer" }
      }
    },
    steps: [
      {
        id: "st_diagnosis",
        title: "Assess the service",
        navigation_title: "Assess",
        description: "Document what you found before building the on-site quote.",
        audience: ["field"],
        items: [
          { kind: "select", writes: "params.service_category", required: true, label: "Service type", options: ["Same-day equipment install", "Emergency repair", "Accessory replacement", "Preventive service"] },
          { kind: "text", writes: "params.diagnosis", required: true, label: "Diagnosis and recommended work", description: "Use customer-friendly language; this appears on the authorization.", presentation: { style: "multiline" } }
        ]
      },
      {
        id: "st_quote",
        title: "Build the quote",
        navigation_title: "Quote",
        description: "Enter materials, estimated labor hours, and the labor rate. The authorization total updates from these rows.",
        audience: ["field"],
        items: [
          { kind: "line_item_editor", writes: "params.scope_items", required: true, label: "Materials and labor", description: "For labor, use quantity for estimated hours and unit price for the hourly rate." }
        ]
      },
      {
        id: "st_review",
        title: "Confirm with the customer",
        navigation_title: "Confirm",
        description: "Check the estimate, then open the customer authorization to take payment and sign.",
        audience: ["field"],
        items: [{ kind: "review", presentation: { live: false } }]
      }
    ],
    audiences: { field: { theme: "portal" } }
  };
}

function roofingCompletionSignoffWorkflowDefinition(): JsonObject {
  return {
    schema_version: 1,
    name: "Roofing completion sign-off",
    contract: {
      params: {
        project: { type: "entity", entity: "project" },
        customer: { type: "entity", entity: "contact" },
        completed_at: { type: "date", label: "Completion date" },
        work_summary: { type: "text", label: "Completed work" },
        warranty_summary: { type: "text", label: "Warranty summary" },
        final_payment_cents: { type: "currency", label: "Final payment" }
      },
      outputs: {
        completion_ack: { type: "select", required: true },
        sig_customer: { type: "signature", required: true, signer: "customer" },
        final_payment: { type: "payment", obligation: "final", required_for: "completed" }
      }
    },
    steps: [
      {
        id: "st_completion_review",
        title: "Review completed work",
        audience: ["customer"],
        items: [{
          kind: "choice_group",
          writes: "outputs.completion_ack",
          required: true,
          label: "Completion review",
          options: [
            { id: "accepted", label: "The work is complete", description: "Everything in the approved scope has been completed and I am ready to review the certificate." },
            { id: "needs_follow_up", label: "I need follow-up before signing", description: "Something still needs attention. Notify the project team and pause the final sign-off." }
          ],
          presentation: { style: "cards" }
        }]
      },
      {
        id: "st_completion_document",
        title: "Review certificate",
        kind: "review",
        audience: ["customer"],
        items: [{ kind: "review", presentation: { live: true } }],
        preview: { template_ref: "tpl_roofing_completion_certificate", live: true }
      },
      {
        id: "st_completion_sign",
        title: "Sign & finish",
        audience: ["customer"],
        items: [
          { kind: "signature", writes: "outputs.sig_customer", required: true, label: "Customer completion signature" },
          { kind: "payment", writes: "outputs.final_payment", label: "Final payment" }
        ]
      }
    ],
    audiences: { internal: {}, customer: { theme: "portal" } }
  };
}

function roofingCustomerWorkflowOnlyDefinition(): JsonObject {
  const definition = threeOptionProposalWorkflowDefinition();
  definition.name = "Roofing choices, signature & payment";
  const steps = (Array.isArray(definition.steps) ? definition.steps : []).map((value) => {
    const step = asObject(value);
    if (!cleanText(step.id).startsWith("st_option_")) return step;
    // The salesperson configures all three packages in the field phase. The
    // customer audience still hides these setup pages and begins at choice.
    const { when: _when, ...visible } = step;
    return { ...visible, audience:["internal", "field"] };
  });
  definition.steps = [
    ...steps,
    {
      id: "st_sign",
      title: "Sign approval",
      audience: ["customer"],
      items: [{ kind: "signature", writes: "outputs.sig_customer", required: true, label: "Customer approval signature", description: "Sign to approve the roofing package selected above." }]
    },
    {
      id: "st_payment",
      title: "Pay deposit",
      audience: ["customer"],
      items: [{ kind: "payment", writes: "outputs.deposit_payment", required: true, label: "Roofing deposit", config: { source: "params.deposit_cents", amount_label: "Deposit due" } }]
    }
  ];
  return definition;
}

// ---------------------------------------------------------------------------
// Ensure flow (preset_revision upgrade pattern from scopes/storage.ts)
// ---------------------------------------------------------------------------

type ThemeSeed = { id: string; name: string; description: string; definition: () => JsonObject };
type TemplateSeed = { id: string; name: string; document_type: string; description: string; definition: () => JsonObject; metadata?: JsonObject };
type WorkflowSeed = { id: string; name: string; description: string; definition: () => JsonObject };

export const THEME_SEEDS: ThemeSeed[] = [
  { id: "thm_margin", name: "Margin", description: "Bold full-height brand rail on the left of every page.", definition: marginThemeDefinition },
  { id: "thm_triangles", name: "Triangles", description: "Corner triangle accents with a bold cover treatment.", definition: trianglesThemeDefinition },
  { id: "thm_clean", name: "Clean", description: "Minimal header bar with a brand rule.", definition: cleanThemeDefinition }
];

export const TEMPLATE_SEEDS: TemplateSeed[] = [
  {
    id: "tpl_proposal_default",
    name: "Standard Proposal",
    document_type: "proposal",
    description: "Cover, pricing, signature and terms pages.",
    definition: proposalTemplateDefinition,
    // Templates may pin their own workflow; instance creation prefers this
    // over the type's default_workflow_id.
    metadata: { default_workflow_id: "wfl_roofing_proposal_intake" }
  },
  { id: "tpl_invoice_default", name: "Standard Invoice", document_type: "invoice", description: "Single-page invoice with line items and pay-now.", definition: invoiceTemplateDefinition },
  { id: "tpl_change_order_default", name: "Standard Change Order", document_type: "change_order", description: "Change scope summary with customer approval page.", definition: changeOrderTemplateDefinition },
  { id: "tpl_money_report_default", name: "Job Cost Report", document_type: "report", description: "Internal job cost report: money metrics, expense breakdown, payment history.", definition: moneyReportTemplateDefinition },
  { id: "tpl_payroll_report_default", name: "Standard Payroll Report", document_type: "payroll_report", description: "Branded payroll report with configurable columns and rows.", definition: payrollReportTemplateDefinition },
  { id: "tpl_payment_receipt_default", name: "Standard Payment Receipt", document_type: "payment_receipt", description: "Branded receipt for a recorded customer payment.", definition: paymentReceiptTemplateDefinition },
  {
    id: "tpl_one_page_legal",
    name: "One-Page Roofing Agreement",
    document_type: "contract",
    description: "Classic single-page roofing agreement on legal paper: checkbox specifications, materials, warranty, price panel and signatures.",
    definition: onePageLegalTemplateDefinition,
    metadata: { default: true, default_workflow_id: "wfl_one_page_legal" }
  },
  {
    id: "tpl_three_option_proposal",
    name: "Three-Option Proposal",
    document_type: "proposal",
    description: "Good / Better / Best proposal: one detail page per option plus a compare-and-choose summary.",
    definition: threeOptionProposalTemplateDefinition,
    // NOT the type default — tpl_proposal_default keeps that slot; instances
    // opt in via template_id.
    metadata: { default: false, default_workflow_id: "wfl_three_option_proposal" }
  },
  {
    id: "tpl_roofing_good_better_best_workflow",
    name: "Roofing Good / Better / Best — Workflow",
    document_type: "proposal",
    description: "Workflow-only Good/Better/Best roofing selection, signature and deposit experience with no document pages.",
    definition: threeOptionProposalTemplateDefinition,
    metadata: {
      default: false,
      default_workflow_id: "wfl_roofing_customer_workflow",
      customer_presentation: { tab: { id: "documents", label: "Documents", icon: "fa-file-lines", order: 60 }, mode: "workflow", workflow_cta: "Complete roofing approval" }
    }
  },
  {
    id: "tpl_roofing_completion_certificate",
    name: "Roofing Completion Certificate",
    document_type: "completion_certificate",
    description: "Customer completion review, certificate signature and optional final-payment workflow.",
    definition: roofingCompletionCertificateTemplateDefinition,
    metadata: {
      default: true,
      disable_default_workflow: true,
      customer_presentation: { tab: { id: "sign_off", label: "Sign-Off", icon: "fa-flag-checkered", order: 70 }, mode: "document", document_cta: "Review certificate & sign" }
    }
  },
  {
    id: "tpl_kitchen_estimate",
    name: "Kitchen Remodel Estimate",
    document_type: "proposal",
    description: "Base kitchen remodel estimate with allowance line items; document-only sign & deposit.",
    definition: proposalTemplateDefinition,
    metadata: {
      default: false,
      disable_default_workflow: true,
      customer_presentation: { tab: { id: "proposals", label: "Proposals", icon: "fa-file-signature", order: 50 }, mode: "document", document_cta: "Review estimate, sign & pay deposit" }
    }
  },
  {
    id: "tpl_kitchen_selections",
    name: "Kitchen Finish Selections",
    document_type: "change_order",
    description: "Customer material selections against allowances; upgrades append to the payment schedule.",
    definition: kitchenSelectionsTemplateDefinition,
    metadata: {
      default: false,
      default_workflow_id: "wfl_kitchen_selections",
      customer_presentation: { tab: { id: "selections", label: "Selections", icon: "fa-swatchbook", order: 55 }, mode: "workflow", workflow_cta: "Make your selections", auto_open: true }
    }
  },
  {
    id: "tpl_roofing_paper_upload",
    name: "Roofing Contract — Paper Upload",
    document_type: "contract",
    description: "Upload a signed (or unsigned) paper roofing contract; the agent extracts these fields for review.",
    definition: () => uploadTemplateDefinition("Roofing Contract — Paper Upload", {
      customer_name: { type: "string", label: "Customer name", required: true },
      property_address: { type: "string", label: "Property address" },
      contract_date: { type: "date", label: "Contract date" },
      shingle_selection: { type: "string", label: "Shingle brand & color" },
      total_cents: { type: "currency", label: "Contract total" },
      deposit_cents: { type: "currency", label: "Deposit" },
      material_notes: { type: "text", label: "Materials & selections notes" }
    }, {
      sig_customer: { type: "signature", required: true, signer: "customer", label: "Customer signature" },
      sig_company: { type: "signature", signer: "internal", label: "Company signature" }
    }),
    metadata: { default: false, intake: "upload", disable_default_workflow: true }
  },
  {
    id: "tpl_same_day_service_authorization",
    name: "Same-Day Service Authorization",
    document_type: "contract",
    description: "Mobile-first on-site materials and labor quote, full payment, and customer authorization.",
    definition: sameDayServiceAgreementTemplateDefinition,
    metadata: {
      default: false,
      default_workflow_id: "wfl_same_day_service_field",
      customer_presentation: { tab: { id: "documents", label: "Documents", icon: "fa-file-lines", order: 60 }, mode: "hybrid", workflow_cta: "Review service estimate" }
    }
  }
];

/**
 * Presets that are no longer seeded: aliases that re-published the standard
 * and three-option proposals under other names. Unedited copies are archived
 * so they leave the template picker; documents already created from them
 * keep resolving their pinned version.
 */
export const RETIRED_TEMPLATE_IDS = [
  "tpl_roofing_selection_to_document",
  "tpl_roofing_signature_payment",
  "tpl_roofing_good_better_best_document"
];

export const WORKFLOW_SEEDS: WorkflowSeed[] = [
  {
    id: "wfl_roofing_proposal_intake",
    name: "Roofing proposal intake",
    description: "Scope, measurements, project details, customer options and live review for roofing proposals.",
    definition: roofingProposalIntakeWorkflowDefinition
  },
  {
    id: "wfl_one_page_legal",
    name: "One-page agreement fill",
    description: "Scope-driven fill for the one-page roofing agreement: pieces, measurements and line items drive the spec checkboxes and price; customer info, overrides, materials and notes follow.",
    definition: onePageLegalWorkflowDefinition
  },
  {
    id: "wfl_three_option_proposal",
    name: "Three-option proposal",
    description: "Build Good/Better/Best options, let the customer compare and choose, then sign.",
    definition: threeOptionProposalWorkflowDefinition
  },
  {
    id: "wfl_roofing_completion_signoff",
    name: "Roofing completion sign-off",
    description: "Customer completion review, certificate signature and final payment.",
    definition: roofingCompletionSignoffWorkflowDefinition
  },
  {
    id: "wfl_roofing_customer_workflow",
    name: "Roofing choices, signature & payment",
    description: "Customer-only Good/Better/Best selection followed by an approval signature and deposit payment.",
    definition: roofingCustomerWorkflowOnlyDefinition
  },
  {
    id: "wfl_kitchen_selections",
    name: "Kitchen finish selections",
    description: "Customer chooses allowance materials per group, reviews the delta, and signs; upgrades bill on the next invoice.",
    definition: kitchenSelectionsWorkflowDefinition
  },
  {
    id: "wfl_same_day_service_field",
    name: "Same-day service visit",
    description: "Mobile field assessment and materials/labor estimate that hands off to payment and customer authorization.",
    definition: sameDayServiceFieldWorkflowDefinition
  }
];

const ensuring = new Set<string>();
const ensured = new Map<string, number>();
const ENSURE_TTL_MS = 60_000;

function presetMetadata(seedId: string) {
  return { preset: true, preset_id: seedId, preset_revision: DOCUMENT_PRESET_REVISION };
}

function needsUpgrade(existing: JsonObject | null) {
  if (!existing) return true;
  const metadata = asObject(existing.metadata);
  if (metadata.preset !== true) return false; // org edited the preset — never overwrite
  return Number(metadata.preset_revision || 0) < DOCUMENT_PRESET_REVISION || Number(existing.current_version || 0) === 0;
}

/**
 * Seed (or upgrade) the default themes and templates for an org. Called
 * lazily from the API on the first template/theme/catalog read. Safe to call
 * repeatedly; a short TTL avoids re-reading collections on every request.
 */
export async function ensureDefaultDocumentAssets(orgId: string, ctx: PlatformAuthContext | null = null) {
  const key = cleanText(orgId);
  if (!key || ensuring.has(key)) return;
  const last = ensured.get(key) || 0;
  if (Date.now() - last < ENSURE_TTL_MS) return;
  ensuring.add(key);
  try {
    const companyThemeDefinition = async (definition: JsonObject) =>
      await themeDefinitionWithOrganizationDefaults(orgId, definition, "default");
    for (const seed of THEME_SEEDS) {
      const existing = await readDocumentTheme(orgId, seed.id).catch(() => null);
      if (!existing) {
        await createDocumentTheme(orgId, {
          id: seed.id,
          name: seed.name,
          description: seed.description,
          status: "active",
          definition: await companyThemeDefinition(seed.definition()),
          metadata: presetMetadata(seed.id)
        }, ctx, { systemPreset: true });
      } else if (needsUpgrade(existing)) {
        await publishDocumentTheme(orgId, seed.id, {
          definition: await companyThemeDefinition(seed.definition()),
          expected_version: Number(existing.current_version || 0),
          metadata: presetMetadata(seed.id)
        }, ctx, { systemPreset: true }).catch(() => null);
      }
    }
    // Repair user themes created at v1 by revision 23, which accidentally used
    // the third palette swatch as Accent. Version >1 means the org has already
    // edited the theme, so it must be left alone.
    const themes = await listDocumentThemes(orgId);
    for (const theme of themes) {
      if (asObject(theme.metadata).preset === true || Number(theme.current_version || 0) !== 1) continue;
      const version = await readDocumentThemeVersion(orgId, cleanText(theme.id), 1).catch(() => null);
      const repaired = repairIncorrectCompanyAccent(asObject(asObject(version).definition));
      if (!repaired) continue;
      await publishDocumentTheme(orgId, cleanText(theme.id), {
        definition: repaired,
        expected_version: 1,
        metadata: { company_accent_repaired: true }
      }, ctx, { systemPreset: true }).catch(() => null);
    }
    for (const seed of WORKFLOW_SEEDS) {
      const existing = await readDocumentWorkflow(orgId, seed.id).catch(() => null);
      if (!existing) {
        await createDocumentWorkflow(orgId, {
          id: seed.id,
          name: seed.name,
          description: seed.description,
          status: "active",
          definition: seed.definition(),
          metadata: presetMetadata(seed.id)
        }, ctx, { systemPreset: true });
      } else if (needsUpgrade(existing)) {
        await publishDocumentWorkflow(orgId, seed.id, {
          definition: seed.definition(),
          expected_version: Number(existing.current_version || 0),
          metadata: presetMetadata(seed.id)
        }, ctx, { systemPreset: true }).catch(() => null);
      }
    }
    for (const seed of TEMPLATE_SEEDS) {
      const existing = await readDocumentTemplate(orgId, seed.id).catch(() => null);
      if (!existing) {
        await createDocumentTemplate(orgId, {
          id: seed.id,
          name: seed.name,
          document_type: seed.document_type,
          description: seed.description,
          status: "active",
          definition: seed.definition(),
          metadata: { ...presetMetadata(seed.id), default: true, ...asObject(seed.metadata) }
        }, ctx, { systemPreset: true });
      } else if (needsUpgrade(existing)) {
        await publishDocumentTemplate(orgId, seed.id, {
          definition: seed.definition(),
          expected_version: Number(existing.current_version || 0),
          metadata: { ...presetMetadata(seed.id), ...asObject(seed.metadata) }
        }, ctx, { systemPreset: true }).catch(() => null);
      }
    }
    for (const id of RETIRED_TEMPLATE_IDS) {
      const existing = await readDocumentTemplate(orgId, id).catch(() => null);
      if (existing && asObject(existing.metadata).preset === true && cleanText(existing.status) !== "archived") {
        await archiveDocumentTemplate(orgId, id, ctx).catch(() => null);
      }
    }
    // Instant roofing estimates are seeded with the signup sandbox; orgs that
    // already have them follow the pack revision here.
    if (await readDocumentTemplate(orgId, "tpl_instant_roofing_quick").catch(() => null)) {
      const { seedInstantRoofingDocuments } = await import("../signup-sandbox/roofing-documents.js");
      await seedInstantRoofingDocuments(orgId, ctx, { create: false }).catch(() => null);
    }
    ensured.set(key, Date.now());
  } finally {
    ensuring.delete(key);
  }
}
