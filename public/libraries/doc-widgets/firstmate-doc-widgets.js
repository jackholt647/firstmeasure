/**
 * FirstMate doc-widgets — client-side widget registry for the document engine.
 *
 * Global: FMDocWidgets (also CommonJS-importable; module load never touches
 * the DOM so the PDF harness can require() it under Node — every
 * document/window access lives inside render functions).
 *
 * Contract: docs/document-engine-contracts.md §2.
 *   FMDocWidgets.register({ id, version, title, icon, category, defaults,
 *                           configPanel, renderStatic(el, ctx), renderInteractive(el, ctx) })
 *   FMDocWidgets.get(id, version)  // fallback: highest version <= requested
 *   FMDocWidgets.list()
 *
 * Pagination participation: a widget whose static render returns
 * { rows: HTMLElement[] } (and/or tags a container with [data-fmdoc-rows],
 * each row with [data-fmdoc-row], trailing once-only content with
 * [data-fmdoc-tail]) is splittable — the renderer treats those rows as flow
 * children when a paginating flow frame overflows, moving the actual row
 * elements onto continuation pages (listeners attached to rows/inputs
 * survive the move; do not rely on delegated listeners on the widget root
 * for row-level interactivity).
 *
 * All money is integer cents, formatted via FMDocModel.formatters.money.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FMDocWidgets = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null, function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  let modelCache = null;
  function model() {
    if (modelCache) return modelCache;
    if (root && root.FMDocModel) return (modelCache = root.FMDocModel);
    if (typeof require === "function") {
      try {
        return (modelCache = require("../doc-model/firstmate-doc-model.js"));
      } catch (error) {
        /* not available; formatting falls back below */
      }
    }
    return null;
  }

  function money(cents, currency) {
    const m = model();
    if (m && m.formatters && m.formatters.money) return m.formatters.money(cents, currency);
    return "$" + ((Number(cents) || 0) / 100).toFixed(2);
  }

  function fmtDate(value, pattern) {
    const m = model();
    if (m && m.formatters && m.formatters.date) return m.formatters.date(value, pattern);
    return String(value || "");
  }

  function cleanText(value) {
    return String(value === null || value === undefined ? "" : value).trim();
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function h(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null && text !== undefined) node.textContent = String(text);
    return node;
  }

  // ---------------------------------------------------------------------------
  // Widget stylesheet. The renderer's embedded stylesheet
  // (<style id="fmdoc-renderer-styles">) carries the shared visual layer for
  // the fmdoc-* widget classes; this block holds widget-owned additions and is
  // injected once per document as <style id="fmdoc-widgets-styles"> the first
  // time any widget renders.
  // ---------------------------------------------------------------------------

  const WIDGETS_CSS = `
.fmdoc-pay-now-qr { display: flex; flex-direction: column; align-items: center; gap: 3pt; margin-top: 8pt; }
.fmdoc-pay-now-qr svg { width: 58pt; height: 58pt; }
.fmdoc-pay-now-qr-hint { font-size: 7pt; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: #667085; }
.fmdoc-pay-now-confirm { margin-top: 6pt; font-size: 9pt; font-weight: 700; color: #047857; }
.fmdoc-measure-title { margin: 0 0 6pt; font-size: 9pt; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; color: var(--fmdoc-primary, var(--fm-primary, #2563eb)); }
.fmdoc-measure-summary { margin-top: 6pt; font-size: 9pt; font-weight: 700; color: #475467; }
.fmdoc-li-select-col { width: 18pt; text-align: center; }
.fmdoc-li-select { accent-color: var(--fmdoc-primary, var(--fm-primary, #2563eb)); }
.fmdoc-input--textarea { min-height: 40pt; resize: vertical; font: inherit; }
/* ── doc.form_field mode parity ───────────────────────────────────────────────
   Interactive inputs must occupy the SAME box as the static value text /
   blank rule (bottom-border-only fields, identical font/line-height/padding),
   so the editor (interactive) and preview/PDF harness (static) lay out
   identically. The blank rule is 14pt + 1pt border = 15pt; value text and
   inputs are border-box 15pt with the same 1pt bottom rule. */
.fmdoc-form-field { display: block; }
.fmdoc-form-field-value,
.fmdoc-form-field .fmdoc-input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 15pt;
  margin: 0;
  padding: 0;
  border: 0;
  border-bottom: 1pt solid var(--fmdoc-text, #111827);
  border-radius: 0;
  background: transparent;
  font: inherit;
  line-height: 14pt;
  color: inherit;
}
.fmdoc-form-field select.fmdoc-input { appearance: none; -webkit-appearance: none; -moz-appearance: none; }
.fmdoc-form-field input.fmdoc-input::placeholder { color: var(--fmdoc-muted, #667085); }
.fmdoc-form-field input[type="number"].fmdoc-input { -moz-appearance: textfield; appearance: textfield; }
.fmdoc-form-field input[type="number"].fmdoc-input::-webkit-outer-spin-button,
.fmdoc-form-field input[type="number"].fmdoc-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.fmdoc-form-field .fmdoc-input--textarea { min-height: 30pt; line-height: 1.35; resize: none; }
.fmdoc-form-field .fmdoc-check-row { min-height: 15pt; align-items: center; }
.fmdoc-form-field .fmdoc-address-grid .fmdoc-input { min-height: 15pt; }
/* ── media popup chips (line-item rows + doc.media_popup) ─────────────────── */
.fmdoc-media-chip { display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; width: 26pt; height: 19pt; margin-left: 4pt; border-radius: 3pt; overflow: hidden; position: relative; background: #1f2937; border: 0.6pt solid rgba(15,23,42,.2); cursor: zoom-in; }
.fmdoc-media-chip img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fmdoc-media-chip-glyph { position: absolute; right: 1.5pt; bottom: 1.5pt; width: 7.5pt; height: 7.5pt; pointer-events: none; }
.fmdoc-media-chip-glyph svg { width: 100%; height: 100%; display: block; }
.fmdoc-media-chip--video { background: #111827; }
.fmdoc-media-chip--video .fmdoc-media-chip-glyph { position: static; width: 10pt; height: 10pt; margin: auto; }
.fmdoc-li-inline-media { display: flex; gap: 3pt; margin-top: 3pt; flex-wrap: wrap; }
.fmdoc-li-inline-media img { width: 42pt; height: 30pt; object-fit: cover; border-radius: 3pt; border: 0.6pt solid rgba(15,23,42,.14); display: block; }
.fmdoc-li-inline-video { width: 42pt; height: 30pt; border-radius: 3pt; border: 0.6pt solid rgba(15,23,42,.14); background: #111827; display: flex; align-items: center; justify-content: center; cursor: zoom-in; }
.fmdoc-li-inline-video svg { width: 12pt; height: 12pt; }
.fmdoc-li-inline-caption { font-size: 6.5pt; font-weight: 600; color: #667085; width: 100%; }
/* ── doc.media_popup ──────────────────────────────────────────────────────── */
.fmdoc-media-popup { display: flex; flex-direction: column; gap: 3pt; align-items: flex-start; margin: 0; }
.fmdoc-media-popup-thumb { position: relative; border-radius: 4pt; overflow: hidden; border: 0.6pt solid rgba(15,23,42,.16); background: #eef1f6; }
.fmdoc-media-popup-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.fmdoc-media-popup-thumb .fmdoc-media-chip-glyph { position: absolute; right: 3pt; bottom: 3pt; width: 10pt; height: 10pt; }
.fmdoc-media-popup--interactive .fmdoc-media-popup-thumb { cursor: zoom-in; }
.fmdoc-media-popup-video { display: flex; align-items: center; justify-content: center; background: #111827; }
.fmdoc-media-popup-video svg { width: 40%; height: 40%; }
.fmdoc-media-popup-caption { font-size: 7.5pt; font-weight: 700; color: #475467; }
.fmdoc-media-popup-url { font-size: 6.8pt; color: #667085; word-break: break-all; max-width: 160pt; }
/* ── shared lightbox overlay (app space — px, fixed) ─────────────────────── */
.fmdoc-lightbox { position: fixed; inset: 0; z-index: 2147483560; display: flex; align-items: center; justify-content: center; padding: 28px; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
.fmdoc-lightbox-backdrop { position: absolute; inset: 0; background: rgba(10,14,24,.82); }
.fmdoc-lightbox-panel { position: relative; margin: 0; max-width: min(940px, 94vw); max-height: 90vh; display: flex; flex-direction: column; gap: 10px; align-items: center; }
.fmdoc-lightbox-image { max-width: 100%; max-height: 76vh; border-radius: 10px; box-shadow: 0 24px 70px rgba(0,0,0,.5); background: #fff; }
.fmdoc-lightbox-video { width: min(880px, 92vw); max-width: 100%; aspect-ratio: 16 / 9; border: 0; border-radius: 10px; background: #000; box-shadow: 0 24px 70px rgba(0,0,0,.5); }
.fmdoc-lightbox-caption { color: #e7ecf5; font-size: 13px; font-weight: 600; text-align: center; max-width: 80ch; }
.fmdoc-lightbox-close { position: absolute; top: -12px; right: -12px; width: 34px; height: 34px; border-radius: 999px; border: 0; background: #fff; color: #111827; font-size: 20px; line-height: 1; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.35); z-index: 1; display: flex; align-items: center; justify-content: center; }
.fmdoc-lightbox-close:hover { background: #f2f4f7; }
/* ── doc.layers_diagram ───────────────────────────────────────────────────── */
.fmdoc-layers-wrap { width: 100%; }
.fmdoc-layers-title { margin: 0 0 6pt; font-size: 10pt; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--fmdoc-primary, var(--fm-primary, #2563eb)); }
.fmdoc-layers { display: flex; gap: 12pt; align-items: flex-start; width: 100%; }
.fmdoc-layers-stage { flex: 1 1 56%; min-width: 0; }
.fmdoc-layers-stage svg { width: 100%; height: auto; display: block; }
.fmdoc-layers-slab { transition: opacity .16s ease, transform .16s ease; }
.fmdoc-layers--interactive .fmdoc-layers-slab { cursor: pointer; }
.fmdoc-layers--interactive .fmdoc-layers-slab--dim { opacity: .38; }
.fmdoc-layers--interactive .fmdoc-layers-slab--active { transform: translateY(-3px); }
.fmdoc-layers--interactive .fmdoc-layers-slab--active .fmdoc-layers-top { stroke: rgba(17,24,39,.85); stroke-width: 1.1; }
.fmdoc-layers-panel { flex: 1 1 44%; min-width: 0; border: 0.8pt solid #e4e7ec; border-radius: 8pt; background: #fff; padding: 10pt 11pt; display: flex; flex-direction: column; gap: 4pt; }
.fmdoc-layers-panel-kicker { display: flex; align-items: center; gap: 5pt; font-size: 7pt; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: #667085; }
.fmdoc-layers-panel-dot { width: 7pt; height: 7pt; border-radius: 99pt; flex: none; }
.fmdoc-layers-panel-name { font-size: 10.5pt; font-weight: 800; color: #111827; line-height: 1.25; }
.fmdoc-layers-panel-blurb { font-size: 8.5pt; font-weight: 500; line-height: 1.55; color: #475467; }
.fmdoc-layers-legend { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4pt; flex: 1 1 44%; min-width: 0; }
.fmdoc-layers-legend li { display: flex; gap: 6pt; align-items: flex-start; font-size: 8pt; line-height: 1.45; color: #344054; }
.fmdoc-layers-legend-num { flex: none; width: 11pt; height: 11pt; border-radius: 99pt; display: inline-flex; align-items: center; justify-content: center; font-size: 6.5pt; font-weight: 800; color: #fff; margin-top: 1pt; }
.fmdoc-layers-legend b { font-weight: 800; color: #111827; }
/* ── doc.workflow_field ─────────────────────────────────────────────────────
   Workflow fields are first-class visual-editor widgets. Their frame, fill,
   border and responsive geometry remain owned by the shared document engine;
   this stylesheet only draws the field's internal form surface. */
.fmdoc-workflow-field { box-sizing: border-box; width: 100%; height: 100%; min-height: 44pt; display: flex; flex-direction: column; justify-content: flex-start; gap: 5pt; position: relative; padding: 9pt 10pt 9pt 11pt; border: .7pt solid #d8dee8; border-left: 3pt solid var(--fmdoc-primary,var(--fm-primary,#2563eb)); border-radius: 8pt; background: #fff; color: #344054; overflow: hidden; }
.fmdoc-workflow-field-label { display: flex; align-items: center; gap: 4pt; min-width: 0; font-size: 8.5pt; font-weight: 800; line-height: 1.25; }
.fmdoc-workflow-field-label b { color: #d92d20; }
.fmdoc-workflow-field-description { max-width: 62ch; color: #667085; font-size: 7.25pt; font-weight: 500; line-height: 1.4; }
.fmdoc-workflow-field-control { flex: 0 0 auto; min-height: 0; width: 100%; display: flex; align-items: flex-start; }
.fmdoc-workflow-field-control :is(input,select,textarea) { box-sizing: border-box; width: min(100%,260pt); min-height: 27pt; border: .7pt solid #cbd3df; border-radius: 6pt; background: #f9fafb; color: #344054; padding: 5pt 7pt; font: inherit; font-size: 8pt; box-shadow: 0 1pt 2pt rgba(16,24,40,.04); }
.fmdoc-workflow-field-control textarea { height: 50pt; min-height: 42pt; max-height: 66pt; resize: none; }
.fmdoc-workflow-input-shell { box-sizing: border-box; width: min(100%,260pt); min-height: 27pt; display: flex; align-items: center; border: .7pt solid #cbd3df; border-radius: 6pt; background: #f9fafb; box-shadow: 0 1pt 2pt rgba(16,24,40,.04); overflow: hidden; }
.fmdoc-workflow-input-shell > span { flex: none; align-self: stretch; min-width: 27pt; display: grid; place-items: center; border-right: .7pt solid #d8dee8; background: #fff; color: var(--fmdoc-primary,var(--fm-primary,#2563eb)); font-size: 8.5pt; font-weight: 850; }
.fmdoc-workflow-input-shell input { width: 100%; min-height: 25pt; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
.fmdoc-workflow-options { width: 100%; display: grid; grid-template-columns: repeat(auto-fit,minmax(72pt,1fr)); gap: 5pt; }
.fmdoc-workflow-option { min-height: 32pt; border: .7pt solid #d6dce5; border-radius: 7pt; background: #fff; color: #475467; display: flex; align-items: center; justify-content: center; gap: 4pt; padding: 5pt; font: inherit; font-size: 7.5pt; font-weight: 800; text-align: center; }
.fmdoc-workflow-option.selected { border-color: var(--fmdoc-primary,var(--fm-primary,#2563eb)); color: var(--fmdoc-primary,var(--fm-primary,#2563eb)); background: color-mix(in srgb,var(--fmdoc-primary,var(--fm-primary,#2563eb)) 8%,#fff); }
.fmdoc-workflow-options.list { display: flex; flex-direction: column; align-items: stretch; }
.fmdoc-workflow-options.list .fmdoc-workflow-option { justify-content: flex-start; min-height: 23pt; }
.fmdoc-workflow-field--disabled { filter: grayscale(.9); opacity: .52; }
.fmdoc-workflow-disabled-note { font-size: 6.8pt; font-weight: 700; color: #667085; }
`;

  function ensureStyles(doc) {
    if (!doc || typeof doc.getElementById !== "function" || doc.getElementById("fmdoc-widgets-styles")) return;
    const style = doc.createElement("style");
    style.id = "fmdoc-widgets-styles";
    style.textContent = WIDGETS_CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  function clearEl(el) {
    if (el && el.ownerDocument) ensureStyles(el.ownerDocument);
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function widgetOutputKey(ctx, fallbackSuffix) {
    const cfg = ctx.config || {};
    if (cleanText(cfg.output_key)) return cleanText(cfg.output_key);
    const nodeId = (ctx.node && ctx.node.id) || "widget";
    return fallbackSuffix ? fallbackSuffix + "_" + nodeId : nodeId;
  }

  function currentOutput(ctx, key) {
    const outputs = ctx.outputs || {};
    return outputs[key] === undefined ? null : outputs[key];
  }

  function mediaUrlFor(ctx, media, variant) {
    if (!media) return "";
    if (typeof media === "string") return media;
    if (media.url) return media.url;
    if (typeof ctx.mediaUrl === "function") return ctx.mediaUrl(media, variant || media.variant) || "";
    const api = ctx.api || {};
    if (media.media_id && api.orgId) {
      const v = variant || media.variant;
      return "/v1/platform/organizations/" + encodeURIComponent(api.orgId) + "/media/" + encodeURIComponent(media.media_id) + "/file" + (v ? "?variant=" + encodeURIComponent(v) : "");
    }
    return "";
  }

  function placeholderBox(el, label, hint) {
    clearEl(el);
    const box = h("div", "fmdoc-widget-placeholder");
    box.appendChild(h("div", "fmdoc-widget-placeholder-title", label));
    if (hint) box.appendChild(h("div", "fmdoc-widget-placeholder-hint", hint));
    el.appendChild(box);
    return box;
  }

  function statusBadge(status) {
    const value = cleanText(status).toLowerCase() || "pending";
    const badge = h("span", "fmdoc-badge fmdoc-badge--" + value.replace(/[^a-z0-9_-]/g, ""), value.replace(/_/g, " "));
    return badge;
  }

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------

  const registry = new Map(); // id -> [{version, def}, ...] sorted ascending

  function register(def) {
    if (!def || typeof def.id !== "string" || !/^[a-z0-9_.-]+$/.test(def.id)) {
      throw new Error("FMDocWidgets.register: widget id must be a lowercase namespaced string");
    }
    const version = Number(def.version) || 1;
    const entry = Object.assign({ version, category: "data", configPanel: [], defaults: { config: {}, frame: { w: 240, h: 120 } } }, def);
    if (typeof entry.renderStatic !== "function") throw new Error("FMDocWidgets.register: " + def.id + " is missing renderStatic");
    if (typeof entry.renderInteractive !== "function") entry.renderInteractive = entry.renderStatic;
    let versions = registry.get(def.id);
    if (!versions) {
      versions = [];
      registry.set(def.id, versions);
    }
    const existing = versions.findIndex((v) => v.version === version);
    if (existing !== -1) versions.splice(existing, 1);
    versions.push({ version, def: entry });
    versions.sort((a, b) => a.version - b.version);
    return entry;
  }

  /** Highest registered version <= requested (exact match preferred); null when nothing qualifies. */
  function get(id, version) {
    const versions = registry.get(id);
    if (!versions || !versions.length) return null;
    const wanted = version === undefined || version === null ? Infinity : Number(version);
    if (Number.isNaN(wanted)) return null;
    let best = null;
    for (const entry of versions) {
      if (entry.version <= wanted) best = entry;
    }
    return best ? best.def : null;
  }

  /** Latest definition of every registered widget id. */
  function list() {
    const out = [];
    for (const versions of registry.values()) out.push(versions[versions.length - 1].def);
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }

  // ---------------------------------------------------------------------------
  // QR encoder — fully self-contained (no network, no external lib).
  //
  // Byte mode, error correction level M, versions 1-10 with automatic version
  // selection. All 8 mask patterns are evaluated with the four standard
  // penalty rules (N1 runs, N2 blocks, N3 finder-like patterns, N4 dark
  // balance) and the best mask wins, with matching BCH(15,5) format bits and
  // (for v7+) BCH(18,6) version bits. Reed-Solomon over GF(256) with the QR
  // polynomial 0x11D. Output is a module matrix rendered to an SVG path.
  // ---------------------------------------------------------------------------

  const QR = (function () {
    // GF(256) log/antilog tables.
    const EXP = new Array(512);
    const LOG = new Array(256);
    (function () {
      let x = 1;
      for (let i = 0; i < 255; i += 1) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d;
      }
      for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
    })();

    function gmul(a, b) {
      if (a === 0 || b === 0) return 0;
      return EXP[LOG[a] + LOG[b]];
    }

    // Product (x - a^0)(x - a^1)...(x - a^(degree-1)), leading coefficient dropped.
    function rsDivisor(degree) {
      const result = [];
      for (let i = 0; i < degree - 1; i += 1) result.push(0);
      result.push(1);
      let rootPow = 1;
      for (let i = 0; i < degree; i += 1) {
        for (let j = 0; j < result.length; j += 1) {
          result[j] = gmul(result[j], rootPow);
          if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        rootPow = gmul(rootPow, 0x02);
      }
      return result;
    }

    // Polynomial remainder of data * x^degree divided by the generator.
    function rsRemainder(data, divisor) {
      const result = divisor.map(() => 0);
      for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i += 1) result[i] ^= gmul(divisor[i], factor);
      }
      return result;
    }

    // EC level M block structure per version: [ecCodewordsPerBlock, [[blockCount, dataCodewordsPerBlock], ...]]
    const EC_M = {
      1: [10, [[1, 16]]],
      2: [16, [[1, 28]]],
      3: [26, [[1, 44]]],
      4: [18, [[2, 32]]],
      5: [24, [[2, 43]]],
      6: [16, [[4, 27]]],
      7: [18, [[4, 31]]],
      8: [22, [[2, 38], [2, 39]]],
      9: [22, [[3, 36], [2, 37]]],
      10: [26, [[4, 43], [1, 44]]]
    };

    const ALIGNMENT = {
      1: [],
      2: [6, 18],
      3: [6, 22],
      4: [6, 26],
      5: [6, 30],
      6: [6, 34],
      7: [6, 22, 38],
      8: [6, 24, 42],
      9: [6, 26, 46],
      10: [6, 28, 50]
    };

    function dataCodewords(version) {
      const spec = EC_M[version];
      let total = 0;
      for (const [count, per] of spec[1]) total += count * per;
      return total;
    }

    function byteCapacity(version) {
      // Header: 4-bit mode + character count (8 bits for v1-9, 16 bits for v10).
      return dataCodewords(version) - (version <= 9 ? 2 : 3);
    }

    function utf8Bytes(text) {
      const out = [];
      for (const ch of String(text)) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      }
      return out;
    }

    function pickVersion(byteLength) {
      for (let v = 1; v <= 10; v += 1) {
        if (byteLength <= byteCapacity(v)) return v;
      }
      return null;
    }

    /** Build the final interleaved codeword stream (data + ECC). */
    function buildCodewords(bytes, version) {
      const capacityBits = dataCodewords(version) * 8;
      const bits = [];
      const push = (value, count) => {
        for (let i = count - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
      };
      push(0b0100, 4); // byte mode
      push(bytes.length, version <= 9 ? 8 : 16);
      for (const b of bytes) push(b, 8);
      // Terminator + pad to byte boundary + alternating pad codewords.
      push(0, Math.min(4, capacityBits - bits.length));
      while (bits.length % 8 !== 0) bits.push(0);
      const padBytes = [0xec, 0x11];
      let padIndex = 0;
      while (bits.length < capacityBits) {
        push(padBytes[padIndex % 2], 8);
        padIndex += 1;
      }
      const data = [];
      for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
        data.push(value);
      }

      // Split into blocks, compute ECC, interleave.
      const [ecPerBlock, groups] = EC_M[version];
      const divisor = rsDivisor(ecPerBlock);
      const blocks = [];
      let offset = 0;
      for (const [count, per] of groups) {
        for (let b = 0; b < count; b += 1) {
          const blockData = data.slice(offset, offset + per);
          offset += per;
          blocks.push({ data: blockData, ecc: rsRemainder(blockData, divisor) });
        }
      }
      const out = [];
      const maxData = Math.max(...blocks.map((b) => b.data.length));
      for (let i = 0; i < maxData; i += 1) {
        for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
      }
      for (let i = 0; i < ecPerBlock; i += 1) {
        for (const block of blocks) out.push(block.ecc[i]);
      }
      return { codewords: out, blocks, ecPerBlock };
    }

    /** BCH(15,5) format bits for a (ecBits, mask) pair. EC level M => ecBits 0b00. */
    function formatBits(ecBits, mask) {
      const data = (ecBits << 3) | mask;
      let rem = data;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      return ((data << 10) | rem) ^ 0x5412;
    }

    /** BCH(18,6) version information bits (only versions >= 7 carry them). */
    function versionBits(version) {
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      return (version << 12) | rem;
    }

    const EC_BITS_M = 0b00;

    /** Mask condition for pattern 0-7 at module (x, y): invert when true. */
    function maskAt(mask, x, y) {
      switch (mask) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
        case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
        case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
        case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
        default: return false;
      }
    }

    // Finder-like sequences for penalty rule N3 (1011101 flanked by 0000).
    const N3_A = [true, false, true, true, true, false, true, false, false, false, false];
    const N3_B = [false, false, false, false, true, false, true, true, true, false, true];

    function lineHasPatternAt(line, at, pattern) {
      for (let i = 0; i < pattern.length; i += 1) {
        if (line[at + i] !== pattern[i]) return false;
      }
      return true;
    }

    /** Standard mask penalty score (rules N1-N4). Lower is better. */
    function penaltyScore(modules, size) {
      let score = 0;
      // N1: runs of >= 5 same-color modules in rows and columns.
      for (let pass = 0; pass < 2; pass += 1) {
        for (let a = 0; a < size; a += 1) {
          let runColor = pass === 0 ? modules[a][0] : modules[0][a];
          let runLen = 1;
          for (let b = 1; b < size; b += 1) {
            const color = pass === 0 ? modules[a][b] : modules[b][a];
            if (color === runColor) {
              runLen += 1;
            } else {
              if (runLen >= 5) score += 3 + (runLen - 5);
              runColor = color;
              runLen = 1;
            }
          }
          if (runLen >= 5) score += 3 + (runLen - 5);
        }
      }
      // N2: 2x2 blocks of one color.
      for (let y = 0; y < size - 1; y += 1) {
        for (let x = 0; x < size - 1; x += 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }
      // N3: finder-like patterns in rows and columns.
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x <= size - 11; x += 1) {
          if (lineHasPatternAt(modules[y], x, N3_A) || lineHasPatternAt(modules[y], x, N3_B)) score += 40;
        }
      }
      const column = new Array(size);
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) column[y] = modules[y][x];
        for (let y = 0; y <= size - 11; y += 1) {
          if (lineHasPatternAt(column, y, N3_A) || lineHasPatternAt(column, y, N3_B)) score += 40;
        }
      }
      // N4: dark proportion deviation from 50% in 5% steps.
      let dark = 0;
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
      }
      score += 10 * Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5);
      return score;
    }

    /** Encode text -> { version, size, modules, isFunction, codewords }. Returns null when too long. */
    function encode(text) {
      const bytes = utf8Bytes(text);
      const version = pickVersion(bytes.length);
      if (!version) return null;
      const size = 17 + version * 4;
      const modules = [];
      const isFunction = [];
      for (let y = 0; y < size; y += 1) {
        modules.push(new Array(size).fill(false));
        isFunction.push(new Array(size).fill(false));
      }
      const set = (x, y, dark) => {
        modules[y][x] = !!dark;
        isFunction[y][x] = true;
      };
      const getBit = (value, i) => ((value >>> i) & 1) !== 0;

      // Timing patterns.
      for (let i = 0; i < size; i += 1) {
        set(6, i, i % 2 === 0);
        set(i, 6, i % 2 === 0);
      }
      // Finder patterns + separators (3x, clamped 9x9 stamps).
      const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy += 1) {
          for (let dx = -4; dx <= 4; dx += 1) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            const x = cx + dx;
            const y = cy + dy;
            if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
          }
        }
      };
      finder(3, 3);
      finder(size - 4, 3);
      finder(3, size - 4);
      // Alignment patterns (skip the three finder corners).
      const positions = ALIGNMENT[version];
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = 0; j < positions.length; j += 1) {
          const cx = positions[i];
          const cy = positions[j];
          const inFinder = (cx <= 8 && cy <= 8) || (cx <= 8 && cy >= size - 9) || (cx >= size - 9 && cy <= 8);
          if (inFinder) continue;
          for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) {
              set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
          }
        }
      }
      // Format information. Drawn with mask 0 first to reserve the modules;
      // redrawn for each candidate mask during selection below.
      const drawFormat = (mask) => {
        const fmt = formatBits(EC_BITS_M, mask);
        for (let i = 0; i <= 5; i += 1) set(8, i, getBit(fmt, i));
        set(8, 7, getBit(fmt, 6));
        set(8, 8, getBit(fmt, 7));
        set(7, 8, getBit(fmt, 8));
        for (let i = 9; i < 15; i += 1) set(14 - i, 8, getBit(fmt, i));
        for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, getBit(fmt, i));
        for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, getBit(fmt, i));
        set(8, size - 8, true); // dark module
      };
      drawFormat(0);
      // Version information for versions 7+.
      if (version >= 7) {
        const vbits = versionBits(version);
        for (let i = 0; i < 18; i += 1) {
          const bit = getBit(vbits, i);
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          set(a, b, bit);
          set(b, a, bit);
        }
      }

      // Codeword placement: zigzag upward/downward in 2-module columns.
      const built = buildCodewords(bytes, version);
      const cw = built.codewords;
      let bitIndex = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert += 1) {
          for (let j = 0; j < 2; j += 1) {
            const x = right - j;
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            if (!isFunction[y][x] && bitIndex < cw.length * 8) {
              modules[y][x] = getBit(cw[bitIndex >> 3], 7 - (bitIndex & 7));
              bitIndex += 1;
            }
          }
        }
      }
      // Evaluate all 8 masks over data modules and keep the lowest penalty.
      const applyMask = (mask) => {
        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            if (!isFunction[y][x] && maskAt(mask, x, y)) modules[y][x] = !modules[y][x];
          }
        }
      };
      let bestMask = 0;
      let bestScore = Infinity;
      for (let mask = 0; mask < 8; mask += 1) {
        applyMask(mask);
        drawFormat(mask);
        const score = penaltyScore(modules, size);
        if (score < bestScore) {
          bestScore = score;
          bestMask = mask;
        }
        applyMask(mask); // XOR toggle undoes the candidate mask
      }
      applyMask(bestMask);
      drawFormat(bestMask);
      return { version, size, modules, isFunction, mask: bestMask, codewords: cw, blocks: built.blocks, ecPerBlock: built.ecPerBlock };
    }

    /** Render an encoded matrix as an SVG string (quiet zone included). */
    function svg(text, options) {
      const opts = options || {};
      const encoded = encode(text);
      if (!encoded) return null;
      const quiet = opts.quiet === undefined ? 4 : Math.max(0, Number(opts.quiet) || 0);
      const dim = encoded.size + quiet * 2;
      let path = "";
      for (let y = 0; y < encoded.size; y += 1) {
        for (let x = 0; x < encoded.size; x += 1) {
          if (encoded.modules[y][x]) path += "M" + (x + quiet) + " " + (y + quiet) + "h1v1h-1z";
        }
      }
      const fg = opts.color || "#111111";
      const bg = opts.background === undefined ? "#ffffff" : opts.background;
      return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + " " + dim + '" shape-rendering="crispEdges" role="img" aria-label="QR code">' +
        (bg ? '<rect width="' + dim + '" height="' + dim + '" fill="' + bg + '"/>' : "") +
        '<path d="' + path + '" fill="' + fg + '"/></svg>'
      );
    }

    return {
      encode,
      svg,
      formatBits,
      versionBits,
      byteCapacity,
      dataCodewords,
      utf8Bytes,
      gf: { EXP, LOG, gmul, rsDivisor, rsRemainder },
      maskAt,
      EC_BITS_M
    };
  })();

  // ---------------------------------------------------------------------------
  // Markup overlay fallback (canonical implementation lives in FMDocRenderer;
  // widgets use it when present so photo overlays match markup_overlay nodes).
  // ---------------------------------------------------------------------------

  function markupOverlayElement(items) {
    const renderer = root && root.FMDocRenderer;
    if (renderer && typeof renderer.markupOverlayElement === "function") return renderer.markupOverlayElement(items);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Shared media lightbox + delegated popup-chip handler.
  //
  // data-fmdoc-media-popup CONTRACT — the one attribute every popup-media
  // affordance uses, whether it was rendered by a widget (doc.media_popup,
  // doc.line_items popup chips) or by RENDERER OUTPUT such as repeater /
  // component instances (wave-2's media_text_row / li_row components emit the
  // same attribute for content_blocks + scope items with display:"popup"):
  //
  //   <span data-fmdoc-media-popup='{"media":{"media_id":"m_1"},"caption":"Ridge detail"}'>…</span>
  //
  // The attribute VALUE is a JSON payload:
  //   { media?:   { media_id?, url?, variant? }   // image to open
  //     video?:   { url? }                        // video file URL, or a YouTube/Vimeo page URL
  //     caption?: string
  //     org_id?:  string }                        // lets media_id resolve to /v1/platform/.../media/:id/file
  //
  // installLightboxDelegate(doc?) installs ONE document-level click listener
  // that opens openLightbox() for any element carrying the attribute — no
  // per-element binding, so rows moved by pagination and repeater-instanced
  // markup keep working. Interactive surfaces (portal viewer, editor preview,
  // any widget renderInteractive that emits chips) install it; static/print
  // surfaces never call it, so identical markup stays inert in PDFs.
  // ---------------------------------------------------------------------------

  const PLAY_GLYPH = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="rgba(255,255,255,.92)"/><path d="M10 8l6.5 4L10 16z" fill="#111827"/></svg>';
  const ZOOM_GLYPH = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="rgba(17,24,39,.78)"/><path d="M11 7a4 4 0 100 8 4 4 0 000-8zm5.7 10.3l-2.4-2.4" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';

  /** YouTube / Vimeo page URL -> embeddable player URL; null for plain files. */
  function videoEmbedUrl(url) {
    const text = cleanText(url);
    if (!text) return null;
    let m = text.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (m) return "https://www.youtube.com/embed/" + m[1];
    m = text.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (m) return "https://player.vimeo.com/video/" + m[1];
    return null;
  }

  /**
   * Self-contained media lightbox: dim backdrop, centered media, caption,
   * close on X / backdrop / Esc. Video plays via <video controls>, or a
   * YouTube/Vimeo iframe when the URL matches those hosts.
   *
   * openLightbox({ media?: {media_id|url,variant?}, url?: string,
   *                video?: {url} | string, caption?, api?: {orgId},
   *                mediaUrl?(media,variant), onClose? }) -> { close, element } | null
   */
  function openLightbox(opts) {
    if (typeof document === "undefined") return null;
    const o = opts || {};
    ensureStyles(document);
    const ctxLike = { api: o.api || {}, mediaUrl: o.mediaUrl };
    const video = isObject(o.video) ? o.video : cleanText(o.video) ? { url: cleanText(o.video) } : null;
    const videoUrl = video ? cleanText(video.url) : "";
    const media = o.media || (cleanText(o.url) ? { url: cleanText(o.url) } : null);

    let contentEl = null;
    if (videoUrl) {
      const embed = videoEmbedUrl(videoUrl);
      if (embed) {
        const iframe = document.createElement("iframe");
        iframe.className = "fmdoc-lightbox-video";
        iframe.src = embed;
        iframe.allow = "autoplay; fullscreen; picture-in-picture";
        iframe.allowFullscreen = true;
        contentEl = iframe;
      } else {
        const player = document.createElement("video");
        player.className = "fmdoc-lightbox-video";
        player.src = videoUrl;
        player.controls = true;
        player.playsInline = true;
        contentEl = player;
      }
    } else if (media) {
      const src = mediaUrlFor(ctxLike, media, isObject(media) ? media.variant || "display" : null);
      if (src) {
        const img = document.createElement("img");
        img.className = "fmdoc-lightbox-image";
        img.src = src;
        img.alt = cleanText(o.caption) || "Media";
        contentEl = img;
      }
    }
    if (!contentEl) return null;

    const overlay = h("div", "fmdoc-lightbox");
    const backdrop = h("div", "fmdoc-lightbox-backdrop");
    overlay.appendChild(backdrop);
    const panel = h("figure", "fmdoc-lightbox-panel");
    overlay.appendChild(panel);
    const closeBtn = h("button", "fmdoc-lightbox-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", (globalThis.PlatformLanguage?.text("doc-widgets","m_3742924668fb10","Close") ?? "Close"));
    panel.appendChild(closeBtn);
    panel.appendChild(contentEl);
    const caption = cleanText(o.caption || (video && video.caption) || (isObject(media) && media.caption));
    if (caption) panel.appendChild(h("figcaption", "fmdoc-lightbox-caption", caption));

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      if (contentEl.tagName === "VIDEO") {
        try { contentEl.pause(); } catch (error) { /* already detached */ }
      }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof o.onClose === "function") {
        try { o.onClose(); } catch (error) { /* host issue */ }
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(overlay);
    return { close, element: overlay };
  }

  /** Install the document-level [data-fmdoc-media-popup] click delegate once. */
  function installLightboxDelegate(doc) {
    const d = doc || (typeof document !== "undefined" ? document : null);
    if (!d || d.__fmdocLightboxDelegate) return;
    d.__fmdocLightboxDelegate = true;
    d.addEventListener("click", (event) => {
      const target = event.target && event.target.closest ? event.target.closest("[data-fmdoc-media-popup]") : null;
      if (!target) return;
      let payload = null;
      try {
        payload = JSON.parse(target.getAttribute("data-fmdoc-media-popup"));
      } catch (error) {
        payload = null;
      }
      if (!payload || !isObject(payload)) return;
      event.preventDefault();
      openLightbox({
        media: payload.media || null,
        video: payload.video || null,
        caption: payload.caption,
        api: payload.org_id ? { orgId: payload.org_id } : null
      });
    });
  }

  /** Build the JSON payload for data-fmdoc-media-popup (see contract above). */
  function mediaPopupAttrValue(ctx, entry) {
    const e = entry || {};
    const payload = {};
    if (e.media) {
      payload.media = isObject(e.media)
        ? { media_id: e.media.media_id || undefined, url: e.media.url || undefined, variant: e.media.variant || undefined }
        : { url: String(e.media) };
    }
    const videoUrl = e.video ? cleanText(isObject(e.video) ? e.video.url : e.video) : "";
    if (videoUrl) payload.video = { url: videoUrl };
    if (cleanText(e.caption)) payload.caption = cleanText(e.caption);
    const orgId = ctx && ctx.api && ctx.api.orgId;
    if (orgId) payload.org_id = String(orgId);
    return JSON.stringify(payload);
  }

  /** Small thumbnail chip carrying the popup attribute (line-item rows). */
  function buildPopupChip(ctx, entry) {
    const chip = h("span", "fmdoc-media-chip");
    chip.setAttribute("data-fmdoc-media-popup", mediaPopupAttrValue(ctx, entry));
    chip.title = cleanText(entry.caption) || "View media";
    const src = entry.media ? mediaUrlFor(ctx, entry.media, "thumb") : "";
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = cleanText(entry.caption) || "";
      chip.appendChild(img);
    } else {
      chip.classList.add("fmdoc-media-chip--video");
    }
    const glyph = h("span", "fmdoc-media-chip-glyph");
    glyph.innerHTML = entry.video && !src ? PLAY_GLYPH : ZOOM_GLYPH;
    chip.appendChild(glyph);
    return chip;
  }

  // ---------------------------------------------------------------------------
  // doc.line_items
  // ---------------------------------------------------------------------------

  const LINE_ITEM_COLUMNS = {
    name: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_5be12a31e41de3","Item") ?? "Item"), className: "fmdoc-li-name" },
    description: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_aa136ecb65672f","Description") ?? "Description"), className: "fmdoc-li-desc" },
    qty: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_1a29aea570fbc4","Qty") ?? "Qty"), className: "fmdoc-li-qty" },
    unit_price: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_bc7b189271d609","Unit price") ?? "Unit price"), className: "fmdoc-li-price" },
    amount: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2b8c3448fa87a1","Amount") ?? "Amount"), className: "fmdoc-li-amount" }
  };

  function lineItemRows(ctx) {
    const data = ctx.data;
    if (data && Array.isArray(data.rows)) return data.rows;
    // No server-resolved data: derive from the configured source path when possible.
    const cfg = ctx.config || {};
    const m = model();
    const source = cleanText(cfg.source) || "params.scope_items";
    const items = m && ctx.scope ? m.getPath(ctx.scope, source) : null;
    if (Array.isArray(items) && items.length) {
      return items.map((item, index) => ({
        id: item.id || "li_" + index,
        depth: Number(item.depth) || 0,
        name: cleanText(item.name || item.title || item.label) || "Item " + (index + 1),
        description: cleanText(item.description || item.details),
        quantity: item.quantity === undefined ? 1 : Number(item.quantity) || 0,
        unit: cleanText(item.unit),
        unit_price_cents: Number(item.unit_price_cents) || 0,
        amount_cents: Number(item.amount_cents) || (Number(item.unit_price_cents) || 0) * (Number(item.quantity) || 1),
        included: !!item.included,
        optional: !!item.optional,
        selected: item.selected !== false,
        selectable_by: item.selectable_by || null,
        group_id: item.group_id || null,
        media: Array.isArray(item.media) ? item.media : [],
        video: isObject(item.video) && cleanText(item.video.url) ? item.video : null,
        display: cleanText(item.display)
      }));
    }
    return null;
  }

  function lineItemColumns(ctx) {
    const cfg = ctx.config || {};
    const fromData = ctx.data && Array.isArray(ctx.data.columns) ? ctx.data.columns : null;
    let columns = Array.isArray(cfg.columns) && cfg.columns.length ? cfg.columns : fromData || ["name", "description", "qty", "unit_price", "amount"];
    if (cfg.show_prices === false) columns = columns.filter((c) => c !== "unit_price" && c !== "amount");
    return columns.filter((c) => LINE_ITEM_COLUMNS[c]);
  }

  /** Recompute totals from rows (selected, non-included), applying the base tax percent. */
  function computeLineItemTotals(rows, base) {
    const b = base || {};
    let subtotal = 0;
    for (const row of rows || []) {
      if (row.included) continue;
      if ((row.optional || row.group_id) && row.selected === false) continue;
      subtotal += Number(row.amount_cents) || 0;
    }
    const taxPercent = Number(b.tax_percent) || 0;
    const tax = taxPercent ? Math.round((subtotal * taxPercent) / 100) : Number(b.tax_cents) && !taxPercent ? Number(b.tax_cents) : 0;
    return { subtotal_cents: subtotal, tax_cents: tax, tax_percent: taxPercent, total_cents: subtotal + tax, currency: b.currency || "USD" };
  }

  function lineItemTotals(ctx, rows) {
    const totals = (ctx.data && ctx.data.totals) || null;
    if (totals) return totals;
    return computeLineItemTotals(rows, null);
  }

  function renderLineItemsTotalsInto(tail, totals, currency) {
    clearEl(tail);
    const addRow = (label, cents, strong) => {
      const row = h("div", "fmdoc-li-total-row" + (strong ? " fmdoc-li-total-row--grand" : ""));
      row.appendChild(h("span", "fmdoc-li-total-label", label));
      row.appendChild(h("span", "fmdoc-li-total-value", money(cents, currency)));
      tail.appendChild(row);
    };
    addRow("Subtotal", totals.subtotal_cents || 0, false);
    if (totals.tax_cents) addRow("Tax" + (totals.tax_percent ? " (" + totals.tax_percent + "%)" : ""), totals.tax_cents, false);
    addRow("Total", totals.total_cents === undefined ? totals.subtotal_cents || 0 : totals.total_cents, true);
  }

  /**
   * Row-level media/video rendering (spec §10.1: line items carry
   * media[]/video + display "inline"|"popup").
   *  - popup: a small thumbnail chip carrying data-fmdoc-media-popup — the
   *    document-level delegate opens the shared lightbox on interactive
   *    surfaces; the same markup is inert (a plain thumbnail) in print.
   *  - inline: a print-safe thumbnail strip under the line-item text.
   * Returns true when a popup chip was emitted (caller installs the delegate).
   */
  function appendLineItemRowMedia(ctx, holder, row) {
    const rowMedia = Array.isArray(row.media) ? row.media.filter(Boolean) : [];
    const rowVideo = isObject(row.video) && cleanText(row.video.url) ? row.video : null;
    if (!rowMedia.length && !rowVideo) return false;
    const display = cleanText(row.display) || "inline";
    if (display === "popup") {
      const first = rowMedia[0] || null;
      holder.appendChild(buildPopupChip(ctx, {
        media: first,
        video: rowVideo,
        caption: cleanText((first && first.caption) || (rowVideo && rowVideo.caption)) || row.name
      }));
      return true;
    }
    // inline: thumbnail row under the line-item text.
    const strip = h("div", "fmdoc-li-inline-media");
    let emittedChip = false;
    for (const entry of rowMedia.slice(0, 4)) {
      const src = mediaUrlFor(ctx, entry, isObject(entry) ? entry.variant || "thumb" : null);
      if (!src) continue;
      const img = document.createElement("img");
      img.src = src;
      img.alt = cleanText(isObject(entry) && entry.caption) || row.name || "";
      strip.appendChild(img);
    }
    if (rowVideo) {
      const tile = h("span", "fmdoc-li-inline-video");
      tile.setAttribute("data-fmdoc-media-popup", mediaPopupAttrValue(ctx, { video: rowVideo, caption: cleanText(rowVideo.caption) || row.name }));
      tile.title = (globalThis.PlatformLanguage?.text("doc-widgets","m_aae553c94b09d8","Play video") ?? "Play video");
      tile.innerHTML = PLAY_GLYPH;
      strip.appendChild(tile);
      emittedChip = true;
    }
    const inlineCaption = cleanText(rowMedia.length && isObject(rowMedia[0]) ? rowMedia[0].caption : "");
    if (inlineCaption) strip.appendChild(h("span", "fmdoc-li-inline-caption", inlineCaption));
    if (strip.childNodes.length) holder.appendChild(strip);
    return emittedChip;
  }

  function renderLineItems(el, ctx, interactive) {
    clearEl(el);
    const cfg = ctx.config || {};
    let rows = lineItemRows(ctx);
    if (!rows) {
      placeholderBox(el, "Line items", "No line items yet — select this block and choose “Edit line items” to add them.");
      return;
    }
    if (cfg.show_included === false) rows = rows.filter((row) => !row.included);
    if (typeof cfg.depth === "number") rows = rows.filter((row) => (Number(row.depth) || 0) <= cfg.depth);
    const columns = lineItemColumns(ctx);
    const showMedia = !!cfg.show_media;
    const showPrices = cfg.show_prices !== false;
    const currency = ((ctx.data && ctx.data.totals) || {}).currency || "USD";
    // Optional rows are customer-selectable by default in interactive mode;
    // config.selectable === false turns the affordance off.
    const selectable = interactive && cfg.selectable !== false && rows.some((row) => row.optional || row.group_id);
    const skin = ctx.skin || {};

    const wrap = h("div", "fmdoc-line-items" + (cfg.compact ? " fmdoc-line-items--compact" : ""));
    el.appendChild(wrap);

    const selections = {};
    for (const row of rows) selections[row.id] = row.selected !== false;

    const submitSelections = () => {
      const outputKey = cleanText(cfg.output_key) || "selections";
      ctx.submitOutput(outputKey, {
        selected_ids: rows.filter((row) => selections[row.id] && (row.optional || row.group_id)).map((row) => row.id)
      });
      // Recompute locally from the new selection state — server totals only
      // describe the state at resolve time (tax percent/currency carry over).
      const updated = rows.map((row) => Object.assign({}, row, { selected: selections[row.id] }));
      const totals = computeLineItemTotals(updated, (ctx.data && ctx.data.totals) || null);
      const tail = wrap.querySelector("[data-fmdoc-tail]");
      if (tail && showPrices) renderLineItemsTotalsInto(tail, totals, currency);
    };

    const rowElements = [];
    let hasPopupChips = false;

    if (cfg.compact) {
      // Legal-style single flow: each row is a paragraph; still tagged for pagination.
      const body = h("div", "fmdoc-li-flow");
      body.setAttribute("data-fmdoc-rows", "true");
      wrap.appendChild(body);
      rows.forEach((row) => {
        const para = h("p", "fmdoc-li-flow-row");
        para.setAttribute("data-fmdoc-row", "true");
        para.style.paddingLeft = (Number(row.depth) || 0) * 12 + "pt";
        const name = h("strong", null, row.name);
        para.appendChild(name);
        if (row.description) para.appendChild(document.createTextNode(" — " + row.description));
        if (showPrices) {
          const amount = row.included ? "Included" : money(row.amount_cents, currency);
          para.appendChild(h("span", "fmdoc-li-flow-amount", " " + amount));
        }
        if (appendLineItemRowMedia(ctx, para, row)) hasPopupChips = true;
        body.appendChild(para);
        rowElements.push(para);
      });
    } else {
      const table = h("table", "fmdoc-table fmdoc-li-table");
      if (skin.header_fill) table.style.setProperty("--fmdoc-table-header-fill", skin.header_fill);
      const thead = h("thead");
      const headRow = h("tr");
      if (selectable) headRow.appendChild(h("th", "fmdoc-li-select-col", ""));
      if (showMedia) headRow.appendChild(h("th", "fmdoc-li-media-col", ""));
      for (const col of columns) {
        const th = h("th", LINE_ITEM_COLUMNS[col].className, LINE_ITEM_COLUMNS[col].label);
        headRow.appendChild(th);
      }
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      table.appendChild(tbody);
      wrap.appendChild(table);

      let lastGroup = null;
      const colSpan = columns.length + (selectable ? 1 : 0) + (showMedia ? 1 : 0);
      rows.forEach((row) => {
        if (cfg.group_by && row.group_id && row.group_id !== lastGroup) {
          lastGroup = row.group_id;
          const groupTr = h("tr", "fmdoc-li-group-row");
          groupTr.setAttribute("data-fmdoc-row", "true");
          const td = h("td", null, cleanText(row.group_label || row.group_id));
          td.colSpan = colSpan;
          groupTr.appendChild(td);
          tbody.appendChild(groupTr);
          rowElements.push(groupTr);
        }
        const tr = h("tr", "fmdoc-li-row" + (row.optional ? " fmdoc-li-row--optional" : ""));
        tr.setAttribute("data-fmdoc-row", "true");
        if (selectable) {
          const td = h("td", "fmdoc-li-select-col");
          if (row.optional || row.group_id) {
            const input = document.createElement("input");
            input.type = row.group_id ? "radio" : "checkbox";
            if (row.group_id) input.name = "fmdoc_group_" + (ctx.node ? ctx.node.id : "w") + "_" + row.group_id;
            input.checked = selections[row.id];
            input.className = "fmdoc-li-select";
            // Listener on the input itself so pagination row moves keep it live.
            input.addEventListener("change", () => {
              if (row.group_id) {
                for (const other of rows) {
                  if (other.group_id === row.group_id) selections[other.id] = other.id === row.id;
                }
              } else {
                selections[row.id] = input.checked;
              }
              submitSelections();
            });
            td.appendChild(input);
          }
          tr.appendChild(td);
        }
        if (showMedia) {
          const td = h("td", "fmdoc-li-media-col");
          const media = Array.isArray(row.media) ? row.media.slice(0, 2) : [];
          for (const entry of media) {
            const src = mediaUrlFor(ctx, entry, entry.variant || "thumb");
            if (!src) continue;
            const img = document.createElement("img");
            img.className = "fmdoc-li-thumb";
            img.src = src;
            img.alt = row.name || "";
            td.appendChild(img);
          }
          tr.appendChild(td);
        }
        for (const col of columns) {
          const meta = LINE_ITEM_COLUMNS[col];
          const td = h("td", meta.className);
          if (col === "name") {
            td.style.paddingLeft = 6 + (Number(row.depth) || 0) * 12 + "pt";
            td.appendChild(h("span", "fmdoc-li-name-text", row.name));
            if (row.optional && !selectable) td.appendChild(h("span", "fmdoc-li-optional-flag", "Optional"));
            if (appendLineItemRowMedia(ctx, td, row)) hasPopupChips = true;
          } else if (col === "description") {
            td.textContent = row.description || "";
          } else if (col === "qty") {
            td.textContent = row.quantity === undefined || row.quantity === null ? "" : String(row.quantity) + (row.unit ? " " + row.unit : "");
          } else if (col === "unit_price") {
            td.textContent = row.included ? "—" : money(row.unit_price_cents, currency);
          } else if (col === "amount") {
            if (row.included) td.appendChild(h("span", "fmdoc-badge fmdoc-badge--included", "Included"));
            else td.textContent = money(row.amount_cents, currency);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        rowElements.push(tr);
      });
    }

    if (showPrices) {
      const tail = h("div", "fmdoc-li-totals");
      tail.setAttribute("data-fmdoc-tail", "true");
      renderLineItemsTotalsInto(tail, lineItemTotals(ctx, rows), currency);
      wrap.appendChild(tail);
    }

    // Popup chips resolve through the document-level delegate on interactive
    // surfaces (static renders keep the markup but never bind).
    if (interactive && hasPopupChips) installLightboxDelegate(el.ownerDocument);

    // Pagination hint: rows are splittable flow children (see file header).
    return { rows: rowElements };
  }

  register({
    id: "doc.line_items",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_097dfe4a1638f4","Line items") ?? "Line items"),
    icon: "fa-table-list",
    category: "data",
    defaults: {
      config: { source: "params.scope_items", show_prices: true, show_included: true, show_media: false, compact: false, selectable: true, output_key: "selections" },
      frame: { w: 540, h: 220 }
    },
    configPanel: [
      { key: "source", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_bb795b3646f994","Data source") ?? "Data source"), kind: "binding" },
      { key: "show_prices", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_4bd603894fc67b","Show prices") ?? "Show prices"), kind: "toggle" },
      { key: "show_included", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_07a9a08f66fb9d","Show included items") ?? "Show included items"), kind: "toggle" },
      { key: "show_media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_5a30878c160aea","Show media thumbnails") ?? "Show media thumbnails"), kind: "toggle" },
      { key: "compact", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_e89e947e0c758b","Compact (legal style)") ?? "Compact (legal style)"), kind: "toggle" },
      { key: "selectable", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_47f7e929a615e3","Customer can select options") ?? "Customer can select options"), kind: "toggle" },
      { key: "columns", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8abb9612e904f8","Columns") ?? "Columns"), kind: "list", options: Object.keys(LINE_ITEM_COLUMNS) },
      { key: "depth", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_99a56228db41ee","Max depth") ?? "Max depth"), kind: "number", min: 0, max: 6 },
      { key: "group_by", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_137f988f9e6d5e","Group rows") ?? "Group rows"), kind: "toggle" }
    ],
    renderStatic(el, ctx) {
      return renderLineItems(el, ctx, false);
    },
    renderInteractive(el, ctx) {
      renderLineItems(el, ctx, true);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.payment_schedule
  // ---------------------------------------------------------------------------

  function paymentObligations(ctx) {
    const data = ctx.data || {};
    if (Array.isArray(data.obligations)) return data.obligations;
    if (Array.isArray(data.rows)) return data.rows;
    const cfg = ctx.config || {};
    if (Array.isArray(cfg.obligations)) return cfg.obligations;
    const m = model();
    const fromParams = m && ctx.scope ? m.getPath(ctx.scope, "params.payment_schedule") : null;
    if (Array.isArray(fromParams)) return fromParams;
    return null;
  }

  register({
    id: "doc.payment_schedule",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_efee8a08306ce6","Payment schedule") ?? "Payment schedule"),
    icon: "fa-calendar-check",
    category: "commerce",
    defaults: { config: { show_status: true }, frame: { w: 540, h: 160 } },
    configPanel: [
      { key: "show_status", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_4238a97b538629","Show payment status") ?? "Show payment status"), kind: "toggle" },
      { key: "title", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const obligations = paymentObligations(ctx);
      if (!obligations || !obligations.length) {
        placeholderBox(el, "Payment schedule", "No payment obligations resolved for this document yet.");
        return;
      }
      const cfg = ctx.config || {};
      const currency = (ctx.data && ctx.data.currency) || "USD";
      const wrap = h("div", "fmdoc-payment-schedule");
      if (cleanText(cfg.title)) wrap.appendChild(h("div", "fmdoc-widget-title", cfg.title));
      const table = h("table", "fmdoc-table");
      const thead = h("thead");
      const headRow = h("tr");
      for (const label of ["Payment", "Due", "Amount"].concat(cfg.show_status === false ? [] : ["Status"])) headRow.appendChild(h("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      obligations.forEach((entry, index) => {
        const tr = h("tr");
        tr.setAttribute("data-fmdoc-row", "true");
        tr.appendChild(h("td", null, cleanText(entry.label || entry.name || entry.description) || "Payment " + (index + 1)));
        tr.appendChild(h("td", null, entry.due_date || entry.due ? fmtDate(entry.due_date || entry.due) : cleanText(entry.due_label || "On completion")));
        tr.appendChild(h("td", "fmdoc-li-amount", money(entry.amount_cents, entry.currency || currency)));
        if (cfg.show_status !== false) {
          const td = h("td");
          td.appendChild(statusBadge(entry.status || "due"));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      el.appendChild(wrap);
    }
  });

  // ---------------------------------------------------------------------------
  // doc.pay_now
  // ---------------------------------------------------------------------------

  function payNowAmount(ctx) {
    const cfg = ctx.config || {};
    const data = ctx.data || {};
    if (data.amount_due_cents !== undefined && data.amount_due_cents !== null) return Number(data.amount_due_cents) || 0;
    if (data.amount_cents !== undefined && data.amount_cents !== null) return Number(data.amount_cents) || 0;
    if (cfg.amount_cents !== undefined && cfg.amount_cents !== null && cfg.amount_cents !== "") return Number(cfg.amount_cents) || 0;
    const m = model();
    const fromParams = m && ctx.scope ? m.getPath(ctx.scope, "params.amount_due_cents") : null;
    if (fromParams !== undefined && fromParams !== null) return Number(fromParams) || 0;
    return null;
  }

  function payNowKey(ctx) {
    return cleanText((ctx.config || {}).output_key) || "payment";
  }

  function payNowSummary(ctx) {
    const cfg = ctx.config || {};
    const data = ctx.data || {};
    const resolvedAmount = payNowAmount(ctx);
    // Authoring canvases should occupy the same amount line-height as a real
    // payment. A zero is deliberately data-shaped; a dash made the configured
    // widget look shorter and caused surprises when project data arrived.
    const amount = resolvedAmount === null && ctx.preview === true ? 0 : resolvedAmount;
    const box = h("div", "fmdoc-pay-now");
    box.appendChild(h("div", "fmdoc-pay-now-label", cleanText(cfg.amount_label) || "Amount due"));
    box.appendChild(h("div", "fmdoc-pay-now-amount", amount === null ? "—" : money(amount, data.currency)));
    const note = cleanText(cfg.note || data.note);
    if (note) box.appendChild(h("div", "fmdoc-pay-now-note", note));
    return box;
  }

  register({
    id: "doc.pay_now",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_36ca6543347503","Pay now") ?? "Pay now"),
    icon: "fa-credit-card",
    category: "commerce",
    resizeAxes: "horizontal",
    heightMode: "content",
    defaults: { config: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_f4f42f8c853a8d","Pay") ?? "Pay"), note: "", output_key: "payment" }, frame: { w: 260, h: 120 } },
    configPanel: [
      { key: "label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_f709f2734ba4ad","Button label") ?? "Button label"), kind: "text" },
      { key: "amount_label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_b6dd4a8a21d841","Amount label") ?? "Amount label"), kind: "text" },
      { key: "note", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_963906ea70bf9a","Note") ?? "Note"), kind: "text" },
      { key: "amount_cents", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2c72140b0fd9d6","Amount (cents)") ?? "Amount (cents)"), kind: "number", min: 0 },
      { key: "output_key", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8ca76efd08d74f","Output key") ?? "Output key"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      // Print view: amount-due summary + a QR pointing at the portal so the
      // paper document links back to the interactive payment flow.
      clearEl(el);
      const box = payNowSummary(ctx);
      const portalUrl = cleanText((ctx.api || {}).portalUrl || (ctx.data && (ctx.data.portal_url || ctx.data.url)));
      if (portalUrl) {
        const svgMarkup = QR.svg(portalUrl, { color: "#111111" });
        if (svgMarkup) {
          const qrWrap = h("div", "fmdoc-pay-now-qr");
          qrWrap.innerHTML = svgMarkup;
          qrWrap.appendChild(h("div", "fmdoc-pay-now-qr-hint", "Scan to pay online"));
          box.appendChild(qrWrap);
        }
      }
      el.appendChild(box);
    },
    renderInteractive(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const data = ctx.data || {};
      const amount = payNowAmount(ctx);
      const key = payNowKey(ctx);
      const intake = root ? root.FirstMatePaymentIntake : null;
      const buttonLabel = cleanText(cfg.button_label) || "Pay";

      // Portal hosts own the actual checkout. Opening it here keeps payment
      // collection in context and avoids treating a click as a completed or
      // remotely "sent" request.
      if (typeof (ctx.api || {}).openPayment === "function") {
        const box = payNowSummary(ctx);
        const button = h("button", "fmdoc-button fmdoc-pay-now-button", buttonLabel);
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            await ctx.api.openPayment({
              outputKey: key,
              amountCents: amount,
              title: cleanText(cfg.title || cfg.label) || "Make a payment",
              description: cleanText(cfg.note || data.note)
            });
          } finally {
            button.disabled = false;
          }
        });
        box.appendChild(button);
        el.appendChild(box);
        return {};
      }

      // Preferred path: mount the shared payment intake inline.
      if (intake && typeof intake.mount === "function" && (ctx.api || {}).publicToken) {
        try {
          const host = h("div", "fmdoc-pay-now fmdoc-pay-now--intake");
          el.appendChild(host);
          const handle = intake.mount(host, {
            title: cleanText(cfg.title) || "Make a payment",
            description: cleanText(cfg.note || data.note),
            amountCents: amount === null ? undefined : amount,
            allowCustomAmount: cfg.allow_custom_amount === true || amount === null,
            submitLabel: buttonLabel,
            primaryColor: (ctx.themeVars || {})["--fm-primary"],
            onSubmit: async (submitted) => {
              ctx.submitOutput(key, {
                intent: "pay",
                amount_cents: submitted && submitted.amountCents !== undefined ? Number(submitted.amountCents) || 0 : amount || 0,
                method: (submitted && (submitted.method || submitted.savedMethodId)) || null
              });
              return { ok: true };
            }
          });
          return {
            destroy() {
              try {
                handle.close();
              } catch (error) {
                /* already torn down */
              }
            }
          };
        } catch (error) {
          clearEl(el); // intake refused — degrade to the plain button below
        }
      }

      // Fallback hosts still open checkout. A click alone never records a
      // payment or claims that a request was sent somewhere.
      const box = payNowSummary(ctx);
      const button = h("button", "fmdoc-button fmdoc-pay-now-button", buttonLabel);
      button.type = "button";
      button.addEventListener("click", () => {
        if (!intake || typeof intake.open !== "function") return;
        intake.open({
          title: cleanText(cfg.title || cfg.label) || "Make a payment",
          description: cleanText(cfg.note || data.note),
          amountCents: amount === null ? undefined : amount,
          allowCustomAmount: cfg.allow_custom_amount === true || amount === null,
          submitLabel: buttonLabel,
          primaryColor: (ctx.themeVars || {})["--fm-primary"],
          onSubmit: async (submitted) => {
            await ctx.submitOutput(key, {
              intent: "paid",
              amount_cents: submitted && submitted.amountCents !== undefined ? Number(submitted.amountCents) || 0 : amount || 0,
              method: cleanText(submitted && (submitted.method || submitted.savedMethodId)),
              payment_method: cleanText(submitted && submitted.method)
            });
            return { ok: true };
          }
        });
      });
      if (!intake || typeof intake.open !== "function") button.disabled = true;
      box.appendChild(button);
      el.appendChild(box);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.signature
  // ---------------------------------------------------------------------------

  const SIGNATURE_FONTS = {
    script: '"Brush Script MT", "Segoe Script", "Snell Roundhand", cursive',
    elegant: '"Lucida Handwriting", "Apple Chancery", cursive',
    casual: '"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive'
  };

  function signatureKey(ctx) {
    return cleanText((ctx.config || {}).output_key) || "sig_customer";
  }

  function signatureValue(ctx) {
    const key = signatureKey(ctx);
    const fromOutputs = currentOutput(ctx, key);
    if (fromOutputs) return fromOutputs;
    if (ctx.data && isObject(ctx.data) && (ctx.data.type === "typed" || ctx.data.type === "drawn")) return ctx.data;
    return null;
  }

  function renderSignatureDisplay(el, ctx) {
    clearEl(el);
    const cfg = ctx.config || {};
    const value = signatureValue(ctx);
    const wrap = h("div", "fmdoc-signature");
    if (value) {
      const face = h("div", "fmdoc-signature-face");
      if (value.type === "drawn" && value.image_data) {
        const img = document.createElement("img");
        img.className = "fmdoc-signature-image";
        img.src = value.image_data;
        img.alt = "Signature";
        face.appendChild(img);
      } else {
        const typed = h("div", "fmdoc-signature-typed", value.text || value.signer_name || "");
        typed.style.fontFamily = SIGNATURE_FONTS[value.style] || SIGNATURE_FONTS.script;
        face.appendChild(typed);
      }
      wrap.appendChild(face);
      const meta = h("div", "fmdoc-signature-meta");
      meta.appendChild(h("span", "fmdoc-signature-name", value.signer_name || ""));
      if (value.signed_at) meta.appendChild(h("span", "fmdoc-signature-date", fmtDate(value.signed_at, "MMM d, yyyy h:mm a")));
      wrap.appendChild(meta);
    } else {
      wrap.appendChild(h("div", "fmdoc-signature-line"));
    }
    wrap.appendChild(h("div", "fmdoc-signature-label", cleanText(cfg.label) || "Signature"));
    el.appendChild(wrap);
    return wrap;
  }

  function openSignatureModal(ctx, onDone) {
    const overlay = h("div", "fmdoc-modal-overlay");
    const modal = h("div", "fmdoc-modal fmdoc-sign-modal");
    overlay.appendChild(modal);
    modal.appendChild(h("div", "fmdoc-modal-title", "Add your signature"));

    const nameField = h("div", "fmdoc-field");
    nameField.appendChild(h("label", "fmdoc-field-label", "Full name"));
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "fmdoc-input";
    nameInput.placeholder = (globalThis.PlatformLanguage?.text("doc-widgets","m_2d2dbe7ed3c8d7","Your full name") ?? "Your full name");
    nameField.appendChild(nameInput);
    modal.appendChild(nameField);

    const tabs = h("div", "fmdoc-tabs");
    const typeTab = h("button", "fmdoc-tab fmdoc-tab--active", "Type");
    const drawTab = h("button", "fmdoc-tab", "Draw");
    typeTab.type = "button";
    drawTab.type = "button";
    tabs.appendChild(typeTab);
    tabs.appendChild(drawTab);
    modal.appendChild(tabs);

    // Typed pane
    const typedPane = h("div", "fmdoc-sign-pane");
    const preview = h("div", "fmdoc-sign-preview", "");
    preview.style.fontFamily = SIGNATURE_FONTS.script;
    typedPane.appendChild(preview);
    const styleRow = h("div", "fmdoc-sign-styles");
    let selectedStyle = "script";
    Object.keys(SIGNATURE_FONTS).forEach((styleKey, index) => {
      const button = h("button", "fmdoc-sign-style" + (index === 0 ? " fmdoc-sign-style--active" : ""), "Aa");
      button.type = "button";
      button.style.fontFamily = SIGNATURE_FONTS[styleKey];
      button.addEventListener("click", () => {
        selectedStyle = styleKey;
        preview.style.fontFamily = SIGNATURE_FONTS[styleKey];
        styleRow.querySelectorAll(".fmdoc-sign-style").forEach((b) => b.classList.remove("fmdoc-sign-style--active"));
        button.classList.add("fmdoc-sign-style--active");
      });
      styleRow.appendChild(button);
    });
    typedPane.appendChild(styleRow);
    modal.appendChild(typedPane);
    nameInput.addEventListener("input", () => {
      preview.textContent = nameInput.value;
    });

    // Drawn pane
    const drawPane = h("div", "fmdoc-sign-pane");
    drawPane.style.display = "none";
    const canvas = document.createElement("canvas");
    canvas.width = 520;
    canvas.height = 180;
    canvas.className = "fmdoc-sign-canvas";
    drawPane.appendChild(canvas);
    const clearButton = h("button", "fmdoc-button fmdoc-button--ghost", "Clear");
    clearButton.type = "button";
    drawPane.appendChild(clearButton);
    modal.appendChild(drawPane);

    const context = canvas.getContext("2d");
    context.lineWidth = 2.4;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#111827";
    let drawing = false;
    let hasInk = false;
    const canvasPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: ((event.clientX - rect.left) / rect.width) * canvas.width, y: ((event.clientY - rect.top) / rect.height) * canvas.height };
    };
    canvas.addEventListener("pointerdown", (event) => {
      drawing = true;
      hasInk = true;
      canvas.setPointerCapture(event.pointerId);
      const point = canvasPoint(event);
      context.beginPath();
      context.moveTo(point.x, point.y);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!drawing) return;
      const point = canvasPoint(event);
      context.lineTo(point.x, point.y);
      context.stroke();
    });
    const endStroke = () => {
      drawing = false;
    };
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    clearButton.addEventListener("click", () => {
      context.clearRect(0, 0, canvas.width, canvas.height);
      hasInk = false;
    });

    let activeMode = "typed";
    const setMode = (mode) => {
      activeMode = mode;
      typedPane.style.display = mode === "typed" ? "" : "none";
      drawPane.style.display = mode === "drawn" ? "" : "none";
      typeTab.classList.toggle("fmdoc-tab--active", mode === "typed");
      drawTab.classList.toggle("fmdoc-tab--active", mode === "drawn");
    };
    typeTab.addEventListener("click", () => setMode("typed"));
    drawTab.addEventListener("click", () => setMode("drawn"));

    const actions = h("div", "fmdoc-modal-actions");
    const cancelButton = h("button", "fmdoc-button fmdoc-button--ghost", "Cancel");
    const adoptButton = h("button", "fmdoc-button fmdoc-button--primary", "Adopt & sign");
    cancelButton.type = "button";
    adoptButton.type = "button";
    actions.appendChild(cancelButton);
    actions.appendChild(adoptButton);
    modal.appendChild(actions);

    const close = () => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };
    cancelButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    adoptButton.addEventListener("click", () => {
      const signerName = cleanText(nameInput.value);
      if (!signerName) {
        nameInput.classList.add("fmdoc-input--invalid");
        nameInput.focus();
        return;
      }
      if (activeMode === "drawn" && !hasInk) {
        canvas.classList.add("fmdoc-sign-canvas--invalid");
        return;
      }
      // Output value shape matches the proposal e-sign contract (§2).
      const value = {
        type: activeMode,
        text: activeMode === "typed" ? signerName : "",
        signer_name: signerName,
        style: activeMode === "typed" ? selectedStyle : "drawn",
        signed_at: new Date().toISOString()
      };
      if (activeMode === "drawn") value.image_data = canvas.toDataURL("image/png");
      close();
      onDone(value);
    });

    document.body.appendChild(overlay);
    nameInput.focus();
    return { close };
  }

  register({
    id: "doc.signature",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_8625881623433e","Signature") ?? "Signature"),
    icon: "fa-signature",
    category: "input",
    defaults: { config: { label: (globalThis.PlatformLanguage?.text("doc-widgets","m_043a279788edc3","Customer signature") ?? "Customer signature"), output_key: "sig_customer", signer: "customer" }, frame: { w: 240, h: 90 } },
    configPanel: [
      { key: "label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9fd79f4276d659","Label") ?? "Label"), kind: "text" },
      { key: "output_key", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8ca76efd08d74f","Output key") ?? "Output key"), kind: "text" },
      { key: "signer", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_4df1190b5e3436","Signer") ?? "Signer"), kind: "select", options: ["customer", "internal"] }
    ],
    renderStatic(el, ctx) {
      renderSignatureDisplay(el, ctx);
    },
    renderInteractive(el, ctx) {
      const wrap = renderSignatureDisplay(el, ctx);
      const value = signatureValue(ctx);
      if (!value) {
        if (ctx.authoring === true) {
          wrap.classList.add("fmdoc-signature--inactive");
          const prompt = h("div", "fmdoc-signature-cta", "Customer signs after sending");
          wrap.insertBefore(prompt, wrap.firstChild);
          wrap.setAttribute("aria-disabled", "true");
          return {};
        }
        wrap.classList.add("fmdoc-signature--actionable");
        const prompt = h("div", "fmdoc-signature-cta", "Click to sign");
        wrap.insertBefore(prompt, wrap.firstChild);
        const open = () => {
          openSignatureModal(ctx, (signed) => {
            const key = signatureKey(ctx);
            if (ctx.outputs) ctx.outputs[key] = signed;
            ctx.submitOutput(key, signed);
            ctx.refresh();
          });
        };
        wrap.addEventListener("click", open);
        wrap.setAttribute("role", "button");
        wrap.tabIndex = 0;
        wrap.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            open();
          }
        });
      }
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.workflow_field
  // ---------------------------------------------------------------------------

  const WORKFLOW_FIELD_KINDS = [
    "text", "textarea", "number", "currency", "date", "select", "multi_select",
    "choice_group", "boolean", "media_picker", "measurements", "piece_select",
    "line_items_review", "content_blocks", "line_item_editor", "review",
    "generate_document", "signature", "payment"
  ];

  function workflowFieldOptions(cfg) {
    return (Array.isArray(cfg.options) ? cfg.options : []).map((option, index) => {
      if (isObject(option)) return {
        value: cleanText(option.value || option.id || option.label) || "option_" + (index + 1),
        label: cleanText(option.label || option.name || option.value) || "Option " + (index + 1),
        icon: cleanText(option.icon)
      };
      return { value: String(option), label: String(option), icon: "" };
    });
  }

  function workflowSetNested(target, parts, value) {
    let cursor = target;
    parts.forEach((part, index) => {
      if (index === parts.length - 1) cursor[part] = value;
      else {
        if (!isObject(cursor[part])) cursor[part] = {};
        cursor = cursor[part];
      }
    });
  }

  function submitWorkflowField(ctx, cfg, value) {
    const writes = cleanText(cfg.writes);
    const parts = writes.split(".").filter(Boolean);
    if (parts.length < 2 || !["params", "outputs"].includes(parts[0])) return;
    const rootName = parts.shift();
    const topKey = parts.shift();
    if (!topKey) return;
    const target = rootName === "params" ? ((isObject(ctx.scope) && ctx.scope.params) || {}) : (ctx.outputs || {});
    const existing = isObject(target[topKey]) ? Object.assign({}, target[topKey]) : {};
    if (parts.length) {
      workflowSetNested(existing, parts, value);
      target[topKey] = existing;
    } else target[topKey] = value;
    if (rootName === "outputs") ctx.submitOutput(topKey, target[topKey]);
  }

  function workflowFieldControl(wrap, ctx, interactive) {
    const cfg = ctx.config || {};
    const kind = WORKFLOW_FIELD_KINDS.includes(cleanText(cfg.kind)) ? cleanText(cfg.kind) : "text";
    const authoring = ctx.authoring === true;
    const disabled = cfg.disabled === true;
    const enabled = interactive && !authoring && !disabled;
    const control = h("div", "fmdoc-workflow-field-control");
    const options = workflowFieldOptions(cfg);
    let value = null;

    if (["select", "multi_select", "choice_group"].includes(kind) && cleanText(cfg.choice_style || cfg.presentation || "tiles") !== "dropdown") {
      const multiple = kind === "multi_select";
      const list = cleanText(cfg.choice_style || cfg.presentation) === "radio";
      const grid = h("div", "fmdoc-workflow-options" + (list ? " list" : ""));
      const selected = new Set();
      options.forEach((option) => {
        const button = h("button", "fmdoc-workflow-option");
        button.type = "button";
        button.disabled = !enabled;
        if (option.icon) {
          const icon = h("i", "fas " + option.icon);
          icon.setAttribute("aria-hidden", "true");
          button.appendChild(icon);
        }
        button.appendChild(document.createTextNode(option.label));
        if (enabled) button.addEventListener("click", () => {
          if (multiple) {
            if (selected.has(option.value)) selected.delete(option.value); else selected.add(option.value);
            button.classList.toggle("selected", selected.has(option.value));
            value = Array.from(selected);
          } else {
            value = option.value;
            Array.from(grid.children).forEach((entry) => entry.classList.toggle("selected", entry === button));
          }
          submitWorkflowField(ctx, cfg, value);
        });
        grid.appendChild(button);
      });
      if (!options.length) grid.appendChild(h("span", "fmdoc-workflow-disabled-note", "Add choices in the field settings."));
      control.appendChild(grid);
    } else if (["select", "multi_select", "choice_group"].includes(kind)) {
      const select = document.createElement("select");
      select.disabled = !enabled;
      select.multiple = kind === "multi_select";
      if (kind !== "multi_select") select.appendChild(new Option(cleanText(cfg.placeholder) || "Choose an option", ""));
      options.forEach((option) => select.appendChild(new Option(option.label, option.value)));
      if (enabled) select.addEventListener("change", () => {
        const next = select.multiple ? Array.from(select.selectedOptions).map((option) => option.value) : select.value;
        submitWorkflowField(ctx, cfg, next);
      });
      control.appendChild(select);
    } else if (kind === "boolean") {
      const grid = h("div", "fmdoc-workflow-options");
      ["Yes", "No"].forEach((label, index) => {
        const button = h("button", "fmdoc-workflow-option", label);
        button.type = "button";
        button.disabled = !enabled;
        if (enabled) button.addEventListener("click", () => {
          Array.from(grid.children).forEach((entry) => entry.classList.toggle("selected", entry === button));
          submitWorkflowField(ctx, cfg, index === 0);
        });
        grid.appendChild(button);
      });
      control.appendChild(grid);
    } else if (["signature", "payment", "review", "generate_document", "media_picker"].includes(kind)) {
      const action = kind === "signature" ? ["fa-signature", "Collect signature"] : kind === "payment" ? ["fa-credit-card", "Collect payment"] : kind === "media_picker" ? ["fa-image", "Choose media"] : kind === "generate_document" ? ["fa-file-circle-plus", "Generate document"] : ["fa-eye", "Review"];
      const button = h("button", "fmdoc-workflow-option");
      button.type = "button";
      button.disabled = !enabled;
      button.appendChild(h("i", "fas " + action[0]));
      button.appendChild(document.createTextNode(action[1]));
      control.appendChild(button);
    } else {
      const input = document.createElement(kind === "textarea" ? "textarea" : "input");
      if (input.tagName === "INPUT") input.type = kind === "date" ? "date" : ["number", "currency"].includes(kind) ? "number" : "text";
      if (kind === "currency") { input.step = "0.01"; input.inputMode = "decimal"; }
      input.placeholder = cleanText(cfg.placeholder) || (kind === "currency" ? "0.00" : kind === "number" ? "0" : authoring ? "Response appears in preview" : "Enter a response");
      input.disabled = !enabled;
      if (enabled) input.addEventListener("change", () => {
        let next = input.value;
        if (kind === "number") next = input.value === "" ? null : Number(input.value);
        if (kind === "currency") next = Math.round((parseFloat(input.value) || 0) * 100);
        submitWorkflowField(ctx, cfg, next);
      });
      if (kind === "currency") {
        const shell = h("div", "fmdoc-workflow-input-shell");
        shell.appendChild(h("span", null, cleanText(cfg.currency_symbol) || "$"));
        shell.appendChild(input);
        control.appendChild(shell);
      } else control.appendChild(input);
    }
    wrap.appendChild(control);
  }

  function renderWorkflowField(el, ctx, interactive) {
    clearEl(el);
    const cfg = ctx.config || {};
    const wrap = h("div", "fmdoc-workflow-field" + (cfg.disabled === true ? " fmdoc-workflow-field--disabled" : ""));
    const label = h("div", "fmdoc-workflow-field-label");
    label.appendChild(document.createTextNode(cleanText(cfg.label) || "Field"));
    if (cfg.required && cfg.disabled !== true) label.appendChild(h("b", null, "*"));
    wrap.appendChild(label);
    if (cleanText(cfg.description)) wrap.appendChild(h("div", "fmdoc-workflow-field-description", cleanText(cfg.description)));
    workflowFieldControl(wrap, ctx, interactive);
    if (cfg.disabled === true) wrap.appendChild(h("div", "fmdoc-workflow-disabled-note", cleanText(cfg.disabled_reason) || "This field is disabled for this organization."));
    el.appendChild(wrap);
  }

  register({
    id: "doc.workflow_field",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_b65ed0ad49cd73","Workflow field") ?? "Workflow field"),
    icon: "fa-list-check",
    category: "input",
    defaults: { config: { kind: "text", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_a20b1dbdbc6449","Field") ?? "Field"), description: "", writes: "", placeholder: "", required: false, options: [], choice_style: "tiles", when: "", transition: "fade" }, frame: { w: 260, h: 82 } },
    configPanel: [
      { key: "label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" },
      { key: "description", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_aa136ecb65672f","Description") ?? "Description"), kind: "textarea", placeholder: (globalThis.PlatformLanguage?.text("doc-widgets","m_4c36d4672bb9ed","Helpful context shown below the title") ?? "Helpful context shown below the title") },
      { key: "kind", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8802aaa05aaa4a","Variable type") ?? "Variable type"), kind: "select", options: WORKFLOW_FIELD_KINDS },
      { key: "writes", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_0ee9789116b880","Output variable") ?? "Output variable"), kind: "text" },
      { key: "placeholder", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_028e61f841ce75","Placeholder") ?? "Placeholder"), kind: "text" },
      { key: "required", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_db97f048cd99aa","Required") ?? "Required"), kind: "toggle" },
      { key: "choice_style", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_83020a34a0e9f2","Choice layout") ?? "Choice layout"), kind: "select", options: ["tiles", "radio", "dropdown"], when: { key: "kind", in: ["select", "multi_select", "choice_group"] } },
      { key: "options", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_627546e4279386","Choices") ?? "Choices"), kind: "list", itemLabel: "Choice", itemFields: [
        { key: "label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9fd79f4276d659","Label") ?? "Label"), kind: "text", placeholder: (globalThis.PlatformLanguage?.text("doc-widgets","m_25e13201551ca4","Choice label") ?? "Choice label") },
        { key: "value", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_bdbba2cffe168c","Output value") ?? "Output value"), kind: "text", placeholder: (globalThis.PlatformLanguage?.text("doc-widgets","m_5264d36c59e39d","choice_value") ?? "choice_value") },
        { key: "icon", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_3e4ee0ace818e7","Icon") ?? "Icon"), kind: "text", placeholder: (globalThis.PlatformLanguage?.text("doc-widgets","m_eee88da9d99df7","fa-circle") ?? "fa-circle") }
      ], when: { key: "kind", in: ["select", "multi_select", "choice_group"] } },
      { key: "when", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_386f0bf7477d03","Show when") ?? "Show when"), kind: "text" },
      { key: "transition", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_db0640bcb0df97","Entrance") ?? "Entrance"), kind: "select", options: ["fade", "grow", "slide", "none"] }
    ],
    renderStatic(el, ctx) { renderWorkflowField(el, ctx, false); },
    renderInteractive(el, ctx) { renderWorkflowField(el, ctx, true); return {}; }
  });

  // ---------------------------------------------------------------------------
  // doc.form_field
  // ---------------------------------------------------------------------------

  const FORM_FIELD_KINDS = ["text", "textarea", "number", "currency", "date", "select", "boolean", "address", "email", "phone"];

  /** Accepts both `kind` and the contract's `field_type` (checkbox == boolean). */
  function formFieldKind(cfg) {
    const raw = cleanText(cfg.kind || cfg.field_type).toLowerCase();
    if (raw === "checkbox") return "boolean";
    return FORM_FIELD_KINDS.includes(raw) ? raw : "text";
  }
  const ADDRESS_SUBFIELDS = [
    { key: "street", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_1027ce0860a411","Street") ?? "Street"), span: 2 },
    { key: "unit", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_4b91b73dae1ff3","Unit") ?? "Unit"), span: 1 },
    { key: "city", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_38e1463e6f0488","City") ?? "City"), span: 1 },
    { key: "state", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_96ca5a6ea0866c","State") ?? "State"), span: 1 },
    { key: "zip", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_1f9e736cde3bde","ZIP") ?? "ZIP"), span: 1 }
  ];

  /** Output key holding the merged form-values object (contract: form_values). */
  function formOutputKey(ctx) {
    return cleanText((ctx.config || {}).output_key) || "form_values";
  }

  /** This field's name inside the merged form-values object. */
  function formFieldKey(ctx) {
    const cfg = ctx.config || {};
    return cleanText(cfg.key || cfg.name) || (ctx.node && ctx.node.id) || "field";
  }

  function formFieldValue(ctx) {
    const key = formFieldKey(ctx);
    const formValues = currentOutput(ctx, formOutputKey(ctx)) || {};
    if (isObject(formValues) && formValues[key] !== undefined) return formValues[key];
    const cfg = ctx.config || {};
    if (cfg.value !== undefined && cfg.value !== null && cfg.value !== "") return cfg.value;
    if (ctx.data && ctx.data.value !== undefined) return ctx.data.value;
    return null;
  }

  function submitFormField(ctx, value) {
    const outputKey = formOutputKey(ctx);
    const key = formFieldKey(ctx);
    const existing = currentOutput(ctx, outputKey);
    const merged = Object.assign({}, isObject(existing) ? existing : {});
    merged[key] = value;
    if (ctx.outputs) ctx.outputs[outputKey] = merged;
    ctx.submitOutput(outputKey, merged);
  }

  function formFieldDisplayText(ctx, value) {
    const cfg = ctx.config || {};
    if (value === null || value === undefined || value === "") return "";
    switch (formFieldKind(cfg)) {
      case "currency":
        return money(value);
      case "boolean":
        return value ? "Yes" : "No";
      case "date":
        return fmtDate(value);
      case "address": {
        if (!isObject(value)) return String(value);
        const line1 = [value.street, value.unit].filter(Boolean).join(" ");
        const line2 = [value.city, value.state, value.zip].filter(Boolean).join(", ");
        return [line1, line2].filter(Boolean).join("\n");
      }
      default:
        return String(value);
    }
  }

  register({
    id: "doc.form_field",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_c36703572c57eb","Form field") ?? "Form field"),
    icon: "fa-input-text",
    category: "input",
    defaults: { config: { kind: "text", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_a20b1dbdbc6449","Field") ?? "Field"), key: "", placeholder: "", required: false, options: [], output_key: "form_values" }, frame: { w: 240, h: 56 } },
    configPanel: [
      { key: "kind", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_d71bdb1b5e587a","Field type") ?? "Field type"), kind: "select", options: FORM_FIELD_KINDS },
      { key: "label", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9fd79f4276d659","Label") ?? "Label"), kind: "text" },
      { key: "key", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_e41c9b6634e3aa","Field name") ?? "Field name"), kind: "text" },
      { key: "placeholder", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_028e61f841ce75","Placeholder") ?? "Placeholder"), kind: "text" },
      { key: "required", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_db97f048cd99aa","Required") ?? "Required"), kind: "toggle" },
      { key: "options", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_60e80621d8a281","Options") ?? "Options"), kind: "list", when: { key: "kind", equals: "select" } },
      { key: "output_key", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8ca76efd08d74f","Output key") ?? "Output key"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const wrap = h("div", "fmdoc-form-field");
      // Same label text as renderInteractive (the old || precedence dropped
      // the required marker whenever a label was set — a mode parity gap).
      wrap.appendChild(h("div", "fmdoc-field-label", (cleanText(cfg.label) || "Field") + (cfg.required ? " *" : "")));
      const value = formFieldValue(ctx);
      const text = formFieldDisplayText(ctx, value);
      if (text) {
        const display = h("div", "fmdoc-form-field-value");
        display.style.whiteSpace = "pre-line";
        display.textContent = text;
        wrap.appendChild(display);
      } else {
        wrap.appendChild(h("div", "fmdoc-blank-rule"));
      }
      el.appendChild(wrap);
    },
    renderInteractive(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const kind = formFieldKind(cfg);
      const wrap = h("div", "fmdoc-form-field");
      const label = h("label", "fmdoc-field-label", (cleanText(cfg.label) || "Field") + (cfg.required ? " *" : ""));
      wrap.appendChild(label);
      const value = formFieldValue(ctx);

      if (kind === "address") {
        const grid = h("div", "fmdoc-address-grid");
        const current = isObject(value) ? Object.assign({}, value) : {};
        for (const sub of ADDRESS_SUBFIELDS) {
          const input = document.createElement("input");
          input.type = "text";
          input.className = "fmdoc-input";
          input.placeholder = sub.label;
          input.style.gridColumn = "span " + sub.span;
          input.value = current[sub.key] === undefined || current[sub.key] === null ? "" : String(current[sub.key]);
          input.addEventListener("change", () => {
            current[sub.key] = input.value;
            submitFormField(ctx, Object.assign({}, current));
          });
          grid.appendChild(input);
        }
        wrap.appendChild(grid);
      } else if (kind === "select") {
        const select = document.createElement("select");
        select.className = "fmdoc-input";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = cleanText(cfg.placeholder) || "Select…";
        select.appendChild(blank);
        for (const option of cfg.options || []) {
          const opt = document.createElement("option");
          opt.value = isObject(option) ? String(option.value) : String(option);
          opt.textContent = isObject(option) ? String(option.label || option.value) : String(option);
          select.appendChild(opt);
        }
        if (value !== null && value !== undefined) select.value = String(value);
        select.addEventListener("change", () => submitFormField(ctx, select.value));
        wrap.appendChild(select);
      } else if (kind === "boolean") {
        const row = h("label", "fmdoc-check-row");
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = !!value;
        input.addEventListener("change", () => submitFormField(ctx, input.checked));
        row.appendChild(input);
        row.appendChild(h("span", null, cleanText(cfg.placeholder) || "Yes"));
        wrap.appendChild(row);
      } else if (kind === "textarea") {
        const input = document.createElement("textarea");
        input.className = "fmdoc-input fmdoc-input--textarea";
        input.rows = Number(cfg.rows) || 3;
        input.placeholder = cleanText(cfg.placeholder);
        if (value !== null && value !== undefined) input.value = String(value);
        input.addEventListener("change", () => submitFormField(ctx, input.value));
        wrap.appendChild(input);
      } else {
        const input = document.createElement("input");
        input.className = "fmdoc-input";
        input.placeholder = cleanText(cfg.placeholder);
        if (kind === "number") input.type = "number";
        else if (kind === "currency") {
          input.type = "number";
          input.step = "0.01";
          input.min = "0";
        } else if (kind === "date") input.type = "date";
        else if (kind === "email") input.type = "email";
        else if (kind === "phone") input.type = "tel";
        else input.type = "text";
        if (value !== null && value !== undefined) {
          input.value = kind === "currency" ? String((Number(value) || 0) / 100) : String(value);
        }
        input.addEventListener("change", () => {
          if (kind === "currency") submitFormField(ctx, Math.round((parseFloat(input.value) || 0) * 100));
          else if (kind === "number") submitFormField(ctx, input.value === "" ? null : Number(input.value));
          else submitFormField(ctx, input.value);
        });
        wrap.appendChild(input);
      }
      el.appendChild(wrap);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.choice_group
  // ---------------------------------------------------------------------------

  function choiceOptions(ctx) {
    const cfg = ctx.config || {};
    if (Array.isArray(cfg.options) && cfg.options.length) return cfg.options;
    if (ctx.data && Array.isArray(ctx.data.options)) return ctx.data.options;
    return null;
  }

  function renderChoiceGroup(el, ctx, interactive) {
    clearEl(el);
    const cfg = ctx.config || {};
    const options = choiceOptions(ctx);
    if (!options) {
      placeholderBox(el, "Choice group", "Add options in the widget settings.");
      return;
    }
    const key = cleanText(cfg.output_key) || "selected_option";
    const optionIdOf = (option, index) => (isObject(option) ? String(option.id !== undefined ? option.id : index) : String(option));
    let selected = currentOutput(ctx, key);
    if (isObject(selected)) selected = selected.option_id;
    if ((selected === null || selected === undefined) && ctx.data && ctx.data.selected !== undefined) selected = ctx.data.selected;
    if (selected === null || selected === undefined) {
      const flaggedIndex = options.findIndex((option) => isObject(option) && option.selected === true);
      selected = options.length ? optionIdOf(options[flaggedIndex === -1 ? 0 : flaggedIndex], flaggedIndex === -1 ? 0 : flaggedIndex) : null;
    }
    const wrap = h("div", "fmdoc-choice-group");
    if (cleanText(cfg.title)) wrap.appendChild(h("div", "fmdoc-widget-title", cfg.title));
    const grid = h("div", "fmdoc-choice-grid");
    wrap.appendChild(grid);
    const cards = [];
    options.forEach((option, index) => {
      const optionId = isObject(option) ? String(option.id !== undefined ? option.id : index) : String(option);
      const optionLabel = isObject(option) ? cleanText(option.label || option.name) || optionId : String(option);
      const card = h("div", "fmdoc-choice-card" + (String(selected) === optionId ? " fmdoc-choice-card--selected" : ""));
      card.setAttribute("data-choice-id", optionId);
      const mediaRef = isObject(option) ? option.media : null;
      if (mediaRef) {
        const src = mediaUrlFor(ctx, mediaRef, "thumb");
        if (src) {
          const img = document.createElement("img");
          img.className = "fmdoc-choice-media";
          img.src = src;
          img.alt = optionLabel;
          card.appendChild(img);
        }
      }
      card.appendChild(h("div", "fmdoc-choice-label", optionLabel));
      if (isObject(option) && cleanText(option.description)) card.appendChild(h("div", "fmdoc-choice-desc", option.description));
      if (isObject(option) && option.price_cents !== undefined && option.price_cents !== null) {
        card.appendChild(h("div", "fmdoc-choice-price", money(option.price_cents)));
      }
      if (interactive) {
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        const pick = () => {
          selected = optionId;
          for (const other of cards) other.classList.toggle("fmdoc-choice-card--selected", other === card);
          const value = { option_id: optionId };
          if (ctx.outputs) ctx.outputs[key] = value;
          ctx.submitOutput(key, value);
        };
        card.addEventListener("click", pick);
        card.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            pick();
          }
        });
      }
      cards.push(card);
      grid.appendChild(card);
    });
    el.appendChild(wrap);
  }

  register({
    id: "doc.choice_group",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_ccac715ebf9703","Choice group") ?? "Choice group"),
    icon: "fa-object-group",
    category: "input",
    defaults: { config: { title: "", options: [], output_key: "selected_option" }, frame: { w: 540, h: 160 } },
    configPanel: [
      { key: "title", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" },
      { key: "output_key", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8ca76efd08d74f","Output key") ?? "Output key"), kind: "text" },
      { key: "options", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_60e80621d8a281","Options") ?? "Options"), kind: "list" }
    ],
    renderStatic(el, ctx) {
      renderChoiceGroup(el, ctx, false);
    },
    renderInteractive(el, ctx) {
      renderChoiceGroup(el, ctx, true);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.qr
  // ---------------------------------------------------------------------------

  register({
    id: "doc.qr",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_5c189cf2882b63","QR code") ?? "QR code"),
    icon: "fa-qrcode",
    category: "layout",
    defaults: { config: { url: "", color: "#111111", caption: "" }, frame: { w: 96, h: 96 } },
    configPanel: [
      { key: "url", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_3c6be3393af8bd","URL / payload") ?? "URL / payload"), kind: "text" },
      { key: "color", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_db7002926d9977","Color") ?? "Color"), kind: "color" },
      { key: "caption", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const payload = cleanText(((ctx.api || {}).portalUrl) || cfg.url || (ctx.data && ctx.data.url));
      if (!payload) {
        placeholderBox(el, "QR code", "Set a URL, or the document's portal link fills in automatically.");
        return;
      }
      const svgMarkup = QR.svg(payload, { color: cfg.color || "#111111" });
      if (!svgMarkup) {
        placeholderBox(el, "QR code", "Payload too long to encode (max ~213 characters).");
        return;
      }
      const wrap = h("div", "fmdoc-qr");
      wrap.innerHTML = svgMarkup;
      if (cleanText(cfg.caption)) wrap.appendChild(h("div", "fmdoc-qr-caption", cfg.caption));
      el.appendChild(wrap);
    }
  });

  // ---------------------------------------------------------------------------
  // doc.photo
  // ---------------------------------------------------------------------------

  function markupItemsFrom(source) {
    if (!source) return [];
    if (Array.isArray(source)) return source;
    if (Array.isArray(source.items)) return source.items;
    return [];
  }

  function renderPhotoStatic(el, ctx) {
    clearEl(el);
    const cfg = ctx.config || {};
    const media = cfg.media || (ctx.data && ctx.data.media) || null;
    const src = mediaUrlFor(ctx, media);
    if (!src) {
      placeholderBox(el, "Photo", "Choose a photo from the project media library.");
      return null;
    }
    const wrap = h("figure", "fmdoc-photo");
    const frame = h("div", "fmdoc-photo-frame");
    const img = document.createElement("img");
    img.className = "fmdoc-photo-image";
    img.src = src;
    img.alt = cleanText(cfg.caption) || "Photo";
    img.style.objectFit = cfg.fit || "cover";
    frame.appendChild(img);
    const items = markupItemsFrom(cfg.markup || (ctx.data && ctx.data.markup));
    if (items.length) {
      const overlay = markupOverlayElement(items);
      if (overlay) frame.appendChild(overlay);
    }
    wrap.appendChild(frame);
    if (cleanText(cfg.caption)) wrap.appendChild(h("figcaption", "fmdoc-photo-caption", cfg.caption));
    el.appendChild(wrap);
    return { wrap, src, media };
  }

  register({
    id: "doc.photo",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_9aa4740fd235ab","Photo") ?? "Photo"),
    icon: "fa-image",
    category: "media",
    defaults: { config: { media: null, caption: "", fit: "cover" }, frame: { w: 260, h: 200 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9aa4740fd235ab","Photo") ?? "Photo"), kind: "media" },
      { key: "caption", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" },
      { key: "fit", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2d8510904d5879","Fit") ?? "Fit"), kind: "select", options: ["cover", "contain", "fill"] }
    ],
    renderStatic(el, ctx) {
      renderPhotoStatic(el, ctx);
    },
    renderInteractive(el, ctx) {
      const built = renderPhotoStatic(el, ctx);
      if (!built) return {};
      // Open the shared media viewer when one is loaded; otherwise no-op.
      const markup = root ? root.FirstMateMarkup : null;
      if (markup && typeof markup.openMediaViewer === "function") {
        built.wrap.classList.add("fmdoc-photo--clickable");
        built.wrap.style.cursor = "zoom-in";
        built.wrap.addEventListener("click", () => {
          try {
            const cfg = ctx.config || {};
            const photo = isObject(built.media) ? Object.assign({}, built.media, { url: built.src }) : { url: built.src };
            if (cleanText(cfg.caption)) photo.caption = cleanText(cfg.caption);
            markup.openMediaViewer({ photos: [photo], index: 0 });
          } catch (error) {
            /* viewer refused — leave the inline photo as-is */
          }
        });
      }
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.photo_grid
  // ---------------------------------------------------------------------------

  register({
    id: "doc.photo_grid",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_5b1656517184ff","Photo grid") ?? "Photo grid"),
    icon: "fa-table-cells",
    category: "media",
    defaults: { config: { media: [], columns: 3, captions: true }, frame: { w: 540, h: 260 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_be4cfb58b9c4d7","Photos") ?? "Photos"), kind: "list" },
      { key: "columns", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8abb9612e904f8","Columns") ?? "Columns"), kind: "number", min: 1, max: 6 },
      { key: "captions", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9d00dd40ea69a0","Show captions") ?? "Show captions"), kind: "toggle" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      let entries = Array.isArray(cfg.media) && cfg.media.length ? cfg.media : ctx.data && Array.isArray(ctx.data.media) ? ctx.data.media : null;
      if (!entries || !entries.length) {
        placeholderBox(el, "Photo grid", "Choose photos, or bind project media to this widget.");
        return;
      }
      const grid = h("div", "fmdoc-photo-grid");
      grid.style.gridTemplateColumns = "repeat(" + (Math.max(1, Math.min(6, Number(cfg.columns) || 3))) + ", 1fr)";
      for (const entry of entries) {
        const src = mediaUrlFor(ctx, entry, isObject(entry) ? entry.variant || "thumb" : null);
        if (!src) continue;
        const cell = h("figure", "fmdoc-photo-grid-cell");
        cell.setAttribute("data-fmdoc-row", "true");
        const img = document.createElement("img");
        img.src = src;
        img.alt = (isObject(entry) && cleanText(entry.caption || entry.label)) || "Photo";
        cell.appendChild(img);
        const caption = isObject(entry) ? cleanText(entry.caption || entry.label) : "";
        if (cfg.captions !== false && caption) cell.appendChild(h("figcaption", "fmdoc-photo-caption", caption));
        grid.appendChild(cell);
      }
      el.appendChild(grid);
    }
  });

  // ---------------------------------------------------------------------------
  // doc.page_number — resolved by the renderer during pagination: the widget
  // renders a [data-fmdoc-page-number] placeholder; after page assembly the
  // renderer fills it with the format string ({page}/{pages} tokens).
  // ---------------------------------------------------------------------------

  register({
    id: "doc.page_number",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_133adbaec70f84","Page number") ?? "Page number"),
    icon: "fa-hashtag",
    category: "layout",
    defaults: { config: { format: "Page {page} of {pages}" }, frame: { w: 120, h: 20 } },
    configPanel: [{ key: "format", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_cdf11b397d38fc","Format") ?? "Format"), kind: "text" }],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const format = cleanText(cfg.format) || "Page {page} of {pages}";
      const span = h("span", "fmdoc-page-number", "");
      span.setAttribute("data-fmdoc-page-number", "true");
      span.setAttribute("data-fmdoc-page-format", format);
      // Resolve immediately from the DOM position of the closest page among
      // its .fmdoc-page siblings; the renderer's pagination pass re-fills the
      // placeholder after continuation pages are cloned.
      let page = 1;
      let pages = 1;
      try {
        const pageEl = el.closest ? el.closest(".fmdoc-page") : null;
        if (pageEl && pageEl.parentElement) {
          const siblings = Array.prototype.filter.call(pageEl.parentElement.children, (node) => node.classList && node.classList.contains("fmdoc-page"));
          const index = siblings.indexOf(pageEl);
          if (index !== -1) {
            page = index + 1;
            pages = siblings.length;
          }
        }
      } catch (error) {
        /* detached render — keep the 1 of 1 fallback */
      }
      span.textContent = format.replace(/\{page\}/g, String(page)).replace(/\{pages\}/g, String(pages));
      el.appendChild(span);
    }
  });

  // ---------------------------------------------------------------------------
  // doc.audio
  // ---------------------------------------------------------------------------

  register({
    id: "doc.audio",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_c28ec04f0667fb","Audio") ?? "Audio"),
    icon: "fa-volume-high",
    category: "media",
    defaults: { config: { media: null, url: "", title: (globalThis.PlatformLanguage?.text("doc-widgets","m_c28ec04f0667fb","Audio") ?? "Audio") }, frame: { w: 400, h: 54 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_fee8c65475aa16","Uploaded audio") ?? "Uploaded audio"), kind: "media", accept: "audio/*", mediaKind: "audio" },
      { key: "url", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_6c0a3c9ead4688","External audio URL") ?? "External audio URL"), kind: "text" },
      { key: "title", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const url = mediaUrlFor(ctx, cfg.media || (ctx.data && ctx.data.media)) || cleanText(cfg.url);
      const wrap = h("div", "fmdoc-audio");
      wrap.appendChild(h("strong", "fmdoc-audio-title", cleanText(cfg.title) || "Audio"));
      if (url) wrap.appendChild(h("div", "fmdoc-audio-url", url));
      el.appendChild(wrap);
    },
    renderInteractive(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const url = mediaUrlFor(ctx, cfg.media || (ctx.data && ctx.data.media)) || cleanText(cfg.url);
      const wrap = h("div", "fmdoc-audio");
      if (cleanText(cfg.title)) wrap.appendChild(h("strong", "fmdoc-audio-title", cfg.title));
      if (url) { const audio = document.createElement("audio"); audio.controls = true; audio.preload = "metadata"; audio.src = url; wrap.appendChild(audio); }
      el.appendChild(wrap);
    }
  });

  // ---------------------------------------------------------------------------
  // doc.photo_carousel — interactive in digital documents; the first slide is
  // used as the deterministic print/PDF representation.
  // ---------------------------------------------------------------------------

  function photoCarouselEntries(ctx) {
    const cfg = ctx.config || {};
    const source = Array.isArray(cfg.media) && cfg.media.length
      ? cfg.media
      : ctx.data && Array.isArray(ctx.data.media) ? ctx.data.media : [];
    return source.map((entry) => ({
      source: entry,
      src: mediaUrlFor(ctx, entry, isObject(entry) ? entry.variant || "original" : null),
      caption: isObject(entry) ? cleanText(entry.caption || entry.label) : ""
    })).filter((entry) => entry.src);
  }

  function buildPhotoCarousel(el, ctx, interactive) {
    clearEl(el);
    const cfg = ctx.config || {};
    const entries = photoCarouselEntries(ctx);
    if (!entries.length) {
      placeholderBox(el, "Photo carousel", "Choose two or more photos for this carousel.");
      return null;
    }

    const wrap = h("div", "fmdoc-photo-carousel");
    const stage = h("div", "fmdoc-photo-carousel-stage");
    const img = document.createElement("img");
    img.className = "fmdoc-photo-carousel-image";
    img.style.objectFit = cfg.fit || "cover";
    const caption = h("div", "fmdoc-photo-carousel-caption");
    const count = h("div", "fmdoc-photo-carousel-count");
    stage.appendChild(img);
    wrap.appendChild(stage);
    wrap.appendChild(caption);
    if (entries.length > 1) wrap.appendChild(count);
    el.appendChild(wrap);

    let index = 0;
    let timer = null;
    const dots = [];
    function show(nextIndex) {
      index = (nextIndex + entries.length) % entries.length;
      const entry = entries[index];
      img.src = entry.src;
      img.alt = entry.caption || "Photo " + (index + 1);
      caption.textContent = cfg.captions === false ? "" : entry.caption;
      caption.style.display = caption.textContent ? "block" : "none";
      count.textContent = (index + 1) + " / " + entries.length;
      dots.forEach((dot, dotIndex) => dot.setAttribute("aria-current", dotIndex === index ? "true" : "false"));
    }
    function stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function start() {
      stop();
      if (!interactive || cfg.autoplay === false || entries.length < 2) return;
      const interval = Math.max(1500, Math.min(15000, Number(cfg.interval_ms) || 4000));
      timer = setInterval(() => show(index + 1), interval);
    }

    if (interactive && entries.length > 1) {
      const controls = h("div", "fmdoc-photo-carousel-controls");
      const previous = h("button", "fmdoc-photo-carousel-button", "‹");
      previous.type = "button";
      previous.setAttribute("aria-label", (globalThis.PlatformLanguage?.text("doc-widgets","m_ff93a3105bd290","Previous photo") ?? "Previous photo"));
      const next = h("button", "fmdoc-photo-carousel-button", "›");
      next.type = "button";
      next.setAttribute("aria-label", (globalThis.PlatformLanguage?.text("doc-widgets","m_289ae0bcddeebf","Next photo") ?? "Next photo"));
      previous.addEventListener("click", () => { show(index - 1); start(); });
      next.addEventListener("click", () => { show(index + 1); start(); });
      controls.appendChild(previous);
      controls.appendChild(next);
      wrap.appendChild(controls);

      const dotsWrap = h("div", "fmdoc-photo-carousel-dots");
      entries.forEach((entry, dotIndex) => {
        const dot = h("button", "fmdoc-photo-carousel-dot");
        dot.type = "button";
        dot.setAttribute("aria-label", "Show photo " + (dotIndex + 1));
        dot.addEventListener("click", () => { show(dotIndex); start(); });
        dots.push(dot);
        dotsWrap.appendChild(dot);
      });
      wrap.appendChild(dotsWrap);
    }

    show(0);
    start();
    return { destroy: stop };
  }

  register({
    id: "doc.photo_carousel",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_6a61d35fd9efa3","Photo carousel") ?? "Photo carousel"),
    icon: "fa-panorama",
    category: "media",
    defaults: { config: { media: [], captions: true, autoplay: true, interval_ms: 4000, fit: "cover" }, frame: { w: 540, h: 300 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_be4cfb58b9c4d7","Photos") ?? "Photos"), kind: "list" },
      { key: "captions", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_9d00dd40ea69a0","Show captions") ?? "Show captions"), kind: "toggle" },
      { key: "autoplay", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_ff054a0818bbae","Auto-advance") ?? "Auto-advance"), kind: "toggle" },
      { key: "interval_ms", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8d46795509ca07","Advance every (ms)") ?? "Advance every (ms)"), kind: "number", min: 1500, max: 15000 },
      { key: "fit", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2d8510904d5879","Fit") ?? "Fit"), kind: "select", options: ["cover", "contain", "fill"] }
    ],
    renderStatic(el, ctx) {
      buildPhotoCarousel(el, ctx, false);
    },
    renderInteractive(el, ctx) {
      return buildPhotoCarousel(el, ctx, true) || {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.video
  // ---------------------------------------------------------------------------

  register({
    id: "doc.video",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_254c9a073d4804","Video") ?? "Video"),
    icon: "fa-circle-play",
    category: "media",
    defaults: { config: { media: null, url: "", poster: null, caption: "" }, frame: { w: 400, h: 225 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_82219b3eb06e11","Uploaded video") ?? "Uploaded video"), kind: "media", accept: "video/*", mediaKind: "video" },
      { key: "url", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2aff31a3fd51ba","External video URL") ?? "External video URL"), kind: "text" },
      { key: "poster", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_6d9dddcb3617dc","Poster image") ?? "Poster image"), kind: "media" },
      { key: "caption", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      // Print fallback: poster frame with a play glyph and the URL as caption.
      clearEl(el);
      const cfg = ctx.config || {};
      const url = mediaUrlFor(ctx, cfg.media || (ctx.data && ctx.data.media)) || cleanText(cfg.url || (ctx.data && ctx.data.url));
      const wrap = h("div", "fmdoc-video fmdoc-video--static");
      const frame = h("div", "fmdoc-video-frame");
      const posterSrc = mediaUrlFor(ctx, cfg.poster || (ctx.data && ctx.data.poster));
      if (posterSrc) {
        const img = document.createElement("img");
        img.className = "fmdoc-video-poster";
        img.src = posterSrc;
        img.alt = cleanText(cfg.caption) || "Video";
        frame.appendChild(img);
      }
      const glyph = h("div", "fmdoc-video-glyph");
      glyph.innerHTML = '<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="rgba(17,24,39,.72)"/><path d="M19 15l16 9-16 9z" fill="#fff"/></svg>';
      frame.appendChild(glyph);
      wrap.appendChild(frame);
      if (url) wrap.appendChild(h("div", "fmdoc-video-url", "Watch online: " + url));
      if (cleanText(cfg.caption)) wrap.appendChild(h("div", "fmdoc-photo-caption", cfg.caption));
      el.appendChild(wrap);
    },
    renderInteractive(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const url = mediaUrlFor(ctx, cfg.media || (ctx.data && ctx.data.media)) || cleanText(cfg.url || (ctx.data && ctx.data.url));
      if (!url) {
        if (ctx.preview === true) {
          // Keep the actual page composition visible before a video has been
          // chosen. Selecting/uploading media replaces this frame with the
          // real interactive player in the same canvas position.
          const wrap = h("div", "fmdoc-video fmdoc-video--static");
          const frame = h("div", "fmdoc-video-frame");
          const glyph = h("div", "fmdoc-video-glyph");
          glyph.innerHTML = '<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="22" fill="rgba(17,24,39,.72)"/><path d="M19 15l16 9-16 9z" fill="#fff"/></svg>';
          frame.appendChild(glyph);
          wrap.appendChild(frame);
          if (cleanText(cfg.caption)) wrap.appendChild(h("div", "fmdoc-photo-caption", cfg.caption));
          el.appendChild(wrap);
          return {};
        }
        placeholderBox(el, "Video", "Upload a video or set an external URL in the widget settings.");
        return {};
      }
      const wrap = h("div", "fmdoc-video");
      const video = document.createElement("video");
      video.className = "fmdoc-video-player";
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      const posterSrc = mediaUrlFor(ctx, cfg.poster || (ctx.data && ctx.data.poster));
      if (posterSrc) video.poster = posterSrc;
      wrap.appendChild(video);
      if (cleanText(cfg.caption)) wrap.appendChild(h("div", "fmdoc-photo-caption", cfg.caption));
      el.appendChild(wrap);
      return {
        destroy() {
          try {
            video.pause();
          } catch (error) {
            /* noop */
          }
        }
      };
    }
  });

  // ---------------------------------------------------------------------------
  // doc.media_popup — thumbnail chip that opens the shared lightbox (spec
  // §10.1 display:"popup"). Static/print: inline thumbnail + caption; a video
  // renders as a poster-style box with the URL printed underneath.
  // ---------------------------------------------------------------------------

  function mediaPopupParts(ctx) {
    const cfg = ctx.config || {};
    const media = cfg.media || (ctx.data && ctx.data.media) || null;
    const rawVideo = cfg.video || cfg.video_url || (ctx.data && ctx.data.video) || null;
    const video = isObject(rawVideo) ? (cleanText(rawVideo.url) ? rawVideo : null) : cleanText(rawVideo) ? { url: cleanText(rawVideo) } : null;
    const size = Math.max(24, Math.min(240, Number(cfg.thumb_size_pt) || 64));
    return { media, video, caption: cleanText(cfg.caption), size };
  }

  function renderMediaPopupThumb(el, ctx, interactive) {
    clearEl(el);
    const { media, video, caption, size } = mediaPopupParts(ctx);
    const src = media ? mediaUrlFor(ctx, media, isObject(media) ? media.variant || "thumb" : null) : "";
    if (!src && !video) {
      placeholderBox(el, "Media popup", "Choose an image or set a video URL in the widget settings.");
      return null;
    }
    const wrap = h("figure", "fmdoc-media-popup" + (interactive ? " fmdoc-media-popup--interactive" : ""));
    const thumb = h("div", "fmdoc-media-popup-thumb" + (src ? "" : " fmdoc-media-popup-video"));
    thumb.style.width = size + "pt";
    thumb.style.height = Math.round(size * 0.75) + "pt";
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = caption || "Media";
      thumb.appendChild(img);
      const glyph = h("span", "fmdoc-media-chip-glyph");
      glyph.innerHTML = video ? PLAY_GLYPH : ZOOM_GLYPH;
      thumb.appendChild(glyph);
    } else {
      thumb.innerHTML = PLAY_GLYPH;
    }
    wrap.appendChild(thumb);
    if (caption) wrap.appendChild(h("figcaption", "fmdoc-media-popup-caption", caption));
    if (!interactive && video) wrap.appendChild(h("div", "fmdoc-media-popup-url", "Watch online: " + cleanText(video.url)));
    el.appendChild(wrap);
    return { wrap, thumb, media, video, caption };
  }

  register({
    id: "doc.media_popup",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_6adc4a94780b59","Media popup") ?? "Media popup"),
    icon: "fa-magnifying-glass-plus",
    category: "media",
    defaults: { config: { media: null, video_url: "", caption: "", thumb_size_pt: 64 }, frame: { w: 96, h: 84 } },
    configPanel: [
      { key: "media", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_54eb8e1b237591","Image") ?? "Image"), kind: "media" },
      { key: "video_url", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_ab0945e21b5b82","Video URL") ?? "Video URL"), kind: "text" },
      { key: "caption", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_8e5d22e5fc5931","Caption") ?? "Caption"), kind: "text" },
      { key: "thumb_size_pt", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_2ac06373633a67","Thumbnail size (pt)") ?? "Thumbnail size (pt)"), kind: "number", min: 24, max: 240 }
    ],
    renderStatic(el, ctx) {
      renderMediaPopupThumb(el, ctx, false);
    },
    renderInteractive(el, ctx) {
      const built = renderMediaPopupThumb(el, ctx, true);
      if (!built) return {};
      built.thumb.setAttribute("data-fmdoc-media-popup", mediaPopupAttrValue(ctx, {
        media: built.media,
        video: built.video,
        caption: built.caption
      }));
      built.thumb.setAttribute("role", "button");
      built.thumb.tabIndex = 0;
      built.thumb.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          built.thumb.click();
        }
      });
      installLightboxDelegate(el.ownerDocument);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.layers_diagram — the sample interactive plugin (tiers spec §10.2).
  // Exploded roof-layers diagram drawn as stacked offset parallelogram slabs
  // (pure SVG, no images). Interactive: hover/tap highlights a layer and shows
  // its blurb in a side panel. Static/print: the same stacked diagram with a
  // numbered legend. Orgs configure data (layer list), never code.
  // ---------------------------------------------------------------------------

  const DEFAULT_ROOF_LAYERS = [
    { name: "Architectural shingles", blurb: "The visible weather surface — dimensional asphalt shingles rated for high wind and algae resistance.", color: "#8B3A2E", thickness_pt: 10 },
    { name: "Ridge vent", blurb: "Continuous exhaust ventilation along the peak lets hot, moist attic air escape through the shingle cap.", color: "#4A5568", thickness_pt: 8 },
    { name: "Synthetic underlayment", blurb: "A tear-resistant secondary moisture barrier between the shingles and the deck.", color: "#94A3B8", thickness_pt: 6 },
    { name: "Ice & water shield", blurb: "Self-sealing membrane at eaves, valleys, and penetrations that stops ice-dam and wind-driven rain intrusion.", color: "#1F6F8B", thickness_pt: 6 },
    { name: "Roof decking", blurb: "Structural wood sheathing — inspected during tear-off and replaced wherever rot or delamination is found.", color: "#B9874B", thickness_pt: 12 },
    { name: "Attic ventilation", blurb: "Balanced soffit intake keeps the whole system dry and shingle temperatures down, protecting the warranty.", color: "#5B8C5A", thickness_pt: 9 }
  ];

  function shadeHex(hex, factor) {
    const text = cleanText(hex).replace("#", "");
    const full = text.length === 3 ? text.split("").map((c) => c + c).join("") : text;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return hex;
    const channel = (i) => Math.max(0, Math.min(255, Math.round(parseInt(full.slice(i, i + 2), 16) * factor)));
    return "#" + [channel(0), channel(2), channel(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
  }

  function normalizedLayers(cfg) {
    const source = Array.isArray(cfg.layers) && cfg.layers.length ? cfg.layers : DEFAULT_ROOF_LAYERS;
    return source.map((raw, index) => {
      const layer = isObject(raw) ? raw : { name: String(raw) };
      const fallback = DEFAULT_ROOF_LAYERS[index % DEFAULT_ROOF_LAYERS.length];
      return {
        name: cleanText(layer.name || layer.label) || "Layer " + (index + 1),
        blurb: cleanText(layer.blurb || layer.description),
        color: cleanText(layer.color) || fallback.color,
        thickness_pt: Math.max(4, Math.min(26, Number(layer.thickness_pt) || 9))
      };
    });
  }

  /** Stacked offset parallelogram slabs, top layer first. Each slab group
   *  carries data-layer-index for the interactive highlight. */
  function layersDiagramSvg(layers) {
    const SK = 66;      // horizontal skew of the top face
    const D = 42;       // projected depth of the top face
    const W = 190;      // top-face width
    const X0 = 30;      // front-left x (leaves room for the number badges)
    const GAP = 14;     // exploded gap between slabs
    let y = 8;
    const slabs = [];
    layers.forEach((layer, i) => {
      const t = layer.thickness_pt;
      const top = [[X0 + SK, y], [X0 + SK + W, y], [X0 + W, y + D], [X0, y + D]];
      const front = [[X0, y + D], [X0 + W, y + D], [X0 + W, y + D + t], [X0, y + D + t]];
      const side = [[X0 + SK + W, y], [X0 + W, y + D], [X0 + W, y + D + t], [X0 + SK + W, y + t]];
      const pts = (list) => list.map((p) => p[0] + "," + p[1]).join(" ");
      slabs.push(
        '<g class="fmdoc-layers-slab" data-layer-index="' + i + '">' +
        '<polygon points="' + pts(side) + '" fill="' + shadeHex(layer.color, 0.62) + '"/>' +
        '<polygon points="' + pts(front) + '" fill="' + shadeHex(layer.color, 0.78) + '"/>' +
        '<polygon class="fmdoc-layers-top" points="' + pts(top) + '" fill="' + layer.color + '" stroke="rgba(255,255,255,.35)" stroke-width="0.75"/>' +
        '<circle cx="14" cy="' + (y + D * 0.62) + '" r="8" fill="' + shadeHex(layer.color, 0.85) + '"/>' +
        '<text x="14" y="' + (y + D * 0.62 + 3.2) + '" text-anchor="middle" font-size="9" font-weight="800" fill="#fff" font-family="inherit">' + (i + 1) + "</text>" +
        "</g>"
      );
      y += D + t + GAP;
    });
    const width = X0 + SK + W + 8;
    const height = y - GAP + 10;
    // Draw bottom-up so upper slabs overlay lower ones where they meet.
    return '<svg viewBox="0 0 ' + width + " " + height + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Layers diagram">' + slabs.slice().reverse().join("") + "</svg>";
  }

  register({
    id: "doc.layers_diagram",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_17a01bae521a27","Layers diagram") ?? "Layers diagram"),
    icon: "fa-layer-group",
    category: "media",
    defaults: { config: { title: (globalThis.PlatformLanguage?.text("doc-widgets","m_b38d59b6a4de1b","Your new roof system") ?? "Your new roof system"), layers: [] }, frame: { w: 470, h: 320 } },
    configPanel: [
      { key: "title", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" },
      { key: "layers", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_6e959b37df2db3","Layers (top to bottom)") ?? "Layers (top to bottom)"), kind: "list" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const layers = normalizedLayers(cfg);
      const wrap = h("div", "fmdoc-layers-wrap");
      if (cleanText(cfg.title)) wrap.appendChild(h("div", "fmdoc-layers-title", cfg.title));
      const row = h("div", "fmdoc-layers");
      const stage = h("div", "fmdoc-layers-stage");
      stage.innerHTML = layersDiagramSvg(layers);
      row.appendChild(stage);
      const legend = h("ol", "fmdoc-layers-legend");
      layers.forEach((layer, i) => {
        const li = h("li");
        const num = h("span", "fmdoc-layers-legend-num", String(i + 1));
        num.style.background = layer.color;
        li.appendChild(num);
        const copy = h("span");
        copy.appendChild(h("b", null, layer.name));
        if (layer.blurb) copy.appendChild(document.createTextNode(" — " + layer.blurb));
        li.appendChild(copy);
        legend.appendChild(li);
      });
      row.appendChild(legend);
      wrap.appendChild(row);
      el.appendChild(wrap);
    },
    renderInteractive(el, ctx) {
      clearEl(el);
      const cfg = ctx.config || {};
      const layers = normalizedLayers(cfg);
      const wrap = h("div", "fmdoc-layers-wrap fmdoc-layers--interactive");
      if (cleanText(cfg.title)) wrap.appendChild(h("div", "fmdoc-layers-title", cfg.title));
      const row = h("div", "fmdoc-layers");
      const stage = h("div", "fmdoc-layers-stage");
      stage.innerHTML = layersDiagramSvg(layers);
      row.appendChild(stage);
      const panel = h("aside", "fmdoc-layers-panel");
      row.appendChild(panel);
      wrap.appendChild(row);
      el.appendChild(wrap);

      const slabs = Array.prototype.slice.call(stage.querySelectorAll(".fmdoc-layers-slab"));
      const setActive = (index) => {
        const layer = layers[index];
        if (!layer) return;
        for (const slab of slabs) {
          const i = Number(slab.getAttribute("data-layer-index"));
          slab.classList.toggle("fmdoc-layers-slab--active", i === index);
          slab.classList.toggle("fmdoc-layers-slab--dim", i !== index);
        }
        clearEl(panel);
        const kicker = h("div", "fmdoc-layers-panel-kicker");
        const dot = h("span", "fmdoc-layers-panel-dot");
        dot.style.background = layer.color;
        kicker.appendChild(dot);
        kicker.appendChild(document.createTextNode("Layer " + (index + 1) + " of " + layers.length));
        panel.appendChild(kicker);
        panel.appendChild(h("div", "fmdoc-layers-panel-name", layer.name));
        if (layer.blurb) panel.appendChild(h("div", "fmdoc-layers-panel-blurb", layer.blurb));
      };
      for (const slab of slabs) {
        const index = Number(slab.getAttribute("data-layer-index"));
        slab.addEventListener("mouseenter", () => setActive(index));
        slab.addEventListener("click", () => setActive(index));
      }
      setActive(0);
      return {};
    }
  });

  // ---------------------------------------------------------------------------
  // doc.measurement_report — FirstMeasure measurements summary (facets/areas
  // table: name, squares/area, pitch). Generic on purpose: it consumes either
  // server-resolved data or params.measurements in several common shapes.
  // ---------------------------------------------------------------------------

  function measurementSource(ctx) {
    if (ctx.data && (Array.isArray(ctx.data) || isObject(ctx.data))) return ctx.data;
    const cfg = ctx.config || {};
    const m = model();
    const source = cleanText(cfg.source) || "params.measurements";
    const fromScope = m && ctx.scope ? m.getPath(ctx.scope, source) : null;
    return fromScope || null;
  }

  function measurementRows(source) {
    if (!source) return null;
    const list = Array.isArray(source)
      ? source
      : Array.isArray(source.facets)
        ? source.facets
        : Array.isArray(source.areas)
          ? source.areas
          : Array.isArray(source.rows)
            ? source.rows
            : null;
    if (!list || !list.length) return null;
    return list.map((facet, index) => {
      const f = isObject(facet) ? facet : {};
      const squares = f.squares !== undefined && f.squares !== null ? Number(f.squares) : f.area_squares !== undefined && f.area_squares !== null ? Number(f.area_squares) : null;
      const areaSqft = f.area_sqft !== undefined && f.area_sqft !== null ? Number(f.area_sqft) : f.area !== undefined && f.area !== null ? Number(f.area) : null;
      return {
        name: cleanText(f.name || f.label || f.id) || "Facet " + (index + 1),
        squares: Number.isFinite(squares) ? squares : null,
        area_sqft: Number.isFinite(areaSqft) ? areaSqft : null,
        pitch: cleanText(f.pitch !== undefined && f.pitch !== null ? f.pitch : f.slope)
      };
    });
  }

  function measurementAreaText(row) {
    if (row.squares !== null) return (Number.isInteger(row.squares) ? String(row.squares) : row.squares.toFixed(2)) + (row.squares === 1 ? " square" : " squares");
    if (row.area_sqft !== null) return (Number.isInteger(row.area_sqft) ? String(row.area_sqft) : row.area_sqft.toFixed(1)) + " sq ft";
    return "";
  }

  register({
    id: "doc.measurement_report",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_67f0bda289cae3","Measurement report") ?? "Measurement report"),
    icon: "fa-ruler-combined",
    category: "data",
    defaults: { config: { source: "params.measurements", title: (globalThis.PlatformLanguage?.text("doc-widgets","m_cb3256a128471a","Measurement summary") ?? "Measurement summary") }, frame: { w: 540, h: 200 } },
    configPanel: [
      { key: "source", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_bb795b3646f994","Data source") ?? "Data source"), kind: "binding" },
      { key: "title", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_29dbd3d8b69f55","Title") ?? "Title"), kind: "text" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const source = measurementSource(ctx);
      const rows = measurementRows(source);
      if (!rows) {
        placeholderBox(el, "Measurement report", "No measurement data — connect params.measurements from FirstMeasure.");
        return;
      }
      const cfg = ctx.config || {};
      const wrap = h("div", "fmdoc-measure");
      if (cleanText(cfg.title)) wrap.appendChild(h("div", "fmdoc-measure-title", cfg.title));
      const table = h("table", "fmdoc-table");
      const thead = h("thead");
      const headRow = h("tr");
      for (const label of ["Facet", "Area", "Pitch"]) headRow.appendChild(h("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      for (const row of rows) {
        const tr = h("tr");
        tr.setAttribute("data-fmdoc-row", "true");
        tr.appendChild(h("td", null, row.name));
        tr.appendChild(h("td", "fmdoc-li-amount", measurementAreaText(row)));
        tr.appendChild(h("td", null, row.pitch));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      wrap.appendChild(table);
      // Summary line: totals from the payload when present, else a facet sum.
      const totals = (isObject(source) && isObject(source.totals) && source.totals) || {};
      let totalSquares = totals.squares !== undefined && totals.squares !== null ? Number(totals.squares) : isObject(source) && source.total_squares !== undefined && source.total_squares !== null ? Number(source.total_squares) : null;
      if (!Number.isFinite(totalSquares)) {
        totalSquares = rows.every((row) => row.squares !== null) ? rows.reduce((acc, row) => acc + row.squares, 0) : null;
      }
      const predominantPitch = cleanText((isObject(source) && (source.predominant_pitch || totals.predominant_pitch)) || "");
      const bits = [];
      if (totalSquares !== null && Number.isFinite(totalSquares)) bits.push("Total: " + (Math.round(totalSquares * 100) / 100) + " squares");
      if (predominantPitch) bits.push("Predominant pitch: " + predominantPitch);
      if (bits.length) wrap.appendChild(h("div", "fmdoc-measure-summary", bits.join(" · ")));
      el.appendChild(wrap);
    }
  });

  // ---------------------------------------------------------------------------
  // Money report widgets (doc.money_metrics / doc.expense_breakdown /
  // doc.payment_history) — static-only renderers for report documents. Data
  // arrives resolved from the server (documents/widgets/builtins.ts pulls the
  // Money tab's own summaries); these renderers never fetch.
  // ---------------------------------------------------------------------------

  register({
    id: "doc.money_metrics",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_b5afb57a742b76","Money metrics") ?? "Money metrics"),
    icon: "fa-coins",
    category: "reports",
    defaults: { config: {}, frame: { w: 540, h: 150 } },
    configPanel: [
      { key: "keys", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_d2838ea32cd4fd","Metrics") ?? "Metrics"), kind: "list", options: ["contract_value", "change_orders", "collected", "balance", "cost_forecast", "expenses_to_date", "forecast_profit", "profit_to_date"] }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const data = ctx.data || {};
      const metrics = Array.isArray(data.metrics) ? data.metrics : [];
      if (!metrics.length) {
        placeholderBox(el, "Money metrics", "Project financial metrics resolve when the report is generated on a project.");
        return;
      }
      const grid = h("div", "fmdoc-money-metrics");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = "repeat(4, 1fr)";
      grid.style.gap = "8pt";
      for (const metric of metrics) {
        const cell = h("div", "fmdoc-money-metric");
        cell.style.border = "1px solid var(--fm-color-border, #e2e2e2)";
        cell.style.borderRadius = "4pt";
        cell.style.padding = "6pt 8pt";
        const label = h("div", "fmdoc-money-metric-label", cleanText(metric.label) || metric.key);
        label.style.fontSize = "7pt";
        label.style.fontWeight = "800";
        label.style.textTransform = "uppercase";
        label.style.color = "var(--fm-color-muted, #777)";
        const value = h("div", "fmdoc-money-metric-value", money(metric.amount_cents, data.currency));
        value.style.fontSize = "12pt";
        value.style.fontWeight = "800";
        if (metric.key === "forecast_profit" || metric.key === "profit_to_date") {
          value.style.color = Number(metric.amount_cents) >= 0 ? "var(--fm-color-positive, #15803d)" : "var(--fm-color-negative, #b91c1c)";
        }
        cell.appendChild(label);
        cell.appendChild(value);
        grid.appendChild(cell);
      }
      el.appendChild(grid);
      if (Number.isFinite(Number(data.margin_bps))) {
        const margin = h("div", "fmdoc-money-metrics-margin", "Forecast margin: " + (Number(data.margin_bps) / 100).toFixed(1) + "%");
        margin.style.marginTop = "6pt";
        margin.style.fontSize = "8pt";
        margin.style.color = "var(--fm-color-muted, #777)";
        el.appendChild(margin);
      }
    }
  });

  register({
    id: "doc.expense_breakdown",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_334386b11071ca","Expense breakdown") ?? "Expense breakdown"),
    icon: "fa-table-cells",
    category: "reports",
    defaults: { config: { include_system: true }, frame: { w: 540, h: 260 } },
    configPanel: [
      { key: "include_system", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_aebf4bbf60e0d3","Include system rows (commissions, payroll labor)") ?? "Include system rows (commissions, payroll labor)"), kind: "toggle" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const data = ctx.data || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length) {
        placeholderBox(el, "Expense breakdown", "Projected vs. actual expenses resolve when the report is generated on a project.");
        return;
      }
      const table = h("table", "fmdoc-table");
      const thead = h("thead");
      const headRow = h("tr");
      for (const label of ["Expense", "Type", "Projected", "Actual", "Variance"]) headRow.appendChild(h("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      for (const row of rows) {
        const tr = h("tr");
        tr.setAttribute("data-fmdoc-row", "true");
        tr.appendChild(h("td", null, cleanText(row.title) || "Expense"));
        tr.appendChild(h("td", null, cleanText(row.resource_type)));
        tr.appendChild(h("td", "fmdoc-li-amount", money(row.projected_cents, data.currency)));
        tr.appendChild(h("td", "fmdoc-li-amount", row.actual_cents === null || row.actual_cents === undefined ? "—" : money(row.actual_cents, data.currency)));
        const varianceTd = h("td", "fmdoc-li-amount", money(row.variance_cents, data.currency));
        if (Number(row.variance_cents) > 0) varianceTd.style.color = "var(--fm-color-negative, #b91c1c)";
        if (Number(row.variance_cents) < 0) varianceTd.style.color = "var(--fm-color-positive, #15803d)";
        tr.appendChild(varianceTd);
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
      const totals = data.totals || {};
      const tail = h("div", "fmdoc-li-totals");
      tail.setAttribute("data-fmdoc-tail", "true");
      tail.style.marginTop = "6pt";
      tail.style.fontSize = "8.5pt";
      tail.style.fontWeight = "700";
      tail.textContent = "Projected " + money(totals.projected_cents, data.currency)
        + "  ·  Forecast " + money(totals.current_cents, data.currency)
        + "  ·  Tracked actual " + money(totals.actual_cents, data.currency);
      el.appendChild(tail);
    }
  });

  register({
    id: "doc.payment_history",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_611ff0e7569d4d","Payment history") ?? "Payment history"),
    icon: "fa-money-bill-transfer",
    category: "reports",
    defaults: { config: { include_outbound: true }, frame: { w: 540, h: 260 } },
    configPanel: [
      { key: "include_outbound", label: (globalThis.PlatformLanguage?.text("doc-widgets","m_a7916d70f75a35","Include outgoing payments") ?? "Include outgoing payments"), kind: "toggle" }
    ],
    renderStatic(el, ctx) {
      clearEl(el);
      const data = ctx.data || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!rows.length) {
        placeholderBox(el, "Payment history", "Settled payments resolve when the report is generated on a project.");
        return;
      }
      const table = h("table", "fmdoc-table");
      const thead = h("thead");
      const headRow = h("tr");
      for (const label of ["Date", "Type", "Method", "Amount", "Cleared"]) headRow.appendChild(h("th", null, label));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      for (const row of rows) {
        const tr = h("tr");
        tr.setAttribute("data-fmdoc-row", "true");
        tr.appendChild(h("td", null, row.received_at ? fmtDate(row.received_at) : ""));
        tr.appendChild(h("td", null, cleanText(row.kind).replace(/_/g, " ") || (row.direction === "outbound" ? "payment out" : "payment")));
        tr.appendChild(h("td", null, cleanText(row.method)));
        const amountTd = h("td", "fmdoc-li-amount", (row.direction === "outbound" ? "−" : "") + money(row.amount_cents, data.currency));
        if (row.direction === "outbound") amountTd.style.color = "var(--fm-color-negative, #b91c1c)";
        tr.appendChild(amountTd);
        tr.appendChild(h("td", null, row.cleared_at ? fmtDate(row.cleared_at) : "—"));
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
      const totals = data.totals || {};
      const tail = h("div", "fmdoc-li-totals");
      tail.setAttribute("data-fmdoc-tail", "true");
      tail.style.marginTop = "6pt";
      tail.style.fontSize = "8.5pt";
      tail.style.fontWeight = "700";
      tail.textContent = "In " + money(totals.inbound_cents, data.currency)
        + "  ·  Out " + money(totals.outbound_cents, data.currency)
        + "  ·  Net " + money(totals.net_cents, data.currency);
      el.appendChild(tail);
    }
  });

  register({
    id: "doc.report_table",
    version: 1,
    title: (globalThis.PlatformLanguage?.text("doc-widgets","m_6878b2125403ba","Report table") ?? "Report table"),
    icon: "fa-table",
    category: "reports",
    defaults: { config: { columns: "params.columns", rows: "params.rows" }, frame: { w: 540, h: 520 } },
    configPanel: [],
    renderStatic(el, ctx) {
      clearEl(el);
      const data = ctx.data || {};
      const columns = Array.isArray(data.columns) ? data.columns : [];
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (!columns.length) {
        placeholderBox(el, "Report table", "Choose the report columns to display.");
        return;
      }
      const table = h("table", "fmdoc-table");
      table.style.width = "100%";
      table.style.tableLayout = "fixed";
      const thead = h("thead");
      const headRow = h("tr");
      for (const column of columns) headRow.appendChild(h("th", null, cleanText(column.label || column.key)));
      thead.appendChild(headRow);
      table.appendChild(thead);
      const tbody = h("tbody");
      tbody.setAttribute("data-fmdoc-rows", "true");
      if (!rows.length) {
        const tr = h("tr");
        const td = h("td", null, "No records were found for this selection.");
        td.colSpan = columns.length;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }
      for (const row of rows) {
        const tr = h("tr");
        tr.setAttribute("data-fmdoc-row", "true");
        for (const column of columns) {
          const td = h("td", null, cleanText(row && row[column.key]));
          td.style.overflowWrap = "anywhere";
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      el.appendChild(table);
    }
  });

  // ---------------------------------------------------------------------------
  // Exports
  // ---------------------------------------------------------------------------

  return {
    register,
    get,
    list,
    /**
     * Shared media lightbox (images, video files, YouTube/Vimeo URLs). See
     * the data-fmdoc-media-popup contract comment above: any renderer output
     * carrying that attribute opens this lightbox once
     * installLightboxDelegate() has run on the document (interactive
     * surfaces only — static/print markup stays inert).
     */
    openLightbox,
    installLightboxDelegate,
    /**
     * Self-contained QR encoder (byte mode, EC level M, versions 1-10,
     * best-of-8 mask selection). encode(text) -> { size, modules, version,
     * mask } where modules is a size x size boolean matrix (modules[y][x]);
     * returns null when the payload exceeds version 10 capacity (~213 bytes).
     * svg(text, { color, background, quiet }) -> SVG markup string.
     */
    qr: {
      encode(text) {
        const encoded = QR.encode(text);
        if (!encoded) return null;
        return { size: encoded.size, modules: encoded.modules, version: encoded.version, mask: encoded.mask };
      },
      svg: QR.svg
    },
    _internal: {
      qr: QR,
      money,
      mediaUrlFor,
      mediaPopupAttrValue,
      videoEmbedUrl,
      SIGNATURE_FONTS
    }
  };
});
