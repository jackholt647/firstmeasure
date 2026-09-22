/**
 * FirstMate doc-renderer — DocModel -> DOM/CSS renderer for the document engine.
 *
 * Global: FMDocRenderer (also CommonJS-importable; module load never touches
 * the DOM so the PDF harness can require() it under Node. Actually rendering
 * requires a real DOM — FMDocRenderer.render throws without one).
 *
 * Contract: docs/document-engine-contracts.md §1.
 *   FMDocRenderer.render(container, { document, theme, themeContext, mode,
 *     widgetData, widgetContext, scale, pageRange, mediaUrl, orgId }) -> handle
 *
 * Render pipeline:
 *   1. Pages are built synchronously into a hidden staging element attached
 *      to document.body (so pagination can measure real layout).
 *   2. Widget renders run (static renders may return promises).
 *   3. Flow frames with props.overflow === "paginate" that overflow their
 *      page are split across cloned continuation pages at child boundaries.
 *      Widgets participate by tagging a rows container [data-fmdoc-rows]
 *      (rows [data-fmdoc-row], final-segment-only content [data-fmdoc-tail])
 *      or by returning { rows: HTMLElement[] } from renderStatic — those rows
 *      are treated as splittable flow children and the actual row elements
 *      are MOVED to continuation pages (row-level listeners survive).
 *      v1 splits at child/row boundaries only: a single unsplittable child
 *      taller than a page is clipped and marked data-overflow="true".
 *   3b. v2 flow chains (contract §7): frames with props.chain {id,index} form
 *      ordered chains; anchor:"flow" blocks pour through them, text splits at
 *      LINE level (widow/orphan keep rules), repeaters/tables/widget rows at
 *      row boundaries, page_break forces a frame break, and auto_pages chains
 *      append pages built from doc.chains[id].page_defaults (columns
 *      supported). Split parts share data-node-id and carry
 *      data-fmdoc-split="head|tail" + data-split-part. Anchors: "inline"
 *      nodes join the run stream, {to_block,wrap} nodes float beside their
 *      block; repeaters honor break_rules (repeat_header/min_rows_per_segment/
 *      keep_with_next); blocks with style_ref resolve through
 *      FMDocModel.resolveStyleRef; page masters may carry header/footer slots.
 *      handle.chainMetrics(chainId) reports per-frame fill for the editor.
 *   4. doc.page_number placeholders ([data-fmdoc-page-number]) are filled.
 *   5. Pages move into the visible root; after images decode and widget
 *      promises settle, container.__fmdocReady = true and a "fmdoc:ready"
 *      CustomEvent fires on the container (the PDF harness waits for this).
 *      Ready ALWAYS fires — empty and failed renders included — so the PDF
 *      pipeline can never hang on this renderer.
 *
 * CSS: there is no separate stylesheet. All renderer + built-in widget CSS is
 * embedded below (RENDERER_CSS) and injected once into document.head as
 * <style id="fmdoc-renderer-styles"> on first render — the PDF harness only
 * inlines the JS libraries and gets the styles automatically. Fonts are pure
 * CSS stacks with system fallbacks (no font binaries, no network requests).
 *
 * All style mapping goes through FMDocModel.fillToCss / filtersToCss /
 * fontToCss — never reimplemented here.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FMDocRenderer = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function (root) {
  "use strict";

  const PT_TO_PX = 96 / 72;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const STYLE_ELEMENT_ID = "fmdoc-renderer-styles";

  // ---------------------------------------------------------------------------
  // Fonts — no binaries, no CDNs, no network. The branded document families
  // resolve through @font-face local() sources (embedded CSS below) and these
  // explicit stacks so unavailable fonts degrade to close system equivalents.
  // ---------------------------------------------------------------------------

  const GENERIC_SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
  const GENERIC_SERIF = 'Georgia, "Times New Roman", Times, serif';

  const FONT_STACKS = {
    montserrat: '"Montserrat", "Trebuchet MS", ' + GENERIC_SANS,
    inter: '"Inter", "Segoe UI", ' + GENERIC_SANS,
    roboto: '"Roboto", "Segoe UI", ' + GENERIC_SANS,
    "open sans": '"Open Sans", "Segoe UI", ' + GENERIC_SANS,
    lato: '"Lato", "Segoe UI", ' + GENERIC_SANS,
    poppins: '"Poppins", "Century Gothic", "Segoe UI", Arial, sans-serif',
    "source sans 3": '"Source Sans 3", "Source Sans Pro", "Segoe UI", ' + GENERIC_SANS,
    georgia: GENERIC_SERIF,
    serif: GENERIC_SERIF,
    "sans-serif": GENERIC_SANS
  };

  /** Expand a bare family name into a full stack with system fallbacks. */
  function expandFontFamily(value) {
    const raw = String(value === null || value === undefined ? "" : value).trim();
    if (!raw || raw.includes(",") || raw.includes("var(")) return raw; // already a stack / token ref
    const bare = raw.replace(/^["']|["']$/g, "").trim();
    const stack = FONT_STACKS[bare.toLowerCase()];
    if (stack) return stack;
    if (/serif/i.test(bare) && !/sans/i.test(bare)) return '"' + bare + '", ' + GENERIC_SERIF;
    return '"' + bare + '", ' + GENERIC_SANS;
  }

  // ---------------------------------------------------------------------------
  // Embedded stylesheet — visual layer for FMDocRenderer + the built-in
  // FMDocWidgets set (visual language follows customer_portal.css). Injected
  // once into document.head as <style id="fmdoc-renderer-styles"> on first
  // render. @font-face declarations use local() sources only: when a family
  // is not installed the stack falls through to the system set.
  // ---------------------------------------------------------------------------

  const RENDERER_CSS = `
@font-face { font-family: "Montserrat"; src: local("Montserrat"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Inter"; src: local("Inter"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Roboto"; src: local("Roboto"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Open Sans"; src: local("Open Sans"), local("OpenSans"); font-weight: 300 800; font-display: swap; }
@font-face { font-family: "Lato"; src: local("Lato"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Poppins"; src: local("Poppins"); font-weight: 100 900; font-display: swap; }
@font-face { font-family: "Source Sans 3"; src: local("Source Sans 3"), local("SourceSans3"), local("Source Sans Pro"); font-weight: 200 900; font-display: swap; }

/* ------------------------------------------------------------------ root */

.fmdoc-root {
  --fmdoc-border: rgba(17, 24, 39, .12);
  --fmdoc-muted: #6b7280;
  --fmdoc-text: var(--fm-text, #111827);
  --fmdoc-primary: var(--fm-primary, #2563eb);
  position: relative;
  color: var(--fmdoc-text);
  font-family: var(--fm-body-font, "Inter"), -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.fmdoc-scale { transform-origin: 0 0; }

/* ------------------------------------------------------------------ page */

.fmdoc-page {
  position: relative;
  overflow: hidden;
  background: #ffffff;
  margin: 0 auto 18px;
  box-shadow: 0 1px 3px rgba(17, 24, 39, .14), 0 8px 24px rgba(17, 24, 39, .08);
  break-after: page;
  page-break-after: always;
}

.fmdoc-chrome {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
}

/* Fluid view surfaces (paper.size "fill"): flow with the host container rather
   than behaving like a fixed sheet of paper. Absolute page content would
   collapse to zero height once the page is auto-height, and the paper drop
   shadow is wrong for an embedded surface like a portal tab. */
.fmdoc-page[data-fill="true"] {
  overflow: visible;
  background: transparent;
  box-shadow: none;
  margin: 0;
  break-after: auto;
  page-break-after: auto;
}
/* Website/view documents are stacks of independently sized sections, not a
   sheet of paper. The wrapper supplies coordinates only and must never paint
   a white page, shadow, radius, or clipping surface behind those sections. */
.fmdoc-view {
  margin-bottom: 0;
  /* A website viewport is a hard horizontal boundary. Responsive children
     reflow inside it; no authored desktop frame may create page-level scroll. */
  overflow-x: clip;
  overflow-y: visible;
  background: transparent;
  box-shadow: none;
  border-radius: 0;
}
.fmdoc-view .fmdoc-node { min-width: 0; max-width: 100%; }
.fmdoc-view .fmdoc-text,
.fmdoc-view .fmdoc-run { overflow-wrap: anywhere; word-break: break-word; }
.fmdoc-view img,
.fmdoc-view video,
.fmdoc-view iframe,
.fmdoc-view table { max-width: 100%; }
.fmdoc-view [data-view-variant="mobile"] { display: none !important; }
/* A narrow website section is its own responsive container, including inside
   the desktop editor's simulated phone (where browser media queries would
   still see the desktop window). Rows wrap and grids collapse without a
   second mobile-only rendering path. */
@container (max-width: 600px) {
  .fmdoc-view [data-mobile-variant-enabled="true"] { display: none !important; }
  .fmdoc-view [data-view-variant="mobile"][data-mobile-enabled="true"] { display: block !important; }
  .fmdoc-view [data-view-variant="mobile"][data-mobile-enabled="true"][data-flow-direction] { display: flex !important; }
  .fmdoc-frame[data-flow-direction="row"] { flex-wrap: wrap !important; }
  .fmdoc-repeater { grid-template-columns: minmax(0, 1fr) !important; }
  .fmdoc-text { height: auto !important; min-height: 1em; }
}
.fmdoc-page[data-fill="true"] > .fmdoc-page-content {
  position: static;
  inset: auto;
  height: auto;
}

.fmdoc-page-content {
  position: absolute;
  inset: 0;
  z-index: 2;
}

/* Master header/footer slots: above the chrome layer (z0), below content (z2). */
.fmdoc-master-hf {
  position: absolute;
  left: 0;
  right: 0;
  z-index: 1;
  overflow: hidden;
  pointer-events: none;
}
.fmdoc-master-header { top: 0; }
.fmdoc-master-footer { bottom: 0; }

/* ------------------------------------------------------------------ nodes */

.fmdoc-node { box-sizing: border-box; }
.fmdoc-node--unknown { outline: 1pt dashed var(--fmdoc-border); }

/* props.link (contracts §10): linked nodes render as anchors. The anchor IS
   the node element (same data-node-id/data-node-type contract), so it must
   behave exactly like the div it replaces. */
a.fmdoc-node.fmdoc-link { display: block; color: inherit; text-decoration: none; cursor: pointer; }

.fmdoc-text { overflow: hidden; }
.fmdoc-block { margin: 0; min-height: 1em; }
.fmdoc-block--heading { font-weight: 700; line-height: 1.2; }
/* List markers are COMPUTED at render time (data-marker) so numbering keeps
   counting across page-split parts and marker glyphs rotate by nest level —
   CSS counters reset inside each split part and cannot do either. */
.fmdoc-block--list_item { position: relative; padding-left: calc(var(--fmdoc-list-indent, 0pt) + 18pt); }
.fmdoc-block--list_item::before { content: attr(data-marker); position: absolute; left: calc(var(--fmdoc-list-indent, 0pt) + 3pt); }
.fmdoc-block--list_item[data-list-style="check"]::before { content: "\\2610"; }
.fmdoc-run { white-space: pre-wrap; }
.fmdoc-run--link { color: var(--fmdoc-primary); text-decoration: underline; }
a.fmdoc-run { color: var(--fmdoc-primary); text-decoration: underline; }

.fmdoc-image-frame { position: relative; }
.fmdoc-image-frame--empty { display:grid;place-items:center;background: repeating-linear-gradient(45deg, #f3f4f6 0 8pt, #e5e7eb 8pt 16pt);color:#667085; }
.fmdoc-image-empty-hint { display:grid;place-items:center;gap:5pt;padding:8pt;text-align:center;font:600 9pt/1.25 var(--fm-body-font,"Inter"),sans-serif;pointer-events:none; }
.fmdoc-image-empty-hint svg { width:25pt;height:25pt;opacity:.78; }
.fmdoc-image { display: block; width: 100%; height: 100%; }
.fmdoc-tint { position: absolute; inset: 0; mix-blend-mode: multiply; pointer-events: none; }
.fmdoc-shape { container-type: size; }
.fmdoc-shape-label { position: absolute; inset: 0; z-index: 1; display: flex; box-sizing: border-box; padding: 6pt; pointer-events: none; white-space: pre-wrap; overflow: hidden; overflow-wrap: anywhere; line-height: 1.2; }

.fmdoc-markup-host { pointer-events: none; }

/* Markup overlay — port of .cp-markup-overlay (customer_portal.css) */
.fmdoc-markup-overlay {
  position: absolute;
  inset: 0;
  z-index: 2;
  overflow: hidden;
  pointer-events: none;
  container-type: size;
}
.fmdoc-markup-overlay svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; }
.fmdoc-markup-overlay path,
.fmdoc-markup-overlay line { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.fmdoc-markup-overlay span {
  position: absolute;
  min-width: 4.5%;
  min-height: 3.3%;
  box-sizing: border-box;
  padding: .45em .6em;
  border-radius: .5em;
  background: rgba(255, 255, 255, .72);
  font-weight: 700;
  line-height: 1.2;
  white-space: pre-wrap;
  overflow: hidden;
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------------ tables */

.fmdoc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 9.5pt;
  border: var(--fmdoc-table-border-width, .75pt) solid var(--fmdoc-table-border-color, var(--fmdoc-border));
}
.fmdoc-table th {
  text-align: left;
  font-weight: 600;
  font-size: 8pt;
  text-transform: uppercase;
  letter-spacing: .4pt;
  color: var(--fmdoc-muted);
  padding: var(--fmdoc-table-cell-padding, 5pt);
  border: var(--fmdoc-table-border-width, .75pt) solid var(--fmdoc-table-border-color, var(--fmdoc-border));
  background: var(--fmdoc-table-header-fill, transparent);
}
.fmdoc-table td {
  padding: var(--fmdoc-table-cell-padding, 5pt);
  border: var(--fmdoc-table-border-width, .75pt) solid var(--fmdoc-table-border-color, var(--fmdoc-border));
  vertical-align: top;
}
.fmdoc-table--striped tbody tr:nth-child(even) td { background: rgba(17, 24, 39, .03); }
.fmdoc-table td, .fmdoc-table th { white-space: pre-wrap; }
.fmdoc-footnote-ref { font-size: 0.65em; vertical-align: super; color: var(--fmdoc-primary, #1a73e8); cursor: pointer; user-select: none; }
.fmdoc-footnotes { position: absolute; z-index: 3; padding-top: 3pt; border-top: 0.75pt solid #9aa0a6; font-size: 8.5pt; line-height: 1.35; background: inherit; }
.fmdoc-footnote { display: flex; gap: 4pt; }
.fmdoc-footnote-num { flex: none; min-width: 10pt; }
.fmdoc-footnote-text { flex: 1; min-height: 1em; }

/* ------------------------------------------------------------------ widgets: shared */

/* A widget owns its internal presentation, but editor-authored corners belong
   to the node shell. Once a radius is explicitly set, inherit it into the
   widget's visual root so the shared corner control can override built-in
   widget defaults instead of rounding an invisible wrapper. */
.fmdoc-widget[data-fmdoc-radius] > :first-child { border-radius: inherit !important; }
.fmdoc-widget.fmdoc-capability-disabled { filter: grayscale(.85); opacity: .5; cursor: not-allowed; }
.fmdoc-widget.fmdoc-capability-disabled > * { pointer-events: none !important; }
.fmdoc-widget.fmdoc-capability-disabled::after {
  content: attr(data-disabled-reason);
  position: absolute;
  left: 4pt;
  right: 4pt;
  bottom: 4pt;
  z-index: 8;
  padding: 3pt 5pt;
  border: .75pt solid #98a2b3;
  border-radius: 4pt;
  background: rgba(242, 244, 247, .96);
  color: #475467;
  font-size: 7.5pt;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
}

.fmdoc-widget-placeholder,
.fmdoc-widget-unknown {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3pt;
  height: 100%;
  min-height: 32pt;
  border: 1pt dashed var(--fmdoc-border);
  border-radius: 4pt;
  background: rgba(17, 24, 39, .02);
  color: var(--fmdoc-muted);
  text-align: center;
  padding: 8pt;
}
.fmdoc-widget-placeholder-title,
.fmdoc-widget-unknown-label { font-weight: 600; font-size: 9pt; }
.fmdoc-widget-placeholder-hint { font-size: 8pt; }
.fmdoc-widget-title { font-weight: 700; font-size: 10.5pt; margin-bottom: 4pt; }

.fmdoc-badge {
  display: inline-block;
  padding: 1pt 5pt;
  border-radius: 999px;
  font-size: 7.5pt;
  font-weight: 600;
  text-transform: capitalize;
  background: rgba(17, 24, 39, .08);
  color: var(--fmdoc-text);
}
.fmdoc-badge--paid { background: rgba(21, 128, 61, .14); color: #15803d; }
.fmdoc-badge--due,
.fmdoc-badge--pending { background: rgba(37, 99, 235, .12); color: var(--fmdoc-primary); }
.fmdoc-badge--overdue { background: rgba(217, 48, 37, .12); color: #d93025; }
.fmdoc-badge--included { background: rgba(21, 128, 61, .12); color: #15803d; }

.fmdoc-button {
  appearance: none;
  border: none;
  border-radius: 6pt;
  background: var(--fmdoc-primary);
  color: #ffffff;
  font: inherit;
  font-weight: 600;
  padding: 6pt 12pt;
  cursor: pointer;
}
.fmdoc-button--ghost { background: transparent; color: var(--fmdoc-text); border: 1pt solid var(--fmdoc-border); }
.fmdoc-button--disabled,
.fmdoc-button[disabled] { opacity: .5; cursor: not-allowed; }

.fmdoc-input {
  box-sizing: border-box;
  width: 100%;
  border: 1pt solid var(--fmdoc-border);
  border-radius: 4pt;
  padding: 4pt 6pt;
  font: inherit;
  background: #ffffff;
  color: var(--fmdoc-text);
}
.fmdoc-input--invalid { border-color: #d93025; }
.fmdoc-field-label {
  display: block;
  font-size: 7.5pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .4pt;
  color: var(--fmdoc-muted);
  margin-bottom: 2pt;
}
.fmdoc-blank-rule { border-bottom: 1pt solid var(--fmdoc-text); height: 14pt; }
.fmdoc-check-row { display: flex; align-items: center; gap: 5pt; }
.fmdoc-address-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4pt; }

/* ------------------------------------------------------------------ line items */

.fmdoc-line-items { display: flex; flex-direction: column; gap: 6pt; }
.fmdoc-li-qty, .fmdoc-li-price, .fmdoc-li-amount { text-align: right; white-space: nowrap; }
.fmdoc-li-table th.fmdoc-li-qty, .fmdoc-li-table th.fmdoc-li-price, .fmdoc-li-table th.fmdoc-li-amount { text-align: right; }
.fmdoc-li-name-text { font-weight: 600; }
.fmdoc-li-desc { color: var(--fmdoc-muted); }
.fmdoc-li-optional-flag { margin-left: 4pt; font-size: 7pt; color: var(--fmdoc-muted); text-transform: uppercase; letter-spacing: .4pt; }
.fmdoc-li-group-row td { font-weight: 700; background: rgba(17, 24, 39, .04); }
.fmdoc-li-select-col { width: 14pt; text-align: center; }
.fmdoc-li-media-col { width: 30pt; }
.fmdoc-li-thumb { width: 22pt; height: 22pt; object-fit: cover; border-radius: 3pt; margin-right: 2pt; }
.fmdoc-li-totals { display: flex; flex-direction: column; align-items: flex-end; gap: 2pt; padding-top: 4pt; }
.fmdoc-li-total-row { display: flex; gap: 14pt; font-size: 9.5pt; }
.fmdoc-li-total-label { color: var(--fmdoc-muted); }
.fmdoc-li-total-value { min-width: 60pt; text-align: right; }
.fmdoc-li-total-row--grand { font-weight: 700; font-size: 11pt; border-top: 1.2pt solid var(--fmdoc-text); padding-top: 3pt; }
.fmdoc-li-total-row--grand .fmdoc-li-total-label { color: var(--fmdoc-text); }
.fmdoc-li-flow { display: flex; flex-direction: column; gap: 3pt; }
.fmdoc-li-flow-row { margin: 0; font-size: 9.5pt; }
.fmdoc-li-flow-amount { font-weight: 600; }

/* ------------------------------------------------------------------ pay now */

.fmdoc-pay-now {
  display: flex;
  flex-direction: column;
  gap: 4pt;
  border: 1pt solid var(--fmdoc-border);
  border-radius: 6pt;
  padding: 10pt;
  background: rgba(37, 99, 235, .04);
}
.fmdoc-pay-now-label { font-size: 7.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: .4pt; color: var(--fmdoc-muted); }
.fmdoc-pay-now-amount { font-size: 16pt; font-weight: 700; color: var(--fmdoc-primary); }
.fmdoc-pay-now-note { font-size: 8.5pt; color: var(--fmdoc-muted); }

/* ------------------------------------------------------------------ signature */

.fmdoc-signature { display: flex; flex-direction: column; justify-content: flex-end; gap: 3pt; height: 100%; }
.fmdoc-signature--actionable { cursor: pointer; border-radius: 4pt; }
.fmdoc-signature--actionable:hover { background: rgba(37, 99, 235, .05); }
.fmdoc-signature-cta { font-size: 8pt; font-weight: 600; color: var(--fmdoc-primary); }
.fmdoc-signature--inactive { cursor: default; }
.fmdoc-signature--inactive .fmdoc-signature-cta { color: var(--fmdoc-muted); }
.fmdoc-signature-face { min-height: 24pt; display: flex; align-items: flex-end; }
.fmdoc-signature-typed { font-size: 18pt; line-height: 1.1; }
.fmdoc-signature-image { max-height: 36pt; max-width: 100%; }
.fmdoc-signature-line { border-bottom: 1pt solid var(--fmdoc-text); height: 24pt; }
.fmdoc-signature-meta { display: flex; justify-content: space-between; gap: 8pt; font-size: 7.5pt; color: var(--fmdoc-muted); }
.fmdoc-signature-label {
  font-size: 7.5pt;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: .4pt;
  color: var(--fmdoc-muted);
  border-top: 1pt solid var(--fmdoc-border);
  padding-top: 2pt;
}

/* ------------------------------------------------------------------ choice group */

.fmdoc-choice-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(110pt, 1fr)); gap: 8pt; }
.fmdoc-choice-card {
  border: 1.2pt solid var(--fmdoc-border);
  border-radius: 6pt;
  padding: 8pt;
  display: flex;
  flex-direction: column;
  gap: 3pt;
  background: #ffffff;
}
.fmdoc-choice-card--selected { border-color: var(--fmdoc-primary); box-shadow: 0 0 0 1.2pt var(--fmdoc-primary) inset; }
[data-mode="interactive"] .fmdoc-choice-card { cursor: pointer; }
.fmdoc-choice-media { width: 100%; height: 54pt; object-fit: cover; border-radius: 4pt; }
.fmdoc-choice-label { font-weight: 700; font-size: 9.5pt; }
.fmdoc-choice-desc { font-size: 8.5pt; color: var(--fmdoc-muted); }
.fmdoc-choice-price { font-weight: 600; color: var(--fmdoc-primary); }

/* ------------------------------------------------------------------ qr / photo / video / page number */

.fmdoc-qr { display: flex; flex-direction: column; gap: 3pt; height: 100%; }
.fmdoc-qr svg { display: block; width: 100%; height: auto; flex: 1 1 auto; min-height: 0; }
.fmdoc-qr-caption { font-size: 7.5pt; color: var(--fmdoc-muted); text-align: center; }

.fmdoc-photo { margin: 0; display: flex; flex-direction: column; gap: 3pt; height: 100%; }
.fmdoc-photo-frame { position: relative; flex: 1 1 auto; min-height: 0; overflow: hidden; border-radius: 4pt; container-type: size; }
.fmdoc-photo-image { display: block; width: 100%; height: 100%; }
.fmdoc-photo-caption { font-size: 8pt; color: var(--fmdoc-muted); }
.fmdoc-photo-grid { display: grid; gap: 6pt; }
.fmdoc-photo-grid-cell { margin: 0; display: flex; flex-direction: column; gap: 2pt; }
.fmdoc-photo-grid-cell img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 4pt; }
.fmdoc-photo-carousel { position: relative; width: 100%; height: 100%; min-height: 72pt; overflow: hidden; border-radius: 4pt; background: #eef1f6; }
.fmdoc-photo-carousel-stage { position: absolute; inset: 0; }
.fmdoc-photo-carousel-image { display: block; width: 100%; height: 100%; }
.fmdoc-photo-carousel-caption { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; padding: 16pt 8pt 6pt; color: #fff; font-size: 8pt; background: linear-gradient(transparent, rgba(15,23,42,.78)); }
.fmdoc-photo-carousel-controls { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: space-between; padding: 6pt; pointer-events: none; }
.fmdoc-photo-carousel-button { display: grid; place-items: center; width: 22pt; height: 22pt; padding: 0; border: 0; border-radius: 999pt; color: #fff; background: rgba(15,23,42,.62); font: 700 14pt/1 sans-serif; cursor: pointer; pointer-events: auto; }
.fmdoc-photo-carousel-dots { position: absolute; left: 50%; bottom: 6pt; z-index: 4; display: flex; gap: 3pt; transform: translateX(-50%); }
.fmdoc-photo-carousel-dot { width: 5pt; height: 5pt; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.55); cursor: pointer; }
.fmdoc-photo-carousel-dot[aria-current="true"] { background: #fff; transform: scale(1.2); }
.fmdoc-photo-carousel-count { position: absolute; right: 6pt; top: 6pt; z-index: 2; padding: 2pt 5pt; border-radius: 999pt; color: #fff; background: rgba(15,23,42,.62); font-size: 7pt; }

.fmdoc-page-number { font-size: 8pt; color: var(--fmdoc-muted); }
.fmdoc-auto-page-number { position:absolute; left:36pt; right:36pt; z-index:40; pointer-events:none; font-size:8pt; color:var(--fmdoc-muted); }
.fmdoc-auto-page-number[data-position="header"] { top:22pt; }
.fmdoc-auto-page-number[data-position="footer"] { bottom:22pt; }

.fmdoc-video { display: flex; flex-direction: column; gap: 3pt; height: 100%; }
.fmdoc-video-frame {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  border-radius: 4pt;
  overflow: hidden;
  background: #111827;
  display: flex;
  align-items: center;
  justify-content: center;
}
.fmdoc-video-poster { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.fmdoc-video-glyph { position: relative; z-index: 1; display: flex; }
.fmdoc-video-player { display: block; width: 100%; height: 100%; background: #111827; border-radius: 4pt; }
.fmdoc-video-url { font-size: 7.5pt; color: var(--fmdoc-muted); word-break: break-all; }

/* ------------------------------------------------------------------ modal (interactive signature) */

.fmdoc-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 2400;
  background: rgba(17, 24, 39, .55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.fmdoc-modal {
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(17, 24, 39, .35);
  width: min(560px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 14px;
  color: #111827;
}
.fmdoc-modal-title { font-size: 17px; font-weight: 700; }
.fmdoc-modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
.fmdoc-modal .fmdoc-button { padding: 9px 16px; border-radius: 8px; }
.fmdoc-modal .fmdoc-input { padding: 8px 10px; border-radius: 8px; }
.fmdoc-modal .fmdoc-field-label { font-size: 11px; margin-bottom: 4px; }
.fmdoc-tabs { display: flex; gap: 6px; border-bottom: 1px solid rgba(17, 24, 39, .12); }
.fmdoc-tab {
  appearance: none;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  font: inherit;
  font-weight: 600;
  color: #6b7280;
  padding: 6px 10px;
  cursor: pointer;
}
.fmdoc-tab--active { color: #2563eb; border-bottom-color: #2563eb; }
.fmdoc-sign-pane { display: flex; flex-direction: column; gap: 10px; }
.fmdoc-sign-preview {
  min-height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 34px;
  border: 1px dashed rgba(17, 24, 39, .18);
  border-radius: 8px;
  padding: 8px;
  overflow: hidden;
}
.fmdoc-sign-styles { display: flex; gap: 8px; }
.fmdoc-sign-style {
  appearance: none;
  background: #ffffff;
  border: 1px solid rgba(17, 24, 39, .16);
  border-radius: 8px;
  font-size: 20px;
  width: 48px;
  height: 40px;
  cursor: pointer;
}
.fmdoc-sign-style--active { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb inset; }
.fmdoc-sign-canvas {
  width: 100%;
  height: 180px;
  border: 1px dashed rgba(17, 24, 39, .25);
  border-radius: 8px;
  background: #fafafa;
  touch-action: none;
  cursor: crosshair;
}
.fmdoc-sign-canvas--invalid { border-color: #d93025; }

/* ------------------------------------------------------------------ v2: chains, anchors, components, repeaters */

/* Anchored floats: text wraps around them inside the referenced block. */
[data-fmdoc-float="left"] { float: left; margin: 0 8pt 4pt 0; }
[data-fmdoc-float="right"] { float: right; margin: 0 0 4pt 8pt; }
[data-fmdoc-float="none"] { float: none; display: block; }

/* Inline-anchored nodes live in the run stream. */
[data-fmdoc-inline] { display: inline-block; vertical-align: middle; position: relative; }

/* Explicit frame/page break marker (consumed by the layout pass). */
.fmdoc-page_break { height: 0; overflow: hidden; }

.fmdoc-repeater { min-height: 0; }
.fmdoc-repeater-empty { color: var(--fmdoc-muted); font-size: 8.5pt; font-style: italic; padding: 4pt 0; }

.fmdoc-component-missing {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 22pt;
  height: 100%;
  box-sizing: border-box;
  border: 1pt dashed var(--fmdoc-border);
  border-radius: 4pt;
  background: rgba(17, 24, 39, .03);
  color: var(--fmdoc-muted);
  font-size: 8.5pt;
  text-align: center;
  padding: 4pt 6pt;
}

/* Split parts share data-node-id; parts never re-impose an authored height. */
[data-fmdoc-split] { min-height: 0; }

/* ------------------------------------------------------------------ pagination artifacts */

[data-overflow="true"] { overflow: hidden; }

/* ------------------------------------------------------------------ print */

@page { margin: 0; }

@media print {
  .fmdoc-root, .fmdoc-print .fmdoc-root { margin: 0; }
  .fmdoc-scale { transform: none !important; }
  .fmdoc-page {
    margin: 0;
    box-shadow: none;
    break-after: page;
    page-break-after: always;
  }
  .fmdoc-page:last-child { break-after: auto; page-break-after: auto; }
  .fmdoc-signature-cta, .fmdoc-modal-overlay { display: none !important; }
}

.fmdoc-print .fmdoc-page {
  margin: 0;
  box-shadow: none;
}
`;

  /** Inject the embedded stylesheet once per document (idempotent). */
  function ensureStyles() {
    if (typeof document === "undefined" || document.getElementById(STYLE_ELEMENT_ID)) return;
    const styleEl = document.createElement("style");
    styleEl.id = STYLE_ELEMENT_ID;
    styleEl.textContent = RENDERER_CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // ---------------------------------------------------------------------------
  // Library resolution (lazy so this file loads under Node without deps)
  // ---------------------------------------------------------------------------

  let modelCache = null;
  function model() {
    if (modelCache) return modelCache;
    if (root && root.FMDocModel) return (modelCache = root.FMDocModel);
    if (typeof require === "function") {
      try {
        return (modelCache = require("../doc-model/firstmate-doc-model.js"));
      } catch (error) {
        /* unavailable */
      }
    }
    throw new Error("FMDocRenderer requires FMDocModel (load doc-model first)");
  }

  function widgetsLib() {
    if (root && root.FMDocWidgets) return root.FMDocWidgets;
    if (typeof require === "function") {
      try {
        return require("../doc-widgets/firstmate-doc-widgets.js");
      } catch (error) {
        /* unavailable */
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------------

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value).trim();
  }

  function escapeHtml(value) {
    return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  function h(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function pt(value) {
    return (Number(value) || 0) + "pt";
  }

  function applyCssMap(elm, css) {
    for (const key of Object.keys(css || {})) {
      elm.style.setProperty(key, key === "font-family" ? expandFontFamily(css[key]) : css[key]);
    }
  }

  function clearEl(elm) {
    while (elm.firstChild) elm.removeChild(elm.firstChild);
  }

  // ---------------------------------------------------------------------------
  // Markup overlay — canonical port of the customer portal's markupOverlayHtml
  // (public/customer_portal/customer_portal.js). Items are the markup
  // system's normalized 0..1 shapes: { type: "stroke"|"arrow"|"text", ... }.
  // ---------------------------------------------------------------------------

  function markupColor(value) {
    const color = cleanText(value);
    return /^#[0-9a-f]{3,8}$/i.test(color) ? color : "#111111";
  }

  function markupPath(points) {
    return (Array.isArray(points) ? points : [])
      .map((point, index) => {
        const x = Math.max(0, Math.min(1, Number((point && point.x) || 0))) * 100;
        const y = Math.max(0, Math.min(1, Number((point && point.y) || 0))) * 100;
        return (index ? "L" : "M") + x.toFixed(3) + " " + y.toFixed(3);
      })
      .join(" ");
  }

  function markupArrowParts(item) {
    const x1 = Number(item.x1 || 0);
    const y1 = Number(item.y1 || 0);
    const x2 = Number(item.x2 || 0);
    const y2 = Number(item.y2 || 0);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const length = 0.035;
    const spread = Math.PI / 7;
    return [
      { x1, y1, x2, y2 },
      { x1: x2, y1: y2, x2: x2 - Math.cos(angle - spread) * length, y2: y2 - Math.sin(angle - spread) * length },
      { x1: x2, y1: y2, x2: x2 - Math.cos(angle + spread) * length, y2: y2 - Math.sin(angle + spread) * length }
    ];
  }

  /** Build a .fmdoc-markup-overlay element from normalized markup items (or null when empty). */
  function markupOverlayElement(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length || typeof document === "undefined") return null;
    const strokes = list
      .filter((entry) => entry.type === "stroke")
      .map((entry) => '<path d="' + markupPath(entry.points) + '" style="stroke:' + markupColor(entry.color) + ";stroke-width:" + Math.max(0.5, Number(entry.size || 2.2)) + '"></path>')
      .join("");
    const arrows = list
      .filter((entry) => entry.type === "arrow")
      .map((entry) =>
        markupArrowParts(entry)
          .map(
            (part) =>
              '<line x1="' + (part.x1 * 100).toFixed(3) + '" y1="' + (part.y1 * 100).toFixed(3) + '" x2="' + (part.x2 * 100).toFixed(3) + '" y2="' + (part.y2 * 100).toFixed(3) + '" style="stroke:' + markupColor(entry.color) + ";stroke-width:" + Math.max(0.5, Number(entry.size || 2.8)) + '"></line>'
          )
          .join("")
      )
      .join("");
    const text = list
      .filter((entry) => entry.type === "text")
      .map((entry) => {
        const size = Number(entry.fontPx) > 0 ? Number(entry.fontPx) / 9 : Number(entry.size || 1.5) * 2.4;
        return '<span style="left:' + Number(entry.x || 0) * 100 + "%;top:" + Number(entry.y || 0) * 100 + "%;width:" + Number(entry.width || 0.24) * 100 + "%;color:" + markupColor(entry.color) + ";font-size:" + Math.max(1, size) + 'cqw">' + escapeHtml(entry.text || "") + "</span>";
      })
      .join("");
    const overlay = h("div", "fmdoc-markup-overlay");
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">' + strokes + arrows + "</svg>" + text;
    return overlay;
  }

  // ---------------------------------------------------------------------------
  // Frame + style application
  // ---------------------------------------------------------------------------

  function responsiveHorizontalCss(position) {
    const pos = model().normalizeHorizontalPosition(position);
    const base = pos.anchor === "left" ? 0 : pos.anchor === "right" ? 100 : 50;
    const unit = pos.unit === "percent" ? "%" : "px";
    const value = Number(pos.value) || 0;
    const left = value === 0
      ? base + "%"
      : "calc(" + base + "% " + (value < 0 ? "-" : "+") + " " + Math.abs(value) + unit + ")";
    return { left: left, translate: pos.anchor === "left" ? "0 0" : pos.anchor === "right" ? "-100% 0" : "-50% 0", position: pos };
  }

  /** Resolve the renderer's individual CSS `translate` into layout pixels.
   *  offsetLeft/offsetTop deliberately exclude transforms, but editor chrome
   *  needs the painted position. Rotation remains separate so the editor can
   *  reproduce it around the same unrotated box. */
  function individualTranslatePx(element) {
    const raw = String(element && element.style && element.style.translate || "").trim();
    if (!raw || raw === "none") return { x: 0, y: 0 };
    const parts = raw.split(/\s+/);
    const resolve = function (token, size) {
      const match = String(token || "").match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|pt|%)?$/i);
      if (!match) return 0;
      const value = Number(match[1]) || 0;
      const unit = String(match[2] || "").toLowerCase();
      if (unit === "%") return size * value / 100;
      if (unit === "pt") return value * PT_TO_PX;
      return value;
    };
    return {
      x: resolve(parts[0], element.offsetWidth || 0),
      y: resolve(parts[1], element.offsetHeight || 0)
    };
  }

  function applyFrame(elm, frame, inFlow, rctx, node) {
    let f = frame || {};
    const responsiveView = !!(rctx && rctx.doc && rctx.doc.kind === "view");
    const responsiveParentWidthPt = Number(rctx && rctx.responsiveParentWidthPt);
    const responsiveResize = responsiveView && f.responsive && model().normalizeResponsiveResize
      ? model().normalizeResponsiveResize(f.responsive)
      : null;
    const autoResize = !!(responsiveResize && responsiveResize.mode === "auto");
    const rawResponsiveWidthPercent = responsiveView && Number.isFinite(responsiveParentWidthPt) && responsiveParentWidthPt > 0 && typeof f.w === "number"
      ? Math.max(0, f.w / responsiveParentWidthPt * 100)
      : null;
    const responsiveWidthPercent = rawResponsiveWidthPercent === null ? null : Math.min(100, rawResponsiveWidthPercent);
    const map = rctx && rctx.pageFrameMap;
    if (!inFlow && map && node && rctx.pageTopLevelNodeId === node.id) {
      const fullBleed = node.props && node.props.full_bleed === true;
      const coversPage = Number(f.x || 0) <= 0 && Number(f.y || 0) <= 0
        && Number(f.w || 0) >= map.paperW * 0.95 && Number(f.h || 0) >= map.paperH * 0.95;
      if (!fullBleed && !coversPage) {
        f = Object.assign({}, f, {
          x: map.left + (Number(f.x || 0) - map.base) * map.sx,
          y: map.top + (Number(f.y || 0) - map.base) * map.sy,
          w: typeof f.w === "number" ? Math.max(1, f.w * map.sx) : f.w,
          h: typeof f.h === "number" ? Math.max(1, f.h * map.sy) : f.h
        });
      }
    }
    if (inFlow) {
      // Flow children participate in the parent's flexbox; frame w/h become
      // preferred sizes ("auto" or missing => content-sized / stretched).
      elm.style.position = "relative";
      elm.style.flex = responsiveView ? "0 1 auto" : "none";
      if (responsiveView) {
        elm.style.minWidth = "0";
        elm.style.maxWidth = "100%";
      }
      // Flow/inline widgets can acquire a relative offset when their west or
      // north resize handle is dragged. Keep this separate from frame x/y:
      // flow projection may normalize frame coordinates during pagination.
      if (node && node.type === "widget") {
        const props = node.props || {};
        // Widget config survives the flow-document projection; arbitrary
        // top-level widget props do not.
        const config = props.config || {};
        const offsetX = Number(config._fm_flow_resize_offset_x || 0);
        const offsetY = Number(config._fm_flow_resize_offset_y || 0);
        if (offsetX) elm.style.left = pt(offsetX);
        if (offsetY) elm.style.top = pt(offsetY);
      }
      if (typeof f.h === "number" && f.h > 0) elm.style.height = pt(f.h);
      if (typeof f.w === "number" && f.w > 0) {
        elm.style.width = responsiveWidthPercent !== null && !(rctx && rctx.viewSectionChild)
          ? "min(" + pt(f.w) + ", " + responsiveWidthPercent + "%)"
          : pt(f.w);
      }
      if (f.z !== undefined && f.z !== null) elm.style.zIndex = String(Math.max(0, Number(f.z) || 0));
      // Rotation applies in both branches — a flow child that dropped its
      // transform on re-render made the editor's rotate gesture appear to
      // revert while the selection box stayed rotated.
      if (f.rotation) elm.style.transform = "rotate(" + f.rotation + "deg)";
    } else {
      elm.style.position = "absolute";
      const responsiveX = responsiveView && !autoResize && f.position && f.position.x
        ? responsiveHorizontalCss(f.position.x)
        : null;
      if (autoResize && Number.isFinite(responsiveParentWidthPt) && responsiveParentWidthPt > 0 && typeof f.x === "number") {
        elm.style.left = (f.x / responsiveParentWidthPt * 100) + "%";
        elm.style.translate = "none";
        elm.setAttribute("data-responsive-resize", "auto");
        const autoItem = rctx && rctx.autoResizeItem;
        if (autoItem) {
          elm.setAttribute("data-responsive-row", String(autoItem.row));
          elm.setAttribute("data-responsive-gap-above", String(autoItem.gapAbove));
        }
      } else if (responsiveX) {
        elm.style.left = responsiveX.left;
        // Individual translate keeps horizontal mounting independent from the
        // authored rotation transform and makes both independently editable.
        elm.style.translate = responsiveX.translate;
        elm.setAttribute("data-position-x-unit", responsiveX.position.unit);
        elm.setAttribute("data-position-x-anchor", responsiveX.position.anchor);
      } else {
        elm.style.left = pt(f.x);
      }
      const responsiveTopPercent = responsiveView && Number.isFinite(responsiveParentWidthPt) && responsiveParentWidthPt > 0 && typeof f.y === "number" && f.y >= 0
        ? f.y / responsiveParentWidthPt * 100
        : null;
      elm.style.top = responsiveTopPercent !== null
        ? (autoResize ? responsiveTopPercent + "cqw" : "min(" + pt(f.y) + ", " + responsiveTopPercent + "cqw)")
        : pt(f.y);
      if (responsiveView) {
        elm.style.minWidth = "0";
        elm.style.maxWidth = "100%";
      }
      if (f.w === "auto") elm.style.width = "auto";
      else if (responsiveWidthPercent !== null) {
        elm.style.width = autoResize || (responsiveResize && responsiveResize.width === "percent")
          ? responsiveWidthPercent + "%"
          : pt(f.w);
        // Once an authored item reaches the viewport ceiling, keep the whole
        // item inside the parent even if its desktop anchor carried an offset.
        if (responsiveWidthPercent >= 99.999) {
          elm.style.left = "50%";
          elm.style.translate = "-50% 0";
        }
      } else elm.style.width = pt(f.w);
      // Magic Mobile carries the desktop row's outer edges forward as exact
      // percentage rails. Applying both edges in painted CSS space keeps the
      // mobile stack aligned with sibling headings/paragraphs and prevents
      // crop or border wrappers from creating unequal visual gutters.
      const magicRails = node && node.props && node.props.magic_mobile_rails;
      if (autoResize && magicRails && typeof magicRails === "object") {
        const railLeft = Math.max(0, Math.min(100, Number(magicRails.left_percent) || 0));
        const railRight = Math.max(0, Math.min(100 - railLeft, Number(magicRails.right_percent) || 0));
        const railWidth = Math.max(0, 100 - railLeft - railRight);
        // Older generated variants may have persisted unequal rails. Preserve
        // their authored width but center it while painting, so opening an
        // existing mobile version receives the correction without requiring
        // the user to run Magic Mobile again.
        const centeredRail = Math.max(0, (100 - railWidth) / 2);
        elm.style.left = centeredRail + "%";
        elm.style.width = railWidth + "%";
        elm.style.translate = "none";
      }
      let responsiveHeightPercent = responsiveView && Number.isFinite(responsiveParentWidthPt) && responsiveParentWidthPt > 0 && typeof f.h === "number" && f.h > 0
        ? f.h / responsiveParentWidthPt * 100
        : null;
      // Auto items are never wider than their parent. If an authored frame
      // begins wider than that ceiling, reduce its height by the same factor
      // so the safety clamp cannot distort images, shapes, or groups.
      if (autoResize && responsiveHeightPercent !== null && rawResponsiveWidthPercent > 100) {
        responsiveHeightPercent *= 100 / rawResponsiveWidthPercent;
      }
      if (f.h === "auto") elm.style.height = "auto";
      else if (responsiveHeightPercent !== null) {
        elm.style.height = autoResize || (responsiveResize && responsiveResize.height === "proportional")
          ? responsiveHeightPercent + "cqw"
          : pt(f.h);
      }
      else elm.style.height = pt(f.h);
      if (f.rotation) elm.style.transform = "rotate(" + f.rotation + "deg)"; // rotates about center (default transform-origin)
      // Authored nodes may sit behind text, but never behind the paper itself.
      elm.style.zIndex = String(Math.max(0, Number(f.z) || 0));
    }
  }

  /** Resolve the URL for an image fill ({ media: {media_id,variant}|{url} }).
   *  Goes through the SAME resolution path as image nodes (rctx.resolveMediaUrl
   *  → media.url / opts.mediaUrl / platform media route). Empty string when
   *  nothing resolves — callers then fall back to fill.fallback_color. */
  function imageFillUrl(fill, rctx) {
    if (!fill || fill.type !== "image") return "";
    const media = fill.media;
    if (!media) return "";
    if (rctx && typeof rctx.resolveMediaUrl === "function") {
      try { return rctx.resolveMediaUrl(media, media && media.variant) || ""; } catch (err) { return ""; }
    }
    if (typeof media === "string") return media;
    return media.url ? String(media.url) : "";
  }

  function fillOpacity(fill, key, fallback) {
    const value = Number(fill && fill[key]);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
  }

  function translucentColor(color, opacity) {
    const alpha = Math.max(0, Math.min(1, Number(opacity)));
    if (!color || alpha <= 0) return "transparent";
    if (alpha >= 1) return color;
    return "color-mix(in srgb," + color + " " + (alpha * 100) + "%,transparent)";
  }

  function applyNodeStyle(elm, node, rctx) {
    const m = model();
    const style = node.style || {};
    if (style.opacity !== undefined && style.opacity !== null) elm.style.opacity = String(style.opacity);
    const authoredRadius = style.radius !== undefined && style.radius !== null ? style.radius : style.corner_radius;
    if (authoredRadius !== undefined && authoredRadius !== null) {
      elm.style.borderRadius = Array.isArray(authoredRadius) ? authoredRadius.map((r) => pt(r)).join(" ") : pt(authoredRadius);
      elm.setAttribute("data-fmdoc-radius", "true");
      if (node.type === "widget") elm.style.overflow = "hidden";
    }
    if (style.shadow) {
      const s = style.shadow;
      elm.style.boxShadow = pt(s.x) + " " + pt(s.y) + " " + pt(s.blur) + " " + (s.color || "rgba(0,0,0,.25)");
    }
    if (style.blend && style.blend !== "normal") elm.style.mixBlendMode = style.blend;
    // Shapes paint their stroke on their actual SVG geometry. Applying the
    // same stroke as a CSS border here creates a second square outline around
    // rounded rectangles, ellipses, polygons, and paths.
    if (node.type !== "shape" && style.stroke && (style.stroke.width_pt || style.stroke.color)) {
      elm.style.border = pt(style.stroke.width_pt || 1) + " " + (style.stroke.dash ? "dashed" : "solid") + " " + (style.stroke.color || "currentColor");
    }
    if (style.filters && node.type !== "image") {
      const filterCss = m.filtersToCss(style.filters);
      if (filterCss) elm.style.filter = filterCss;
    }
    if ((node.type === "frame" || node.type === "text" || node.type === "table") && style.fill) {
      // Image fill (contracts §10) — frames only; other node types get the
      // fallback color through fillToCss. Painted as a background image so the
      // node's corner radius clips it (backgrounds clip to the border box) and
      // an unloadable URL degrades to the fallback color, never broken layout.
      const url = node.type === "frame" && style.fill.type === "image" ? imageFillUrl(style.fill, rctx) : "";
      if (url) {
        if (style.fill.fallback_color) elm.style.backgroundColor = style.fill.fallback_color;
        const overlayColor = style.fill.overlay_color;
        const overlayOpacity = fillOpacity(style.fill, "overlay_opacity", overlayColor ? 1 : 0);
        const hasOverlay = !!(overlayColor && overlayOpacity > 0);
        const overlay = hasOverlay
          ? "linear-gradient(" + translucentColor(overlayColor, overlayOpacity) + "," + translucentColor(overlayColor, overlayOpacity) + "),"
          : "";
        elm.style.backgroundImage = overlay + 'url("' + url.replace(/["\\\n\r]/g, "") + '")';
        const crop = cropRect(style.fill.crop);
        if (crop) {
          // Crop: image at a frame-relative rect. background-position % maps
          // offset = p * (box - image) => p = crop.x / (1 - crop.w).
          elm.style.backgroundSize = (hasOverlay ? "100% 100%," : "") + crop.w * 100 + "% " + crop.h * 100 + "%";
          const px = Math.abs(1 - crop.w) < 1e-6 ? 0 : (crop.x / (1 - crop.w)) * 100;
          const py = Math.abs(1 - crop.h) < 1e-6 ? 0 : (crop.y / (1 - crop.h)) * 100;
          elm.style.backgroundPosition = (hasOverlay ? "0 0," : "") + px + "% " + py + "%";
        } else {
          elm.style.backgroundSize = (hasOverlay ? "100% 100%," : "") + (style.fill.fit === "contain" ? "contain" : "cover");
          elm.style.backgroundPosition = (hasOverlay ? "0 0," : "") + "center";
        }
        elm.style.backgroundRepeat = hasOverlay ? "no-repeat,no-repeat" : "no-repeat";
      } else {
        const fill = m.fillToCss(style.fill);
        if (fill) elm.style.background = style.fill.type === "solid"
          ? translucentColor(fill, fillOpacity(style.fill, "opacity", 1))
          : fill;
      }
    }
    if (style.font && node.type !== "text") applyCssMap(elm, m.fontToCss(style.font));
  }

  // ---------------------------------------------------------------------------
  // Text rendering
  // ---------------------------------------------------------------------------

  function typeStyleFor(theme, block) {
    const styles = (theme && theme.type_styles) || {};
    let key = block.style;
    if (!key) {
      if (block.type === "heading") key = "h" + (block.level || 1);
      else if (block.type === "list_item" && styles.list_item) key = "list_item";
      else key = "body";
    }
    return styles[key] || styles.body || null;
  }

  function renderRun(run, rctx) {
    const m = model();
    const link = cleanText(run.link);
    const safeLink = /^\s*(javascript|data|vbscript):/i.test(link) ? "" : link;
    // Contract: link runs are real <a> anchors in interactive mode only;
    // static (print/PDF) renders them as plain styled text with no handlers.
    const interactive = rctx.mode === "interactive";
    const span = document.createElement(safeLink && interactive ? "a" : "span");
    span.className = "fmdoc-run" + (safeLink ? " fmdoc-run--link" : "");
    if (safeLink && interactive) {
      span.setAttribute("href", safeLink);
      span.setAttribute("target", "_blank");
      span.setAttribute("rel", "noopener noreferrer");
    }
    span.textContent = run.text === null || run.text === undefined ? "" : String(run.text);
    if (typeof run.font === "string") span.style.fontFamily = expandFontFamily(run.font);
    else if (isObject(run.font)) applyCssMap(span, m.fontToCss(run.font));
    if (run.size_pt) span.style.fontSize = pt(run.size_pt);
    if (run.color) span.style.color = run.color;
    if (run.background) span.style.backgroundColor = run.background;
    if (run.weight) span.style.fontWeight = String(run.weight);
    if (run.italic) span.style.fontStyle = "italic";
    const decorations = [];
    if (run.underline) decorations.push("underline");
    if (run.strike) decorations.push("line-through");
    if (decorations.length) span.style.textDecoration = decorations.join(" ");
    if (run.super || run.sub) {
      span.style.verticalAlign = run.super ? "super" : "sub";
      // Shrink relative to the run's own size when known, else the block's.
      const ownPt = run.size_pt || (isObject(run.font) && run.font.size_pt) || 0;
      span.style.fontSize = ownPt ? pt(ownPt * 0.65) : "0.65em";
    }
    return span;
  }

  function listAlpha(n) {
    let out = "";
    let value = Math.max(1, n);
    while (value > 0) { value -= 1; out = String.fromCharCode(97 + (value % 26)) + out; value = Math.floor(value / 26); }
    return out;
  }

  function listRoman(n) {
    const table = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
    let out = "";
    let value = Math.max(1, n);
    for (const [num, sym] of table) while (value >= num) { out += sym; value -= num; }
    return out;
  }

  function listMarkerFor(styleKind, count, level) {
    if (styleKind === "number") {
      const kind = level % 3;
      if (kind === 1) return listAlpha(count) + ".";
      if (kind === 2) return listRoman(count) + ".";
      return String(count) + ".";
    }
    return ["•", "◦", "▪"][level % 3];
  }

  function renderTextBlocks(elm, node, rctx) {
    const m = model();
    const props = node.props || {};
    const nodeStyle = node.style || {};
    const blocks = Array.isArray(props.blocks) ? props.blocks : [];
    // Multi-level list numbering: per-level counters, reset by any non-list
    // block (Docs behavior) unless the next run carries list_continue.
    let listCounters = [];
    let savedCounters = [];
    for (const block of blocks) {
      const blockEl = h("div", "fmdoc-block fmdoc-block--" + (block.type || "paragraph"));
      if (block.id) blockEl.setAttribute("data-block-id", String(block.id));
      if (block.type === "heading") blockEl.setAttribute("data-level", String(block.level || 1));
      // Style precedence: style_ref (doc.styles over theme.type_styles) — else
      // the theme type style — then node style, block-level fields, per-run
      // style. style_ref resolves through FMDocModel.resolveStyleRef and is
      // applied BEFORE all inline overrides (contract §7).
      let typeStyle = null;
      if (block.style_ref) {
        blockEl.setAttribute("data-style-ref", String(block.style_ref));
        const refStyle = typeof m.resolveStyleRef === "function" ? m.resolveStyleRef(block.style_ref, rctx.doc, rctx.theme) : null;
        if (refStyle && Object.keys(refStyle).length) typeStyle = refStyle;
      }
      if (!typeStyle) typeStyle = typeStyleFor(rctx.theme, block);
      if (typeStyle) {
        applyCssMap(blockEl, m.fontToCss(typeStyle.font || typeStyle, null));
        if (typeStyle.line_height && (props.line_height === undefined || props.line_height === null)) blockEl.style.lineHeight = String(typeStyle.line_height);
        if (typeStyle.letter_spacing && (props.letter_spacing === undefined || props.letter_spacing === null)) blockEl.style.letterSpacing = pt(typeStyle.letter_spacing);
        // Paragraph-level style properties (named styles may carry these).
        if (typeStyle.align) blockEl.style.textAlign = typeStyle.align;
        if (typeStyle.space_before_pt) blockEl.style.marginTop = pt(typeStyle.space_before_pt);
        if (typeStyle.space_after_pt) blockEl.style.marginBottom = pt(typeStyle.space_after_pt);
        if (typeStyle.indent_pt) blockEl.style.marginLeft = pt(typeStyle.indent_pt);
      }
      if (nodeStyle.font) applyCssMap(blockEl, m.fontToCss(nodeStyle.font, null));
      if (block.align) blockEl.style.textAlign = block.align;
      const isList = block.type === "list_item";
      // List indent moves the marker with the text (CSS var); plain paragraph
      // indent stays simple left padding.
      if (isList) { if (block.indent) blockEl.style.setProperty("--fmdoc-list-indent", pt(block.indent * 18)); }
      else if (block.indent) blockEl.style.paddingLeft = pt(block.indent * 18);
      if (block.line_height) blockEl.style.lineHeight = String(block.line_height);
      if (block.first_line_indent_pt !== undefined && block.first_line_indent_pt !== null) blockEl.style.textIndent = pt(block.first_line_indent_pt);
      // Block-level spacing/direction override the named style's values.
      if (block.space_before_pt !== undefined && block.space_before_pt !== null) blockEl.style.marginTop = pt(block.space_before_pt);
      if (block.space_after_pt !== undefined && block.space_after_pt !== null) blockEl.style.marginBottom = pt(block.space_after_pt);
      if (block.direction === "rtl" || block.direction === "ltr") blockEl.setAttribute("dir", block.direction);
      if (block.list_style) blockEl.setAttribute("data-list-style", String(block.list_style));
      if (isList) {
        const level = Math.max(0, Math.min(8, Number(block.indent) || 0));
        if (block.list_style === "number") {
          if (!listCounters.length && block.list_continue && savedCounters.length) listCounters = savedCounters.slice();
          if (block.list_restart) listCounters[level] = 0;
          listCounters[level] = (listCounters[level] || 0) + 1;
          listCounters.length = level + 1;
          blockEl.setAttribute("data-marker", listMarkerFor("number", listCounters[level], level));
        } else if (block.list_style !== "check") {
          blockEl.setAttribute("data-marker", listMarkerFor("bullet", 0, level));
        }
      } else if (listCounters.length) {
        savedCounters = listCounters.slice();
        listCounters = [];
      }
      // Paragraph borders & shading (Format ▸ Borders & shading).
      if (block.shading) {
        blockEl.style.backgroundColor = String(block.shading);
      }
      const border = block.border;
      if (border && Number(border.width_pt) > 0) {
        const line = border.width_pt + "pt solid " + (border.color || "#000000");
        const sides = border.sides && typeof border.sides === "object" ? border.sides : null;
        if (!sides || sides.top) blockEl.style.borderTop = line;
        if (!sides || sides.bottom) blockEl.style.borderBottom = line;
        if (!sides || sides.left) blockEl.style.borderLeft = line;
        if (!sides || sides.right) blockEl.style.borderRight = line;
      }
      if (block.shading || (border && Number(border.width_pt) > 0)) {
        blockEl.style.paddingTop = "2pt";
        blockEl.style.paddingBottom = "2pt";
        blockEl.style.paddingRight = "4pt";
        if (!isList && !block.indent) blockEl.style.paddingLeft = "4pt";
      }
      for (const run of block.runs || []) blockEl.appendChild(renderRun(run, rctx));
      elm.appendChild(blockEl);
    }
  }

  function renderTextNode(elm, node, rctx) {
    const props = node.props || {};
    elm.style.display = "flex";
    elm.style.flexDirection = "column";
    const valign = props.valign || "top";
    elm.style.justifyContent = valign === "middle" || valign === "center" ? "center" : valign === "bottom" ? "flex-end" : "flex-start";
    if (props.line_height !== undefined && props.line_height !== null) elm.style.lineHeight = String(props.line_height);
    if (props.letter_spacing) elm.style.letterSpacing = pt(props.letter_spacing);
    renderTextBlocks(elm, node, rctx);
  }

  // ---------------------------------------------------------------------------
  // Image rendering
  // ---------------------------------------------------------------------------

  /** Normalized crop rect ({x,y,w,h} as fractions of the node frame — the
   *  image is drawn at that rect, the frame is the fixed viewport). Returns
   *  null when absent/malformed so callers keep the plain fit behavior. */
  function cropRect(crop) {
    if (!crop || typeof crop !== "object") return null;
    const x = Number(crop.x);
    const y = Number(crop.y);
    const w = Number(crop.w);
    const h = Number(crop.h);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }

  function renderImageNode(elm, node, rctx) {
    const m = model();
    const props = node.props || {};
    const src = rctx.resolveMediaUrl(props.media, props.media && props.media.variant);
    elm.classList.add("fmdoc-image-frame");
    elm.style.overflow = "hidden";
    if (!src) {
      elm.classList.add("fmdoc-image-frame--empty");
      const hint = document.createElement("span");
      hint.className = "fmdoc-image-empty-hint";
      hint.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/></svg><span>${(globalThis.PlatformLanguage?.text("doc-renderer","m_1c63591771736b","Double-click to add media") ?? "Double-click to add media")}</span>`;
      elm.appendChild(hint);
      return;
    }
    const img = document.createElement("img");
    img.className = "fmdoc-image";
    img.src = src;
    img.alt = cleanText(props.alt);
    img.style.objectFit = props.fit || "cover";
    // Crop (contracts §10): props.crop places the image at a frame-relative
    // rect — the frame stays the viewport, the image pans/zooms beneath it.
    const crop = cropRect(props.crop);
    if (crop) {
      img.style.position = "absolute";
      img.style.left = crop.x * 100 + "%";
      img.style.top = crop.y * 100 + "%";
      img.style.width = crop.w * 100 + "%";
      img.style.height = crop.h * 100 + "%";
      img.style.maxWidth = "none";
      // A crop rect positions/scales the source beneath the viewport; it must
      // never authorize non-uniform image scaling when the frame is resized.
      // Cover preserves the source aspect ratio and simply reveals a different
      // portion of it as the viewport dimensions change.
      img.style.objectFit = "cover";
      img.style.objectPosition = "center";
    }
    const focal = props.focal || props.focal_point;
    if (focal) img.style.objectPosition = Math.round((Number(focal.x) || 0.5) * 100) + "% " + Math.round((Number(focal.y) || 0.5) * 100) + "%";
    const filters = (node.style || {}).filters;
    if (filters) {
      const filterCss = m.filtersToCss(filters);
      if (filterCss) img.style.filter = filterCss;
    }
    elm.appendChild(img);
    // Tint filter: implemented as a color overlay + blend per the spec.
    if (filters && filters.tint && filters.tint.color) {
      const tint = h("div", "fmdoc-tint");
      tint.style.background = filters.tint.color;
      tint.style.opacity = String(filters.tint.amount === undefined ? 0.25 : filters.tint.amount);
      elm.appendChild(tint);
    }
    // Optional markup overlay carried on the image node itself.
    const markup = props.markup && (Array.isArray(props.markup) ? props.markup : props.markup.items);
    if (markup && markup.length) {
      const overlay = markupOverlayElement(markup);
      if (overlay) elm.appendChild(overlay);
    }
  }

  // ---------------------------------------------------------------------------
  // Shape rendering (SVG in a viewBox matching the frame in pt)
  // ---------------------------------------------------------------------------

  function svgFillColor(fill) {
    const m = model();
    const css = m.fillToCss(fill);
    if (!css) return "none";
    // SVG fill attributes cannot take CSS gradient strings; fall back to the
    // first stop color for gradient fills (documents needing true gradients
    // should use a frame background instead).
    if (css.includes("gradient")) {
      const stops = (fill && fill.stops) || [];
      return (stops[0] && stops[0].color) || "none";
    }
    return css;
  }

  /** Sync every size-dependent attribute of a shape's SVG to the node's
   *  current frame. Split out of renderShapeNode so the EDITOR can call it
   *  mid-gesture (live resize) with an overridden frame — the old
   *  stretch-the-viewBox preview distorted image fills until pointerup.
   *  Pass wOverride/hOverride (pt) to preview a size the node doesn't have yet. */
  function syncShapeSvg(svg, node, wOverride, hOverride) {
    if (!svg || !node) return;
    const props = node.props || {};
    const style = node.style || {};
    const frame = node.frame || {};
    const w = Number.isFinite(wOverride) && wOverride > 0 ? wOverride
      : (typeof frame.w === "number" && frame.w > 0 ? frame.w : 100);
    const hgt = Number.isFinite(hOverride) && hOverride > 0 ? hOverride
      : (typeof frame.h === "number" && frame.h > 0 ? frame.h : 100);
    svg.setAttribute("viewBox", "0 0 " + w + " " + hgt);
    const strokeWidth = Math.max(0, Number(style.stroke && style.stroke.width_pt) || 0);
    const strokeInset = Math.min(w / 2, hgt / 2, strokeWidth / 2);
    const innerW = Math.max(0, w - strokeInset * 2);
    const innerH = Math.max(0, hgt - strokeInset * 2);

    const pattern = svg.querySelector("defs > pattern");
    if (pattern) {
      pattern.setAttribute("width", String(w));
      pattern.setAttribute("height", String(hgt));
      pattern.querySelectorAll("rect").forEach(function (layer) {
        layer.setAttribute("width", String(w));
        layer.setAttribute("height", String(hgt));
      });
      const image = pattern.querySelector("image");
      if (image) {
        const crop = cropRect(style.fill && style.fill.crop);
        if (crop) {
          image.setAttribute("x", String(crop.x * w));
          image.setAttribute("y", String(crop.y * hgt));
          image.setAttribute("width", String(crop.w * w));
          image.setAttribute("height", String(crop.h * hgt));
          // Keep the source aspect ratio through both live and committed frame
          // resizes. The crop rect is a viewport placement, not permission to
          // stretch the bitmap to a new aspect ratio.
          image.setAttribute("preserveAspectRatio", "xMidYMid slice");
        } else {
          image.setAttribute("x", "0");
          image.setAttribute("y", "0");
          image.setAttribute("width", String(w));
          image.setAttribute("height", String(hgt));
          image.setAttribute("preserveAspectRatio", style.fill && style.fill.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice");
        }
      }
    }

    const points = Array.isArray(props.points) ? props.points : null;
    const kind = props.shape || "rect";
    if (kind === "rect") {
      const rect = svg.querySelector(":scope > rect");
      if (rect) {
        rect.setAttribute("x", String(strokeInset));
        rect.setAttribute("y", String(strokeInset));
        rect.setAttribute("width", String(innerW));
        rect.setAttribute("height", String(innerH));
        const radius = Math.max(0, Number(props.corner_radius) || 0);
        rect.setAttribute("rx", String(Math.max(0, radius - strokeInset)));
      }
    } else if (kind === "ellipse") {
      const ellipse = svg.querySelector(":scope > ellipse");
      if (ellipse) {
        ellipse.setAttribute("cx", String(w / 2));
        ellipse.setAttribute("cy", String(hgt / 2));
        ellipse.setAttribute("rx", String(Math.max(0, w / 2 - strokeInset)));
        ellipse.setAttribute("ry", String(Math.max(0, hgt / 2 - strokeInset)));
      }
    } else if (kind === "line") {
      const line = svg.querySelector(":scope > line");
      if (line) {
        const p0 = (points && points[0]) || { x: 0, y: 0 };
        const p1 = (points && points[1]) || { x: 1, y: 1 };
        line.setAttribute("x1", String(strokeInset + (Number(p0.x) || 0) * innerW));
        line.setAttribute("y1", String(strokeInset + (Number(p0.y) || 0) * innerH));
        line.setAttribute("x2", String(strokeInset + (Number(p1.x) || 0) * innerW));
        line.setAttribute("y2", String(strokeInset + (Number(p1.y) || 0) * innerH));
      }
    } else if (kind === "polygon") {
      const polygon = svg.querySelector(":scope > polygon");
      if (polygon) {
        const pts = (points || []).map((p) => (strokeInset + (Number(p.x) || 0) * innerW).toFixed(2) + "," + (strokeInset + (Number(p.y) || 0) * innerH).toFixed(2)).join(" ");
        polygon.setAttribute("points", pts);
      }
    } else if (kind === "path") {
      const path = svg.querySelector(":scope > path");
      if (path) path.setAttribute("transform", "translate(" + strokeInset + " " + strokeInset + ") scale(" + innerW + " " + innerH + ")");
    }
  }

  function renderShapeNode(elm, node, rctx) {
    const props = node.props || {};
    const style = node.style || {};
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.display = "block";
    // Geometry is inset by half its stroke width, so the complete border stays
    // inside the authored frame and its editor selection box.
    svg.style.overflow = "hidden";

    // svgFillColor already resolves an image fill to its fallback color; a
    // resolvable URL upgrades it to a per-node <pattern> painted onto the
    // geometry, so the ellipse/polygon/rounded outline crops the image
    // naturally. Pattern ids are unique per render (node id + random suffix)
    // so multiple instances of the same node never collide.
    let fill = svgFillColor(style.fill);
    const fillImageUrl = imageFillUrl(style.fill, rctx);
    if (fillImageUrl) {
      const pid = "fmfill-" + String(node.id || "n").replace(/[^A-Za-z0-9_-]/g, "") + "-" + Math.random().toString(36).slice(2, 8);
      const defs = document.createElementNS(SVG_NS, "defs");
      const pattern = document.createElementNS(SVG_NS, "pattern");
      pattern.setAttribute("id", pid);
      pattern.setAttribute("patternUnits", "userSpaceOnUse");
      pattern.setAttribute("x", "0");
      pattern.setAttribute("y", "0");
      if (style.fill.fallback_color) {
        // Painted beneath the image: an unloadable URL degrades to the
        // fallback color instead of an invisible shape.
        const under = document.createElementNS(SVG_NS, "rect");
        under.setAttribute("fill", style.fill.fallback_color);
        pattern.appendChild(under);
      }
      const image = document.createElementNS(SVG_NS, "image");
      image.setAttribute("href", fillImageUrl);
      image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", fillImageUrl);
      pattern.appendChild(image);
      if (style.fill.overlay_color && fillOpacity(style.fill, "overlay_opacity", 1) > 0) {
        const overlay = document.createElementNS(SVG_NS, "rect");
        overlay.setAttribute("fill", style.fill.overlay_color);
        overlay.setAttribute("fill-opacity", String(fillOpacity(style.fill, "overlay_opacity", 1)));
        overlay.setAttribute("data-fmdoc-fill-overlay", "true");
        pattern.appendChild(overlay);
      }
      defs.appendChild(pattern);
      svg.appendChild(defs);
      fill = "url(#" + pid + ")";
    }
    const stroke = style.stroke || {};
    const strokeColor = stroke.color || "none";
    const strokeWidth = Number(stroke.width_pt) || 0;
    const applyPaint = (shape) => {
      shape.setAttribute("fill", fill);
      if (!fillImageUrl && style.fill && style.fill.type === "solid") {
        shape.setAttribute("fill-opacity", String(fillOpacity(style.fill, "opacity", 1)));
      }
      shape.setAttribute("stroke", strokeWidth ? strokeColor : "none");
      if (strokeWidth) {
        shape.setAttribute("stroke-width", String(strokeWidth));
        if (stroke.dash) shape.setAttribute("stroke-dasharray", Array.isArray(stroke.dash) ? stroke.dash.join(" ") : String(stroke.dash));
        shape.setAttribute("stroke-linecap", "round");
        shape.setAttribute("stroke-linejoin", "round");
      }
      return shape;
    };

    const points = Array.isArray(props.points) ? props.points : null;
    const kind = props.shape || "rect";
    if (kind === "rect") {
      const rect = document.createElementNS(SVG_NS, "rect");
      rect.setAttribute("x", "0");
      rect.setAttribute("y", "0");
      if (props.corner_radius) rect.setAttribute("rx", String(props.corner_radius));
      svg.appendChild(applyPaint(rect));
    } else if (kind === "ellipse") {
      const ellipse = document.createElementNS(SVG_NS, "ellipse");
      svg.appendChild(applyPaint(ellipse));
    } else if (kind === "line") {
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", strokeColor === "none" ? fill : strokeColor);
      line.setAttribute("stroke-width", String(strokeWidth || 1));
      if (stroke.dash) line.setAttribute("stroke-dasharray", Array.isArray(stroke.dash) ? stroke.dash.join(" ") : String(stroke.dash));
      svg.appendChild(line);
    } else if (kind === "polygon") {
      const polygon = document.createElementNS(SVG_NS, "polygon");
      svg.appendChild(applyPaint(polygon));
    } else if (kind === "path") {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", String(props.d || ""));
      // Path data is authored in a 0..1 unit space; scale to the frame and
      // keep strokes un-distorted via non-scaling-stroke.
      path.setAttribute("vector-effect", "non-scaling-stroke");
      svg.appendChild(applyPaint(path));
    }
    syncShapeSvg(svg, node);
    elm.appendChild(svg);
    if (props.text !== undefined && props.text !== null && String(props.text) !== "") {
      const textStyle = props.text_style || {};
      const label = h("div", "fmdoc-shape-label");
      label.textContent = String(props.text);
      label.style.color = textStyle.color || "#111827";
      if (textStyle.family) label.style.fontFamily = expandFontFamily(textStyle.family);
      if (Number(textStyle.size_pt) > 0) label.style.fontSize = pt(textStyle.size_pt);
      if (textStyle.weight) label.style.fontWeight = String(textStyle.weight);
      if (textStyle.italic) label.style.fontStyle = "italic";
      if (textStyle.underline) label.style.textDecoration = "underline";
      const align = props.text_align || "center";
      const valign = props.text_valign || "middle";
      label.style.textAlign = align;
      label.style.justifyContent = align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center";
      label.style.alignItems = valign === "top" ? "flex-start" : valign === "bottom" ? "flex-end" : "center";
      elm.appendChild(label);
    }
  }

  // ---------------------------------------------------------------------------
  // Table rendering (static, non-live)
  // ---------------------------------------------------------------------------

  function renderTableNode(elm, node, rctx) {
    const props = node.props || {};
    const table = h("table", "fmdoc-table");
    table.style.setProperty("--fmdoc-table-border-width", pt(Math.max(0, Number(props.border_width_pt === undefined ? 0.75 : props.border_width_pt) || 0)));
    table.style.setProperty("--fmdoc-table-border-color", String(props.border_color || "#d7dce3"));
    table.style.setProperty("--fmdoc-table-cell-padding", pt(Math.max(0, Number(props.cell_padding_pt === undefined ? 5 : props.cell_padding_pt) || 0)));
    if (props.row_stripe) table.classList.add("fmdoc-table--striped");
    const columns = Array.isArray(props.columns) ? props.columns : [];
    if (columns.length) {
      const colgroup = document.createElement("colgroup");
      for (const column of columns) {
        const col = document.createElement("col");
        if (column.width_pt) col.style.width = pt(column.width_pt);
        else if (column.width_frac) col.style.width = column.width_frac * 100 + "%";
        colgroup.appendChild(col);
      }
      table.appendChild(colgroup);
    }
    const rows = Array.isArray(props.rows) ? props.rows : [];
    let body = null;
    rows.forEach((row, rowIndex) => {
      const isHeader = props.header !== false && rowIndex === 0;
      const tr = h("tr");
      (row.cells || []).forEach((cell, cellIndex) => {
        const td = h(isHeader ? "th" : "td");
        // Stable coordinates for the doc-mode cell editor.
        td.setAttribute("data-cell", rowIndex + ":" + cellIndex);
        const column = columns[cellIndex];
        td.style.textAlign = (column && column.align) || props.cell_align || "left";
        td.style.verticalAlign = props.cell_valign || "top";
        if (cell && Number(cell.colspan) > 1) td.colSpan = Number(cell.colspan);
        if (cell && cell.fill) td.style.backgroundColor = String(cell.fill);
        if (Array.isArray(cell.blocks)) {
          renderTextBlocks(td, { props: { blocks: cell.blocks }, style: node.style || {} }, rctx);
        } else {
          td.textContent = cleanText(cell.text !== undefined ? cell.text : cell);
        }
        tr.appendChild(td);
      });
      if (isHeader) {
        const thead = h("thead");
        thead.appendChild(tr);
        table.appendChild(thead);
      } else {
        if (!body) {
          body = h("tbody");
          table.appendChild(body);
        }
        body.appendChild(tr);
      }
    });
    elm.appendChild(table);
  }

  // ---------------------------------------------------------------------------
  // Widget rendering
  // ---------------------------------------------------------------------------

  function parseWidgetRef(ref) {
    const raw = cleanText(ref);
    const at = raw.lastIndexOf("@");
    if (at === -1) return { id: raw, version: 1 };
    return { id: raw.slice(0, at), version: Number(raw.slice(at + 1)) || 1 };
  }

  function widgetCapability(refId) {
    const id = cleanText(refId).toLowerCase().split("@")[0];
    if (id === "doc.signature") return "documents.esign";
    if (id === "doc.pay_now" || id === "doc.payment_schedule") return "documents.payments";
    return "";
  }

  function unknownWidgetPlaceholder(elm, label) {
    clearEl(elm);
    const box = h("div", "fmdoc-widget-unknown");
    box.appendChild(h("div", "fmdoc-widget-unknown-label")).textContent = label;
    elm.appendChild(box);
  }

  function mountWidget(elm, node, rctx) {
    const ref = parseWidgetRef(node.props && node.props.widget);
    // Registry resolution: an explicit options.widgetRegistry wins (the PDF
    // harness / Node callers pass the required registry), else the global.
    const lib = rctx.state.opts.widgetRegistry || widgetsLib();
    const def = lib && ref.id ? lib.get(ref.id, ref.version) : null;
    if (!def) {
      // Unknown widget id/version: neutral placeholder, never a throw.
      unknownWidgetPlaceholder(elm, ref.id ? ref.id + "@" + ref.version : "widget");
      return;
    }
    // Content-height widgets may keep a numeric fallback height in their
    // authored frame for placement and older documents, but that fallback
    // must not create empty selected space or clip dynamic content. Width is
    // still frame-controlled; height follows the mounted widget contents.
    if (def.heightMode === "content") {
      elm.style.height = "auto";
      elm.style.minHeight = "0";
      elm.setAttribute("data-fmdoc-content-height", "true");
    }
    const state = rctx.state;
    const nodeProps = (node && node.props) || {};
    const requiredCapability = widgetCapability(ref.id);
    const disabledByCapability = requiredCapability && rctx.capabilities && rctx.capabilities[requiredCapability] === false;
    if (nodeProps.disabled === true || disabledByCapability) {
      elm.classList.add("fmdoc-capability-disabled");
      elm.setAttribute("aria-disabled", "true");
      const label = requiredCapability === "documents.esign" ? "E-signature" : "Payments";
      elm.setAttribute("data-disabled-reason", cleanText(nodeProps.disabled_reason) || `${label} is disabled for this organization.`);
    }
    const ctx = {
      node,
      config: (node.props && node.props.config) || {},
      data: state.widgetData[node.id] === undefined ? null : state.widgetData[node.id],
      mode: rctx.mode,
      // Authoring hosts opt into a canvas-native preview. Renderers use this
      // only when resolved project data is unavailable; the actual widget is
      // still what gets mounted in the page.
      preview: rctx.preview === true,
      // Distinct from static/interactive: an editor is interactive for object
      // manipulation, but must not execute customer-facing widget actions.
      authoring: rctx.authoring === true,
      definition: typeof rctx.definitionResolver === "function"
        ? (rctx.definitionResolver(ref.id, ref.version) || def)
        : def,
      scope: rctx.scope,
      themeVars: rctx.themeVars,
      skin: ((rctx.theme && rctx.theme.widget_skins) || {})[ref.id] || {},
      submitOutput: rctx.mode === "interactive" ? rctx.submitOutput : function () {},
      outputs: rctx.outputs,
      api: rctx.api,
      mediaUrl: rctx.resolveMediaUrl,
      resolvePageHref: rctx.resolvePageHref || null,
      // Customer-portal hosting context for portal.* widgets (contracts §11).
      // Null outside a portal, which is what makes those widgets degrade to a
      // placeholder rather than render project data on a public page.
      portal: rctx.portal || null,
      refresh: () => {
        clearEl(elm);
        mountWidget(elm, node, rctx);
      }
    };
    let result;
    try {
      result = rctx.mode === "static" ? def.renderStatic(elm, ctx) : (def.renderInteractive || def.renderStatic)(elm, ctx);
    } catch (error) {
      unknownWidgetPlaceholder(elm, ref.id + " (render failed)");
      return;
    }
    const settled = Promise.resolve(result)
      .then((value) => {
        if (!value) return;
        if (typeof value.destroy === "function") state.destroyers.push(value.destroy);
        // Pagination hint: { rows: HTMLElement[] } marks splittable rows.
        if (Array.isArray(value.rows) && value.rows.length) {
          for (const row of value.rows) {
            if (row && row.setAttribute) row.setAttribute("data-fmdoc-row", "true");
          }
          const parent = value.rows[0] && value.rows[0].parentElement;
          if (parent && !parent.hasAttribute("data-fmdoc-rows")) parent.setAttribute("data-fmdoc-rows", "true");
        }
      })
      .catch(() => {});
    state.widgetPromises.push(settled);
  }

  // ---------------------------------------------------------------------------
  // Node dispatch
  // ---------------------------------------------------------------------------

  /**
   * Anchored-children pass (v2). Inline and float anchors are represented in
   * the model as SIBLINGS of the text blocks they attach to (children of the
   * same frame) — there is no run-level inline marker in DocModel v2, so this
   * renderer adopts the sibling interpretation documented in the contract:
   *   - anchor:"inline" + props.after_block (block id) [+ props.inline_offset
   *     = run index]: the node is inserted INTO that block's run stream as an
   *     inline-block (before the run at inline_offset, else appended).
   *   - anchor:{ to_block, offset?, wrap:"left"|"right"|"none" }: the node is
   *     inserted at the START of the referenced block so text wraps around it
   *     via CSS float (each .fmdoc-block is a flex item and therefore its own
   *     formatting context — the float wraps that block's text only and is
   *     included in its height). Because the float sits before the block's
   *     first run, a line-level split always keeps it with the HEAD part.
   *   - offset (pt) nudges the anchored node vertically (margin-top).
   * Targets are looked up within the same frame element ([data-block-id],
   * falling back to [data-node-id]); cross-frame anchors are not supported.
   */
  function attachAnchoredChildren(frameEl, inlineKids, floatKids, rctx) {
    const findBlockTarget = (ref) => {
      const selector = '[data-block-id="' + String(ref).replace(/"/g, '\\"') + '"], [data-node-id="' + String(ref).replace(/"/g, '\\"') + '"]';
      let target = null;
      try {
        target = frameEl.querySelector(selector);
      } catch (error) {
        return null;
      }
      if (target && !target.classList.contains("fmdoc-block")) {
        // node-level ref: attach to the node's first block
        target = target.querySelector(".fmdoc-block") || target;
      }
      return target;
    };
    for (const child of floatKids) {
      const anchor = child.anchor || {};
      const el = renderNode(child, rctx, true);
      if (!el) continue;
      const wrap = anchor.wrap === "left" ? "left" : anchor.wrap === "none" ? "none" : "right";
      el.setAttribute("data-fmdoc-float", wrap);
      if (anchor.offset) el.style.marginTop = pt(anchor.offset);
      const target = findBlockTarget(anchor.to_block);
      if (!target) {
        frameEl.appendChild(el); // never lose content: degrade to a plain block
        continue;
      }
      if (wrap === "none") target.parentNode.insertBefore(el, target);
      else target.insertBefore(el, target.firstChild);
    }
    for (const child of inlineKids) {
      const props = child.props || {};
      const el = renderNode(child, rctx, true);
      if (!el) continue;
      el.setAttribute("data-fmdoc-inline", "true");
      const target = props.after_block !== undefined && props.after_block !== null ? findBlockTarget(props.after_block) : null;
      if (!target) {
        frameEl.appendChild(el);
        continue;
      }
      const idx = Number(props.inline_offset);
      const runs = target.children;
      if (Number.isFinite(idx) && idx >= 0 && idx < runs.length) target.insertBefore(el, runs[idx]);
      else target.appendChild(el);
    }
  }

  /**
   * Frame body (also used for detached component_ref nodes). v2: a frame with
   * props.chain = { id, index } is a flow-chain member — it always lays out as
   * a column flow, carries data-chain/data-chain-index for the editor, and its
   * flow children are stamped data-fmdoc-flow so the chain layout pass can
   * pour them through the chain. Child anchors:
   *   "flow" / absent → block in the flow (source order, position static)
   *   "page"          → absolutely positioned within the frame (legacy)
   *   "inline" / {to_block} → attached into the run stream / floated
   */
  function renderFrameContents(elm, node, rctx) {
    const props = node.props || {};
    if (props.view_variant === "mobile" && props.variant_of) {
      elm.setAttribute("data-view-variant", "mobile");
      elm.setAttribute("data-variant-of", String(props.variant_of));
      elm.setAttribute("data-mobile-enabled", props.mobile_enabled === true ? "true" : "false");
    } else if (rctx && rctx.doc && rctx.doc.kind === "view" && rctx.doc.root && (rctx.doc.root.children || []).indexOf(node) !== -1) {
      const mobile = model().mobileViewSection ? model().mobileViewSection(rctx.doc, node) : null;
      const enabled = props.mobile_variant_enabled === true && mobile && mobile.props && mobile.props.mobile_enabled === true;
      elm.setAttribute("data-view-variant", "desktop");
      elm.setAttribute("data-mobile-variant-enabled", enabled ? "true" : "false");
    }
    if (props.page_region) elm.setAttribute("data-page-region", String(props.page_region));
    if (props.fmde_doc_placeholder) {
      elm.setAttribute("data-fmde-doc-placeholder", "true");
      elm.setAttribute("data-fmde-placeholder-page-id", String(props.fmde_placeholder_page_id || ""));
    }
    if (props.background) {
      const bg = model().fillToCss(props.background);
      if (bg) elm.style.background = bg;
    }
    if (props.clip) elm.style.overflow = "hidden";
    const chain = props.chain && props.chain.id ? props.chain : null;
    const isFlow = (node.frame && node.frame.layout) === "flow" || Boolean(chain);
    const viewFrame = !!(rctx && rctx.doc && rctx.doc.kind === "view");
    if (viewFrame) {
      // Container queries must follow the simulated/published section width,
      // not the desktop browser window that happens to host the editor.
      elm.style.containerType = "inline-size";
      elm.style.minWidth = "0";
    }
    if (isFlow) {
      const flow = props.flow || {};
      elm.style.display = "flex";
      elm.style.flexDirection = flow.direction === "row" ? "row" : "column";
      if (viewFrame) elm.setAttribute("data-flow-direction", flow.direction === "row" ? "row" : "column");
      elm.style.gap = pt(flow.gap || 0);
      const padding = Array.isArray(flow.padding) ? flow.padding : [0, 0, 0, 0];
      elm.style.padding = padding.map((p) => pt(p)).join(" ");
      const alignMap = { start: "flex-start", end: "flex-end", center: "center", stretch: "stretch", baseline: "baseline" };
      elm.style.alignItems = alignMap[flow.align] || "stretch";
      if (flow.justify) elm.style.justifyContent = alignMap[flow.justify] || flow.justify;
      if (flow.wrap) elm.style.flexWrap = "wrap";
      if (chain) {
        // Chained frames paginate through the chain pass, never the legacy one.
        elm.setAttribute("data-chain", String(chain.id));
        elm.setAttribute("data-chain-index", String(Number(chain.index) || 0));
        // The chain pass uses scroll geometry to detect overflow, but the
        // authored frame remains the visible boundary while a live editor is
        // waiting to repaginate. Never let body text paint through a footer.
        if (props.overflow === "hidden" || props.clip) elm.style.overflow = "hidden";
      } else if (props.overflow === "paginate") elm.setAttribute("data-fmdoc-paginate", "true");
      else if (props.overflow === "hidden" || props.clip) elm.style.overflow = "hidden";
    }
    const inlineKids = [];
    const floatKids = [];
    const ownWidthPt = Number(node && node.frame && node.frame.w);
    const childCtx = viewFrame
      ? Object.assign({}, rctx, {
          responsiveParentWidthPt: Number.isFinite(ownWidthPt) && ownWidthPt > 0 ? ownWidthPt : rctx.responsiveParentWidthPt,
          viewSectionChild: node === rctx.doc.root
        })
      : rctx;
    const autoRowById = new Map();
    if (viewFrame && model().responsiveAutoRows) {
      for (const row of model().responsiveAutoRows(node.children || [])) {
        for (const item of row.items) {
          autoRowById.set(String(item.id), {
            row: row.index,
            gapAbove: row.gap_above,
            offsetTop: item.offset_top
          });
        }
      }
    }
    for (const child of node.children || []) {
      const anchor = child && child.anchor;
      if (anchor === "inline") {
        inlineKids.push(child);
        continue;
      }
      if (isObject(anchor) && anchor.to_block) {
        floatKids.push(child);
        continue;
      }
      const childInFlow = isFlow && anchor !== "page";
      const childRenderCtx = autoRowById.has(String(child && child.id))
        ? Object.assign({}, childCtx, { autoResizeItem: autoRowById.get(String(child.id)) })
        : childCtx;
      const childEl = renderNode(child, childRenderCtx, childInFlow);
      if (childEl) {
        if (chain && childInFlow) childEl.setAttribute("data-fmdoc-flow", "true");
        elm.appendChild(childEl);
      }
    }
    if (inlineKids.length || floatKids.length) attachAnchoredChildren(elm, inlineKids, floatKids, childCtx);
  }

  /**
   * Repeater node: children are the resolved instances (doc-model output).
   * props.layout { direction, columns, gap_pt } drives arrangement; instances
   * are the split units — the container is tagged [data-fmdoc-rows] and each
   * instance [data-fmdoc-row] so BOTH the chain layout pass and the legacy
   * paginate machinery split it at instance boundaries. break_rules are
   * carried on data attributes so the split code can honor them on clones.
   */
  function renderRepeaterNode(elm, node, rctx, inFlow) {
    const props = node.props || {};
    const layout = props.layout || {};
    const columns = Math.max(1, Number(layout.columns) || 1);
    const gap = Number(layout.gap_pt);
    elm.classList.add("fmdoc-repeater");
    elm.setAttribute("data-fmdoc-rows", "true");
    elm.setAttribute("data-fmdoc-repeater", "true");
    if (columns > 1) {
      elm.style.display = "grid";
      elm.style.gridTemplateColumns = "repeat(" + columns + ", 1fr)";
      elm.setAttribute("data-fmdoc-columns", String(columns));
    } else {
      elm.style.display = "flex";
      elm.style.flexDirection = layout.direction === "row" ? "row" : "column";
    }
    elm.style.gap = pt(Number.isFinite(gap) ? gap : 6);
    const instances = node.children || [];
    const rules = props.break_rules || {};
    // repeat_header applies when instance 0 is a header component: name ends
    // in "_header" or matches break_rules.header_component (contract §7/C).
    const first = instances[0];
    const headerApplies =
      Boolean(rules.repeat_header) &&
      first &&
      typeof first.component === "string" &&
      (/_header$/.test(first.component) || (rules.header_component && rules.header_component === first.component));
    if (headerApplies) elm.setAttribute("data-fmdoc-repeat-header", "true");
    if (rules.min_rows_per_segment) elm.setAttribute("data-fmdoc-min-rows", String(rules.min_rows_per_segment));
    if (Array.isArray(rules.keep_with_next) && rules.keep_with_next.length) elm.setAttribute("data-fmdoc-keep-next", rules.keep_with_next.join(","));
    // Absolute repeater with overflow:"paginate" splits across cloned pages
    // through the legacy machinery (instances are its direct children).
    if (!inFlow && props.overflow === "paginate") elm.setAttribute("data-fmdoc-paginate", "true");
    if (!instances.length) {
      const emptyText = cleanText(props.empty_text);
      if (emptyText) {
        const empty = h("div", "fmdoc-repeater-empty");
        empty.textContent = emptyText;
        elm.appendChild(empty);
      }
      return;
    }
    for (const inst of instances) {
      const instEl = renderNode(inst, rctx, true);
      if (instEl) {
        instEl.setAttribute("data-fmdoc-row", "true");
        elm.appendChild(instEl);
      }
    }
  }

  /**
   * props.link → resolved { href, target } or null (contracts §10).
   * href resolution order: link.href, else link.page through the host's
   * widgetContext.resolvePageHref (site runtime / portal supply it; plain
   * documents don't, so page-only links render without an anchor there).
   */
  function nodeLink(node, rctx) {
    const link = node.props && node.props.link;
    if (!link || typeof link !== "object" || Array.isArray(link)) return null;
    let href = typeof link.href === "string" && link.href ? link.href : "";
    if (!href && link.page && typeof rctx.resolvePageHref === "function") {
      try {
        href = String(rctx.resolvePageHref(String(link.page)) || "");
      } catch (error) {
        href = "";
      }
    }
    if (!href) return null;
    return { href, target: link.target === "_blank" ? "_blank" : null };
  }

  function renderNode(node, rctx, inFlow) {
    if (!node || node.visible === false) return null;
    // Linked nodes render as <a> — the node element itself is the anchor so
    // the DOM contract (data-node-id/data-node-type on the node element,
    // children positioned inside it) is untouched for overlays/hit-testing.
    const link = nodeLink(node, rctx);
    const elm = h(link ? "a" : "div", "fmdoc-node fmdoc-" + node.type + (link ? " fmdoc-link" : ""));
    if (link) {
      elm.setAttribute("href", link.href);
      if (link.target === "_blank") {
        elm.setAttribute("target", "_blank");
        elm.setAttribute("rel", "noopener");
      }
    }
    elm.setAttribute("data-node-id", node.id);
    elm.setAttribute("data-node-type", node.type);
    if (rctx.chrome) elm.setAttribute("data-chrome", "true");
    // Editor hooks: resolved component instances carry these markers.
    if (node.component) elm.setAttribute("data-component", String(node.component));
    if (node.component_ref_id) elm.setAttribute("data-component-ref", String(node.component_ref_id));
    if (node.repeater_index !== undefined && node.repeater_index !== null) elm.setAttribute("data-repeater-index", String(node.repeater_index));
    applyFrame(elm, node.frame, inFlow, rctx, node);
    applyNodeStyle(elm, node, rctx);

    switch (node.type) {
      case "component_ref": {
        // Only unresolved (missing def) or detached refs reach the renderer;
        // resolved instances arrive inlined as ordinary subtrees.
        const props = node.props || {};
        if (node.resolved_component_missing || !props.detached) {
          // Neutral placeholder with the component name — never throw.
          const box = h("div", "fmdoc-component-missing");
          box.textContent = cleanText(props.component) || "component";
          elm.appendChild(box);
          break;
        }
        // Detached instance: children are the fork; render like a frame.
        renderFrameContents(elm, node, rctx);
        break;
      }
      case "repeater": {
        renderRepeaterNode(elm, node, rctx, inFlow);
        break;
      }
      case "page_break":
        // Zero-height marker; the chain/pagination pass consumes it.
        break;
      case "frame": {
        renderFrameContents(elm, node, rctx);
        break;
      }
      case "text":
        renderTextNode(elm, node, rctx);
        break;
      case "image":
        renderImageNode(elm, node, rctx);
        break;
      case "shape":
        renderShapeNode(elm, node, rctx);
        break;
      case "widget":
        mountWidget(elm, node, rctx);
        break;
      case "markup_overlay": {
        // Reuses the markup system's normalized 0..1 items. Items may arrive
        // resolved on the node (props.items / props.markup.items) or through
        // widgetData keyed by node id ({ items } from the media layer).
        const props = node.props || {};
        const data = rctx.state.widgetData[node.id];
        const items = (Array.isArray(props.items) && props.items) || (props.markup && props.markup.items) || (data && (Array.isArray(data) ? data : data.items)) || [];
        const overlay = markupOverlayElement(items);
        if (overlay) elm.appendChild(overlay);
        elm.classList.add("fmdoc-markup-host");
        break;
      }
      case "table":
        renderTableNode(elm, node, rctx);
        break;
      default:
        elm.classList.add("fmdoc-node--unknown");
        break;
    }
    return elm;
  }

  /** Apply the shared responsive sizing contract to a root website section. */
  function applyViewSectionWidth(sectionEl, sectionNode) {
    if (!sectionEl || !sectionNode) return;
    const sizing = model().normalizeSectionWidth
      ? model().normalizeSectionWidth(sectionNode.props && sectionNode.props.section_width)
      : { width_percent: 100, max_enabled: true, max_width_px: 1000 };
    // Percentages are relative to the rendered website surface. In the
    // editor that surface excludes open rails, trays and inspectors; on the
    // published site it naturally resolves against the public page width.
    sectionEl.style.width = sizing.width_percent + "%";
    sectionEl.style.maxWidth = sizing.max_enabled ? sizing.max_width_px + "px" : "";
    // The root is a column flex container. align-self:center deliberately
    // distributes overflow evenly when a section is wider than the nominal
    // page. Auto inline margins do the opposite for an oversized flex item:
    // they collapse to zero and pin its left edge to the page origin.
    sectionEl.style.alignSelf = "center";
    sectionEl.style.minWidth = "0";
    sectionEl.style.containerType = "inline-size";
    sectionEl.style.overflowX = "clip";
    sectionEl.style.marginLeft = "";
    sectionEl.style.marginRight = "";
    sectionEl.setAttribute("data-section-width-percent", String(sizing.width_percent));
    if (sizing.max_enabled) sectionEl.setAttribute("data-section-max-width", String(sizing.max_width_px));
    else sectionEl.removeAttribute("data-section-max-width");
  }

  /** Resolve website section widths against the actual visible host surface.
   * The page may retain a fixed design width for positioned contents, while
   * its section backgrounds remain responsive. Dividing by render scale keeps
   * both the percentage and pixel cap exact in final on-screen pixels. */
  function syncViewSectionWidths(state, surfaceWidthPx) {
    const doc = state && state.opts && state.opts.document;
    if (!state || !doc || doc.kind !== "view" || !state.pageEls || !state.pageEls[0]) return;
    const availableWidth = Number(surfaceWidthPx);
    const metadata = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {};
    const workflowWidth = metadata.workflow_page === true ? Number(metadata.workflow_max_width_px) : 0;
    // Website views consume their host width. Workflow views are embeddable
    // controls and own only their standardized surface; the host supplies any
    // surrounding tab/page background or content.
    const width = workflowWidth > 0 ? Math.min(availableWidth, workflowWidth) : availableWidth;
    if (!(width > 0)) return;
    state.viewSurfaceWidthPx = width;
    const scale = Math.max(0.01, Number(state.opts.scale) || 1);
    const nodes = new Map((doc.root && doc.root.children || []).map((node) => [String(node && node.id || ""), node]));
    const rootId = String(doc.root && doc.root.id || "").replace(/"/g, '\\"');
    const rootNodeEl = state.pageEls[0].querySelector('[data-node-id="' + rootId + '"]');
    if (!rootNodeEl) return;
    const layoutWidth = width / scale;
    // Make the coordinate wrapper itself equal the available surface. This
    // removes the old hidden design-width "page" that sections could appear
    // inside of or overflow, and gives every section one shared center axis.
    state.pageEls[0].style.width = layoutWidth + "px";
    state.pageEls[0].style.maxWidth = "none";
    state.pageEls[0].style.overflowX = "clip";
    rootNodeEl.style.width = "100%";
    rootNodeEl.style.maxWidth = "100%";
    rootNodeEl.style.overflowX = "clip";
    if (state.scaleWrap) state.scaleWrap.style.width = layoutWidth + "px";
    if (state.root) state.root.style.width = width + "px";
    for (const child of rootNodeEl.children) {
      if (!child.getAttribute || child.getAttribute("data-node-type") !== "frame") continue;
      const node = nodes.get(String(child.getAttribute("data-node-id") || ""));
      const sizing = model().normalizeSectionWidth
        ? model().normalizeSectionWidth(node && node.props && node.props.section_width)
        : { width_percent: 100, max_enabled: true, max_width_px: 1000 };
      const availableLayoutWidth = width / scale;
      const requestedWidth = availableLayoutWidth * sizing.width_percent / 100;
      const maximumWidth = sizing.max_enabled ? Math.min(availableLayoutWidth, sizing.max_width_px / scale) : availableLayoutWidth;
      const sectionWidth = Math.min(availableLayoutWidth, requestedWidth, maximumWidth);
      child.style.width = sectionWidth + "px";
      child.style.maxWidth = availableLayoutWidth + "px";
      child.style.minWidth = "0";
      child.style.overflowX = "clip";

      // Auto-resize sections scale their complete authored vertical rhythm
      // with width. Because each child derives its top/height from that same
      // ratio, overlapping side-by-side items form one row and downstream
      // rows move once by the row's maximum growth rather than once per item.
      const authoredWidth = Math.max(1, Number(node && node.frame && node.frame.w) * PT_TO_PX || availableLayoutWidth);
      const authoredHeight = Math.max(0, Number(node && node.frame && node.frame.h) * PT_TO_PX || 0);
      const autoRows = model().responsiveAutoRows && node ? model().responsiveAutoRows(node.children || []) : [];
      if (autoRows.length && authoredHeight > 0) {
        const responsiveMinHeight = Math.max(48, authoredHeight * sectionWidth / authoredWidth);
        child.style.height = "auto";
        child.style.minHeight = responsiveMinHeight + "px";
        const contentHeight = child.scrollHeight;
        if (contentHeight > responsiveMinHeight) child.style.minHeight = contentHeight + "px";
        child.setAttribute("data-responsive-auto", "true");
        if (availableLayoutWidth <= 600) child.setAttribute("data-responsive-narrow", "true");
        else child.removeAttribute("data-responsive-narrow");
      } else if (availableLayoutWidth <= 600 && authoredHeight > 0) {
        const responsiveMinHeight = Math.max(48, authoredHeight * Math.min(1, sectionWidth / authoredWidth));
        child.style.height = "auto";
        child.style.minHeight = responsiveMinHeight + "px";
        const contentHeight = child.scrollHeight;
        if (contentHeight > responsiveMinHeight) child.style.minHeight = contentHeight + "px";
        child.setAttribute("data-responsive-narrow", "true");
      } else {
        child.style.height = authoredHeight > 0 ? authoredHeight + "px" : "";
        child.style.minHeight = "";
        child.removeAttribute("data-responsive-auto");
        child.removeAttribute("data-responsive-narrow");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Page building
  // ---------------------------------------------------------------------------

  /** Render one master header/footer slot into a page section (v2 §7). */
  function renderMasterSlot(section, master, slot, rctx) {
    const defn = master && master[slot];
    if (!defn || !Array.isArray(defn.chrome) || !defn.chrome.length) return;
    const wrapEl = h("div", "fmdoc-master-hf fmdoc-master-" + slot);
    wrapEl.setAttribute("data-chrome", "true");
    wrapEl.style.height = pt(Number(defn.frame_h_pt) || 36);
    const slotCtx = Object.assign({}, rctx, { chrome: true });
    for (const slotNode of defn.chrome) {
      const el = renderNode(slotNode, slotCtx, false);
      if (el) wrapEl.appendChild(el);
    }
    section.appendChild(wrapEl);
  }

  /** Resolve an explicit page master, including the per-page `none` sentinel
   * used by page menus to suppress decorative theme chrome. */
  function pageMasterForPage(theme, page) {
    const ref = cleanText(page && page.master_ref);
    if (ref === "none") return null;
    if (ref) {
      const explicit = ((theme && theme.page_masters) || []).find((master) => cleanText(master && master.id) === ref);
      if (explicit) return explicit;
    }
    return model().pageMasterForRole(theme, (page && page.role) || "body");
  }

  /** Header/footer heights for a page (auto-page margins must clear them). */
  function masterSlotHeights(theme, page) {
    const master = pageMasterForPage(theme, page);
    const heightOf = (slot) => {
      const defn = master && master[slot];
      return defn && Array.isArray(defn.chrome) && defn.chrome.length ? Number(defn.frame_h_pt) || 36 : 0;
    };
    return { header: heightOf("header"), footer: heightOf("footer") };
  }

  /** Map the document's conventional 40pt design box into a theme safe area. */
  function pageFrameMap(theme, master, paper, enabled) {
    if (!enabled || paper.fill) return null;
    const spacing = theme && theme.tokens && theme.tokens.spacing || {};
    const inset = master && master.content_inset || {};
    const all = Number(spacing.page_margin_pt);
    const fallback = Number.isFinite(all) ? Math.max(0, all) : 40;
    const side = (name) => {
      const masterValue = Number(inset[name]);
      if (Number.isFinite(masterValue)) return Math.max(0, masterValue);
      const tokenValue = Number(spacing["page_margin_" + name + "_pt"]);
      return Number.isFinite(tokenValue) ? Math.max(0, tokenValue) : fallback;
    };
    const left = side("left");
    const right = side("right");
    const top = side("top");
    const bottom = side("bottom");
    const base = Number.isFinite(Number(spacing.design_margin_pt)) ? Math.max(0, Number(spacing.design_margin_pt)) : 40;
    const designW = Math.max(1, paper.w_pt - base * 2);
    const designH = Math.max(1, paper.h_pt - base * 2);
    return {
      left, right, top, bottom, base,
      paperW: paper.w_pt,
      paperH: paper.h_pt,
      sx: Math.max(0.05, (paper.w_pt - left - right) / designW),
      sy: Math.max(0.05, (paper.h_pt - top - bottom) / designH)
    };
  }

  function buildPage(page, paper, rctx) {
    const section = document.createElement("section");
    section.className = "fmdoc-page";
    section.setAttribute("data-page-id", page.id);
    section.setAttribute("data-role", page.role || "body");
    if (page.master_ref) section.setAttribute("data-master-ref", String(page.master_ref));
    // Fluid view surfaces (paper.size "fill") follow their container instead of
    // a fixed paper width, and grow to their content instead of a paper height.
    // Without this a "fill" page still lays out at 720pt and renders narrower
    // than its host panel.
    if (paper.fill) {
      section.style.width = "100%";
      section.style.height = "auto";
      section.setAttribute("data-fill", "true");
    } else {
      section.style.width = pt(paper.w_pt);
      section.style.height = pt(paper.h_pt);
    }
    const baseFont = rctx.baseFontPt;
    if (baseFont) section.style.fontSize = pt(baseFont);
    // Page background color (settings.page_background — Docs "Page color").
    const pageBackground = rctx.doc && rctx.doc.settings && rctx.doc.settings.page_background;
    if (pageBackground) section.style.background = String(pageBackground);
    // Pages use the same authored fill/stroke model as frames. This keeps a
    // media background crop-compatible without inserting a synthetic layer
    // that could accidentally be reordered above page content.
    if (page.style) applyNodeStyle(section, { type: "frame", style: page.style }, rctx);

    // Page-master chrome renders UNDER content (data-chrome, non-interactive).
    const master = pageMasterForPage(rctx.theme, page);
    // Authored page coordinates are the output coordinates. Theme masters may
    // paint chrome and advertise a safe area, but must not silently move page
    // content only in previews/PDFs. A legacy caller can still opt into the
    // old design-box mapping explicitly while migrated documents are opened.
    const frameMap = pageFrameMap(rctx.theme, master, paper, rctx.applyThemeMargins === true);
    if (frameMap) {
      section.setAttribute("data-content-inset", [frameMap.top, frameMap.right, frameMap.bottom, frameMap.left].join(" "));
    }
    if (master && Array.isArray(master.chrome) && master.chrome.length) {
      const chromeLayer = h("div", "fmdoc-chrome");
      chromeLayer.setAttribute("data-chrome", "true");
      const chromeCtx = Object.assign({}, rctx, { chrome: true });
      for (const chromeNode of master.chrome) {
        const chromeEl = renderNode(chromeNode, chromeCtx, false);
        if (chromeEl) chromeLayer.appendChild(chromeEl);
      }
      section.appendChild(chromeLayer);
    }

    // v2: master header/footer slots ({ frame_h_pt, chrome:[nodes] }) render
    // on every matching page — above the chrome layer, below content z.
    // doc.page_number works inside them (placeholders filled after assembly).
    renderMasterSlot(section, master, "header", rctx);
    renderMasterSlot(section, master, "footer", rctx);

    // Frames remain page-relative in the document model and normally render at
    // those exact coordinates. frameMap is present only for an explicit legacy
    // compatibility render of an older 40pt design-box document.
    const content = h("div", "fmdoc-page-content");
    for (const child of page.children || []) {
      const childCtx = frameMap
        ? Object.assign({}, rctx, { pageFrameMap: frameMap, pageTopLevelNodeId: child.id })
        : rctx;
      const childEl = renderNode(child, childCtx, false);
      if (childEl) content.appendChild(childEl);
    }
    section.appendChild(content);
    return section;
  }

  // ---------------------------------------------------------------------------
  // Pagination — split primitives
  //
  // Two consumers share these: the legacy paginate() pass (flow frames with
  // props.overflow === "paginate") and the v2 chain layout pass. All split
  // decisions are made from real staged geometry (getBoundingClientRect on
  // the unscaled staging layout).
  // ---------------------------------------------------------------------------

  function markSplitParts(headEl, tailEl) {
    // Parts share the source node id (data-node-id) and carry
    // data-fmdoc-split / data-split-part. A part that was already a tail and
    // splits again stays "tail" (3+ frame spans: head, tail, tail...).
    const headValue = headEl.getAttribute("data-fmdoc-split") === "tail" ? "tail" : "head";
    headEl.setAttribute("data-fmdoc-split", headValue);
    headEl.setAttribute("data-split-part", headValue);
    tailEl.setAttribute("data-fmdoc-split", "tail");
    tailEl.setAttribute("data-split-part", "tail");
    // Authored heights would double-impose on both parts.
    headEl.style.height = "";
    tailEl.style.height = "";
  }

  /** Break rules carried on a rows container (repeaters set these). */
  function rowRulesFor(rowsContainer) {
    const attr = (name) => (rowsContainer.getAttribute ? rowsContainer.getAttribute(name) : null);
    return {
      min: Math.max(1, Number(attr("data-fmdoc-min-rows")) || 1),
      keepList: String(attr("data-fmdoc-keep-next") || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      repeatHeader: attr("data-fmdoc-repeat-header") === "true",
      columns: Math.max(1, Number(attr("data-fmdoc-columns")) || 1)
    };
  }

  /**
   * Adjust a geometric row fit for break rules. Returns the number of rows
   * that stay in the head segment, or null for "do not split here" (caller
   * moves the whole element).
   *   - repeatHeader: row 0 is a header that stays in the head and is cloned
   *     onto every continuation; it does not count as a data row.
   *   - keepList (keep_with_next): a staying row whose data-component is
   *     listed is pulled into the next segment with its follower.
   *   - min: minimum data rows per segment (head AND tail).
   *   - columns: grid repeaters break at full-row boundaries.
   *   - atTop: the element sits alone at the top of its region — progress is
   *     forced (rules yield) because moving it wholesale cannot help.
   */
  function adjustRowFit(rows, geoFit, rules, atTop) {
    const total = rows.length;
    if (total < 2) return null;
    const dataStart = rules.repeatHeader ? 1 : 0;
    let fit = Math.min(geoFit, total);
    if (fit >= total) return null;
    let guard = 0;
    while (fit - dataStart > 1 && guard < 200) {
      guard += 1;
      const comp = rows[fit - 1].getAttribute ? rows[fit - 1].getAttribute("data-component") : null;
      if (comp && rules.keepList.indexOf(comp) !== -1) fit -= 1;
      else break;
    }
    if (total - fit < rules.min) fit = total - rules.min;
    if (rules.columns > 1 && fit > dataStart) fit = dataStart + Math.floor((fit - dataStart) / rules.columns) * rules.columns;
    if (fit - dataStart < rules.min) {
      if (!atTop) return null;
      fit = dataStart + Math.max(1, Math.min(Math.max(geoFit - dataStart, 1), total - dataStart - 1));
    }
    if (fit <= 0 || fit >= total) return null;
    return fit;
  }

  /**
   * Split an element at row boundaries against an ABSOLUTE bottom limit (px,
   * staging space). shellEl is the element that gets cloned as the
   * continuation shell (deep clone keeps header chrome/thead); rowsContainer
   * holds the row elements (may be shellEl itself for repeaters). Real row
   * elements are MOVED so row-level listeners survive; [data-fmdoc-tail]
   * content stays with the last segment.
   */
  function splitRowsElement(shellEl, rowsContainer, rows, limitY, atTop) {
    if (rows.length < 2) return null;
    let geoFit = 0;
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom <= limitY + 0.5) geoFit += 1;
      else break;
    }
    const rules = rowRulesFor(rowsContainer);
    const fit = adjustRowFit(rows, geoFit, rules, atTop);
    if (fit === null) return null;
    const locate =
      rowsContainer === shellEl
        ? (clone) => clone
        : rowsContainer.tagName === "TBODY"
          ? (clone) => clone.querySelector("tbody")
          : (clone) => clone.querySelector("[data-fmdoc-rows]");
    const continuation = shellEl.cloneNode(true);
    continuation.setAttribute("data-fmdoc-continuation", "true");
    const contRows = locate(continuation);
    if (!contRows) return null;
    clearEl(contRows);
    for (let i = fit; i < rows.length; i += 1) contRows.appendChild(rows[i]);
    if (rules.repeatHeader && fit >= 1) {
      const headerClone = rows[0].cloneNode(true);
      headerClone.setAttribute("data-fmdoc-repeat-clone", "true");
      contRows.insertBefore(headerClone, contRows.firstChild);
    }
    for (const tail of Array.from(shellEl.querySelectorAll("[data-fmdoc-tail]"))) tail.parentNode.removeChild(tail);
    markSplitParts(shellEl, continuation);
    return continuation;
  }

  // --------------------------------------------------------------- line split

  function isAtomicInline(el) {
    if (el.nodeType !== 1) return false;
    if (el.hasAttribute("data-fmdoc-inline")) return true;
    const tag = el.tagName;
    return tag === "IMG" || tag === "SVG" || tag === "CANVAS" || tag === "VIDEO";
  }

  /**
   * In-order inline leaves of a block: text nodes plus atomic inline-blocks.
   * Float subtrees are excluded — they are out-of-flow for line purposes and
   * their tall rects would corrupt line-box clustering.
   */
  function collectInlineLeaves(rootEl) {
    const leaves = [];
    (function walk(node) {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 3) {
          if (child.nodeValue && child.nodeValue.length) leaves.push({ kind: "text", node: child });
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (child.hasAttribute("data-fmdoc-float")) continue;
        if (isAtomicInline(child)) {
          leaves.push({ kind: "atom", el: child });
          continue;
        }
        walk(child);
      }
    })(rootEl);
    return leaves;
  }

  /**
   * Rendered line boxes of a block element: per-text-node Range client rects
   * (true line fragments, robust for mixed runs/inline nodes/line-heights)
   * clustered into vertical bands. Returns [{ top, bottom }] in document
   * order.
   */
  function measureLineBoxes(blockEl) {
    const leaves = collectInlineLeaves(blockEl);
    const rects = [];
    const range = document.createRange();
    for (const leaf of leaves) {
      if (leaf.kind === "text") {
        range.selectNodeContents(leaf.node);
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 0.01 && r.height > 0.01) rects.push(r);
        }
      } else {
        const r = leaf.el.getBoundingClientRect();
        if (r.height > 0.01) rects.push(r);
      }
    }
    rects.sort((a, b) => a.top - b.top || a.left - b.left);
    const lines = [];
    for (const r of rects) {
      const line = lines[lines.length - 1];
      const centerY = (r.top + r.bottom) / 2;
      if (line && centerY <= line.bottom + 0.5) {
        line.top = Math.min(line.top, r.top);
        line.bottom = Math.max(line.bottom, r.bottom);
      } else {
        lines.push({ top: r.top, bottom: r.bottom });
      }
    }
    return lines;
  }

  /**
   * First character index in a text node whose glyph sits below boundaryY
   * (-1 when the whole node is above). Binary search over per-character
   * Range rects — valid because glyph order is vertically monotonic within a
   * block. Collapsed whitespace produces degenerate rects; those are skipped
   * by probing forward, so a split can land on a collapsed space (harmless).
   */
  function firstCharBelow(node, boundaryY) {
    const len = node.nodeValue.length;
    const range = document.createRange();
    const probe = (i) => {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const r = range.getBoundingClientRect();
      if (r.width <= 0.01 && r.height <= 0.01) return null;
      return (r.top + r.bottom) / 2 > boundaryY;
    };
    let last = null;
    for (let j = len - 1; j >= 0; j -= 1) {
      last = probe(j);
      if (last !== null) break;
    }
    if (last !== true) return -1;
    let lo = 0;
    let hi = len - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      let idx = mid;
      let below = probe(idx);
      while (below === null && idx < hi) {
        idx += 1;
        below = probe(idx);
      }
      // below === false: the boundary is right of idx. Anything else (a
      // below-glyph, or a degenerate run reaching hi) means splitting at mid
      // is safe — degenerate chars are collapsed whitespace with no glyph.
      if (below === false) lo = idx + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Split one block element at the line boundary nearest boundaryY. Returns
   * the tail block element (extracted content in a shallow clone of the
   * block) or null. Range.extractContents preserves partially-selected run
   * spans (clones their element shells), so mixed runs and inline nodes
   * survive the cut.
   */
  function splitBlockAtBoundary(blockEl, boundaryY) {
    const leaves = collectInlineLeaves(blockEl);
    const range = document.createRange();
    let startSet = false;
    for (const leaf of leaves) {
      if (leaf.kind === "atom") {
        const r = leaf.el.getBoundingClientRect();
        if (r.height > 0.01 && (r.top + r.bottom) / 2 > boundaryY) {
          range.setStartBefore(leaf.el);
          startSet = true;
          break;
        }
        continue;
      }
      const idx = firstCharBelow(leaf.node, boundaryY);
      if (idx >= 0) {
        range.setStart(leaf.node, idx);
        startSet = true;
        break;
      }
    }
    if (!startSet) return null;
    range.setEnd(blockEl, blockEl.childNodes.length);
    if (range.collapsed) return null;
    const frag = range.extractContents();
    if (!frag.childNodes.length) return null;
    const tailBlock = blockEl.cloneNode(false);
    tailBlock.appendChild(frag);
    tailBlock.style.textIndent = "0"; // continuation lines are not first lines
    tailBlock.style.marginTop = "0"; // space_before belongs to the head part
    return tailBlock;
  }

  /**
   * Split a text NODE element against an absolute bottom limit. Splits at
   * block (paragraph) granularity first; the straddling paragraph/heading is
   * split at LINE level honoring keep rules (widow/orphan: never fewer than
   * N lines on either side, else the whole block moves). list_item blocks
   * split at item boundaries only. Returns the tail text element or null
   * (null = move the whole element).
   */
  function splitTextElement(textEl, limitY, keep, atTop) {
    const blocks = Array.from(textEl.children).filter((c) => c.classList && c.classList.contains("fmdoc-block"));
    if (!blocks.length) return null;
    let bi = -1;
    for (let i = 0; i < blocks.length; i += 1) {
      if (blocks[i].getBoundingClientRect().bottom > limitY + 0.5) {
        bi = i;
        break;
      }
    }
    if (bi === -1) return null; // everything fits
    const straddler = blocks[bi];
    const sRect = straddler.getBoundingClientRect();
    let tailBlock = null;
    const lineSplittable = /fmdoc-block--(paragraph|heading)/.test(straddler.className);
    if (sRect.top < limitY - 1 && lineSplittable) {
      const lines = measureLineBoxes(straddler);
      const total = lines.length;
      // Glyph rects sit inside the line box (half-leading above/below), so a
      // line's LAYOUT bottom is the boundary midway to the next line's glyphs
      // — and the block's own bottom for the last line. Fitting on glyph
      // bottoms alone overcounts by up to the half-leading.
      const lineLayoutBottom = (i) => (i < total - 1 ? (lines[i].bottom + lines[i + 1].top) / 2 : sRect.bottom);
      let geoFit = 0;
      while (geoFit < total && lineLayoutBottom(geoFit) <= limitY + 0.5) geoFit += 1;
      if (geoFit > 0 && geoFit < total) {
        const widow = Math.max(1, Number(keep && keep.widow) || 2);
        const orphan = Math.max(1, Number(keep && keep.orphan) || 2);
        let fit = geoFit;
        if (total - fit < widow) fit = total - widow;
        if (fit < orphan) fit = 0;
        // Forced progress: a block alone at the top of an empty region must
        // split even when keep rules cannot be honored.
        if (fit <= 0 && atTop && bi === 0) fit = Math.max(1, Math.min(geoFit, total - 1));
        if (fit > 0 && fit < total) {
          const boundaryY = (lines[fit - 1].bottom + lines[fit].top) / 2;
          tailBlock = splitBlockAtBoundary(straddler, boundaryY);
          // space_after belongs after the paragraph, not at a frame break —
          // and the flex container would count it into the head's height.
          if (tailBlock) straddler.style.marginBottom = "0";
        }
      }
    }
    const firstWholeMoved = tailBlock ? bi + 1 : bi;
    if (!tailBlock && firstWholeMoved === 0) return null; // whole element moves
    const tailText = textEl.cloneNode(false);
    if (tailBlock) tailText.appendChild(tailBlock);
    for (let i = firstWholeMoved; i < blocks.length; i += 1) tailText.appendChild(blocks[i]);
    if (!tailText.childNodes.length) return null;
    markSplitParts(textEl, tailText);
    return tailText;
  }

  /** Legacy row-split entry (paginating flow frames): limit is frame-relative. */
  function trySplitChild(flowEl, child, limit, atTop) {
    const rowsContainer = child.hasAttribute("data-fmdoc-rows") ? child : child.querySelector("[data-fmdoc-rows]");
    if (!rowsContainer) return null;
    const rows = Array.from(rowsContainer.children).filter((r) => !(r.classList && r.classList.contains("fmdoc-repeater-empty")));
    if (rows.length < 2) return null;
    const flowRect = flowEl.getBoundingClientRect();
    return splitRowsElement(child, rowsContainer, rows, flowRect.top + limit, atTop);
  }

  function isPageBreakEl(el) {
    return el && el.getAttribute && el.getAttribute("data-node-type") === "page_break";
  }

  function computeOverflowMoves(flowEl) {
    const children = Array.from(flowEl.children);
    if (!children.length) return null;
    // Explicit page_break: force continuation regardless of geometry.
    for (let i = 0; i < children.length; i += 1) {
      if (isPageBreakEl(children[i]) && !children[i].hasAttribute("data-fmdoc-break-done")) {
        children[i].setAttribute("data-fmdoc-break-done", "true");
        const forced = children.slice(i + 1);
        if (forced.length) return forced;
      }
    }
    if (flowEl.scrollHeight <= flowEl.clientHeight + 1) return null;
    const limit = flowEl.clientHeight;
    let breakIndex = -1;
    for (let i = 0; i < children.length; i += 1) {
      if (children[i].offsetTop + children[i].offsetHeight > limit + 1) {
        breakIndex = i;
        break;
      }
    }
    if (breakIndex === -1) return null;
    // Repeater as the paginating element itself: instances are the split
    // units; honor break rules directly (min rows, keep_with_next, columns).
    if (flowEl.hasAttribute("data-fmdoc-repeater")) {
      const rows = children.filter((c) => c.hasAttribute("data-fmdoc-row") || c.hasAttribute("data-fmdoc-repeat-clone"));
      const fit = adjustRowFit(rows, breakIndex, rowRulesFor(flowEl), true);
      if (fit === null) return null;
      return rows.slice(fit);
    }
    const moves = [];
    const breaking = children[breakIndex];
    const continuation = trySplitChild(flowEl, breaking, limit, breakIndex === 0);
    if (continuation) {
      moves.push(continuation);
      for (let i = breakIndex + 1; i < children.length; i += 1) moves.push(children[i]);
      return moves;
    }
    if (breakIndex === 0) {
      // Unsplittable child taller than the page: clip it (line splitting is
      // chain-only) and push everything after it to the next page.
      breaking.setAttribute("data-overflow", "true");
      breakIndex = 1;
      if (breakIndex >= children.length) return null;
    }
    for (let i = breakIndex; i < children.length; i += 1) moves.push(children[i]);
    return moves.length ? moves : null;
  }

  // ---------------------------------------------------------------------------
  // v2 flow chains
  //
  // Frames with props.chain {id,index} form an ordered chain. All flow blocks
  // authored across the chain's frames are collected in order and poured
  // frame by frame; a block that straddles a frame boundary is split (text at
  // line level with widow/orphan keep rules, repeaters/tables/widget rows at
  // row boundaries). When the chain's doc-level definition has auto_pages and
  // content overflows the last frame, pages are appended from page_defaults:
  // a cloned page shell (master chrome + header/footer for the role) with
  // `columns` chained frames sized to the margins/column gap.
  // ---------------------------------------------------------------------------

  /** Bottom Y limit (absolute px) of a frame's usable content area. */
  function frameInnerBottomY(frameEl) {
    const rect = frameEl.getBoundingClientRect();
    let padBottom = 0;
    try {
      padBottom = parseFloat(getComputedStyle(frameEl).paddingBottom) || 0;
    } catch (error) {
      /* non-rendered environments */
    }
    return rect.top + frameEl.clientTop + frameEl.clientHeight - padBottom;
  }

  /** Split any chain block element against an absolute limit; null = move whole. */
  function splitChainElement(el, limitY, keep, atTop) {
    const type = el.getAttribute("data-node-type");
    if (type === "text") return splitTextElement(el, limitY, keep, atTop);
    if (type === "repeater") {
      const rows = Array.from(el.children).filter((c) => c.hasAttribute("data-fmdoc-row") || c.hasAttribute("data-fmdoc-repeat-clone"));
      return splitRowsElement(el, el, rows, limitY, atTop);
    }
    if (type === "table") {
      const tbody = el.querySelector("tbody");
      if (!tbody) return null;
      return splitRowsElement(el, tbody, Array.from(tbody.children), limitY, atTop);
    }
    // Widgets (or frames) that tag a rows container split at row boundaries.
    const rowsContainer = el.hasAttribute("data-fmdoc-rows") ? el : el.querySelector("[data-fmdoc-rows]");
    if (rowsContainer) {
      const rows = Array.from(rowsContainer.children).filter((r) => !(r.classList && r.classList.contains("fmdoc-repeater-empty")));
      return splitRowsElement(el, rowsContainer, rows, limitY, atTop);
    }
    return null;
  }

  /**
   * Append an auto page for a chain (auto_pages:true). The page shell is a
   * real buildPage for page_defaults.role (master chrome + header/footer +
   * base font), holding `columns` chained frames cloned SHALLOW from the last
   * authored chain frame (keeps flow gap/padding/background consistent) and
   * sized to margins_pt/column_gap_pt. Margins are widened to clear the
   * master's header/footer slots.
   */
  function appendAutoPage(state, rctx, chainId, def, lastFrameEl) {
    const paper = model().paperDimensions(state.opts.document || {});
    const pd = def.page_defaults || {};
    const anchorPage = lastFrameEl.closest(".fmdoc-page");
    const role = pd.role || (anchorPage && anchorPage.getAttribute("data-role")) || "body";
    state.autoPageCounter += 1;
    const inheritedMasterRef = anchorPage && anchorPage.getAttribute("data-master-ref");
    const page = { id: "pg_auto_" + chainId + "_" + state.autoPageCounter, role, master_ref: inheritedMasterRef || null, children: [] };
    const pageEl = buildPage(page, paper, rctx);
    pageEl.setAttribute("data-fmdoc-auto-page", "true");
    if (anchorPage && anchorPage.parentNode) {
      anchorPage.parentNode.insertBefore(pageEl, anchorPage.nextSibling);
      const at = state.pageEls.indexOf(anchorPage);
      state.pageEls.splice(at === -1 ? state.pageEls.length : at + 1, 0, pageEl);
    } else {
      state.pageEls.push(pageEl);
    }
    const margins = pd.margins_pt || {};
    const slots = masterSlotHeights(rctx.theme, page);
    const mTop = Math.max(Number(margins.top) || 72, slots.header);
    const mBottom = Math.max(Number(margins.bottom) || 72, slots.footer);
    const mLeft = Number(margins.left) || 72;
    const mRight = Number(margins.right) || 72;
    const columns = Math.max(1, Number(pd.columns) || 1);
    const gap = Number(pd.column_gap_pt);
    const gapPt = Number.isFinite(gap) ? gap : 24;
    const colW = (paper.w_pt - mLeft - mRight - gapPt * (columns - 1)) / columns;
    const colH = paper.h_pt - mTop - mBottom;
    const content = pageEl.querySelector(".fmdoc-page-content");
    // Blank word-processing documents author their header/footer as editable
    // source regions on page one. Repeat snapshots of those regions on every
    // generated page; editing the source and re-rendering refreshes all copies.
    if (anchorPage) {
      for (const region of Array.from(anchorPage.querySelectorAll(':scope > .fmdoc-page-content > [data-page-region="header"], :scope > .fmdoc-page-content > [data-page-region="footer"], :scope > .fmdoc-page-content > [data-page-region="header_even"], :scope > .fmdoc-page-content > [data-page-region="footer_even"]'))) {
        const repeated = region.cloneNode(true);
        repeated.setAttribute("data-chrome", "true");
        repeated.removeAttribute("data-chain");
        repeated.removeAttribute("data-chain-index");
        for (const nested of Array.from(repeated.querySelectorAll("[data-chain]"))) {
          nested.removeAttribute("data-chain");
          nested.removeAttribute("data-chain-index");
        }
        for (const editable of Array.from(repeated.querySelectorAll('[contenteditable="true"]'))) editable.setAttribute("contenteditable", "false");
        content.appendChild(repeated);
      }
    }
    const frames = [];
    for (let c = 0; c < columns; c += 1) {
      const frameEl = lastFrameEl.cloneNode(false);
      frameEl.setAttribute("data-node-id", page.id + "_col" + c);
      frameEl.setAttribute("data-fmdoc-auto-frame", "true");
      frameEl.removeAttribute("data-overflow");
      frameEl.removeAttribute("data-fmdoc-split");
      frameEl.removeAttribute("data-split-part");
      frameEl.style.position = "absolute";
      frameEl.style.left = pt(mLeft + c * (colW + gapPt));
      frameEl.style.top = pt(mTop);
      frameEl.style.width = pt(colW);
      frameEl.style.height = pt(colH);
      content.appendChild(frameEl);
      frames.push(frameEl);
    }
    return frames;
  }

  function frameFlowChildren(frameEl) {
    return Array.from(frameEl.children).filter((c) => c.hasAttribute && c.hasAttribute("data-fmdoc-flow"));
  }

  function layoutChain(state, rctx, chainId, frames, def) {
    const keepRules = def.keep_rules || {};
    const keep = {
      widow: Math.max(1, Number(keepRules.widow_lines) || 2),
      orphan: Math.max(1, Number(keepRules.orphan_lines) || 2)
    };
    // Collect every flow block across the chain's frames, in chain order.
    const queue = [];
    for (const frameEl of frames) {
      for (const child of frameFlowChildren(frameEl)) {
        queue.push(child);
        child.parentNode.removeChild(child);
      }
    }
    const frameList = frames.slice();
    let fi = 0;
    const advance = () => {
      fi += 1;
      if (fi >= frameList.length) {
        if (def.auto_pages) {
          const created = appendAutoPage(state, rctx, chainId, def, frameList[frameList.length - 1]);
          for (const f of created) frameList.push(f);
        } else {
          fi = frameList.length - 1;
          return false;
        }
      }
      return true;
    };
    let guard = 0;
    let exhausted = false;
    while (queue.length && guard < 10000) {
      guard += 1;
      const frameEl = frameList[fi];
      const el = queue.shift();
      if (isPageBreakEl(el)) {
        const hadContent = frameFlowChildren(frameEl).length > 0;
        frameEl.appendChild(el); // keep the (zero-height) marker in the DOM
        if (hadContent && queue.length && !exhausted) {
          if (!advance()) exhausted = true;
        }
        continue;
      }
      frameEl.appendChild(el);
      if (exhausted) {
        frameEl.setAttribute("data-overflow", "true");
        continue;
      }
      const limitY = frameInnerBottomY(frameEl);
      if (el.getBoundingClientRect().bottom <= limitY + 0.5) continue;
      // Overflow: split at the frame boundary, else push the block onward.
      const flowSiblings = frameFlowChildren(frameEl);
      const atTop = flowSiblings.length === 1; // el alone in this frame
      const tail = splitChainElement(el, limitY, keep, atTop);
      if (tail) {
        queue.unshift(tail);
        if (!advance()) exhausted = true;
        continue;
      }
      if (!atTop) {
        frameEl.removeChild(el);
        queue.unshift(el);
        if (!advance()) exhausted = true;
        continue;
      }
      // Alone at the top and unsplittable: clip (never lose later content).
      el.setAttribute("data-overflow", "true");
      frameEl.setAttribute("data-overflow", "true");
      if (queue.length && !advance()) exhausted = true;
    }
    // chainMetrics: per-frame fill info for Doc-mode caret work.
    state.chainLayouts[chainId] = frameList.map((frameEl) => {
      const pageEl = frameEl.closest(".fmdoc-page");
      const blocks = frameFlowChildren(frameEl);
      let padTop = 0;
      let padBottom = 0;
      try {
        const cs = getComputedStyle(frameEl);
        padTop = parseFloat(cs.paddingTop) || 0;
        padBottom = parseFloat(cs.paddingBottom) || 0;
      } catch (error) {
        /* measurement best-effort */
      }
      const frameRect = frameEl.getBoundingClientRect();
      const innerTop = frameRect.top + frameEl.clientTop + padTop;
      let usedPx = 0;
      if (blocks.length) usedPx = Math.max(0, blocks[blocks.length - 1].getBoundingClientRect().bottom - innerTop);
      const round2 = (v) => Math.round(v * 100) / 100;
      return {
        frame_node_id: frameEl.getAttribute("data-node-id"),
        page_id: pageEl ? pageEl.getAttribute("data-page-id") : null,
        used_pt: round2(usedPx / PT_TO_PX),
        capacity_pt: round2(Math.max(0, frameEl.clientHeight - padTop - padBottom) / PT_TO_PX),
        block_ids: blocks.map((b) => b.getAttribute("data-node-id"))
      };
    });
  }

  /** Lay out every flow chain (runs in staging, before the legacy paginate). */
  function layoutChains(state) {
    const rctx = state.rctx;
    if (!rctx) return;
    const doc = state.opts.document || {};
    const byChain = {};
    for (const pageEl of state.pageEls) {
      for (const frameEl of Array.from(pageEl.querySelectorAll("[data-chain]"))) {
        if (frameEl.hasAttribute("data-chrome")) continue;
        const id = frameEl.getAttribute("data-chain");
        (byChain[id] = byChain[id] || []).push(frameEl);
      }
    }
    for (const chainId of Object.keys(byChain)) {
      const frames = byChain[chainId].sort((a, b) => (Number(a.getAttribute("data-chain-index")) || 0) - (Number(b.getAttribute("data-chain-index")) || 0));
      const def = (doc.chains || {})[chainId] || {};
      layoutChain(state, rctx, chainId, frames, def);
    }
  }

  function buildContinuationPage(pageEl, flowEl, state) {
    state.contCounter += 1;
    const contPage = pageEl.cloneNode(false);
    contPage.setAttribute("data-fmdoc-continuation", "true");
    const baseId = pageEl.getAttribute("data-page-id") || "page";
    contPage.setAttribute("data-page-id", baseId + "__cont" + state.contCounter);
    const chrome = pageEl.querySelector(":scope > .fmdoc-chrome");
    if (chrome) contPage.appendChild(chrome.cloneNode(true));
    for (const hf of Array.from(pageEl.querySelectorAll(":scope > .fmdoc-master-hf"))) contPage.appendChild(hf.cloneNode(true));
    const content = pageEl.querySelector(":scope > .fmdoc-page-content");
    // Shallow-clone the ancestor chain from the content layer down to the
    // paginating flow frame so nesting/insets carry over to the new page.
    const chain = [];
    let cursor = flowEl;
    while (cursor && cursor !== content && cursor !== pageEl) {
      chain.unshift(cursor);
      cursor = cursor.parentElement;
    }
    let parent = contPage;
    if (content) {
      parent = content.cloneNode(false);
      contPage.appendChild(parent);
    }
    let contFlow = parent;
    for (const ancestor of chain) {
      const clone = ancestor.cloneNode(false);
      clone.setAttribute("data-fmdoc-continuation", "true");
      parent.appendChild(clone);
      parent = clone;
      contFlow = clone;
    }
    return { page: contPage, flow: contFlow };
  }

  function paginate(state) {
    const source = state.pageEls;
    const out = [];
    for (let i = 0; i < source.length; i += 1) {
      let pageEl = source[i];
      out.push(pageEl);
      // v1: one paginating flow per page (the first found).
      let flowEl = pageEl.querySelector("[data-fmdoc-paginate]");
      let guard = 0;
      while (flowEl && guard < 500) {
        guard += 1;
        const moves = computeOverflowMoves(flowEl);
        if (!moves || !moves.length) break;
        const continuation = buildContinuationPage(pageEl, flowEl, state);
        for (const moved of moves) continuation.flow.appendChild(moved);
        // Repeater paginating itself: re-render the header instance at the
        // top of each continuation segment (break_rules.repeat_header).
        if (flowEl.hasAttribute("data-fmdoc-repeater") && flowEl.getAttribute("data-fmdoc-repeat-header") === "true") {
          const headerSrc = flowEl.querySelector(':scope > [data-repeater-index="0"]');
          if (headerSrc) {
            const headerClone = headerSrc.cloneNode(true);
            headerClone.setAttribute("data-fmdoc-repeat-clone", "true");
            continuation.flow.insertBefore(headerClone, continuation.flow.firstChild);
          }
        }
        pageEl.parentNode.insertBefore(continuation.page, pageEl.nextSibling);
        out.push(continuation.page);
        pageEl = continuation.page;
        flowEl = continuation.flow.hasAttribute("data-fmdoc-paginate") ? continuation.flow : continuation.page.querySelector("[data-fmdoc-paginate]");
      }
    }
    state.pageEls = out;
  }

  /**
   * Footnotes (metadata.footnotes: [{id, node_id, block_id, offset, text}]):
   * post-pagination pass that injects superscript reference markers at their
   * anchor offsets and a numbered strip at the bottom of each owning page.
   * Markers carry data-fmdoc-inline + contenteditable=false so the doc-mode
   * parser and offset math skip them. v1 limitation: the strip overlays the
   * bottom of the body area instead of reflowing text above it.
   */
  function fillFootnotes(state) {
    const doc = state.opts.document || {};
    const notes = (doc.metadata && doc.metadata.footnotes) || [];
    if (!Array.isArray(notes) || !notes.length) return;
    const located = [];
    for (const note of notes) {
      if (!note || !note.id || !note.block_id) continue;
      for (let pageIndex = 0; pageIndex < state.pageEls.length; pageIndex += 1) {
        const blockEl = state.pageEls[pageIndex].querySelector('[data-block-id="' + String(note.block_id).replace(/"/g, '\\"') + '"]');
        if (blockEl) { located.push({ note, pageIndex, pageEl: state.pageEls[pageIndex], blockEl }); break; }
      }
    }
    if (!located.length) return;
    located.sort((a, b) => a.pageIndex - b.pageIndex || (a.blockEl.compareDocumentPosition(b.blockEl) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1) || (Number(a.note.offset) || 0) - (Number(b.note.offset) || 0));
    const skip = (el) => el.nodeType === 1 && (el.hasAttribute("data-fmdoc-inline") || el.hasAttribute("data-fmdoc-float") || el.hasAttribute("data-node-id") || el.getAttribute("contenteditable") === "false");
    const byPage = new Map();
    located.forEach((entry, index) => {
      const number = index + 1;
      // Inject the marker at the character offset (walk text nodes, skip atoms).
      let rest = Math.max(0, Number(entry.note.offset) || 0);
      let target = null;
      (function walk(node) {
        if (target) return;
        if (node.nodeType === 3) {
          const len = (node.nodeValue || "").length;
          if (rest <= len) target = { node, local: rest }; else rest -= len;
          return;
        }
        if (node.nodeType !== 1 || (node !== entry.blockEl && skip(node))) return;
        for (let child = node.firstChild; child; child = child.nextSibling) { walk(child); if (target) return; }
      })(entry.blockEl);
      const sup = document.createElement("sup");
      sup.className = "fmdoc-footnote-ref";
      sup.setAttribute("data-fmdoc-inline", "true");
      sup.setAttribute("contenteditable", "false");
      sup.setAttribute("data-footnote-id", entry.note.id);
      sup.textContent = String(number);
      if (target) {
        const after = target.node.splitText(target.local);
        after.parentNode.insertBefore(sup, after);
      } else entry.blockEl.appendChild(sup);
      if (!byPage.has(entry.pageEl)) byPage.set(entry.pageEl, []);
      byPage.get(entry.pageEl).push({ note: entry.note, number });
    });
    for (const [pageEl, entries] of byPage) {
      const strip = document.createElement("div");
      strip.className = "fmdoc-footnotes";
      const bodyEl = pageEl.querySelector('[data-page-region="body"]');
      if (bodyEl) {
        const pageRect = pageEl.getBoundingClientRect();
        const bodyRect = bodyEl.getBoundingClientRect();
        if (pageRect.width > 0) {
          strip.style.left = ((bodyRect.left - pageRect.left) / pageRect.width * 100) + "%";
          strip.style.width = (bodyRect.width / pageRect.width * 100) + "%";
          strip.style.bottom = ((pageRect.bottom - bodyRect.bottom) / pageRect.height * 100) + "%";
        }
      }
      for (const item of entries) {
        const row = document.createElement("div");
        row.className = "fmdoc-footnote";
        row.setAttribute("data-footnote-id", item.note.id);
        const num = document.createElement("span");
        num.className = "fmdoc-footnote-num";
        num.textContent = String(item.number) + ".";
        const text = document.createElement("span");
        text.className = "fmdoc-footnote-text";
        text.setAttribute("data-footnote-id", item.note.id);
        text.textContent = String(item.note.text || "");
        row.appendChild(num);
        row.appendChild(text);
        strip.appendChild(row);
      }
      pageEl.appendChild(strip);
    }
  }

  /**
   * Docs-style header variants (settings.header_options): "different first
   * page" swaps page 1 to the *_first regions; "different odd & even" swaps
   * even pages to the *_even regions. Variant frames live on model page 1 and
   * ride the continuation cloning like base headers.
   */
  function applyHeaderVariants(state) {
    const doc = state.opts.document || {};
    const options = doc.settings && doc.settings.header_options;
    if (!options || (!options.different_first && !options.different_odd_even)) {
      // Variants authored but disabled: never show them.
      state.pageEls.forEach((pageEl) => {
        for (const el of Array.from(pageEl.querySelectorAll('[data-page-region$="_first"], [data-page-region$="_even"]'))) el.style.display = "none";
      });
      return;
    }
    state.pageEls.forEach((pageEl, index) => {
      const pageNumber = index + 1;
      for (const kind of ["header", "footer"]) {
        let use = "base";
        if (options.different_first && pageNumber === 1) use = "first";
        else if (options.different_odd_even && pageNumber % 2 === 0) use = "even";
        for (const el of Array.from(pageEl.querySelectorAll('[data-page-region="' + kind + '"]'))) el.style.display = use === "base" ? "" : "none";
        for (const el of Array.from(pageEl.querySelectorAll('[data-page-region="' + kind + '_first"]'))) el.style.display = use === "first" ? "" : "none";
        for (const el of Array.from(pageEl.querySelectorAll('[data-page-region="' + kind + '_even"]'))) el.style.display = use === "even" ? "" : "none";
      }
    });
  }

  function fillPageNumbers(state) {
    const total = state.pageEls.length;
    const rawConfig = (((state.opts.document || {}).metadata || {}).page_numbers);
    const autoConfig = rawConfig && typeof rawConfig === "object" ? rawConfig : (rawConfig ? { enabled: true } : null);
    state.pageEls.forEach((pageEl, index) => {
      pageEl.setAttribute("data-page-number", String(index + 1));
      for (const placeholder of Array.from(pageEl.querySelectorAll("[data-fmdoc-page-number]"))) {
        const format = placeholder.getAttribute("data-fmdoc-page-format") || "Page {page} of {pages}";
        placeholder.textContent = format.replace(/\{page\}/g, String(index + 1)).replace(/\{pages\}/g, String(total));
      }
      if (autoConfig && autoConfig.enabled !== false && (index > 0 || autoConfig.first_page !== false)) {
        const start = Math.max(1, Number(autoConfig.start) || 1);
        const value = start + index;
        const overlay = document.createElement("div");
        overlay.className = "fmdoc-auto-page-number";
        overlay.setAttribute("data-position", autoConfig.position === "header" ? "header" : "footer");
        overlay.style.textAlign = ["left", "right"].includes(autoConfig.align) ? autoConfig.align : "center";
        overlay.textContent = String(autoConfig.format || "{page}").replace(/\{page\}/g, String(value)).replace(/\{pages\}/g, String(start + total - 1));
        pageEl.appendChild(overlay);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Readiness
  // ---------------------------------------------------------------------------

  function imagesReady(rootEl, timeoutMs) {
    const images = Array.from(rootEl.querySelectorAll("img"));
    const waits = images.map((img) => {
      if (img.complete && img.naturalWidth !== 0) return Promise.resolve();
      if (img.complete) return Promise.resolve(); // broken image: do not hang the harness
      return new Promise((resolve) => {
        const done = () => resolve();
        if (typeof img.decode === "function") img.decode().then(done, done);
        img.addEventListener("load", done, { once: true });
        img.addEventListener("error", done, { once: true });
      });
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, timeoutMs || 10000));
    return Promise.race([Promise.all(waits), timeout]);
  }

  // ---------------------------------------------------------------------------
  // render()
  // ---------------------------------------------------------------------------

  /** Flag + event that the PDF harness waits on. Fires exactly once per build. */
  function markReady(state) {
    state.container.__fmdocReady = true;
    try {
      const event = typeof CustomEvent === "function" ? new CustomEvent("fmdoc:ready", { bubbles: true }) : null;
      if (event) state.container.dispatchEvent(event);
    } catch (error) {
      /* older engines: the flag alone is enough */
    }
  }

  /**
   * A failed build must never hang the PDF pipeline: render a neutral error
   * box and mark ready anyway (contract: ready fires on empty/failed renders).
   */
  function failBuild(state, error) {
    try {
      if (state.staging && state.staging.parentNode) state.staging.parentNode.removeChild(state.staging);
      state.staging = null;
      if (!state.root) {
        state.root = h("div", "fmdoc-root");
        state.container.appendChild(state.root);
      }
      const box = h("div", "fmdoc-widget-unknown");
      const label = h("div", "fmdoc-widget-unknown-label");
      label.textContent = "Document failed to render" + (error && error.message ? ": " + error.message : "");
      box.appendChild(label);
      state.root.appendChild(box);
    } catch (secondary) {
      /* container may be unusable; readiness still fires */
    }
    state.readyPromise = Promise.resolve().then(() => {
      if (!state.destroyed) markReady(state);
    });
  }

  function safeBuild(state) {
    try {
      build(state);
    } catch (error) {
      failBuild(state, error);
    }
  }

  function render(container, options) {
    if (typeof document === "undefined") throw new Error("FMDocRenderer.render requires a DOM");
    if (!container) throw new Error("FMDocRenderer.render: container is required");
    const state = {
      container,
      opts: Object.assign({}, options || {}),
      destroyers: [],
      widgetPromises: [],
      widgetData: {},
      pageEls: [],
      contCounter: 0,
      autoPageCounter: 0,
      chainLayouts: {},
      rctx: null,
      destroyed: false,
      root: null,
      scaleWrap: null,
      staging: null,
      viewSurfaceWidthPx: null
    };

    safeBuild(state);

    const handle = {
      get scale() {
        return PT_TO_PX * (Number(state.opts.scale) || 1);
      },
      ready() {
        return state.readyPromise;
      },
      destroy() {
        teardown(state);
        state.destroyed = true;
      },
      update(next) {
        teardown(state);
        state.destroyed = false;
        state.opts = Object.assign({}, state.opts, next || {});
        safeBuild(state);
        return handle;
      },
      /** Scale-only fast path: retransform in place, no rebuild. Lets hosts
       *  zoom without the async teardown/rebuild flicker. */
      setScale(nextScale) {
        const scale = Number(nextScale) || 1;
        state.opts = Object.assign({}, state.opts, { scale });
        if (!state.root || !state.scaleWrap) return handle;
        state.scaleWrap.style.transform = scale === 1 ? "" : "scale(" + scale + ")";
        state.scaleWrap.style.transformOrigin = "0 0";
        state.root.setAttribute("data-scale", String(scale));
        const paper = model().paperDimensions(state.opts.document || {});
        const doc = state.opts.document || {};
        if (scale === 1) {
          // Natural layout — pinning an explicit height here froze whatever
          // was measured at call time (often before images loaded), leaving
          // hosts with a clipped, scrolling stage. Fluid view pages must KEEP
          // width:100% (build-time contract) or the whole page collapses to
          // 0 width in shrink-wrapping hosts like the editor stage.
          state.root.style.width = doc.kind === "view" && paper.fill ? "100%" : "";
          state.root.style.height = "";
          if (doc.kind === "view") state.scaleWrap.style.width = "";
        } else {
          // Mirror the build-time contract: the wrap keeps its NATURAL width
          // (a fluid page built at scale 1 has none — without this the
          // transform multiplies a root-derived width and double-scales).
          if (doc.kind === "view") state.scaleWrap.style.width = paper.w_pt * PT_TO_PX + "px";
          state.root.style.width = paper.w_pt * PT_TO_PX * scale + "px";
          state.root.style.height = state.scaleWrap.offsetHeight * scale + "px";
        }
        syncViewSectionWidths(state, state.viewSurfaceWidthPx);
        return handle;
      },
      /** Website editor rails and trays consume browser width, so the host
       * supplies the canvas pixels that are genuinely available to sections. */
      setViewSurfaceWidth(nextWidth) {
        const width = Number(nextWidth);
        if (width > 0) syncViewSectionWidths(state, width);
        return state.viewSurfaceWidthPx || null;
      },
      /** Refresh the renderer's outer footprint after an editor changes a
       * flowed view section directly during a pointer gesture. Scaled views
       * otherwise retain the height measured at the previous full render, so
       * host-owned content after the stage (notably the website footer
       * preview) cannot follow the section until pointer-up commits it. */
      syncLayoutFootprint() {
        if (!state.root || !state.scaleWrap) return handle;
        const doc = state.opts.document || {};
        if (doc.kind !== "view") return handle;
        const scale = Number(state.opts.scale) || 1;
        state.root.style.height = scale === 1 ? "" : state.scaleWrap.offsetHeight * scale + "px";
        return handle;
      },
      pageElements() {
        return state.pageEls.slice();
      },
      nodeElement(nodeId) {
        const selector = '[data-node-id="' + String(nodeId).replace(/"/g, '\\"') + '"]';
        let fallback = null;
        for (const pageEl of state.pageEls) {
          for (const match of Array.from(pageEl.querySelectorAll(selector))) {
            if (!match.hasAttribute("data-chrome")) return match;
            fallback = fallback || match;
          }
        }
        return fallback;
      },
      measureNode(nodeId) {
        const elm = handle.nodeElement(nodeId);
        if (!elm) return null;
        let x = 0;
        let y = 0;
        let cursor = elm;
        while (cursor && !(cursor.classList && cursor.classList.contains("fmdoc-page"))) {
          const translated = individualTranslatePx(cursor);
          x += (cursor.offsetLeft || 0) + translated.x;
          y += (cursor.offsetTop || 0) + translated.y;
          cursor = cursor.offsetParent;
        }
        return {
          x: Math.round((x / PT_TO_PX) * 100) / 100,
          y: Math.round((y / PT_TO_PX) * 100) / 100,
          w: Math.round((elm.offsetWidth / PT_TO_PX) * 100) / 100,
          h: Math.round((elm.offsetHeight / PT_TO_PX) * 100) / 100
        };
      },
      /** Per-frame fill info for a flow chain (editor Doc-mode caret work). */
      chainMetrics(chainId) {
        const list = (state.chainLayouts || {})[String(chainId)] || [];
        return list.map((entry) => Object.assign({}, entry, { block_ids: entry.block_ids.slice() }));
      }
    };
    return handle;
  }

  function teardown(state) {
    for (const destroy of state.destroyers) {
      try {
        destroy();
      } catch (error) {
        /* widget destroy must never break teardown */
      }
    }
    state.destroyers = [];
    state.widgetPromises = [];
    state.pageEls = [];
    state.contCounter = 0;
    state.autoPageCounter = 0;
    state.chainLayouts = {};
    state.rctx = null;
    if (state.staging && state.staging.parentNode) state.staging.parentNode.removeChild(state.staging);
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.staging = null;
    state.root = null;
    state.scaleWrap = null;
    if (state.container) state.container.__fmdocReady = false;
  }

  function build(state) {
    ensureStyles();
    const m = model();
    const opts = state.opts;
    const doc = opts.document;
    if (!doc) throw new Error("FMDocRenderer.render: opts.document is required");
    const theme = opts.theme || {};
    const mode = opts.mode === "static" ? "static" : "interactive";
    const scale = Number(opts.scale) || 1;
    const widgetContext = opts.widgetContext || {};
    state.widgetData = opts.widgetData || {};

    const themeVars = m.resolveThemeTokens(theme, opts.themeContext || {});
    const paper = m.paperDimensions(doc);

    const resolveMediaUrl = (media, variant) => {
      if (!media) return "";
      if (typeof media === "string") return media;
      if (media.url) return media.url;
      if (typeof opts.mediaUrl === "function") return opts.mediaUrl(media, variant) || "";
      if (media.media_id && opts.orgId) {
        const v = variant || media.variant;
        return "/v1/platform/organizations/" + encodeURIComponent(opts.orgId) + "/media/" + encodeURIComponent(media.media_id) + "/file" + (v ? "?variant=" + encodeURIComponent(v) : "");
      }
      return "";
    };

    const outputs = widgetContext.outputs || {};
    const scope = widgetContext.scope || {
      params: widgetContext.params || {},
      outputs,
      computed: doc.computed_values || {},
      theme: theme.tokens || {},
      org: widgetContext.org || {},
      project: widgetContext.project || {},
      customer: widgetContext.customer || {},
      doc: widgetContext.doc || {}
    };
    const api = Object.assign({ orgId: opts.orgId || null }, widgetContext.api || {});

    const rctx = {
      state,
      mode,
      theme,
      doc, // style_ref resolution (doc.styles) + chain definitions
      themeVars,
      scope,
      outputs,
      api,
      submitOutput: typeof widgetContext.submitOutput === "function" ? widgetContext.submitOutput : function () {},
      resolveMediaUrl,
      // Host-supplied site-page href resolution for props.link and web.*
      // widgets (contracts §10). Absent for plain documents.
      resolvePageHref: typeof widgetContext.resolvePageHref === "function" ? widgetContext.resolvePageHref : null,
      preview: widgetContext.preview === true,
      authoring: widgetContext.authoring === true,
      capabilities: (opts.capabilities && typeof opts.capabilities === "object" ? opts.capabilities : null)
        || (widgetContext.capabilities && typeof widgetContext.capabilities === "object" ? widgetContext.capabilities : null),
      definitionResolver: typeof widgetContext.definitionResolver === "function" ? widgetContext.definitionResolver : null,
      // Customer-portal hosting context for portal.* widgets (contracts §11).
      // Carries the portal identity, resolved settings, and the customer-write
      // action channel. Null for documents, PDFs, and public sites — portal.*
      // widgets degrade to their placeholder when it is absent, so one is never
      // able to write (or read project data) outside a portal.
      portal: widgetContext.portal && typeof widgetContext.portal === "object" ? widgetContext.portal : null,
      baseFontPt: (doc.settings && doc.settings.base_font_pt) || 11,
      applyThemeMargins: opts.applyThemeMargins === true,
      chrome: false
    };
    state.rctx = rctx;

    // Root + scale wrapper in the caller's container.
    const rootEl = h("div", "fmdoc-root");
    rootEl.setAttribute("data-scale", String(scale));
    rootEl.setAttribute("data-mode", mode);
    // Fluid view pages span their host (hosts center fixed-width pages, so
    // the root would otherwise shrink-wrap in flex/centered containers).
    if (doc.kind === "view" && paper.fill) rootEl.style.width = "100%";
    for (const name of Object.keys(themeVars)) rootEl.style.setProperty(name, themeVars[name]);
    const scaleWrap = h("div", "fmdoc-scale");
    if (scale !== 1) {
      scaleWrap.style.transform = "scale(" + scale + ")";
      scaleWrap.style.transformOrigin = "0 0";
    }
    // The wrap must keep its NATURAL layout width — without this it inherits
    // the root's scaled width and the transform multiplies it again
    // (double-scaling: pages drifted right and overflowed at zoom > 1).
    if (doc.kind !== "view" || scale !== 1) {
      scaleWrap.style.width = paper.w_pt * PT_TO_PX + "px";
    }
    rootEl.appendChild(scaleWrap);
    // Linked nodes are real anchors; under an editor canvas clicks must keep
    // selecting, never navigating. The visual-mode overlay swallows clicks
    // already — this delegated guard covers the surfaces without an overlay
    // (doc/preview/fill) and survives pagination clones.
    rootEl.addEventListener("click", (ev) => {
      const target = ev.target;
      const anchor = target && target.closest ? target.closest("a.fmdoc-link") : null;
      if (anchor && anchor.closest(".fmde-root, [data-fmde]")) ev.preventDefault();
    });
    state.container.appendChild(rootEl);
    state.root = rootEl;
    state.scaleWrap = scaleWrap;

    // Hidden staging pass: pages are built and paginated off-screen (unscaled)
    // so measurements are true pt->px layout, then moved into the scale wrap.
    const staging = h("div", "fmdoc-staging");
    staging.style.position = "absolute";
    staging.style.left = "-100000px";
    staging.style.top = "0";
    staging.style.visibility = "hidden";
    staging.style.pointerEvents = "none";
    for (const name of Object.keys(themeVars)) staging.style.setProperty(name, themeVars[name]);
    document.body.appendChild(staging);
    state.staging = staging;

    if (doc.kind === "view") {
      const viewWrap = h("div", "fmdoc-view fmdoc-page");
      viewWrap.setAttribute("data-page-id", "view_root");
      viewWrap.setAttribute("data-role", "custom");
      // paper.fill = fluid page: width follows the container instead of a
      // fixed design width (no proportional scaling on the live site).
      viewWrap.style.width = paper.fill ? "100%" : pt(paper.w_pt);
      viewWrap.style.maxWidth = "100%"; // views are responsive, not paged
      if (paper.fill) viewWrap.setAttribute("data-fill", "true");
      const rootNodeEl = doc.root ? renderNode(doc.root, rctx, false) : null;
      if (rootNodeEl) {
        rootNodeEl.style.position = "relative";
        rootNodeEl.style.left = "";
        rootNodeEl.style.top = "";
        // The view root's frame is width-only by design (h: 0 = grow with
        // content) — applyFrame's absolute branch would pin it to 0px tall
        // and the whole page renders blank. Size it to the wrapper and let
        // flowed children establish the height.
        rootNodeEl.style.width = "100%";
        rootNodeEl.style.height = "auto";
        rootNodeEl.style.minHeight = "48px";
        // Website roots are stacks of full-bleed sections. Section spacing is
        // authored inside each section; a root flex gap creates an unintended
        // strip of canvas between otherwise adjoining backgrounds.
        rootNodeEl.style.gap = "0px";
        // Top-level website sections are responsive containers. Their shared
        // width contract applies in both the editor preview and published
        // output; default sections still span the full available width.
        const sectionNodes = new Map((doc.root && doc.root.children || []).map((node) => [String(node && node.id || ""), node]));
        for (const child of rootNodeEl.children) {
          if (!child.getAttribute || child.getAttribute("data-node-type") !== "frame") continue;
          applyViewSectionWidth(child, sectionNodes.get(String(child.getAttribute("data-node-id") || "")));
        }
        viewWrap.appendChild(rootNodeEl);
      }
      staging.appendChild(viewWrap);
      state.pageEls = [viewWrap];
    } else {
      let pages = Array.isArray(doc.pages) ? doc.pages : [];
      if (Array.isArray(opts.pageRange) && opts.pageRange.length === 2) {
        pages = pages.slice(Math.max(0, opts.pageRange[0]), opts.pageRange[1] + 1);
      }
      state.pageEls = pages.map((page) => {
        const pageEl = buildPage(page, paper, rctx);
        staging.appendChild(pageEl);
        return pageEl;
      });
    }

    state.readyPromise = finalize(state, paper);
  }

  function finalize(state, paper) {
    // Read the scale at completion time, not build-start time — setScale()
    // may have changed it while pages were still building.
    const liveScale = () => Number(state.opts.scale) || 1;
    return Promise.all(state.widgetPromises.slice())
      .catch(() => {})
      .then(() => {
        if (state.destroyed || !state.staging) return null;
        if ((state.opts.document || {}).kind !== "view") {
          layoutChains(state); // v2 flow chains (may append auto pages)
          paginate(state); // legacy overflow:"paginate" flow frames
        }
        applyHeaderVariants(state);
        fillPageNumbers(state);
        fillFootnotes(state); // needs staged geometry for the per-page strips
        for (const pageEl of state.pageEls) state.scaleWrap.appendChild(pageEl);
        if (state.staging && state.staging.parentNode) state.staging.parentNode.removeChild(state.staging);
        state.staging = null;
        // Give the (scaled) root a real footprint so callers can lay it out.
        // EXCEPT for fluid view surfaces: pinning a pt-derived pixel width here
        // silently undoes the width:100% set at build time, so a "fill" page
        // ends up laid out at its nominal paper width instead of its host's.
        const scale = liveScale();
        const fluid = (state.opts.document || {}).kind === "view" && paper.fill;
        state.scaleWrap.style.transform = scale === 1 ? "" : "scale(" + scale + ")";
        state.root.style.width = fluid ? "100%" : paper.w_pt * PT_TO_PX * scale + "px";
        if ((state.opts.document || {}).kind === "view") {
          const hostWidth = state.container && state.container.getBoundingClientRect
            ? state.container.getBoundingClientRect().width
            : 0;
          syncViewSectionWidths(state, state.viewSurfaceWidthPx || hostWidth);
          // Standalone/published views have no editor to report a viewport.
          // Follow their block container directly. Editor instances explicitly
          // provide the inner canvas width because their stage shrink-wraps.
          if (typeof ResizeObserver !== "undefined" && !(state.container.closest && state.container.closest(".fmde-root"))) {
            const observer = new ResizeObserver(function (entries) {
              const rect = entries && entries[0] && entries[0].contentRect;
              if (!state.destroyed && rect && rect.width > 0) syncViewSectionWidths(state, rect.width);
            });
            observer.observe(state.container);
            state.destroyers.push(function () { observer.disconnect(); });
          }
        }
        return imagesReady(state.root);
      })
      .then(() => {
        if (state.destroyed || !state.root) return null;
        const scale = liveScale();
        if (state.scaleWrap && scale !== 1) {
          state.root.style.height = state.scaleWrap.offsetHeight * scale + "px";
        }
        markReady(state);
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  return {
    render,
    markupOverlayElement,
    // Editor live-preview hook: retarget a shape SVG's geometry + image fill
    // to an in-gesture frame without a rebuild.
    syncShapeSvg,
    PT_TO_PX,
    STYLE_ELEMENT_ID,
    rendererCss: RENDERER_CSS,
    fontStackFor: expandFontFamily
  };
});
